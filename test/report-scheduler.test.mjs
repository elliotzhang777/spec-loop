import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'

import { cli, tempRoot, writeMd } from './helpers.mjs'
import { runReportScheduler, setReportSchedulerPaused } from '../dist/report-scheduler.js'
import { annotateExecution } from '../dist/execution-events.js'
import { buildExecutionSnapshot } from '../dist/execution-view.js'
import { acquireOwnedDirectoryLock } from '../dist/owned-lock.js'
import { createWaveReview } from '../dist/wave-review.js'
import { approvedAcceptanceContractValue } from '../dist/acceptance-loop.js'

async function taskFingerprint(root) {
  const files = []
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else files.push([path.relative(root, file), await readFile(file, 'utf8')]) } }
  await walk(root); return JSON.stringify(files.sort(([left], [right]) => left.localeCompare(right)))
}

async function fixture(projectId = 'PROJ-REPORT', taskId = 'TASK-REPORT-1') {
  const root = await tempRoot('scheduler-report-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', projectId, '--name', 'Report only', '--repository', repository]).code, 0)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved project review', '--goal', 'Report task readiness', '--reason', 'Need scheduler facts', '--ac', 'report is deterministic'])
  assert.equal(proposal.code, 0, proposal.stderr); assert.equal(cli(['triage', 'approve', root, proposal.stdout.trim(), '--by', 'owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', root, proposal.stdout.trim(), '--id', taskId, '--title', 'Report readiness']).code, 0)
  return { root, taskRoot: path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase()) }
}

test('report-only scheduler is canonical, measurable, read-only to Tasks, and fail closed', async () => {
  const f = await fixture(), before = await taskFingerprint(f.taskRoot)
  for(let index=0;index<21;index++)await annotateExecution(f.root,{taskId:'TASK-REPORT-1',round:0,label:'历史进展',summary:`完整执行事实 ${index}`})
  assert.match((await buildExecutionSnapshot(f.root)).diagnostics.join('\n'),/最近 20 个步骤/)
  const first = await runReportScheduler(f.root), second = await runReportScheduler(f.root)
  assert.equal(first.metrics.missing_data,0,'bounded Dashboard history is not missing source data')
  assert.equal(first.suggestions.length, 1)
  assert.equal(first.suggestions[0].source, 'project-task:TASK-REPORT-1')
  assert.equal(first.suggestions[0].risk, 'standard')
  assert.equal(first.suggestions[0].estimated_cost, 3)
  assert.equal(second.canonical_report_hash, first.canonical_report_hash)
  assert.equal(second.equivalent_to_previous, true)
  assert.equal(second.full_scan, false)
  assert.equal(await taskFingerprint(f.taskRoot), before)

  const cursorPath = path.join(f.root, '.spec-loop', 'output', 'scheduler-cursor.json')
  const cursor = JSON.parse(await readFile(cursorPath, 'utf8'))
  await writeFile(cursorPath, `${JSON.stringify({ ...cursor, scanned_at: new Date(0).toISOString() })}\n`)
  const expired = await runReportScheduler(f.root)
  assert.equal(expired.full_scan, true)
  assert.equal(expired.canonical_report_hash, first.canonical_report_hash)

  const other = await fixture('PROJ-REPORT-B', 'TASK-REPORT-2')
  const otherReport = await runReportScheduler(other.root)
  assert.equal(otherReport.project_id, 'PROJ-REPORT-B')
  assert.deepEqual(otherReport.suggestions.map(item => item.task_id), ['TASK-REPORT-2'])
  await writeFile(path.join(other.root, '.spec-loop', 'output', 'scheduler-cursor.json'), await readFile(cursorPath))
  await assert.rejects(runReportScheduler(other.root), /different Project/)

  await writeFile(path.join(f.root, '.spec-loop', 'SCHEDULER_FEEDBACK.json'), `${JSON.stringify({ schema_version: 1, items: [{ dedupe_key: first.suggestions[0].dedupe_key, disposition: 'adopted' }] }, null, 2)}\n`)
  const measured = await runReportScheduler(f.root)
  assert.equal(measured.metrics.adopted, 1)
  assert.equal(measured.metrics.adoption_rate, 1)

  const feedbackPath = path.join(f.root, '.spec-loop', 'SCHEDULER_FEEDBACK.json')
  const feedback = JSON.parse(await readFile(feedbackPath, 'utf8'))
  await writeFile(feedbackPath, `${JSON.stringify({ ...feedback, prompt: 'private fixture text' })}\n`)
  await assert.rejects(runReportScheduler(f.root), /unrecognized|invalid/i)
  await writeFile(feedbackPath, `${JSON.stringify(feedback)}\n`)

  const scanLock = await acquireOwnedDirectoryLock(path.join(f.root, '.spec-loop', 'scheduler-report.lock'), { name: 'test scan', maxWaitMs: 0 })
  const pendingPause = setReportSchedulerPaused(f.root, true)
  await assert.rejects(runReportScheduler(f.root), /already running/)
  await scanLock.release()
  await pendingPause
  await assert.rejects(runReportScheduler(f.root), /paused/)

  assert.equal(cli(['scheduler', 'resume', f.root]).code, 0)

  const lock = path.join(f.root, '.spec-loop', 'scheduler-report.lock'); await mkdir(lock)
  await assert.rejects(runReportScheduler(f.root), /already running/)
  await rm(lock, { recursive: true })

  await mkdir(lock)
  await writeFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: 99999999, process_started_at: 'stale-owner', created_at: new Date(0).toISOString() })}\n`)
  const recovered = await runReportScheduler(f.root)
  assert.equal(recovered.suggestions.length, 1)

  await writeFile(path.join(f.root, '.spec-loop', 'output', 'scheduler-cursor.json'), '{"schema_version":1,"corrupt":true}\n')
  await assert.rejects(runReportScheduler(f.root), /cursor is invalid/)
  assert.equal(await taskFingerprint(f.taskRoot), before)
})

test('report-only keeps nonterminal v1 tasks visible without calling them dispatch ready', async () => {
  const f = await fixture('PROJ-V1-REPORT', 'TASK-V1-REPORT')
  await writeMd(path.join(f.taskRoot, 'PLAN.md'), {
    schema_version: 1, task_id: 'TASK-V1-REPORT', version: 1, ac_coverage: ['AC-1'],
  }, '# Plan\n\nExercise report-only readiness throughout the v1 lifecycle.')
  async function assertNotReady(stage) {
    const report = await runReportScheduler(f.root)
    assert.equal(report.suggestions.length, 1)
    assert.equal(report.suggestions[0].protocol, 'v1')
    assert.equal(report.suggestions[0].stage, stage)
    assert.equal(report.suggestions[0].ready, false)
    assert.equal(report.suggestions[0].reason, 'v1 task requires manual compatibility workflow')
  }
  const planned = cli(['plan', f.taskRoot])
  assert.equal(planned.code, 0, planned.stderr)
  await assertNotReady('planned')

  const started = cli(['round', f.taskRoot])
  assert.equal(started.code, 0, started.stderr)
  await assertNotReady('working')

  await writeMd(path.join(f.taskRoot, 'ROUNDS', 'ROUND-0001.md'), {
    schema_version: 1, task_id: 'TASK-V1-REPORT', round: 1, status: 'open',
  }, '# Round 1\n\n## Work\n\nExercise v1 report visibility.\n\n## Changes\n\nRecord the lifecycle transition.\n\n## Outcome\n\nThe task remains visible and cannot be dispatched automatically.')

  const evidence = path.join(f.root, 'verification-evidence.txt')
  await writeFile(evidence, 'Fixture verification evidence.\n')
  const verified = cli(['verify', f.taskRoot, '--result', 'pass', '--evidence', evidence, '--verifier', 'fixture-verifier', '--revision', 'fixture-revision'])
  assert.equal(verified.code, 0, verified.stderr)
  await assertNotReady('verifying')

  const iterated = cli(['verify', f.taskRoot, '--result', 'fail', '--evidence', evidence, '--verifier', 'fixture-verifier', '--revision', 'fixture-revision'])
  assert.equal(iterated.code, 0, iterated.stderr)
  await assertNotReady('iterating')
})

test('report-only rejects private source text and duplicate feedback without publishing false metrics', async () => {
  const f = await fixture('PROJ-PRIVATE-REPORT', 'TASK-PRIVATE-1')
  const contractPath = path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md')
  const privateText = 'PRIVATE_CUSTOMER_RELEASE_CODE_42'
  await writeFile(contractPath, `---\nschema_version: 2\ndepends_on:\n  - ${privateText}\n---\n`)
  const invalid = await runReportScheduler(f.root)
  assert.equal(invalid.suggestions[0].reason, 'invalid v2 contract dependencies')
  assert.equal(invalid.metrics.missing_data, 1)
  assert.equal(JSON.stringify(invalid).includes(privateText), false)

  await writeFile(contractPath, '---\nschema_version: 2\ndepends_on:\n  - TASK-OTHER-PROJECT-1\n---\n')
  const foreign = await runReportScheduler(f.root)
  assert.equal(foreign.suggestions[0].reason, 'unknown v2 contract dependency')
  assert.equal(JSON.stringify(foreign).includes('TASK-OTHER-PROJECT-1'), false)

  await rm(contractPath)
  const runPath = path.join(f.taskRoot, 'ACCEPTANCE_RUN.json')
  await writeFile(runPath, `${JSON.stringify({ protocol_version: 2, stage: privateText, active_conflict_id: privateText })}\n`)
  const invalidRun = await runReportScheduler(f.root)
  assert.equal(invalidRun.suggestions[0].reason, 'invalid v2 run')
  assert.equal(invalidRun.metrics.missing_data, 1)
  assert.equal(JSON.stringify(invalidRun).includes(privateText), false)
  await rm(runPath)

  const valid = await runReportScheduler(f.root)
  const reportPath = path.join(f.root, '.spec-loop', 'output', 'scheduler-report.json')
  const before = await readFile(reportPath, 'utf8')
  const feedbackPath = path.join(f.root, '.spec-loop', 'SCHEDULER_FEEDBACK.json')
  await writeFile(feedbackPath, `${JSON.stringify({ schema_version: 1, items: [
    { dedupe_key: valid.suggestions[0].dedupe_key, disposition: 'adopted' },
    { dedupe_key: valid.suggestions[0].dedupe_key, disposition: 'false_positive' },
  ] })}\n`)
  await assert.rejects(runReportScheduler(f.root), /duplicate feedback dedupe_key/)
  assert.equal(await readFile(reportPath, 'utf8'), before)
})

test('damaged wave-review holds fail closed and valid holds use a generic report reason', async () => {
  const f = await fixture('PROJ-REVIEW-HOLD', 'TASK-HOLD-1')
  const contract = approvedAcceptanceContractValue({
    schema_version: 2, task_id: 'TASK-HOLD-1', version: 1, risk: 'standard', critical_path: false, depends_on: [],
    criteria: [{ id: 'AC-1', text: 'The report describes the current hold', risk_tags: ['functional'], waivable: false }],
    use_cases: [{ id: 'UC-1', ac: ['AC-1'], scenario: 'Inspect a pending wave review hold' }],
    tools: [{ id: 'report', kind: 'command', gate_id: 'hold-check', command: [process.execPath, '--version'], playwright: null }],
    assertions: [{ id: 'AS-1', ac: ['AC-1'], tool_id: 'report', operator: 'exit_code_zero', expected: 'Report command exits successfully' }],
    evidence_requirements: [{ id: 'ER-1', ac: ['AC-1'], tool_id: 'report', kind: 'command_log', required: true }],
    budgets: { max_semantic_reworks: 2, max_infrastructure_retries_per_stage: 1, repeated_failure_limit: 2 },
  }, 'owner')
  await writeMd(path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), contract, '# Approved report fixture')
  await writeFile(path.join(f.taskRoot, 'ACCEPTANCE_RUN.json'), `${JSON.stringify({ protocol_version: 2, stage: 'm_working', contract_hash: contract.contract_hash })}\n`)
  const baseline = await runReportScheduler(f.root)
  assert.equal(baseline.suggestions[0].ready, true)
  const reportPath = path.join(f.root, '.spec-loop', 'output', 'scheduler-report.json')
  const before = await readFile(reportPath, 'utf8')
  const holdPath = path.join(f.root, '.spec-loop', 'scheduler', 'wave-reviews', 'tasks', 'TASK-HOLD-1.json')
  await mkdir(path.dirname(holdPath), { recursive: true })
  const privateText = 'PRIVATE_CUSTOMER_PROMPT_ORIGINAL_TEXT_42'
  await writeFile(holdPath, `${JSON.stringify({ task_id: 'TASK-HOLD-1', status: 'awaiting_wave_review', wave_id: privateText })}\n`)
  await assert.rejects(runReportScheduler(f.root), /invalid wave review hold/)
  assert.equal(await readFile(reportPath, 'utf8'), before)

  await writeFile(holdPath, `${JSON.stringify({ schema_version: 1, task_id: 'TASK-HOLD-1', status: 'awaiting_wave_review', wave_id: 'WAVE-UNBOUND', bundle_hash: 'a'.repeat(64), facts_hash: 'b'.repeat(64) })}\n`)
  await assert.rejects(runReportScheduler(f.root), /wave review hold binding is invalid/)
  assert.equal(await readFile(reportPath, 'utf8'), before)

  await rm(holdPath)
  const waveId = 'WAVE-PRIVATE-CUSTOMER-PROMPT-42'
  await writeMd(path.join(f.root, '.spec-loop', 'GATES.md'), { schema_version: 1, scope_kind: 'task', wave_id: waveId, coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' }, gates: [{ id: 'hold-check', ac: ['AC-1'], command: [process.execPath, '--version'], timeout_seconds: 10 }] }, '# Report hold fixture\n')
  await createWaveReview(f.root, { wave_id: waveId, status: 'completed', authorized_tasks: ['TASK-HOLD-1'], results: [], budget: {} })
  const held = await runReportScheduler(f.root)
  assert.equal(held.suggestions[0].ready, false)
  assert.equal(held.suggestions[0].reason, 'awaiting wave review')
  assert.equal(JSON.stringify(held).includes(waveId), false)
  assert.equal(held.metrics.missing_data, 0)
  const heldReport = await readFile(reportPath, 'utf8')
  const realHold = JSON.parse(await readFile(holdPath, 'utf8'))
  await writeFile(holdPath, `${JSON.stringify({ schema_version: 1, task_id: 'TASK-HOLD-1', wave_id: waveId, bundle_hash: realHold.bundle_hash, status: 'released', decision_id: randomUUID() })}\n`)
  await assert.rejects(runReportScheduler(f.root), /wave review hold binding is invalid/)
  assert.equal(await readFile(reportPath, 'utf8'), heldReport)
  const forgedHold = await readFile(holdPath, 'utf8')
  await assert.rejects(createWaveReview(f.root, { wave_id: 'WAVE-FORGED-REPLACEMENT', status: 'completed', authorized_tasks: ['TASK-HOLD-1'], results: [], budget: {} }), /wave review hold binding is invalid/)
  assert.equal(await readFile(holdPath, 'utf8'), forgedHold)
})
