import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { cli, fillContracts, tempRoot, writeMd } from './helpers.mjs'
import {
  buildAcceptanceSchedule,
  compileAcceptancePlan,
  readAcceptanceRun,
  recordRResult,
  recordVResult,
  resolveAcceptanceConflict,
  startAcceptanceRun,
  submitMakerCandidate,
} from '../dist/acceptance-loop.js'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function contract(taskId, overrides = {}) {
  return {
    schema_version: 2,
    task_id: taskId,
    version: 1,
    risk: 'standard',
    critical_path: false,
    depends_on: [],
    criteria: [
      { id: 'AC-1', text: 'candidate behavior passes', risk_tags: ['functional'], waivable: false },
      { id: 'AC-2', text: 'regression evidence passes', risk_tags: ['functional'], waivable: true },
    ],
    use_cases: [
      { id: 'UC-1', ac: ['AC-1'], scenario: 'run the candidate behavior' },
      { id: 'UC-2', ac: ['AC-2'], scenario: 'run the regression behavior' },
    ],
    tools: [{ id: 'acceptance-tool', kind: 'unit', gate_id: 'acceptance-test', command: [process.execPath, 'check.mjs'], playwright: null }],
    assertions: [
      { id: 'AS-1', ac: ['AC-1'], tool_id: 'acceptance-tool', operator: 'exit_code_zero', expected: 'exit code is zero' },
      { id: 'AS-2', ac: ['AC-2'], tool_id: 'acceptance-tool', operator: 'exit_code_zero', expected: 'exit code is zero' },
    ],
    evidence_requirements: [
      { id: 'ER-1', ac: ['AC-1'], tool_id: 'acceptance-tool', kind: 'test_report', required: true },
      { id: 'ER-2', ac: ['AC-2'], tool_id: 'acceptance-tool', kind: 'test_report', required: true },
    ],
    budgets: { max_semantic_reworks: 2, max_infrastructure_retries_per_stage: 2, repeated_failure_limit: 2 },
    ...overrides,
  }
}

async function fixture(name = 'acceptance-v2-', taskId = 'TASK-PMVR-1', contractOverrides = {}) {
  const root = await tempRoot(name), repository = path.join(root, 'repo')
  await mkdir(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.email', 'test@example.com'])
  git(repository, ['config', 'user.name', 'Test'])
  await writeFile(path.join(repository, 'check.mjs'), "console.log('acceptance pass')\n")
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'initial'])
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-PMVR', '--name', 'PMVR fixture', '--repository', repository]).code, 0)
  const contractFile = path.join(root, `${taskId}-contract.json`)
  await writeFile(contractFile, `${JSON.stringify(contract(taskId, contractOverrides), null, 2)}\n`)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved specification', '--goal', 'Exercise P M V R acceptance', '--reason', 'Need independent acceptance', '--contract', contractFile])
  assert.equal(proposal.code, 0, proposal.stderr)
  const proposalId = proposal.stdout.trim()
  assert.equal(cli(['triage', 'approve', root, proposalId, '--by', 'human-owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', root, proposalId, '--id', taskId, '--title', 'P M V R acceptance']).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase())
  await fillContracts(taskRoot, { id: taskId, title: 'P M V R acceptance', level: 'standard' })
  await writeMd(path.join(taskRoot, 'SPEC.md'), {
    schema_version: 1, task_id: taskId, title: 'P M V R acceptance', level: 'standard', proposal_id: proposalId,
  }, '# Goal\n\nExercise the approved P M V R acceptance protocol.\n\n## Scope\n\nChange the fixture candidate.\n\n## Non-goals\n\nDo not change unrelated behavior.')
  assert.equal(cli(['plan', taskRoot]).code, 0)
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: [process.execPath, 'check.mjs'], timeout_seconds: 30 }],
  }, '# Gates\n\nThe v2 fixture executes the approved unit acceptance tool.')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'approved project specification'])
  assert.equal(await readFile(path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), 'utf8').then((value) => value.includes('approved_by: human-owner')), true)
  await startAcceptanceRun(root, taskId)
  const workspaceResult = cli(['workspace', 'create', root, taskId, '--json'])
  assert.equal(workspaceResult.code, 0, workspaceResult.stderr)
  const workspace = JSON.parse(workspaceResult.stdout).worktree
  await writeFile(path.join(workspace, 'candidate.txt'), 'candidate one\n')
  git(workspace, ['add', '.'])
  git(workspace, ['commit', '-m', 'candidate one'])
  const selfTest = path.join(root, `${taskId}-self-test.txt`)
  await writeFile(selfTest, 'M self-test passed\n')
  await submitMakerCandidate(root, taskId, [selfTest])
  await compileAcceptancePlan(root, taskId)
  return { root, repository, taskRoot, taskId, workspace, selfTest }
}

async function addQueuedV2Task(f, taskId, dependsOn = []) {
  const contractFile = path.join(f.root, `${taskId}-contract.json`)
  await writeFile(contractFile, `${JSON.stringify(contract(taskId, { depends_on: dependsOn }), null, 2)}\n`)
  const proposal = cli(['triage', 'propose', f.root, '--source', 'approved dependency plan', '--goal', `Queue ${taskId}`, '--reason', 'Exercise v2 scheduler dependencies', '--contract', contractFile])
  assert.equal(proposal.code, 0, proposal.stderr)
  const proposalId = proposal.stdout.trim()
  assert.equal(cli(['triage', 'approve', f.root, proposalId, '--by', 'human-owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', f.root, proposalId, '--id', taskId, '--title', `Queue ${taskId}`]).code, 0)
  const taskRoot = path.join(f.root, '.spec-loop', 'tasks', taskId.toLowerCase())
  await fillContracts(taskRoot, { id: taskId, title: `Queue ${taskId}`, level: 'standard' })
  await writeMd(path.join(taskRoot, 'SPEC.md'), {
    schema_version: 1, task_id: taskId, title: `Queue ${taskId}`, level: 'standard', proposal_id: proposalId,
  }, '# Goal\n\nExercise v2 scheduler dependencies.\n\n## Scope\n\nQueue this approved fixture.\n\n## Non-goals\n\nDo not execute unrelated work.')
  assert.equal(cli(['plan', taskRoot]).code, 0)
  await startAcceptanceRun(f.root, taskId)
  return taskRoot
}

async function roleInput(root, taskId, role, suffix, values) {
  const evidence = path.join(root, `${taskId}-${role}-${suffix}.txt`)
  await writeFile(evidence, `${role} ${suffix} independent evidence\n`)
  const file = path.join(root, `${taskId}-${role}-${suffix}.json`)
  const requirements = [
    { file: evidence, ac: ['AC-1'], requirement_ids: ['ER-1'] },
    { file: evidence, ac: ['AC-2'], requirement_ids: ['ER-2'] },
  ]
  const run = await readAcceptanceRun(root, taskId)
  const binding = { task_id: taskId, contract_hash: run.contract_hash, plan_hash: run.plan_hash, head: run.current_head, ...(role === 'R' ? { v_evidence_set_hash: run.last_v_evidence_set_hash } : {}) }
  await writeFile(file, `${JSON.stringify({ ...binding, evidence: requirements, ...values }, null, 2)}\n`)
  return file
}

test('v2 P/M/V/R creates Candidate without mutating the v1 Task lifecycle', async () => {
  const f = await fixture()
  const v = await roleInput(f.root, f.taskId, 'V', 'pass', { invocation_id: 'verifier-invocation-1', verdict: 'pass', classification: null, failed_ac: [], message: 'all acceptance checks passed' })
  assert.equal((await recordVResult(f.root, f.taskId, v)).stage, 'v_passed')
  const sameInvocation = await roleInput(f.root, f.taskId, 'R', 'same-role', { invocation_id: 'verifier-invocation-1', verdict: 'pass', classification: null, failed_ac: [], message: 'evidence review passed' })
  await assert.rejects(recordRResult(f.root, f.taskId, sameInvocation), /must differ from V/)
  const r = await roleInput(f.root, f.taskId, 'R', 'pass', { invocation_id: 'reviewer-invocation-1', verdict: 'pass', classification: null, failed_ac: [], message: 'evidence review passed' })
  const candidate = await recordRResult(f.root, f.taskId, r)
  assert.equal(candidate.stage, 'candidate')
  assert.match(candidate.candidate_id, /^CANDIDATE-/)
  const legacy = JSON.parse(cli(['status', f.taskRoot, '--json']).stdout)
  assert.equal(legacy.status, 'planned')
  assert.equal(legacy.state_version, 2)
})

test('M rework requires a new HEAD and the third semantic repair enters Review Inbox', async () => {
  const f = await fixture('acceptance-budget-')
  const failureMessages = ['boundary condition is incorrect', 'regression branch is incorrect', 'fallback behavior is incorrect']
  for (let attempt = 1; attempt <= 3; attempt++) {
    const v = await roleInput(f.root, f.taskId, 'V', `implementation-${attempt}`, {
      invocation_id: `verifier-${attempt}`, verdict: 'fail', classification: 'implementation_problem', failed_ac: ['AC-1'], message: failureMessages[attempt - 1],
    })
    const result = await recordVResult(f.root, f.taskId, v)
    if (attempt === 3) {
      assert.equal(result.stage, 'waiting_human_review')
      assert.equal(result.semantic_reworks_used, 2)
      break
    }
    assert.equal(result.stage, 'm_working')
    await assert.rejects(submitMakerCandidate(f.root, f.taskId, [f.selfTest]), /new HEAD/)
    await writeFile(path.join(f.workspace, `fix-${attempt}.txt`), `fix ${attempt}\n`)
    git(f.workspace, ['add', '.'])
    git(f.workspace, ['commit', '-m', `fix ${attempt}`])
    await writeFile(f.selfTest, `M self-test passed after fix ${attempt}\n`)
    await submitMakerCandidate(f.root, f.taskId, [f.selfTest])
    await compileAcceptancePlan(f.root, f.taskId)
  }
  const inbox = JSON.parse(await readFile(path.join(f.root, '.spec-loop', 'REVIEW_INBOX.json'), 'utf8'))
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].task_id, f.taskId)
  assert.equal(inbox.items[0].requires_immediate_attention, false)
  const schedule = await buildAcceptanceSchedule(f.root)
  assert.deepEqual(schedule.suspended, [f.taskId])
  assert.deepEqual(schedule.immediate_attention, [])
})

test('same V failure fingerprint stops early while infrastructure retry does not consume semantic budget', async () => {
  const f = await fixture('acceptance-fingerprint-')
  let input = await roleInput(f.root, f.taskId, 'V', 'infra-1', {
    invocation_id: 'verifier-infra-1', verdict: 'fail', classification: 'infrastructure_problem', failed_ac: [], message: 'browser service unavailable 503',
  })
  let run = await recordVResult(f.root, f.taskId, input)
  assert.equal(run.stage, 'plan_compiled')
  assert.equal(run.semantic_reworks_used, 0)
  assert.equal(run.infrastructure_retries.V, 1)
  input = await roleInput(f.root, f.taskId, 'V', 'infra-2', {
    invocation_id: 'verifier-infra-2', verdict: 'fail', classification: 'infrastructure_problem', failed_ac: [], message: 'browser service unavailable 504',
  })
  run = await recordVResult(f.root, f.taskId, input)
  assert.equal(run.stage, 'waiting_human_review')
  assert.equal(run.semantic_reworks_used, 0)
  assert.match(run.history.at(-1).action, /infrastructure retry exhausted/)
})

test('protected AC cannot be waived and spec replacement must be a newly approved contract version', async () => {
  const f = await fixture('acceptance-human-')
  const riskyContract = contract(f.taskId, {
    version: 2,
    criteria: [
      { id: 'AC-1', text: 'authorization remains enforced', risk_tags: ['authorization'], waivable: false },
      { id: 'AC-2', text: 'optional presentation remains readable', risk_tags: ['functional'], waivable: true },
    ],
  })
  const badContractFile = path.join(f.root, 'bad-contract.json')
  await writeFile(badContractFile, `${JSON.stringify({ ...riskyContract, criteria: [{ ...riskyContract.criteria[0], waivable: true }, riskyContract.criteria[1]] }, null, 2)}\n`)
  const conflictInput = await roleInput(f.root, f.taskId, 'V', 'high-risk', {
    invocation_id: 'verifier-risk', verdict: 'fail', classification: 'high_risk', failed_ac: ['AC-1'], message: 'authorization behavior is ambiguous and high risk',
  })
  assert.equal((await recordVResult(f.root, f.taskId, conflictInput)).stage, 'waiting_human_review')
  await assert.rejects(resolveAcceptanceConflict(f.root, f.taskId, {
    action: 'waive_noncritical', actor: 'human-owner', note: 'attempt to waive protected behavior', ac: ['AC-1'], contract_file: badContractFile, reauthorize_budget: true,
  }), /may not be waived/)
  await assert.rejects(resolveAcceptanceConflict(f.root, f.taskId, {
    action: 'revise_spec_and_reauthorize', actor: 'human-owner', note: 'reuse old contract without version change', ac: [], contract_file: path.join(f.root, `${f.taskId}-contract.json`), reauthorize_budget: true,
  }), /increase version/)
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'waiting_human_review')
})

test('R evidence failure routes back to V and both roles require fresh Evidence', async () => {
  const f = await fixture('acceptance-r-route-')
  const firstV = await roleInput(f.root, f.taskId, 'V', 'initial-pass', { invocation_id: 'verifier-first', verdict: 'pass', classification: null, failed_ac: [], message: 'initial V coverage passed' })
  await recordVResult(f.root, f.taskId, firstV)
  const failedR = await roleInput(f.root, f.taskId, 'R', 'evidence-gap', { invocation_id: 'reviewer-gap', verdict: 'fail', classification: 'evidence_problem', failed_ac: ['AC-2'], message: 'regression evidence lacks an independent trace' })
  let run = await recordRResult(f.root, f.taskId, failedR)
  assert.equal(run.stage, 'plan_compiled')
  assert.equal(run.semantic_reworks_used, 1)
  const repeatedV = path.join(f.root, `${f.taskId}-V-repeat.json`)
  const oldV = JSON.parse(await readFile(firstV, 'utf8'))
  await writeFile(repeatedV, `${JSON.stringify({ ...oldV, invocation_id: 'verifier-repeat' }, null, 2)}\n`)
  await assert.rejects(recordVResult(f.root, f.taskId, repeatedV), /new Evidence/)
  const freshV = await roleInput(f.root, f.taskId, 'V', 'fresh-pass', { invocation_id: 'verifier-fresh', verdict: 'pass', classification: null, failed_ac: [], message: 'fresh V evidence covers the gap' })
  run = await recordVResult(f.root, f.taskId, freshV)
  assert.equal(run.stage, 'v_passed')
  const finalR = await roleInput(f.root, f.taskId, 'R', 'final-pass', { invocation_id: 'reviewer-final', verdict: 'pass', classification: null, failed_ac: [], message: 'fresh evidence review passed' })
  assert.equal((await recordRResult(f.root, f.taskId, finalR)).stage, 'candidate')
})

test('V and R reject a changed Gate Plan or tampered V Evidence', async () => {
  const gateDrift = await fixture('acceptance-gate-drift-')
  await writeMd(path.join(gateDrift.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: [process.execPath, '--version'], timeout_seconds: 30 }],
  }, '# Gates\n\nThis command was changed after plan compilation and must be rejected.')
  const driftV = await roleInput(gateDrift.root, gateDrift.taskId, 'V', 'drift', { invocation_id: 'verifier-drift', verdict: 'pass', classification: null, failed_ac: [], message: 'attempt to use a changed plan' })
  await assert.rejects(recordVResult(gateDrift.root, gateDrift.taskId, driftV), /Gate Plan changed/)

  const tamper = await fixture('acceptance-evidence-tamper-')
  const vFile = await roleInput(tamper.root, tamper.taskId, 'V', 'before-tamper', { invocation_id: 'verifier-tamper', verdict: 'pass', classification: null, failed_ac: [], message: 'V evidence initially passed' })
  await recordVResult(tamper.root, tamper.taskId, vFile)
  await writeFile(path.join(tamper.root, `${tamper.taskId}-V-before-tamper.txt`), 'tampered after V signed it\n')
  const rFile = await roleInput(tamper.root, tamper.taskId, 'R', 'after-tamper', { invocation_id: 'reviewer-tamper', verdict: 'pass', classification: null, failed_ac: [], message: 'attempt to approve tampered evidence' })
  await assert.rejects(recordRResult(tamper.root, tamper.taskId, rFile), /tampered V Evidence/)
})

test('scheduler continues independent Ready work, blocks downstream, and escalates critical conflicts', async () => {
  const f = await fixture('acceptance-schedule-', 'TASK-PMVR-BASE', { critical_path: true })
  const conflict = await roleInput(f.root, f.taskId, 'V', 'critical-conflict', {
    invocation_id: 'verifier-critical', verdict: 'fail', classification: 'spec_ambiguity', failed_ac: ['AC-1'], message: 'critical path specification is ambiguous',
  })
  await recordVResult(f.root, f.taskId, conflict)
  await addQueuedV2Task(f, 'TASK-PMVR-READY')
  await addQueuedV2Task(f, 'TASK-PMVR-DOWNSTREAM', [f.taskId])
  const schedule = await buildAcceptanceSchedule(f.root)
  assert.deepEqual(schedule.immediate_attention, [f.taskId])
  assert.ok(schedule.ready.includes('TASK-PMVR-READY'))
  const downstream = schedule.tasks.find((item) => item.task_id === 'TASK-PMVR-DOWNSTREAM')
  assert.deepEqual(downstream.blocked_by, [f.taskId])
  assert.equal(downstream.ready, false)
  await assert.rejects(submitMakerCandidate(f.root, 'TASK-PMVR-DOWNSTREAM', []), /blocked by unfinished v2 dependencies/)
})
