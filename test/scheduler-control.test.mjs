import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { cli, fillContracts, tempRoot, writeMd } from './helpers.mjs'
import { startAcceptanceRun } from '../dist/acceptance-loop.js'
import { acquireProjectLease, acquireTaskLease, assertSchedulerAction, assertTaskLeaseResult, configureWaveBudget, inspectSchedulerLiveness, killSchedulerControl, pauseSchedulerControl, planReadyWave, reconcileInterruptedWaves, reconcileSchedulerControl, releaseProjectLease, releaseTaskLease, resumeSchedulerControl, runReadyWave, runSchedulerWatchdog, stopTaskExecution } from '../dist/scheduler-control.js'
import { schedulerSupervisorLaunchdPlan, schedulerSupervisorStatus, startManagedSchedulerSupervisor, stopManagedSchedulerSupervisor } from '../dist/scheduler-supervisor.js'
import { processStartedAt } from '../dist/process-control.js'
import { readState } from '../dist/task.js'
import { buildExecutionSnapshot } from '../dist/execution-view.js'
import { readExecutionEvents } from '../dist/execution-events.js'

function contract(taskId) { return { schema_version: 2, task_id: taskId, version: 1, risk: 'standard', critical_path: false, depends_on: [], criteria: [{ id: 'AC-1', text: 'controlled task is safe', risk_tags: ['functional'], waivable: false }], use_cases: [{ id: 'UC-1', ac: ['AC-1'], scenario: 'schedule an approved task' }], tools: [{ id: 'safe-test', kind: 'unit', gate_id: 'safe-test', command: [process.execPath, '--test'], playwright: null }], assertions: [{ id: 'AS-1', ac: ['AC-1'], tool_id: 'safe-test', operator: 'exit_code_zero', expected: 'exit code 0' }], evidence_requirements: [{ id: 'ER-1', ac: ['AC-1'], tool_id: 'safe-test', kind: 'test_report', required: true }], budgets: { max_semantic_reworks: 2, max_infrastructure_retries_per_stage: 1, repeated_failure_limit: 2 } } }

async function addTask(root, repository, taskId) {
  const contractFile = path.join(root, `${taskId}.json`); await writeFile(contractFile, `${JSON.stringify(contract(taskId), null, 2)}\n`)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved scheduler fixture', '--goal', `Schedule ${taskId}`, '--reason', 'Exercise lease coordination', '--contract', contractFile]); assert.equal(proposal.code, 0, proposal.stderr)
  assert.equal(cli(['triage', 'approve', root, proposal.stdout.trim(), '--by', 'owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', root, proposal.stdout.trim(), '--id', taskId, '--title', `Schedule ${taskId}`]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase()); await fillContracts(taskRoot, { id: taskId, title: `Schedule ${taskId}`, level: 'standard', criteria: ['controlled task is safe'] })
  await writeMd(path.join(taskRoot, 'SPEC.md'), { schema_version: 1, task_id: taskId, title: `Schedule ${taskId}`, level: 'standard', proposal_id: proposal.stdout.trim() }, '# Goal\n\nExercise scheduler leases.\n\n## Scope\n\nUse fixture facts.\n\n## Non-goals\n\nDo not execute external work.')
  assert.equal(cli(['plan', taskRoot]).code, 0); await startAcceptanceRun(root, taskId)
}

async function useFixtureProvider(root) {
  const providers = path.join(root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: codex', 'executable: /usr/bin/true'))
}

test('scheduler leases fence stale workers, serialize conflicting resources, and honor Pause/Kill', async (t) => {
  const root = await tempRoot('scheduler-control-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-CONTROL', '--name', 'Scheduler control', '--repository', repository]).code, 0)
  assert.equal(cli(['project', 'protocol', root, '--set', 'v2']).code, 0)
  await useFixtureProvider(root)
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), { schema_version: 1, scope_kind: 'task', wave_id: 'WCONTROL', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' }, gates: [{ id: 'safe-test', ac: ['AC-1'], command: [process.execPath, '--test'], timeout_seconds: 30 }] }, '# Gates\n\nScheduler fixture gate.')
  await addTask(root, repository, 'TASK-LEASE-1'); await addTask(root, repository, 'TASK-LEASE-2')

  const project = await acquireProjectLease(root, { owner: 'worker-a', idempotencyKey: 'project-run-1', ttlSeconds: 300 })
  assert.equal((await acquireProjectLease(root, { owner: 'worker-a', idempotencyKey: 'project-run-1', ttlSeconds: 300 })).lease_id, project.lease_id)
  await assert.rejects(acquireProjectLease(root, { owner: 'worker-b', idempotencyKey: 'project-run-2', ttlSeconds: 300 }), /already has an active/)

  const first = await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'task-run-1', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' })
  assert.equal((await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'task-run-1', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' })).lease_id, first.lease_id)
  await assert.rejects(acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-2', owner: 'worker-a', idempotencyKey: 'task-run-conflict', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' }), /resources conflict/)
  const parallel = await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-2', owner: 'worker-a', idempotencyKey: 'task-run-2', ttlSeconds: 300, resources: ['module:web'], action: 'start_m' })
  assert.ok(parallel.fencing_token > first.fencing_token)
  assert.equal((await assertTaskLeaseResult(root, first.lease_id, first.fencing_token)).accepted, true)
  await assert.rejects(assertTaskLeaseResult(root, first.lease_id, first.fencing_token - 1), /stale/)
  assert.throws(() => assertSchedulerAction('push'), /denied/); assert.deepEqual(assertSchedulerAction('start_v'), { allowed: true, action: 'start_v' })

  await pauseSchedulerControl(root)
  await assert.rejects(acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'paused-task', ttlSeconds: 300, resources: ['tool:simulator'], action: 'start_m' }), /paused/)
  await resumeSchedulerControl(root)
  await assert.rejects(releaseProjectLease(root, project.lease_id, project.fencing_token), /still owns active Task leases/)
  await releaseTaskLease(root, first.lease_id, first.fencing_token)
  await releaseTaskLease(root, parallel.lease_id, parallel.fencing_token)
  assert.equal((await releaseProjectLease(root, project.lease_id, project.fencing_token)).status, 'released')
  const killProject = await acquireProjectLease(root, { owner: 'worker-a', idempotencyKey: 'project-run-kill', ttlSeconds: 300 })
  const killedLease = await acquireTaskLease(root, { projectLeaseId: killProject.lease_id, projectFencingToken: killProject.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'task-run-kill', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' })
  const staleDriverLock = path.join(root, '.spec-loop', 'locks', 'workflow-driver-TASK-LEASE-1.lock')
  await mkdir(staleDriverLock, { recursive: true })
  await writeFile(path.join(staleDriverLock, 'owner.json'), `${JSON.stringify({ pid: 99999999 })}\n`)
  const effect = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { try { effect.kill('SIGKILL') } catch {} })
  const activeEffects = path.join(root, '.spec-loop', 'active-effects'); await mkdir(activeEffects, { recursive: true })
  const effectMarker = path.join(activeEffects, 'TASK-LEASE-1-effect.json')
  await writeFile(effectMarker, `${JSON.stringify({ schema_version: 2, effect_id: 'effect-under-stop', task_id: 'TASK-LEASE-1', kind: 'gate', pid: effect.pid, process_started_at: await processStartedAt(effect.pid), process_group: false, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), last_progress_at: new Date().toISOString(), idle_timeout_seconds: 10 })}\n`)
  const health = await inspectSchedulerLiveness(root, 3)
  assert.equal(health.effects.find(item => item.effect_id === 'effect-under-stop').status, 'healthy')
  assert.equal(health.drivers.find(item => item.task_id === 'TASK-LEASE-1').status, 'dead_or_pid_reused')
  const marker = JSON.parse(await readFile(effectMarker, 'utf8')); marker.last_progress_at = new Date(Date.now() - 20_000).toISOString(); marker.heartbeat_at = new Date().toISOString(); await writeFile(effectMarker, `${JSON.stringify(marker)}\n`)
  const inspection = await runSchedulerWatchdog(root, 3, false)
  assert.equal(inspection.action, 'inspection_only')
  assert.equal(inspection.effects.find(item => item.effect_id === 'effect-under-stop').status, 'no_progress')
  assert.equal((await runSchedulerWatchdog(root, 3, true)).stopped_tasks.length, 1)
  await killSchedulerControl(root)
  assert.equal((await readState(path.join(root, '.spec-loop', 'tasks', 'task-lease-1'))).status, 'cancelled')
  const stopped = await stopTaskExecution(root, 'TASK-LEASE-1', 'duplicate stop must be idempotent')
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.driver_lock_reclaimed, true)
  assert.deepEqual(stopped.cancelled_effects, ['effect-under-stop'])
  const cancellationEvents = (await readExecutionEvents(root)).filter(event => event.task_id === 'TASK-LEASE-1' && event.label === 'Task 已取消')
  assert.equal(cancellationEvents.length, 1)
  const firstSnapshot = await buildExecutionSnapshot(root, new Date('2026-09-06T00:00:00.000Z'))
  const secondSnapshot = await buildExecutionSnapshot(root, new Date('2026-09-06T01:00:00.000Z'))
  assert.equal(firstSnapshot.tasks.find(task => task.task_id === 'TASK-LEASE-1').wall_clock_ms, secondSnapshot.tasks.find(task => task.task_id === 'TASK-LEASE-1').wall_clock_ms)
  assert.equal(firstSnapshot.tasks.find(task => task.task_id === 'TASK-LEASE-1').status, 'cancelled')
  await assert.rejects(assertTaskLeaseResult(root, killedLease.lease_id, killedLease.fencing_token), /stale, killed, or inactive/)
  await assert.rejects(resumeSchedulerControl(root), /reconcile/)
  assert.equal((await reconcileSchedulerControl(root)).reconcile_required, false)
  assert.equal((await resumeSchedulerControl(root)).paused, false)
})

test('wave executor concurrently dispatches Ready Tasks within elapsed, token and cost ceilings', async (t) => {
  const root = await tempRoot('scheduler-wave-'), repository = path.join(root, 'repo'); await mkdir(repository)
  t.after(async () => { await stopManagedSchedulerSupervisor(root).catch(() => {}) })
  const { spawnSync } = await import('node:child_process')
  const runGit = (cwd, args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim() }
  runGit(repository, ['init', '-b', 'main']); runGit(repository, ['config', 'user.email', 'test@example.com']); runGit(repository, ['config', 'user.name', 'Test'])
  await writeFile(path.join(repository, 'README.md'), 'wave fixture\n'); runGit(repository, ['add', '.']); runGit(repository, ['commit', '-m', 'initial'])
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-WAVE', '--name', 'Wave executor', '--repository', repository]).code, 0)
  assert.equal(cli(['project', 'protocol', root, '--set', 'v2']).code, 0)
  await useFixtureProvider(root)
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), { schema_version: 1, scope_kind: 'task', wave_id: 'WWAVE', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' }, gates: [{ id: 'safe-test', ac: ['AC-1'], command: [process.execPath, '--test'], timeout_seconds: 30 }] }, '# Gates\n\nWave fixture gate.')
  await addTask(root, repository, 'TASK-WAVE-1'); await addTask(root, repository, 'TASK-WAVE-2')
  runGit(repository, ['add', '.']); runGit(repository, ['commit', '-m', 'approved wave specifications'])
  const firstWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-1', '--json']); assert.equal(firstWorkspace.code, 0, firstWorkspace.stderr)
  const secondWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-2', '--json']); assert.equal(secondWorkspace.code, 0, secondWorkspace.stderr)
  const provider = path.join(root, 'wave-provider.sh'), starts = path.join(root, 'wave-starts.txt')
  await writeFile(provider, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ]; then printf 'codex fixture 1.0\\n'; exit 0; fi; done\nprintf '%s\\n' "$SPEC_LOOP_INVOCATION_ID" >> ${JSON.stringify(starts)}\nattempt=0\nwhile [ "$(wc -l < ${JSON.stringify(starts)})" -lt 2 ] && [ "$attempt" -lt 400 ]; do attempt=$((attempt + 1)); sleep 0.05; done\n[ "$(wc -l < ${JSON.stringify(starts)})" -ge 2 ] || { printf 'provider was serialized\\n' >&2; exit 9; }\nprintf '%s\\n' "$SPEC_LOOP_INVOCATION_ID" > "$SPEC_LOOP_INVOCATION_ID.txt"\ngit add "$SPEC_LOOP_INVOCATION_ID.txt"\ngit commit -m "$SPEC_LOOP_INVOCATION_ID" >/dev/null\nprintf '%s\\n' 'candidate self-test passed' > "$SPEC_LOOP_EVIDENCE_ROOT/self-test.txt"\nprintf '%s\\n' '{"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10,"cost_usd":0.01}}'\n`)
  await import('node:fs/promises').then(fs => fs.chmod(provider, 0o755))
  const providers = path.join(root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${provider}`))
  await configureWaveBudget(root, { maxParallel: 2, maxElapsedSeconds: 120, maxTokens: 100, maxCostUsd: 1 })
  assert.deepEqual((await planReadyWave(root)).ready.map(item => item.task_id), ['TASK-WAVE-1', 'TASK-WAVE-2'])
  const wave = await runReadyWave(root, { owner: 'wave-test' })
  assert.equal(wave.status, 'completed', JSON.stringify(wave.results))
  assert.ok(wave.supervisor.pid > 0)
  assert.equal((await schedulerSupervisorStatus(root)).healthy, true)
  assert.equal(wave.results.length, 2)
  assert.equal(wave.usage.total_tokens, 20, JSON.stringify(wave.results))
  assert.equal(wave.usage.cost_usd, 0.02)
  assert.ok(wave.results.reduce((sum, item) => sum + item.reservation.tokens, 0) <= wave.budget.max_tokens)
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 2)
  assert.deepEqual((await planReadyWave(root)).ready.map(item => [item.task_id, item.role]), [['TASK-WAVE-1', 'V'], ['TASK-WAVE-2', 'V']])

  await addTask(root, repository, 'TASK-WAVE-3'); await addTask(root, repository, 'TASK-WAVE-4')
  runGit(repository, ['add', '.']); runGit(repository, ['commit', '-m', 'add usage fuse fixtures'])
  const thirdWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-3', '--json']); assert.equal(thirdWorkspace.code, 0, thirdWorkspace.stderr)
  const fourthWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-4', '--json']); assert.equal(fourthWorkspace.code, 0, fourthWorkspace.stderr)
  await writeFile(providers, (await readFile(providers, 'utf8')).replace(`executable: ${provider}`, 'executable: /usr/bin/true'))
  await configureWaveBudget(root, { maxParallel: 1, maxElapsedSeconds: 30, maxTokens: 100, maxCostUsd: 1 })
  const unknown = await runReadyWave(root, { owner: 'usage-fuse-test' })
  assert.equal(unknown.status, 'usage_unknown')
  assert.equal(unknown.results.length, 1)
  assert.equal(unknown.usage.recorded, false)
})

test('dead wave drivers are reconciled into an explicit requeue state', async () => {
  const root = await tempRoot('scheduler-wave-recovery-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-WAVE-RECOVERY', '--name', 'Wave recovery', '--repository', repository]).code, 0)
  const runs = path.join(root, '.spec-loop', 'scheduler', 'wave-runs'); await mkdir(runs, { recursive: true })
  const file = path.join(runs, 'WAVE-DEAD.json')
  await writeFile(file, `${JSON.stringify({ schema_version: 2, wave_id: 'WAVE-DEAD', status: 'running', driver: { pid: 99999999, process_started_at: 'never' }, started_at: new Date(Date.now() - 60_000).toISOString(), heartbeat_at: new Date(Date.now() - 60_000).toISOString(), planned_tasks: [], results: [] }, null, 2)}\n`)
  const inspected = await reconcileInterruptedWaves(root, false)
  assert.equal(inspected.waves[0].status, 'dead_driver')
  const applied = await reconcileInterruptedWaves(root, true)
  assert.equal(applied.waves[0].status, 'interrupted_requeued')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).status, 'interrupted_requeued')
})

test('independent Supervisor survives its caller and automatically closes a dead Driver task', async () => {
  const root = await tempRoot('scheduler-supervisor-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-SUPERVISOR', '--name', 'Scheduler Supervisor', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-supervised-1')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-SUPERVISED-1', '--title', 'Stop dead Driver', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-SUPERVISED-1', title: 'Stop dead Driver', level: 'standard', criteria: ['dead Driver is stopped'] })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  const staleDriverLock = path.join(root, '.spec-loop', 'locks', 'workflow-driver-TASK-SUPERVISED-1.lock')
  await mkdir(staleDriverLock, { recursive: true })
  await writeFile(path.join(staleDriverLock, 'owner.json'), `${JSON.stringify({ pid: 99999999, created_at: new Date().toISOString() })}\n`)

  let status
  try {
    status = await startManagedSchedulerSupervisor(root, { intervalSeconds: 1, staleSeconds: 3, cycleTimeoutSeconds: 10 })
    assert.equal(status.running, true)
    const duplicate = await startManagedSchedulerSupervisor(root, { intervalSeconds: 1, staleSeconds: 3, cycleTimeoutSeconds: 10 })
    assert.equal(duplicate.marker.pid, status.marker.pid)
    const taskDeadline = Date.now() + 60_000
    while (Date.now() < taskDeadline) {
      if ((await readState(taskRoot)).status === 'cancelled') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal((await readState(taskRoot)).status, 'cancelled')
    const markerDeadline = Date.now() + 60_000
    while (Date.now() < markerDeadline) {
      status = await schedulerSupervisorStatus(root)
      if (status.marker?.last_stopped_tasks?.includes('TASK-SUPERVISED-1')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(status.running, true)
    assert.equal(status.healthy, true)
    assert.ok(status.marker.iteration >= 1)
    assert.deepEqual(status.marker.last_stopped_tasks, ['TASK-SUPERVISED-1'])
  } finally {
    const stopped = await stopManagedSchedulerSupervisor(root)
    assert.equal(stopped.stopped, true)
  }
  assert.equal((await schedulerSupervisorStatus(root)).running, false)
  assert.equal((await stopManagedSchedulerSupervisor(root)).stopped, false)
  const launchd = await schedulerSupervisorLaunchdPlan(root)
  assert.match(launchd.plist, /KeepAlive/)
  assert.match(launchd.plist, /PROJ-SUPERVISOR/i)
  assert.equal(launchd.installed, false)
})
