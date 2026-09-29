import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { realpath } from 'node:fs/promises'
import { processStartedAt } from '../dist/process-control.js'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'

import { cli, fillContracts, tempRoot } from './helpers.mjs'
import {
  annotateExecution,
  cancelTaskExecution,
  finishExecutionStep,
  readExecutionEvents,
  startExecutionStep,
} from '../dist/execution-events.js'
import { cancelTask } from '../dist/task.js'
import { finishWorkActivity, runWorkCommand, startWorkActivity } from '../dist/work-activity.js'
import { buildExecutionSnapshot, compactExecutionSnapshot, MAX_EXECUTION_SNAPSHOT_BYTES } from '../dist/execution-view.js'
import { closeExecutionViewServer, executionViewStatus, startExecutionViewServer, startManagedExecutionView, stopManagedExecutionView } from '../dist/execution-view-server.js'
import { unfinishedTaskDependencies } from '../dist/project.js'

async function projectFixture(name = 'execution-view-') {
  const root = await tempRoot(name), repository = path.join(root, 'repo')
  await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-VIEW', '--name', 'Execution View', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-view')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-VIEW', '--title', 'Measure execution', '--repository', repository]).code, 0)
  return { root, repository, taskRoot }
}

test('execution events produce exact active, waiting, wall-clock and current elapsed time', async () => {
  const { root } = await projectFixture()
  const t0 = new Date('2026-08-12T08:00:00.000Z')
  const work = await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: 'Round 1 实现',
    summary: '推进本轮实现并记录准确耗时', occurredAt: t0,
  })
  const wait = await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'wait.user', wait: true, label: '等待用户确认',
    summary: '等待用户确认当前候选', occurredAt: new Date(t0.getTime() + 10_000),
  })
  await finishExecutionStep(root, wait, { outcome: 'success', occurredAt: new Date(t0.getTime() + 30_000) })
  await finishExecutionStep(root, work, { outcome: 'success', occurredAt: new Date(t0.getTime() + 50_000) })
  const running = await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'harness.execute', label: 'Agent 实现',
    summary: 'Provider 在隔离 worktree 中执行批准步骤', occurredAt: new Date(t0.getTime() + 55_000),
  })

  const snapshot = await buildExecutionSnapshot(root, new Date(t0.getTime() + 70_000))
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW')
  assert.equal(snapshot.active_task.step_id, running.step_run_id)
  assert.equal(snapshot.active_task.current_elapsed_ms, 15_000)
  assert.equal(task.wall_clock_ms, 70_000)
  assert.equal(task.waiting_ms, 20_000)
  assert.equal(task.active_ms, 15_000)
  assert.equal(task.untracked_ms, 35_000)
  assert.equal(task.timing_precision, 'exact')
  assert.deepEqual(task.depends_on, [])
  assert.equal(task.managed, true)
  assert.equal(task.bottleneck_step_id, running.step_run_id)
  assert.equal(task.round_work_ms, 50_000)
  assert.equal(task.round_detail_ms, 0)
  assert.equal(task.round_waiting_ms, 20_000)
  assert.equal(task.round_unattributed_ms, 30_000)
  assert.equal(task.recording_coverage_pct, 35_000 / 70_000 * 100)
  assert.ok(task.detail_coverage_pct > 0)
  assert.equal(task.duration_breakdown.wait_ms, 20_000)
  assert.equal(Object.values(task.duration_breakdown).reduce((sum, value) => sum + value, 0), task.wall_clock_ms)
  assert.equal(task.steps.find((item) => item.id === wait.step_run_id).round, 1)
  assert.equal(task.steps.find((item) => item.id === wait.step_run_id).precision, 'exact')

  const events = await readExecutionEvents(root)
  assert.equal(events[0].kind, 'annotation')
  assert.equal(events.at(-1).kind, 'step_started')
  assert.equal(events.every((event, index) => event.sequence === index + 1), true)
})

test('a growing Project retains every Task and active detail inside the snapshot limit', async () => {
  const { root } = await projectFixture('execution-view-project-budget-')
  await annotateExecution(root, { taskId: 'TASK-VIEW', round: 1, label: '历史进展', summary: '历史步骤', occurredAt: new Date() })
  const baseline = await buildExecutionSnapshot(root)
  const step = baseline.tasks[0].steps.at(-1)
  assert.ok(step)
  const expanded = structuredClone(baseline)
  expanded.tasks = Array.from({ length: 74 }, (_, index) => ({
    ...structuredClone(baseline.tasks[0]), task_id: `TASK-BUDGET-${index + 1}`, current: index === 0,
    steps: Array.from({ length: 20 }, (_, number) => ({ ...step, id: `STEP-${index}-${number}`, summary: '历史上下文'.repeat(45), order: number })),
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(expanded)) > MAX_EXECUTION_SNAPSHOT_BYTES)
  const bounded = compactExecutionSnapshot(expanded)
  assert.equal(bounded.tasks.length, 74)
  assert.equal(bounded.tasks[0].steps.length, 5, 'current Task keeps recent detail')
  assert.ok(bounded.tasks.slice(1).every(task => task.steps.length >= 1))
  assert.ok(bounded.tasks.some(task => task.steps.length < 5), 'older detail is compacted as the Project grows')
  assert.equal(bounded.revision, baseline.revision)
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MAX_EXECUTION_SNAPSHOT_BYTES)
})

test('cancelled tasks close active steps, freeze elapsed time, and bound Dashboard history', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-cancelled-')
  await fillContracts(taskRoot, { id: 'TASK-VIEW', title: 'Measure execution', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const startedAt = new Date('2026-09-06T00:00:00.000Z')
  await startExecutionStep(root, { taskId: 'TASK-VIEW', round: 1, stepType: 'harness.execute', label: 'Agent 实现', summary: 'active provider work', occurredAt: startedAt, detached: true })
  for (let index = 0; index < 205; index++) await annotateExecution(root, { taskId: 'TASK-VIEW', round: 1, label: `进度 ${index}`, summary: `bounded dashboard event ${index}`, occurredAt: new Date(startedAt.getTime() + index + 1) })
  const cancelledAt = new Date(Date.now() + 1_000)
  await cancelTaskExecution(root, { taskId: 'TASK-VIEW', round: 1, summary: 'user stopped task', occurredAt: cancelledAt })
  await cancelTask(taskRoot, cancelledAt)
  const first = await buildExecutionSnapshot(root, new Date(startedAt.getTime() + 20_000))
  const later = await buildExecutionSnapshot(root, new Date(startedAt.getTime() + 3_620_000))
  const task = first.tasks.find(item => item.task_id === 'TASK-VIEW')
  assert.equal(task.status, 'cancelled')
  assert.equal(task.wall_clock_ms, later.tasks.find(item => item.task_id === 'TASK-VIEW').wall_clock_ms)
  assert.equal(task.steps.length, 20)
  assert.match(task.diagnostics.join(' '), /最近 20 个步骤/)
  assert.equal(first.active_task, null)
  assert.ok(task.steps.some(step => step.status === 'cancelled'))
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= MAX_EXECUTION_SNAPSHOT_BYTES)
})

test('Dashboard distinguishes historical records and exposes bounded live role heartbeat, deadline and usage', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-runtime-')
  await fillContracts(taskRoot, { id: 'TASK-VIEW', title: 'Measure execution', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0); assert.equal(cli(['round', taskRoot]).code, 0)
  const invocationId = 'INV-TASK-VIEW-V-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', base = path.join(root, '.spec-loop', 'output', 'TASK-VIEW-acceptance-v2', 'invocations', invocationId), now = new Date('2026-09-06T08:00:00.000Z')
  await mkdir(base, { recursive: true })
  await writeFile(path.join(base, 'INVOCATION.json'), `${JSON.stringify({ invocation_id: invocationId, role: 'V', status: 'running', result_status: 'none', created_at: new Date(now.getTime() - 5_000).toISOString(), token_limit: 1000, usage: { total_tokens: 120 } }, null, 2)}\n`)
  await writeFile(path.join(base, 'HEARTBEAT.json'), `${JSON.stringify({ heartbeat_at: new Date(now.getTime() - 2_000).toISOString(), last_progress_at: new Date(now.getTime() - 3_000).toISOString(), progress_sequence: 4, output_bytes: 2048, idle_timeout_seconds: 300, deadline_at: new Date(now.getTime() + 30_000).toISOString(), usage: { total_tokens: 120 } }, null, 2)}\n`)
  const snapshot = await buildExecutionSnapshot(root, now), task = snapshot.tasks.find(item => item.task_id === 'TASK-VIEW')
  assert.equal(task.record_kind, 'current_run')
  assert.deepEqual(task.runtime, { role: 'V', invocation_id: invocationId, state: 'running', heartbeat_at: '2026-09-06T07:59:58.000Z', heartbeat_age_ms: 2000, last_progress_at: '2026-09-06T07:59:57.000Z', progress_age_ms: 3000, progress_sequence: 4, output_bytes: 2048, idle_timeout_ms: 300000, deadline_at: '2026-09-06T08:00:30.000Z', remaining_ms: 30000, usage_total_tokens: 120, token_limit: 1000 })
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_EXECUTION_SNAPSHOT_BYTES)
})

test('an open Round envelope does not become continuous active execution or a live step', async () => {
  const { root } = await projectFixture('execution-view-open-round-')
  const startedAt = new Date('2026-08-12T08:00:00.000Z')
  await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: 'Round 1 实现',
    summary: '本轮可以跨越多次人工反馈和空闲时间', occurredAt: startedAt,
  })

  const snapshot = await buildExecutionSnapshot(root, new Date(startedAt.getTime() + 8 * 24 * 60 * 60 * 1000))
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW')
  assert.equal(task.wall_clock_ms, 8 * 24 * 60 * 60 * 1000)
  assert.equal(task.round_work_ms, 8 * 24 * 60 * 60 * 1000)
  assert.equal(task.active_ms, 0)
  assert.equal(task.waiting_ms, 0)
  assert.equal(task.untracked_ms, 8 * 24 * 60 * 60 * 1000)
  assert.equal(snapshot.active_task.step_id, null)
  assert.equal(snapshot.active_task.current_elapsed_ms, null)
})

test('an unclosed detail activity from an older Round is not shown as the current live step', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-stale-detail-')
  await fillContracts(taskRoot, { id: 'TASK-VIEW', title: 'Measure execution', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const stale = await startWorkActivity(taskRoot, { kind: 'analyze', label: 'Round 1 stale detail', summary: 'legacy unclosed activity' })
  await writeFile(path.join(taskRoot, 'ROUNDS', 'ROUND-0001.md'), `---
schema_version: 1
task_id: TASK-VIEW
round: 1
status: open
---

# Round 1

## Work

Reproduce the stale activity projection.

## Changes

Record the first Round before verification.

## Outcome

Independent verification failed.
`)
  const candidate = path.join(root, 'candidate.txt')
  await writeFile(candidate, 'failed evidence\n')
  assert.equal(cli(['verify', taskRoot, '--result', 'fail', '--evidence', candidate,
    '--verifier', 'independent', '--independent', '--revision', 'a'.repeat(40)]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)

  const snapshot = await buildExecutionSnapshot(root)
  assert.equal(snapshot.active_task.round, 2)
  assert.equal(snapshot.active_task.step_id, null)
  assert.equal(snapshot.active_task.step_status, null)
  const staleStep = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW').steps.find((item) => item.id === stale.step_run_id)
  assert.equal(staleStep.status, 'interrupted')
  assert.notEqual(staleStep.ended_at, null)
  assert.equal(staleStep.precision, 'derived')
})

test('latest unclosed step wins over newer Task state and keeps concurrent work visible',async()=>{
  const {root,repository}=await projectFixture('execution-view-concurrent-active-')
  const secondRoot=path.join(root,'.spec-loop','tasks','task-second')
  assert.equal(cli(['init',secondRoot,'--level','standard','--id','TASK-SECOND','--title','Second task','--repository',repository]).code,0)
  await startExecutionStep(root,{taskId:'TASK-SECOND',round:1,stepType:'harness.execute',label:'Second task running',summary:'Older concurrent execution',occurredAt:new Date('2026-09-29T08:00:00.000Z'),detached:true})
  const latest=await startExecutionStep(root,{taskId:'TASK-VIEW',round:1,stepType:'harness.execute',label:'Current task running',summary:'Latest concurrent execution',occurredAt:new Date('2026-09-29T08:01:00.000Z'),detached:true})
  for(let index=0;index<25;index++)await annotateExecution(root,{taskId:'TASK-VIEW',round:1,label:`Later note ${index}`,summary:'Keep the live step outside the latest twenty records',occurredAt:new Date(Date.parse('2026-09-29T08:02:00.000Z')+index)})
  const snapshot=await buildExecutionSnapshot(root,new Date('2026-09-29T09:00:00.000Z'))
  assert.equal(snapshot.active_task.task_id,'TASK-VIEW')
  assert.equal(snapshot.active_task.step_id,latest.step_run_id)
  assert.deepEqual(snapshot.active_task.concurrent_task_ids,['TASK-SECOND'])
  assert.ok(snapshot.tasks.find(task=>task.task_id==='TASK-VIEW').steps.some(step=>step.id===latest.step_run_id))
})

test('Round work activities expose reproduce, analysis, change and command timings without double counting', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-activities-')
  await fillContracts(taskRoot, { id: 'TASK-VIEW', title: 'Measure execution', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const reproduce = await startWorkActivity(taskRoot, { kind: 'reproduce', label: '复现发布失败', summary: '使用固定数据复现失败路径' })
  await new Promise((resolve) => setTimeout(resolve, 15))
  await finishWorkActivity(taskRoot, reproduce.step_run_id, { outcome: 'success', summary: '稳定复现发布失败' })
  const command = await runWorkCommand(taskRoot, {
    kind: 'command', label: '定向命令', summary: '运行当前 Task 的最小检查', executable: process.execPath, args: ['-e', 'process.exit(0)'],
  })
  assert.equal(command.exitCode, 0)
  const timed=await runWorkCommand(taskRoot,{
    kind:'command',label:'有界命令',summary:'验证工作命令硬超时',executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:50,
  })
  assert.equal(timed.exitCode,124)
  assert.equal(timed.timedOut,true)
  assert.equal(timed.terminationVerified,true)

  const snapshot = await buildExecutionSnapshot(root)
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW')
  assert.ok(task.steps.some((step) => step.type === 'work.reproduce' && step.duration_ms >= 10))
  assert.ok(task.steps.some((step) => step.type === 'gate.command' && step.status === 'succeeded'))
  assert.ok(task.round_detail_ms > 0)
  assert.ok(task.round_unattributed_ms >= 0)
  assert.notEqual(task.bottleneck_step_id, task.steps.find((step) => step.type === 'round.work').id)
})

test('legacy gates retain exact duration while missing lifecycle time remains unknown', async () => {
  const { root, repository } = await projectFixture('execution-view-legacy-')
  const legacyRoot = path.join(root, '.spec-loop', 'tasks', 'task-legacy')
  assert.equal(cli(['init', legacyRoot, '--level', 'standard', '--id', 'TASK-LEGACY', '--title', 'Legacy task', '--repository', repository]).code, 0)
  const artifact = '.spec-loop/output/TASK-LEGACY-gate-build.txt'
  await writeFile(path.join(root, artifact), 'legacy gate passed\n')
  await writeFile(path.join(root, '.spec-loop', 'output', 'TASK-LEGACY-gates.json'), `${JSON.stringify([{
    schema_version: 1, task_id: 'TASK-LEGACY', id: 'build', kind: 'command', duration_ms: 12_345,
    created_at: '2026-08-01T01:00:00.000Z', exit_code: 0, timed_out: false,
    artifact, sha256: 'a'.repeat(64),
  }])}\n`)

  const snapshot = await buildExecutionSnapshot(root, new Date('2026-08-12T08:00:00.000Z'))
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-LEGACY')
  const gate = task.steps.find((item) => item.id === 'legacy-gate-build')
  assert.equal(gate.duration_ms, 12_345)
  assert.equal(gate.precision, 'exact')
  assert.equal(task.wall_clock_ms, null)
  assert.equal(task.timing_precision, 'unknown')
  assert.match(task.diagnostics.join(' '), /没有执行事件/)
})

test('target task dependencies are projected for Heavy Task DAG reconstruction', async () => {
  const { root, repository, taskRoot } = await projectFixture('execution-view-dependencies-')
  await writeFile(path.join(repository, 'TASK-VIEW.md'), '# TASK-VIEW：Measure execution\n\n- 依赖：TASK-BASE、WEB-TASK-SHELL\n')
  await writeFile(path.join(taskRoot, 'SPEC.md'), `---
schema_version: 1
task_id: TASK-VIEW
title: Measure execution
level: standard
target_spec: TASK-VIEW.md
---

# Goal

Measure execution dependencies.
`)
  const snapshot = await buildExecutionSnapshot(root)
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-VIEW').depends_on, ['TASK-BASE', 'WEB-TASK-SHELL'])
})

test('Round startup fails closed when a managed dependency is unfinished', async () => {
  const { root, repository, taskRoot } = await projectFixture('execution-view-dependency-gate-')
  const dependencyRoot = path.join(root, '.spec-loop', 'tasks', 'task-base')
  assert.equal(cli(['init', dependencyRoot, '--level', 'standard', '--id', 'TASK-BASE', '--title', 'Base task', '--repository', repository]).code, 0)
  await writeFile(path.join(repository, 'TASK-VIEW.md'), '# TASK-VIEW：Measure execution\n\n- 依赖任务：TASK-BASE\n')
  await fillContracts(taskRoot, { id: 'TASK-VIEW', title: 'Measure execution', level: 'standard' })
  await writeFile(path.join(taskRoot, 'SPEC.md'), `---
schema_version: 1
task_id: TASK-VIEW
title: Measure execution
level: standard
target_spec: TASK-VIEW.md
---

# Goal

Measure execution dependencies before starting work.
`)
  assert.equal(cli(['plan', taskRoot]).code, 0)
  const result = cli(['round', taskRoot])
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /TASK-VIEW: blocked by unfinished dependencies: TASK-BASE/)
  const snapshot = await buildExecutionSnapshot(root)
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-VIEW').blocked_by, ['TASK-BASE'])
  assert.equal(snapshot.active_task.task_id, 'TASK-BASE')
})

test('a v2 Candidate satisfies target task dependency checks even when its v1 lifecycle remains planned', async () => {
  const { root, repository, taskRoot } = await projectFixture('execution-view-v2-candidate-dependency-')
  const dependencyRoot = path.join(root, '.spec-loop', 'tasks', 'task-base')
  assert.equal(cli(['init', dependencyRoot, '--level', 'standard', '--id', 'TASK-BASE', '--title', 'Base task', '--repository', repository]).code, 0)
  await writeFile(path.join(dependencyRoot, 'ACCEPTANCE_CONTRACT_V2.md'), '---\nschema_version: 2\n---\n')
  await writeFile(path.join(dependencyRoot, 'ACCEPTANCE_RUN.json'), `${JSON.stringify({ protocol_version: 2, stage: 'candidate' }, null, 2)}\n`)
  await writeFile(path.join(repository, 'TASK-VIEW.md'), '# TASK-VIEW：Measure execution\n\n- 依赖任务：TASK-BASE\n')
  await writeFile(path.join(taskRoot, 'SPEC.md'), `---
schema_version: 1
task_id: TASK-VIEW
title: Measure execution
level: standard
target_spec: TASK-VIEW.md
---

# Goal

Treat an accepted v2 Candidate as a finished dependency.
`)
  assert.deepEqual(await unfinishedTaskDependencies(root, 'TASK-VIEW'), [])
})

test('a fresh v2 Candidate is projected as delivered instead of the stale v1 planned lifecycle', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-v2-candidate-status-')
  const contractInput = { schema_version: 2, task_id: 'TASK-VIEW' }
  const contractHash = createHash('sha256').update(JSON.stringify(contractInput)).digest('hex')
  await writeFile(path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), `---
schema_version: 2
task_id: TASK-VIEW
contract_hash: ${contractHash}
approval:
  approved_by: user
  approved_at: 2026-09-20T00:00:00.000Z
  contract_hash: ${contractHash}
---
`)
  const candidateId = 'CANDIDATE-TASK-VIEW-1', head = 'a'.repeat(40)
  await writeFile(path.join(taskRoot, 'ACCEPTANCE_RUN.json'), `${JSON.stringify({
    task_id: 'TASK-VIEW', stage: 'candidate', run_id: 'RUN-TASK-VIEW-1', contract_hash: contractHash,
    current_head: head, plan_hash: null, last_v_evidence_set_hash: null, last_r_evidence_set_hash: null,
    candidate_id: candidateId,
  }, null, 2)}\n`)
  const output = path.join(root, '.spec-loop', 'output', 'TASK-VIEW-acceptance-v2')
  await mkdir(output, { recursive: true })
  await writeFile(path.join(output, 'CANDIDATE.json'), `${JSON.stringify({
    candidate_id: candidateId, contract_hash: contractHash, plan_hash: null, head,
    v_evidence_set_hash: null, r_evidence_set_hash: null,
  }, null, 2)}\n`)

  const invocationId='INV-TASK-VIEW-V-stale',invocation=path.join(output,'invocations',invocationId)
  await mkdir(invocation,{recursive:true})
  await writeFile(path.join(invocation,'INVOCATION.json'),JSON.stringify({invocation_id:invocationId,role:'V',status:'succeeded',result_status:'awaiting_ingestion',created_at:new Date().toISOString()}))
  const startedAt=new Date(Date.now()+1_000)
  const role=await startExecutionStep(root,{taskId:'TASK-VIEW',round:1,stepType:'role.v',label:'V review',summary:'Independent verification',occurredAt:startedAt})
  await finishExecutionStep(root,role,{outcome:'success',occurredAt:new Date(startedAt.getTime()+80)})
  const candidate=await startExecutionStep(root,{taskId:'TASK-VIEW',round:1,stepType:'acceptance.candidate',label:'Candidate',summary:'V and R passed',occurredAt:new Date(startedAt.getTime()+100)})
  await finishExecutionStep(root,candidate,{outcome:'success',occurredAt:new Date(startedAt.getTime()+120)})

  const snapshot = await buildExecutionSnapshot(root,new Date(startedAt.getTime()+200))
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW')
  assert.equal(task.acceptance.fresh, true)
  assert.equal(task.status, 'delivered')
  assert.equal(task.record_kind, 'historical_runtime')
  assert.equal(task.runtime, null)
  assert.ok(task.wall_clock_ms >= 120)
  assert.ok(task.wall_clock_ms >= task.active_ms)
  assert.equal(snapshot.active_task, null)

  const holds=path.join(root,'.spec-loop/scheduler/wave-reviews/tasks');await mkdir(holds,{recursive:true})
  const hold=path.join(holds,'TASK-VIEW.json')
  const factsHash='b'.repeat(64),reviewBase={schema_version:1,wave_id:'WAVE-pending',project_id:'PROJ-VIEW',tasks:[{task_id:'TASK-VIEW',facts_hash:factsHash}]}
  const bundleHash=createHash('sha256').update(JSON.stringify(reviewBase)).digest('hex')
  await writeFile(path.join(root,'.spec-loop/scheduler/wave-reviews/WAVE-pending.json'),JSON.stringify({schema_version:1,bundle:{...reviewBase,bundle_hash:bundleHash},status:'awaiting_wave_review',decision:null}))
  await writeFile(hold,JSON.stringify({schema_version:1,task_id:'TASK-VIEW',wave_id:'WAVE-pending',bundle_hash:bundleHash,facts_hash:factsHash,status:'awaiting_wave_review'}))
  assert.equal((await buildExecutionSnapshot(root)).tasks.find(item=>item.task_id==='TASK-VIEW').status,'awaiting_wave_review')
  const decisionId='00000000-0000-4000-8000-000000000000'
  await writeFile(path.join(root,'.spec-loop/scheduler/wave-reviews/WAVE-pending.json'),JSON.stringify({schema_version:1,bundle:{...reviewBase,bundle_hash:bundleHash},status:'reviewed',decision:{request_id:decisionId,bundle_hash:bundleHash,applied:['TASK-VIEW'],choices:[{task_id:'TASK-VIEW',action:'accept'}]}}))
  await writeFile(hold,JSON.stringify({schema_version:1,task_id:'TASK-VIEW',wave_id:'WAVE-pending',bundle_hash:bundleHash,status:'accepted',decision_id:decisionId}))
  assert.equal((await buildExecutionSnapshot(root)).tasks.find(item=>item.task_id==='TASK-VIEW').status,'delivered')
})

test('target-only Heavy Tasks remain visible without fabricated execution timing', async () => {
  const { root, repository } = await projectFixture('execution-view-target-only-')
  const taskDir = path.join(repository, 'spec', '04-task')
  await mkdir(taskDir, { recursive: true })
  await writeFile(path.join(taskDir, 'TASK-200.md'), `# TASK-200：H14 Heavy\n\n- 状态：已完成\n- 最后更新：2026-08-12\n- 依赖工单：TASK-190～192、WEB-TASK-040～041\n\n## 验证范围\n\n唯一 Heavy。\n`)
  const snapshot = await buildExecutionSnapshot(root)
  const task = snapshot.tasks.find((item) => item.task_id === 'TASK-200')
  assert.equal(task.managed, false)
  assert.equal(task.level, 'heavy')
  assert.equal(task.status, 'delivered')
  assert.deepEqual(task.depends_on, ['TASK-190', 'TASK-191', 'TASK-192', 'WEB-TASK-040', 'WEB-TASK-041'])
  assert.equal(task.wall_clock_ms, null)
  assert.deepEqual(task.steps, [])
})

test('H wave overview expands past H15 without leaking later maintenance tasks into a wave', async () => {
  const { root, repository } = await projectFixture('execution-view-waves-')
  const specRoot = path.join(repository, 'spec'), taskDir = path.join(specRoot, '04-task'), featureDir = path.join(specRoot, '02-feature')
  await mkdir(taskDir, { recursive: true })
  await mkdir(featureDir, { recursive: true })
  await writeFile(path.join(specRoot, 'roadmap.md'), `| 阶段 | 目标 | 范围 | 规格 | 状态 |\n|---|---|---|---|---|\n| H1 基线加固 | 稳定基线 | 完成第一批能力 | FEAT-001 | 已完成 |\n| H11 入口安全 | 安全登录 | 登录与 MFA | FEAT-011 | 已完成 |\n| H17 BOM 闭环 | 多层 BOM | BOM 易用性与来源闭环 | FEAT-017 | 进行中 |\n`)
  await writeFile(path.join(specRoot, 'wave-task-status.md'), `## H1：基线加固\n\n所属 Feature：FEAT-001\n\n| Task | 类型 | 内容 | 状态 |\n|---|---|---|---|\n| [TASK-001](04-task/TASK-001.md) | Backend | 基础能力 | 已完成 |\n| [TASK-002](04-task/TASK-002.md) | Heavy | 最终收口 | 已完成 |\n\n## H17：BOM 闭环\n\n所属 Feature：FEAT-017\n\n| Task | 类型 | 内容 | 状态 |\n|---|---|---|---|\n| [WEB-TASK-017](04-task/WEB-TASK-017.md) | Web | 多层 BOM 工作台 | 进行中 |\n\n## 持续维护\n\n| [TASK-099](04-task/TASK-099.md) | Backend | 不属于 H1 | 已完成 |\n`)
  await writeFile(path.join(featureDir, 'FEAT-011-entry-security.md'), '# FEAT-011：入口安全\n\n- 工单：TASK-011～TASK-012、WEB-TASK-011\n')
  for (const id of ['TASK-001', 'TASK-002', 'TASK-011', 'TASK-012', 'WEB-TASK-011', 'WEB-TASK-017', 'TASK-099']) {
    const status = id === 'TASK-011' ? '待验证' : id === 'WEB-TASK-017' ? '进行中' : '已完成'
    await writeFile(path.join(taskDir, `${id}.md`), `# ${id}：${id} work\n\n- 状态：${status}\n- 最后更新：2026-08-12\n${id === 'TASK-002' ? '- 风险等级：heavy\n' : ''}`)
  }
  const snapshot = await buildExecutionSnapshot(root)
  assert.equal(snapshot.waves.length, 17)
  assert.deepEqual(snapshot.waves.map((wave) => wave.wave_id), Array.from({ length: 17 }, (_, index) => `H${index + 1}`))
  assert.deepEqual(snapshot.waves.find((wave) => wave.wave_id === 'H1').task_ids, ['TASK-001', 'TASK-002'])
  assert.deepEqual(snapshot.waves.find((wave) => wave.wave_id === 'H1').heavy_task_ids, ['TASK-002'])
  assert.deepEqual(snapshot.waves.find((wave) => wave.wave_id === 'H11').task_ids, ['TASK-011', 'TASK-012', 'WEB-TASK-011'])
  assert.equal(snapshot.waves.find((wave) => wave.wave_id === 'H11').declared_status, 'delivered')
  assert.equal(snapshot.waves.find((wave) => wave.wave_id === 'H11').status, 'verifying')
  assert.deepEqual(snapshot.waves.find((wave) => wave.wave_id === 'H11').unfinished_task_ids, ['TASK-011'])
  assert.deepEqual(snapshot.waves.find((wave) => wave.wave_id === 'H17').task_ids, ['WEB-TASK-017'])
  assert.equal(snapshot.waves.find((wave) => wave.wave_id === 'H17').status, 'working')
  assert.match(snapshot.diagnostics.join(' '), /H11.*路线图标记已完成.*TASK-011/)
  assert.match(snapshot.diagnostics.join(' '), /TASK-VIEW.*未归属任何波次/)
})

test('operational WQ waves preserve dependency order and block tasks whose prerequisites are unfinished', async () => {
  const { root, repository } = await projectFixture('execution-view-operational-wave-')
  const specRoot = path.join(repository, 'spec'), taskDir = path.join(specRoot, '04-task')
  await mkdir(taskDir, { recursive: true })
  await writeFile(path.join(specRoot, 'wave-task-status.md'), `# BATCH-001：运行可靠性与策略评估

- 状态：进行中，Wave 1 基线门已解除
- Spec-Loop Wave ID：\`WQ-RUNTIME-1\`

## 批次目标

按依赖顺序完成运行修复和最终 Heavy 收口。

## 依赖图与执行波次

| 波次 | Task | 可并行 | 启动条件 | 当前引擎状态 |
|---|---|---|---|---|
| Gate 0 | TASK-005 | 否 | 已批准 | 已完成 |
| Wave 1 | TASK-006、TASK-007 | 是 | TASK-005 完成 | 进行中 |
| Wave 2 | TASK-008 | 否 | TASK-006、TASK-007 完成 | 已进入控制面 |
| Wave 3 | TASK-009 | 否 | TASK-007、TASK-008 完成 | 已进入控制面 |
| Wave 4 | TASK-010 | 否 | TASK-005～010 顺序收口 | 已进入控制面 |
`)
  const definitions = [
    ['TASK-005', '已完成', '无'], ['TASK-006', '进行中', 'TASK-005'], ['TASK-007', '进行中', 'TASK-005'],
    ['TASK-008', '进行中', 'TASK-006、TASK-007'], ['TASK-009', '进行中', 'TASK-007、TASK-008'],
    ['TASK-010', '进行中', 'TASK-005～009'],
  ]
  for (const [id, status, dependency] of definitions) {
    await writeFile(path.join(taskDir, `${id}.md`), `# ${id}：${id} work\n\n- 状态：${status}\n- 最后更新：2026-08-21\n- 依赖任务：${dependency}\n${id === 'TASK-010' ? '- 风险等级：heavy\n' : ''}`)
  }

  const snapshot = await buildExecutionSnapshot(root)
  const wave = snapshot.waves.find((item) => item.wave_id === 'WQ-RUNTIME-1')
  assert.deepEqual(wave.task_ids, ['TASK-005', 'TASK-006', 'TASK-007', 'TASK-008', 'TASK-009', 'TASK-010'])
  assert.deepEqual(wave.heavy_task_ids, ['TASK-010'])
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-006').blocked_by, [])
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-007').blocked_by, [])
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-008').blocked_by, ['TASK-006', 'TASK-007'])
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-009').blocked_by, ['TASK-007', 'TASK-008'])
  assert.deepEqual(snapshot.tasks.find((task) => task.task_id === 'TASK-010').blocked_by, ['TASK-006', 'TASK-007', 'TASK-008', 'TASK-009'])
  assert.match(snapshot.diagnostics.join(' '), /TASK-008.*等待依赖/)
})

test('clock-only growth does not change the snapshot revision or force a full UI redraw', async () => {
  const { root, repository } = await projectFixture('execution-view-stable-revision-')
  const specRoot = path.join(repository, 'spec')
  await mkdir(specRoot, { recursive: true })
  await writeFile(path.join(specRoot, 'roadmap.md'), `| 阶段 | 标题 | 目标 | 规格 | 状态 |\n|---|---|---|---|---|\n| H1 当前波次 | 当前波次 | 验证稳定刷新 | FEAT-001 | 进行中 |\n`)
  await writeFile(path.join(specRoot, 'wave-task-status.md'), `## H1：当前波次\n\n| Task | 类型 | 内容 | 状态 |\n|---|---|---|---|\n| TASK-VIEW | Standard | Measure execution | 进行中 |\n`)
  await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: 'Round 1 实现',
    summary: '验证时钟增长不会改变事实 revision', occurredAt: new Date('2026-08-20T01:59:00.000Z'),
  })
  const first = await buildExecutionSnapshot(root, new Date('2026-08-20T02:00:00.000Z'))
  const second = await buildExecutionSnapshot(root, new Date('2026-08-20T02:00:10.000Z'))
  assert.notEqual(first.waves[0].task_wall_clock_ms, second.waves[0].task_wall_clock_ms)
  assert.equal(first.revision, second.revision)
})

test('event tampering and secret-bearing summaries fail closed', async () => {
  const { root } = await projectFixture('execution-view-security-')
  await assert.rejects(startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: 'Unsafe step',
    summary: 'token=abcdefghijk should never be stored',
  }), /possible secret/)
  await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: 'Safe step', summary: 'Record safe execution facts',
  })
  const file = path.join(root, '.spec-loop', 'EXECUTION_EVENTS.jsonl'), lines = (await readFile(file, 'utf8')).trim().split('\n')
  const event = JSON.parse(lines[1]); event.summary = 'tampered summary'; lines[1] = JSON.stringify(event)
  await writeFile(file, `${lines.join('\n')}\n`)
  await assert.rejects(readExecutionEvents(root), /event hash mismatch/)
  await assert.rejects(buildExecutionSnapshot(root), /event hash mismatch/)
})

test('concurrent writers keep a continuous hash chain and dead bounded steps become interrupted', async () => {
  const { root } = await projectFixture('execution-view-concurrency-')
  await Promise.all(Array.from({ length: 12 }, (_, index) => startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: `Parallel observation ${index + 1}`,
    summary: `Record concurrent observation ${index + 1}`,
  })))
  let events = await readExecutionEvents(root)
  assert.equal(events.length, 13)
  assert.equal(events.every((event, index) => event.sequence === index + 1), true)

  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { startExecutionStep } from './dist/execution-events.js'
    await startExecutionStep(process.argv[1], {
      taskId: 'TASK-VIEW', round: 1, stepType: 'harness.execute', label: 'Child execution',
      summary: 'Bounded child process exits before closing this step'
    })
  `, root], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  events = await readExecutionEvents(root)
  const childStart = events.at(-1)
  const snapshot = await buildExecutionSnapshot(root)
  const step = snapshot.tasks.find((item) => item.task_id === 'TASK-VIEW').steps.find((item) => item.id === childStart.step_run_id)
  assert.equal(step.status, 'interrupted')
  assert.equal(step.precision, 'derived')
  assert.equal(step.duration_ms, null)
})

test('local execution view is loopback-only, read-only and supports stable ETags', async () => {
  const { root } = await projectFixture('execution-view-http-')
  const childRoot = path.join(root, 'projects', 'child-project'), childRepository = path.join(childRoot, 'repo')
  await mkdir(childRepository, { recursive: true })
  assert.equal(cli(['project', 'init', childRoot, '--id', 'PROJ-CHILD', '--name', 'Child Project', '--repository', childRepository]).code, 0)
  await symlink(childRoot, path.join(root, 'projects', 'aliased-project'))
  await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'harness.execute', label: 'Agent 实现', summary: 'Execute the approved local step',
  })
  const { server, url } = await startExecutionViewServer(root)
  try {
    const address = server.address()
    assert.equal(typeof address, 'object')
    assert.equal(address.address, '127.0.0.1')
    const page = await fetch(url)
    assert.equal(page.status, 200)
    const html = await page.text()
    const controlsSource = await readFile(new URL('../assets/execution-view/controls.jsx', import.meta.url), 'utf8')
    assert.match(html, /id="execution-view"/)
    assert.match(controlsSource, /正在定位当前波次/)
    assert.match(controlsSource, /当前波次 Task 执行图/)
    assert.match(controlsSource, /id="workflow-controls"/)
    assert.match(controlsSource, /id="task-controls"/)
    assert.match(controlsSource, /id="project-controls"/)
    assert.match(controlsSource, /id="wave-list"/)
    assert.match(controlsSource, /完整波次明细/)
    assert.match(controlsSource, /AIRFLOW OVERVIEW/)
    assert.match(controlsSource, /id="global-overview-control"/)
    assert.match(html, /\/controls\.js/)
    assert.doesNotMatch(html, /<(?:select|button)\b/)
    assert.match(controlsSource, /生命周期构成/)
    assert.match(controlsSource, /生命周期跨度/)
    assert.match(controlsSource, /不能相加为工时/)
    assert.match(controlsSource, /未归因 \/ 空闲/)
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
    assert.match(page.headers.get('content-security-policy'), /style-src 'self' 'nonce-/)
    const app = await (await fetch(new URL('/app.js', url))).text()
    assert.doesNotThrow(() => new Script(app))
    assert.doesNotMatch(app, /innerHTML|outerHTML|document\.write/)
    assert.match(app, /事实无变化/)
    assert.match(app, /workflowStages/)
    assert.match(app, /workflowEdges/)
    assert.match(app, /Task 内部步骤有向无环执行图/)
    assert.match(app, /renderPortfolioWorkflow/)
    assert.match(app, /renderFocusedWaveWorkflow/)
    assert.match(app, /renderWaveSidebar/)
    assert.match(app, /patchWaveSidebar/)
    assert.match(app, /波次执行图/)
    assert.match(app, /reducedWaveGraph/)
    assert.match(app, /elkWaveLayout/)
    assert.match(app, /roundedOrthogonalPath/)
    assert.match(app, /renderInlineTaskDetail/)
    assert.match(app, /分层时间线/)
    assert.match(app, /耗时构成/)
    assert.match(app, /执行结论/)
    assert.match(app, /taskMatchesFilter/)
    assert.match(app, /renderTaskWaveSelector/)
    assert.match(app, /patchLiveView/)
    assert.match(app, /snapshotStructureSignature/)
    assert.match(app, /tickLiveNumbers/)
    assert.match(app, /未归属波次/)
    assert.match(app, /等待依赖/)
    assert.match(app, /空白画布已隐藏/)
    assert.match(app, /timeRange\(step\)/)
    assert.match(app, /appendLaneArrowDefinitions/)
    assert.match(app, /data-edge-from/)
    assert.match(app, /workflow-breadcrumb/)
    assert.match(app, /本次刷新失败/)
    assert.match(app, /function callAntd/)
    assert.match(app, /label: project\.name/)
    assert.doesNotMatch(app, /label: `\$\{project\.name\} · \$\{project\.project_id\}`/)
    assert.match(app, /spec-loop:antd-ready/)
    assert.doesNotMatch(app, /window\.ExecutionAntd\.(?:mount|update)/)
    const style = await (await fetch(new URL('/style.css', url))).text()
    assert.match(style, /@keyframes active-node/)
    assert.match(style, /@keyframes dag-flow/)
    assert.match(style, /task-node/)
    assert.match(style, /wave-lane/)
    assert.match(style, /antd-wave-item/)
    assert.match(style, /antd-global-overview/)
    assert.match(app, /updateWaveMenu/)
    assert.match(app, /globalTaskStatusSummary/)
    assert.match(app, /function defaultWave/)
    assert.match(style, /antd-global-grid/)
    assert.match(style, /execution-shell/)
    assert.match(style, /inline-task-detail/)
    assert.match(style, /lane-arrow-head/)
    assert.match(style, /lane-edge\.highlight/)
    assert.match(style, /@media \(prefers-reduced-motion: reduce\)/)
    assert.doesNotMatch(style, /\.segmented button/)
    const controls = await (await fetch(new URL('/controls.js', url))).text()
    assert.match(controls, /ExecutionAntd/)
    assert.match(controlsSource, /from 'antd'/)
    assert.match(controlsSource, /当前执行位置/)
    assert.doesNotMatch(controlsSource, /state\.projectId/)
    assert.match(controlsSource, /task-filter-change/)
    assert.match(controlsSource, /project-change/)
    assert.match(controlsSource, /<Select/)
    assert.match(controlsSource, /<Segmented/)
    assert.match(controlsSource, /<Card/)
    assert.match(controlsSource, /<Menu/)
    assert.match(controlsSource, /<Progress/)
    assert.match(controlsSource, /<Statistic/)
    assert.match(controlsSource, /<Layout/)
    assert.match(controlsSource, /<Sider/)
    assert.match(controlsSource, /<Timeline/)
    assert.match(controlsSource, /<Descriptions/)
    assert.match(controlsSource, /<Spin/)
    assert.ok(controlsSource.indexOf('window.ExecutionAntd =') < controlsSource.indexOf('flushSync(() => executionViewRoot.render'))
    assert.equal((await fetch(new URL('/controls.css', url))).status, 200)
    const elk = await fetch(new URL('/vendor/elk.bundled.js', url))
    assert.equal(elk.status, 200)
    assert.match(elk.headers.get('content-type'), /javascript/)

    const catalogResponse = await fetch(new URL('/api/projects', url))
    assert.equal(catalogResponse.status, 200)
    const catalog = await catalogResponse.json()
    assert.equal(catalog.default_project, 'root')
    assert.deepEqual(catalog.projects.map((project) => project.key), ['root', 'project:child-project'])
    assert.equal((await fetch(new URL('/api/snapshot?project=project%3Aaliased-project', url))).status, 404)
    assert.deepEqual(catalog.projects.map((project) => project.project_id), ['PROJ-VIEW', 'PROJ-CHILD'])
    const childSnapshot = await (await fetch(new URL('/api/snapshot?project=project%3Achild-project', url))).json()
    assert.equal(childSnapshot.project.project_id, 'PROJ-CHILD')
    assert.equal((await fetch(new URL('/api/snapshot?project=..%2Fsecret', url))).status, 404)
    assert.equal((await fetch(new URL('/api/projects?path=secret', url))).status, 400)

    const first = await fetch(new URL('/api/snapshot', url))
    assert.equal(first.status, 200)
    const etag = first.headers.get('etag'), snapshot = await first.json()
    assert.equal(snapshot.project.project_id, 'PROJ-VIEW')
    const second = await fetch(new URL('/api/snapshot', url), { headers: { 'If-None-Match': etag } })
    assert.equal(second.status, 304)
    assert.equal((await fetch(new URL('/api/snapshot', url), { method: 'POST' })).status, 405)
    assert.equal((await fetch(new URL('/..%2f..%2fetc%2fpasswd', url))).status, 404)
  } finally {
    await closeExecutionViewServer(server)
  }
})

test('background execution view lifecycle is idempotent and rejects stale process markers', async () => {
  const { root } = await projectFixture('execution-view-lifecycle-')
  let marker
  try {
    const started=Date.now()
    marker = await startManagedExecutionView(root,0,{timeoutMs:4500})
    assert.ok(Date.now()-started<5000,'interactive view starts within five seconds')
    assert.match(marker.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const reused = await startManagedExecutionView(root)
    assert.equal(reused.pid, marker.pid)
    assert.equal(reused.process_started_at, marker.process_started_at)
    assert.equal((await executionViewStatus(root)).running, true)
    assert.equal((await stopManagedExecutionView(root)).stopped, true)
    assert.equal((await executionViewStatus(root)).running, false)
  } finally {
    if ((await executionViewStatus(root).catch(() => ({ running: false }))).running) await stopManagedExecutionView(root)
  }
})

test('occupied view port does not leave a live marker or block a later start',async()=>{
  const {root}=await projectFixture('execution-view-port-conflict-'),occupied=createServer(()=>{})
  await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve))
  try{
    await assert.rejects(startManagedExecutionView(root,occupied.address().port,{timeoutMs:1500}),/did not become healthy/)
    assert.equal((await executionViewStatus(root)).running,false)
    const marker=await startManagedExecutionView(root,0,{timeoutMs:4500})
    assert.match(marker.url,/^http:\/\/127\.0\.0\.1:\d+\/$/)
    assert.equal((await stopManagedExecutionView(root)).stopped,true)
  }finally{
    await closeExecutionViewServer(occupied)
    if((await executionViewStatus(root).catch(()=>({running:false}))).running)await stopManagedExecutionView(root)
  }
})

test('a living slow dashboard keeps its owner marker and is not started twice',async()=>{
  const {root}=await projectFixture('execution-view-slow-'),server=createServer(()=>{})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try{
    const marker={schema_version:1,project_root:await realpath(root),pid:process.pid,process_started_at:await processStartedAt(process.pid),url:`http://127.0.0.1:${server.address().port}/`,started_at:new Date().toISOString()},file=path.join(root,'.spec-loop','execution-view.json')
    await writeFile(file,JSON.stringify(marker))
    const status=await executionViewStatus(root);assert.equal(status.running,true);assert.equal(status.reason,'unhealthy')
    assert.deepEqual(await startManagedExecutionView(root),marker)
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),marker)
  }finally{await closeExecutionViewServer(server)}
})

test('dashboard shutdown bounds requests that never finish',async()=>{
  const server=createServer(()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const pending=fetch(`http://127.0.0.1:${server.address().port}/`,{signal:AbortSignal.timeout(5000)}).catch(()=>null)
  await new Promise(resolve=>setTimeout(resolve,50))
  const began=Date.now();await closeExecutionViewServer(server);assert.ok(Date.now()-began<2000);assert.equal(await pending,null)
})

test('verified event cache isolates callers, handles appended history and still rejects rewritten prefixes',async()=>{
  const {root}=await projectFixture('execution-events-cache-')
  const start=await startExecutionStep(root,{taskId:'TASK-VIEW',round:1,stepType:'task.attempt',label:'缓存校验开始',summary:'验证追加与调用方隔离'})
  const first=await readExecutionEvents(root),expected=first[0].summary;first[0].summary='caller mutation'
  assert.equal((await readExecutionEvents(root))[0].summary,expected)
  await finishExecutionStep(root,start,{outcome:'success',summary:'追加终态后验证完整链'})
  const updated=await readExecutionEvents(root);assert.equal(updated.length,first.length+1)
  assert.equal(updated.at(-1).outcome,'success')
  const file=path.join(root,'.spec-loop','EXECUTION_EVENTS.jsonl'),raw=await readFile(file,'utf8'),tampered=JSON.parse(raw.split('\n')[0]);tampered.summary='modified cached prefix'
  await writeFile(file,JSON.stringify(tampered)+'\n'+raw.split('\n').slice(1).join('\n'))
  await assert.rejects(readExecutionEvents(root),/hash mismatch/)
})

test('snapshot task state cache rejects changed authority history',async()=>{
  const {root,taskRoot}=await projectFixture('execution-view-state-cache-')
  await buildExecutionSnapshot(root)
  await buildExecutionSnapshot(root)
  const file=path.join(taskRoot,'STATE_HISTORY.jsonl'),raw=await readFile(file,'utf8')
  const lines=raw.trim().split('\n'),tail=JSON.parse(lines.at(-1))
  tail.state_hash='0'.repeat(64)
  lines[lines.length-1]=JSON.stringify(tail)
  await writeFile(file,`${lines.join('\n')}\n`)
  await assert.rejects(buildExecutionSnapshot(root),/does not match CLI state history/)
})

test('deleting a disposable UI snapshot preserves canonical facts and cold rebuild', async () => {
  const { root, taskRoot } = await projectFixture('execution-view-cache-rebuild-')
  await startExecutionStep(root, {
    taskId: 'TASK-VIEW', round: 1, stepType: 'round.work', label: '缓存重建',
    summary: '仅从权威文件重建页面', occurredAt: new Date('2026-09-30T09:00:00.000Z'),
  })
  const now = '2026-09-30T09:00:10.000Z'
  const authorityFiles = [
    path.join(root, '.spec-loop', 'PROJECT.md'),
    path.join(root, '.spec-loop', 'EXECUTION_EVENTS.jsonl'),
    path.join(taskRoot, 'TASK_STATE.md'),
    path.join(taskRoot, 'STATE_HISTORY.jsonl'),
  ]
  const before = await Promise.all(authorityFiles.map(file => readFile(file)))
  const expected = await buildExecutionSnapshot(root, new Date(now))
  const cacheDir = path.join(root, '.spec-loop', 'cache')
  await mkdir(cacheDir)
  await writeFile(path.join(cacheDir, 'execution-snapshot.json'), '{"untrusted":"stale"}\n')
  await rm(cacheDir, { recursive: true })
  const cold = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    'import {buildExecutionSnapshot} from "./dist/execution-view.js"; console.log(JSON.stringify(await buildExecutionSnapshot(process.argv[1], new Date(process.argv[2]))))',
    root, now,
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(cold.status, 0, cold.stderr)
  assert.deepEqual(JSON.parse(cold.stdout), expected)
  assert.deepEqual(await Promise.all(authorityFiles.map(file => readFile(file))), before)
})

test('event cache does not treat an append after an unterminated line as a valid event',async()=>{
  const {root}=await projectFixture('execution-events-boundary-')
  const start=await startExecutionStep(root,{taskId:'TASK-VIEW',round:1,stepType:'task.attempt',label:'边界校验开始',summary:'检测缺少换行的追加'})
  const file=path.join(root,'.spec-loop','EXECUTION_EVENTS.jsonl')
  const unterminated=(await readFile(file,'utf8')).trimEnd()
  await writeFile(file,unterminated)
  await readExecutionEvents(root)
  await finishExecutionStep(root,start,{outcome:'success',summary:'生成合法终态作为追加样本'})
  const terminal=(await readFile(file,'utf8')).trimEnd().split('\n').at(-1)
  await writeFile(file,`${unterminated}${terminal}\n`)
  await assert.rejects(readExecutionEvents(root),/malformed JSON/)
})
