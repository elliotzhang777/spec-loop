import { readWaveReview, decideWaveReview } from '../dist/wave-review.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { cli, fillContracts, tempRoot, writeMd } from './helpers.mjs'
import { startAcceptanceRun } from '../dist/acceptance-loop.js'
import { acquireProjectLease, acquireTaskLease, assertSchedulerAction, assertTaskLeaseResult, classifySchedulerFailure, configureWaveBudget, inspectSchedulerLiveness, killSchedulerControl, pauseSchedulerControl, planReadyWave, reconcileInterruptedWaves, reconcileSchedulerControl, releaseProjectLease, releaseTaskLease, renewProjectLease, renewTaskLease, resourceClaimGroupsConflict, resourceClaimsConflict, resumeSchedulerControl, runReadyWave, runSchedulerWatchdog, shouldRetrySchedulerFailure, stopTaskExecution } from '../dist/scheduler-control.js'
import { resetSchedulerSupervisorCircuit, schedulerSupervisorCircuitStatus, schedulerSupervisorLaunchdPlan, schedulerSupervisorStatus, startManagedSchedulerSupervisor, stopManagedSchedulerSupervisor } from '../dist/scheduler-supervisor.js'
import { processMatches, processStartedAt } from '../dist/process-control.js'
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

  const abandonedMutex = path.join(root, '.spec-loop', 'scheduler', 'mutex')
  await mkdir(abandonedMutex, { recursive: true })
  await writeFile(path.join(abandonedMutex, 'owner.json'), `${JSON.stringify({ pid: 99999999, process_started_at: 'stale-owner', created_at: new Date(0).toISOString() })}\n`)
  const project = await acquireProjectLease(root, { owner: 'worker-a', idempotencyKey: 'project-run-1', ttlSeconds: 300 })
  assert.equal((await acquireProjectLease(root, { owner: 'worker-a', idempotencyKey: 'project-run-1', ttlSeconds: 300 })).lease_id, project.lease_id)
  await assert.rejects(acquireProjectLease(root, { owner: 'worker-b', idempotencyKey: 'project-run-2', ttlSeconds: 300 }), /already has an active/)

  const first = await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'task-run-1', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' })
  assert.equal((await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-1', owner: 'worker-a', idempotencyKey: 'task-run-1', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' })).lease_id, first.lease_id)
  await assert.rejects(acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-2', owner: 'worker-a', idempotencyKey: 'task-run-conflict', ttlSeconds: 300, resources: ['module:api'], action: 'start_m' }), /resources conflict/)
  const parallel = await acquireTaskLease(root, { projectLeaseId: project.lease_id, projectFencingToken: project.fencing_token, taskId: 'TASK-LEASE-2', owner: 'worker-a', idempotencyKey: 'task-run-2', ttlSeconds: 300, resources: ['module:web'], action: 'start_m' })
  assert.ok(parallel.fencing_token > first.fencing_token)
  const renewalDeadline=new Date(Date.now()+30_000).toISOString()
  await assert.rejects(renewTaskLease(root,{leaseId:first.lease_id,fencingToken:first.fencing_token,ownerNonce:randomUUID(),ttlSeconds:60,notAfter:renewalDeadline}),/foreign/)
  const renewedProject=await renewProjectLease(root,{leaseId:project.lease_id,fencingToken:project.fencing_token,ownerNonce:project.owner_nonce,ttlSeconds:60,notAfter:renewalDeadline})
  const renewedTask=await renewTaskLease(root,{leaseId:first.lease_id,fencingToken:first.fencing_token,ownerNonce:first.owner_nonce,ttlSeconds:60,notAfter:renewalDeadline})
  assert.ok(Date.parse(renewedProject.expires_at)<=Date.parse(renewalDeadline));assert.ok(Date.parse(renewedTask.expires_at)<=Date.parse(renewalDeadline))
  assert.equal(resourceClaimsConflict(['repo:a'],['branch:a/main']),true)
  assert.equal(resourceClaimsConflict(['module:backend#read'],['module:backend/order#read']),false)
  assert.equal(resourceClaimsConflict(['module:backend#read'],['module:backend/order#write']),true)
  assert.equal(resourceClaimsConflict(['tool:simulator/ios#1/2'],['tool:simulator/ios#1/2']),false)
  assert.equal(resourceClaimsConflict(['tool:simulator/ios#2/2'],['tool:simulator/ios#1/2']),true)
  assert.equal(resourceClaimGroupsConflict([['tool:simulator/ios#1/2'],['tool:simulator/ios#1/2']],['tool:simulator/ios#1/2']),true)
  assert.equal(classifySchedulerFailure(new Error('provider network timeout')).retryClass,'infrastructure')
  assert.equal(classifySchedulerFailure(new Error('Codex Adapter exited with code 2: unknown option')).retryClass,'deterministic_tool')
  assert.equal(classifySchedulerFailure(new Error('acceptance assertion failed')).retryClass,'workflow')
  assert.equal(shouldRetrySchedulerFailure('infrastructure',1,1),true)
  assert.equal(shouldRetrySchedulerFailure('infrastructure',2,2),false)
  assert.equal(shouldRetrySchedulerFailure('deterministic_tool',1,1),false)
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
  const stopSignalLog = path.join(root, 'stop-signals.txt')
  const stubbornEffect = "const fs=require('node:fs');process.on('SIGTERM',()=>fs.appendFileSync(process.argv[1],Date.now()+'\\n'));setInterval(() => {}, 1000)"
  const effect = spawn(process.execPath, ['-e', stubbornEffect, stopSignalLog], { stdio: 'ignore' })
  const secondEffect = spawn(process.execPath, ['-e', stubbornEffect, stopSignalLog], { stdio: 'ignore' })
  t.after(() => { try { effect.kill('SIGKILL') } catch {};try { secondEffect.kill('SIGKILL') } catch {} })
  const activeEffects = path.join(root, '.spec-loop', 'active-effects'); await mkdir(activeEffects, { recursive: true })
  const effectMarker = path.join(activeEffects, 'TASK-LEASE-1-effect.json')
  await writeFile(effectMarker, `${JSON.stringify({ schema_version: 2, effect_id: 'effect-under-stop', task_id: 'TASK-LEASE-1', kind: 'gate', pid: effect.pid, process_started_at: await processStartedAt(effect.pid), process_group: false, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), last_progress_at: new Date().toISOString(), idle_timeout_seconds: 10 })}\n`)
  const secondEffectMarker = path.join(activeEffects, 'TASK-LEASE-2-effect.json')
  await writeFile(secondEffectMarker, `${JSON.stringify({ schema_version: 2, effect_id: 'second-effect-under-stop', task_id: 'TASK-LEASE-2', kind: 'gate', pid: secondEffect.pid, process_started_at: await processStartedAt(secondEffect.pid), process_group: false, started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), last_progress_at: new Date().toISOString(), idle_timeout_seconds: 10 })}\n`)
  const health = await inspectSchedulerLiveness(root, 3)
  assert.equal(health.control_locks.find(item=>item.name==='scheduler_control').status,'idle')
  assert.equal(typeof health.control_locks.find(item=>item.name==='scheduler_control').wait_duration_ms,'number')
  assert.equal(health.effects.find(item => item.effect_id === 'effect-under-stop').status, 'healthy')
  assert.equal(health.drivers.find(item => item.task_id === 'TASK-LEASE-1').status, 'dead_or_pid_reused')
  const marker = JSON.parse(await readFile(effectMarker, 'utf8')); marker.last_progress_at = new Date(Date.now() - 20_000).toISOString(); marker.heartbeat_at = new Date().toISOString(); await writeFile(effectMarker, `${JSON.stringify(marker)}\n`)
  const secondMarker = JSON.parse(await readFile(secondEffectMarker, 'utf8')); secondMarker.last_progress_at = new Date(Date.now() - 20_000).toISOString(); secondMarker.heartbeat_at = new Date().toISOString(); await writeFile(secondEffectMarker, `${JSON.stringify(secondMarker)}\n`)
  const inspection = await runSchedulerWatchdog(root, 3, false)
  assert.equal(inspection.action, 'inspection_only')
  assert.equal(inspection.effects.find(item => item.effect_id === 'effect-under-stop').status, 'no_progress')
  const watchdogStarted=Date.now(),appliedWatchdog=await runSchedulerWatchdog(root, 3, true)
  assert.equal(appliedWatchdog.stopped_tasks.length, 2)
  if(process.platform!=='win32'){
    assert.ok(Date.now()-watchdogStarted<10_500,`bounded concurrent stop took ${Date.now()-watchdogStarted}ms`)
    const signals=(await readFile(stopSignalLog,'utf8')).trim().split('\n').map(Number).sort((a,b)=>a-b)
    assert.equal(signals.length,2)
    assert.ok(signals[1]-signals[0]<900,`stop signals were serialized by ${signals[1]-signals[0]}ms`)
  }
  await killSchedulerControl(root)
  assert.equal((await readState(path.join(root, '.spec-loop', 'tasks', 'task-lease-1'))).status, 'cancelled')
  const stopIntentFile=path.join(root,'.spec-loop/scheduler/stop-intents/TASK-LEASE-1.json')
  const staleIntent=JSON.parse(await readFile(stopIntentFile,'utf8'))
  await writeFile(stopIntentFile,JSON.stringify({...staleIntent,status:'stop_incomplete',completed_at:null,last_error:'prior bounded caller expired'}))
  const stopped = await stopTaskExecution(root, 'TASK-LEASE-1', 'duplicate stop must be idempotent')
  assert.equal(JSON.parse(await readFile(stopIntentFile,'utf8')).status,'completed')
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
  const provider = path.join(root, 'wave-provider.sh'), starts = path.join(root, '.spec-loop', 'shared-cache', 'wave-starts.txt')
  await writeFile(provider, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ]; then printf 'codex fixture 1.0\\n'; exit 0; fi; done\nprintf '%s\\n' "$SPEC_LOOP_INVOCATION_ID" >> ${JSON.stringify(starts)}\nattempt=0\nwhile [ "$(wc -l < ${JSON.stringify(starts)})" -lt 2 ] && [ "$attempt" -lt 400 ]; do attempt=$((attempt + 1)); sleep 0.05; done\n[ "$(wc -l < ${JSON.stringify(starts)})" -ge 2 ] || { printf 'provider was serialized\\n' >&2; exit 9; }\nprintf '%s\\n' "$SPEC_LOOP_INVOCATION_ID" > "$SPEC_LOOP_INVOCATION_ID.txt"\ngit add "$SPEC_LOOP_INVOCATION_ID.txt"\ngit commit -m "$SPEC_LOOP_INVOCATION_ID" >/dev/null\nprintf '%s\\n' 'candidate self-test passed' > "$SPEC_LOOP_EVIDENCE_ROOT/self-test.txt"\nprintf '%s\\n' '{"usage":{"input_tokens":8,"output_tokens":2,"total_tokens":10,"cost_usd":0.01}}'\n`)
  await import('node:fs/promises').then(fs => fs.chmod(provider, 0o755))
  const providers = path.join(root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${provider}`))
  await configureWaveBudget(root, { maxParallel: 2, maxElapsedSeconds: 120, maxTokens: 100, maxCostUsd: 1 })
  assert.deepEqual((await planReadyWave(root)).ready.map(item => item.task_id), ['TASK-WAVE-1', 'TASK-WAVE-2'])
  const wave = await runReadyWave(root, { owner: 'wave-test',singleStage:true,testSessionId:'wave-executor-test',testMaxRuntimeSeconds:120 })
  assert.equal(wave.status, 'awaiting_wave_review', JSON.stringify(wave.results))
  assert.ok(wave.supervisor.pid > 0)
  // An in-flight checking cycle is not a completed health proof. Await the
  // bounded Supervisor readiness path instead of sampling that transient.
  assert.equal((await startManagedSchedulerSupervisor(root,{testMode:true,testSessionId:'wave-executor-test',maxRuntimeSeconds:120})).healthy, true)
  assert.equal(wave.results.length, 2)
  assert.equal(wave.usage.total_tokens, 20, JSON.stringify(wave.results))
  assert.equal(wave.usage.cost_usd, 0.02)
  assert.ok(wave.results.reduce((sum, item) => sum + item.reservation.tokens, 0) <= wave.budget.max_tokens)
  assert.equal((await readFile(starts, 'utf8')).trim().split('\n').length, 2)
  assert.equal((await planReadyWave(root)).ready.length,0)
  assert.equal((await planReadyWave(root)).held.filter(item=>item.reason.startsWith('awaiting_wave_review')).length,2)

  await addTask(root, repository, 'TASK-WAVE-3'); await addTask(root, repository, 'TASK-WAVE-4')
  runGit(repository, ['add', '.']); runGit(repository, ['commit', '-m', 'add usage fuse fixtures'])
  const thirdWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-3', '--json']); assert.equal(thirdWorkspace.code, 0, thirdWorkspace.stderr)
  const fourthWorkspace = cli(['workspace', 'create', root, 'TASK-WAVE-4', '--json']); assert.equal(fourthWorkspace.code, 0, fourthWorkspace.stderr)
  await writeFile(providers, (await readFile(providers, 'utf8')).replace(`executable: ${provider}`, 'executable: /usr/bin/true'))
  await configureWaveBudget(root, { maxParallel: 1, maxElapsedSeconds: 30, maxTokens: 100, maxCostUsd: 1 })
  const unknown = await runReadyWave(root, { owner: 'usage-fuse-test',testSessionId:'wave-executor-test',testMaxRuntimeSeconds:120 })
  assert.equal(unknown.status, 'usage_unknown')
  assert.equal(unknown.results.length, 1)
  assert.equal(unknown.usage.recorded, false)

  const review=await readWaveReview(root,unknown.wave_id)
  await decideWaveReview(root,unknown.wave_id,{bundle_hash:review.bundle.bundle_hash,request_id:randomUUID(),actor:'owner',note:'重试超时停止测试',choices:review.bundle.tasks.map(item=>({task_id:item.task_id,action:'return_to_m'}))})

  // An elapsed fuse must bound the whole stop batch, even while roles are
  // preparing or running, and retain every unverified stop for retry.
  await writeFile(provider, `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "--version" ]; then printf 'codex fixture 1.0\\n'; exit 0; fi; done\nsleep 60\n`)
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${provider}`))
  await configureWaveBudget(root, { maxParallel: 2, maxElapsedSeconds: 3, maxTokens: 100, maxCostUsd: 1 })
  const began = performance.now()
  const elapsed = await runReadyWave(root, { owner: 'elapsed-fuse-test', testSessionId: 'wave-executor-test', testMaxRuntimeSeconds: 120 })
  assert.ok(performance.now() - began < 18_000, `wave shutdown exceeded its deadline: ${performance.now() - began}ms`)
  assert.match(elapsed.fuse_reason, /elapsed budget reached/)
  assert.ok(['budget_stopped', 'usage_unknown', 'stop_incomplete'].includes(elapsed.status), JSON.stringify(elapsed))
  assert.deepEqual(elapsed.pending_stops, elapsed.stop_results.filter(item => item.stop_complete !== true).map(item => item.task_id))
  for (const stop of elapsed.stop_results) {
    const intent = JSON.parse(await readFile(path.join(root, '.spec-loop', 'scheduler', 'stop-intents', `${stop.task_id}.json`), 'utf8'))
    if(intent.request_id===stop.request_id)assert.equal(intent.status,stop.stop_complete?'completed':'stop_incomplete')
    else {
      // The independent Supervisor can already be retrying the incomplete stop.
      // Its newer generation must not be compared with the old wave receipt.
      assert.ok(Date.parse(intent.requested_at)>=Date.parse(elapsed.started_at))
      assert.ok(['requested','stop_incomplete','completed'].includes(intent.status))
    }
  }
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
    status = await startManagedSchedulerSupervisor(root, { intervalSeconds: 1, staleSeconds: 3, cycleTimeoutSeconds: 10,testMode:true,maxRuntimeSeconds:120,testSessionId:'independent-supervisor-test' })
    assert.equal(status.running, true)
    const duplicate = await startManagedSchedulerSupervisor(root, { intervalSeconds: 1, staleSeconds: 3, cycleTimeoutSeconds: 10,testMode:true,maxRuntimeSeconds:120,testSessionId:'independent-supervisor-test' })
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
    assert.ok(status.marker.iteration > status.marker.successful_watchdogs,'an ok:false watchdog must count as a failure, not a successful watchdog')
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

test('Supervisor verifies a timed-out watchdog has exited before it starts another cycle', async (t) => {
  const root = await tempRoot('scheduler-supervisor-timeout-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-SUPERVISOR-TIMEOUT', '--name', 'Scheduler timeout', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-supervised-timeout')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-SUPERVISED-TIMEOUT', '--title', 'Timeout watchdog', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-SUPERVISED-TIMEOUT', title: 'Timeout watchdog', level: 'standard', criteria: ['timed out watchdog exits'] })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  const mutex = path.join(root, '.spec-loop', 'execution-events.lock')
  t.after(async () => { await rm(mutex, { recursive: true, force: true }); await stopManagedSchedulerSupervisor(root).catch(() => {}) })
  await startManagedSchedulerSupervisor(root, { intervalSeconds: 1, staleSeconds: 3, cycleTimeoutSeconds: 3,testMode:true,maxRuntimeSeconds:120,testSessionId:'timeout-supervisor-test' })
  const driverLock = path.join(root, '.spec-loop', 'locks', 'workflow-driver-TASK-SUPERVISED-TIMEOUT.lock')
  await mkdir(driverLock, { recursive: true })
  await writeFile(path.join(driverLock, 'owner.json'), `${JSON.stringify({ pid: 99999999, created_at: new Date().toISOString() })}\n`)
  const testProcessStart = await processStartedAt(process.pid)
  assert.ok(testProcessStart)
  await mkdir(mutex, { recursive: true })
  await writeFile(path.join(mutex, 'owner.json'), `${JSON.stringify({ pid: process.pid, process_started_at: testProcessStart, created_at: new Date().toISOString() })}\n`)
  let worker = null
  const workerDeadline = Date.now() + 10_000
  while (Date.now() < workerDeadline) {
    const status = await schedulerSupervisorStatus(root)
    if (status.marker?.worker_pid && status.marker.worker_process_started_at) { worker = { pid: status.marker.worker_pid, startedAt: status.marker.worker_process_started_at }; break }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(worker)
  const timeoutDeadline = Date.now() + 10_000
  let status
  while (Date.now() < timeoutDeadline) {
    status = await schedulerSupervisorStatus(root)
    if (status.marker?.state === 'degraded' && status.marker.worker_pid === null) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(status.marker.state, 'degraded')
  assert.equal(await processMatches(worker.pid, worker.startedAt), false)

  await rm(mutex, { recursive: true, force: true })
  // A loaded full suite may spend multiple watchdog cycles confirming the old worker exited.
  const recoveryDeadline = Date.now() + 30_000
  while (Date.now() < recoveryDeadline) {
    status = await schedulerSupervisorStatus(root)
    if (status.healthy) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(status.healthy, true, JSON.stringify(status))
})

test('test-mode Supervisor self-terminates at its bounded runtime', async (t) => {
  const root=await tempRoot('scheduler-supervisor-test-mode-'),repository=path.join(root,'repo');await mkdir(repository)
  assert.equal(cli(['project','init',root,'--id','PROJ-SUPERVISOR-TEST-MODE','--name','Bounded Supervisor','--repository',repository]).code,0)
  t.after(async()=>stopManagedSchedulerSupervisor(root).catch(()=>{}))
  const started=await startManagedSchedulerSupervisor(root,{intervalSeconds:1,staleSeconds:3,cycleTimeoutSeconds:3,testMode:true,maxRuntimeSeconds:2,testSessionId:'node-test-session'})
  assert.equal(started.healthy,true)
  assert.equal(started.marker.test_mode,true)
  assert.equal(started.marker.test_session_id,'node-test-session')
  const deadline=Date.now()+8_000;let status=started
  while(Date.now()<deadline){status=await schedulerSupervisorStatus(root);if(!status.running)break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(status.running,false)
})

test('persistent Supervisor circuit blocks automatic restart until explicit reset', async () => {
  const root=await tempRoot('scheduler-supervisor-circuit-'),repository=path.join(root,'repo');await mkdir(repository)
  assert.equal(cli(['project','init',root,'--id','PROJ-SUPERVISOR-CIRCUIT','--name','Persistent circuit','--repository',repository]).code,0)
  const circuitFile=path.join(root,'.spec-loop','scheduler','SUPERVISOR_CIRCUIT.json'),now=new Date().toISOString()
  await mkdir(path.dirname(circuitFile),{recursive:true})
  await writeFile(circuitFile,`${JSON.stringify({schema_version:1,circuit_open:true,opened_at:now,reason:'fixture watchdog failures',consecutive_failures:3,automatic_restarts:[],updated_at:now},null,2)}\n`)
  await assert.rejects(startManagedSchedulerSupervisor(root,{testMode:true,maxRuntimeSeconds:10,testSessionId:'circuit-test'}),/requires explicit reset/)
  assert.equal((await schedulerSupervisorCircuitStatus(root)).circuit_open,true)
  assert.equal((await resetSchedulerSupervisorCircuit(root)).circuit_open,false)
  assert.equal((await schedulerSupervisorCircuitStatus(root)).circuit_open,false)
})

test('run-ready Supervisor bootstrap replaces a live process with a stale heartbeat', {skip:process.platform==='win32'}, async (t) => {
  const root=await tempRoot('scheduler-supervisor-stale-'),repository=path.join(root,'repo');await mkdir(repository)
  assert.equal(cli(['project','init',root,'--id','PROJ-SUPERVISOR-STALE','--name','Stale Supervisor','--repository',repository]).code,0)
  t.after(async()=>stopManagedSchedulerSupervisor(root).catch(()=>{}))
  const first=await startManagedSchedulerSupervisor(root,{intervalSeconds:1,staleSeconds:3,cycleTimeoutSeconds:3,testMode:true,maxRuntimeSeconds:30,testSessionId:'stale-recovery'})
  assert.equal(first.healthy,true);const oldPid=first.marker.pid
  process.kill(oldPid,'SIGSTOP')
  const staleDeadline=Date.now()+8_000;let stale
  while(Date.now()<staleDeadline){stale=await schedulerSupervisorStatus(root);if(stale.reason==='stale_heartbeat')break;await new Promise(resolve=>setTimeout(resolve,100))}
  assert.equal(stale.reason,'stale_heartbeat')
  const recovered=await startManagedSchedulerSupervisor(root,{intervalSeconds:1,staleSeconds:3,cycleTimeoutSeconds:3,testMode:true,maxRuntimeSeconds:30,testSessionId:'stale-recovery'})
  assert.equal(recovered.healthy,true)
  assert.notEqual(recovered.marker.pid,oldPid)
  assert.match(recovered.marker.last_recovery_action,/stale_heartbeat/)
  assert.equal(await processMatches(oldPid,first.marker.process_started_at),false)
})
