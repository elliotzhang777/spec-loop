import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { processStartedAt } from '../dist/process-control.js'
import { spawnSync } from 'node:child_process'

import { cli, fillContracts, readMd, tempRoot, writeMd } from './helpers.mjs'
import {
  acceptanceContractInputSchema,
  buildAcceptanceSchedule,
  cancelAcceptanceRun,
  compileAcceptancePlan,
  describeControlledGateFailures,
  failureFingerprint,
  readAcceptanceRun,
  reconcileCandidateBaseline,
  recordRResult,
  recordVResult,
  resolveAcceptanceConflict,
  reviseUnstartedAcceptanceDependencies,
  returnAcceptanceToMaker,
  runControlledV,
  startAcceptanceRun,
  submitMakerCandidate,
} from '../dist/acceptance-loop.js'

test('controlled Gate failures distinguish test names while ignoring TAP order and duration', async () => {
  const root = await tempRoot('controlled-gate-failure-')
  const artifact = path.join(root, 'quality.tap')
  const gate = { id: 'quality-full', artifact: 'quality.tap', exit_code: 1, timed_out: false }
  await writeFile(artifact, 'not ok 216 - fast exit identity probe\n  duration_ms: 300.1\n')
  const fastExit = await describeControlledGateFailures(root, [gate])
  await writeFile(artifact, 'not ok 84 - background execution view lifecycle\n  duration_ms: 8216.3\n')
  const viewStartup = await describeControlledGateFailures(root, [gate])
  assert.notEqual(fastExit, viewStartup)
  await writeFile(artifact, 'not ok 312 - fast exit identity probe\n  duration_ms: 900.7\n')
  assert.equal(await describeControlledGateFailures(root, [gate]), fastExit)
  await writeFile(artifact, 'not ok 1 - parameterized path 1 rejects invalid token\n')
  const numericOne = await describeControlledGateFailures(root, [gate])
  await writeFile(artifact, 'not ok 1 - parameterized path 2 rejects invalid token\n')
  const numericTwo = await describeControlledGateFailures(root, [gate])
  assert.notEqual(numericOne, numericTwo)
  await writeFile(artifact, 'not ok 1 - fast exit identity probe\nnot ok 2 - background execution view lifecycle\n')
  const both = await describeControlledGateFailures(root, [gate])
  await writeFile(artifact, 'not ok 9 - background execution view lifecycle\nnot ok 8 - fast exit identity probe\n')
  assert.equal(await describeControlledGateFailures(root, [gate]), both)
  const fingerprintFor = (message) => failureFingerprint('V', 'implementation_problem', ['AC-1'], message, 'evidence-hash')
  assert.notEqual(fingerprintFor(numericOne), fingerprintFor(numericTwo))
  assert.equal(fingerprintFor(both), fingerprintFor(await describeControlledGateFailures(root, [gate])))
  assert.equal(fingerprintFor(`${both}; Provider V: attempt 503`), fingerprintFor(`${both}; Provider V: attempt 504`))
  const firstEight = Array.from({ length: 8 }, (_, index) => `not ok ${index + 1} - failing case ${index + 1}`).join('\n')
  await writeFile(artifact, `${firstEight}\nnot ok 9 - ninth failure alpha\n`)
  const ninthAlpha = await describeControlledGateFailures(root, [gate])
  await writeFile(artifact, `${firstEight}\nnot ok 9 - ninth failure beta\n`)
  assert.notEqual(fingerprintFor(ninthAlpha), fingerprintFor(await describeControlledGateFailures(root, [gate])))
  await writeFile(artifact, 'command failed without TAP output\n')
  assert.match(await describeControlledGateFailures(root, [gate]), /quality-full: exit 1/)
})
import { addWritableRoots, buildProviderArgs, cancelRoleInvocation, ingestSucceededRoleResult, prepareRoleInvocation, readRoleInvocation, reconcileRoleInvocation, runRoleInvocation, summarizeRoleUsage } from '../dist/role-orchestrator.js'
import { inspectSchedulerLiveness, stopTaskExecution } from '../dist/scheduler-control.js'
import { readExecutionEvents } from '../dist/execution-events.js'
import { buildExecutionSnapshot } from '../dist/execution-view.js'
import { freezeControlledVerificationCandidate, runGates } from '../dist/execution.js'

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

test('initial contract IDs are continuous, while revised contracts keep stable ordered IDs', () => {
  const initial = contract('TASK-REVISION-IDS')
  const skipped = {
    ...initial, criteria: [initial.criteria[1]],
    use_cases: initial.use_cases.filter(item => item.ac.includes('AC-2')),
    assertions: initial.assertions.filter(item => item.ac.includes('AC-2')),
    evidence_requirements: initial.evidence_requirements.filter(item => item.ac.includes('AC-2')),
  }
  assert.equal(acceptanceContractInputSchema.safeParse(skipped).success, false)
  assert.equal(acceptanceContractInputSchema.safeParse({ ...skipped, version: 2 }).success, true)
  assert.equal(acceptanceContractInputSchema.safeParse({ ...initial, version: 2, criteria: [...initial.criteria].reverse() }).success, false)
  assert.equal(acceptanceContractInputSchema.safeParse({ ...initial, version: 2, criteria: [initial.criteria[0], initial.criteria[0]] }).success, false)
})

test('P can audit a dependency-only Contract correction before M submits a HEAD', async () => {
  const f = await fixture('acceptance-unstarted-revision-', 'TASK-REVISION-PRE-M', { depends_on: ['TASK-LEGACY'] }, false, false)
  const previousFile = path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md')
  const previousText = await readFile(previousFile, 'utf8')
  const previous = (await readMd(previousFile)).data
  await startAcceptanceRun(f.root, f.taskId)
  const runFile = path.join(f.taskRoot, 'ACCEPTANCE_RUN.json')
  const previousRun = await readFile(runFile, 'utf8')
  const revisedFile = path.join(f.root, 'revised.json')
  const revision = contract(f.taskId, { version: 2, depends_on: [] })
  for (const invalid of [
    { ...revision, critical_path: true },
    { ...revision, criteria: [{ ...revision.criteria[0], text: 'changed acceptance criterion' }, revision.criteria[1]] },
    { ...revision, tools: [{ ...revision.tools[0], command: ['node', 'other.mjs'] }] },
    { ...revision, budgets: { ...revision.budgets, repeated_failure_limit: 3 } },
  ]) {
    await writeFile(revisedFile, `${JSON.stringify(invalid)}\n`)
    await assert.rejects(reviseUnstartedAcceptanceDependencies(f.root, f.taskId, revisedFile, previous.contract_hash, 'human-owner', 'Remove obsolete legacy dependency'), /may not change AC, tools, Evidence or budgets/)
    assert.equal(await readFile(previousFile, 'utf8'), previousText)
    assert.equal(await readFile(runFile, 'utf8'), previousRun)
  }
  await writeFile(revisedFile, `${JSON.stringify(revision)}\n`)
  await assert.rejects(reviseUnstartedAcceptanceDependencies(f.root, f.taskId, revisedFile, 'a'.repeat(64), 'human-owner', 'Remove obsolete legacy dependency'), /expected Contract hash differs/)
  assert.equal(await readFile(runFile, 'utf8'), previousRun)
  const result = await reviseUnstartedAcceptanceDependencies(f.root, f.taskId, revisedFile, previous.contract_hash, 'human-owner', 'Remove obsolete legacy dependency')
  assert.equal(result.contract.version, 2)
  assert.deepEqual(result.contract.depends_on, [])
  assert.equal(result.run.contract_hash, result.contract.contract_hash)
  assert.equal(result.run.stage, 'm_working')
  assert.equal(result.run.history.at(-1).actor, 'human')
  const audit = JSON.parse(await readFile(path.join(f.root, result.audit_file), 'utf8'))
  assert.equal(audit.prior_hash, previous.contract_hash)
  assert.equal(audit.new_hash, result.contract.contract_hash)
  assert.equal(audit.prior_version, previous.version)
  assert.equal(audit.new_version, result.contract.version)
  assert.equal(audit.run_id, result.run.run_id)
  assert.equal(result.run.history.at(-1).artifact, result.audit_file)
  assert.deepEqual(await readAcceptanceRun(f.root, f.taskId), result.run)
  assert.deepEqual(audit.removed_dependencies, ['TASK-LEGACY'])
  assert.equal(await readFile(path.join(f.root, audit.archived_contract), 'utf8'), previousText)
  await assert.rejects(reviseUnstartedAcceptanceDependencies(f.root, f.taskId, revisedFile, previous.contract_hash, 'human-owner', 'Replay old approval'), /expected Contract hash differs/)
})

test('unstarted Contract correction rejects an active M invocation and an already submitted M candidate', async () => {
  const active = await fixture('acceptance-active-m-revision-', 'TASK-REVISION-ACTIVE', {}, true, false)
  await startAcceptanceRun(active.root, active.taskId)
  assert.equal(cli(['workspace', 'create', active.root, active.taskId]).code, 0)
  const invocation = await prepareRoleInvocation(active.root, active.taskId, 'M')
  assert.equal(invocation.status, 'prepared')
  const current = (await readMd(path.join(active.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'))).data
  const replacement = path.join(active.root, 'replacement.json')
  await writeFile(replacement, `${JSON.stringify(contract(active.taskId, { version: 2 }))}\n`)
  await assert.rejects(reviseUnstartedAcceptanceDependencies(active.root, active.taskId, replacement, current.contract_hash, 'human-owner', 'Correct dependency before M'), /every role invocation to be terminal/)
  const submitted = await fixture('acceptance-submitted-m-revision-', 'TASK-REVISION-SUBMITTED')
  const approved = (await readMd(path.join(submitted.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'))).data
  await assert.rejects(reviseUnstartedAcceptanceDependencies(submitted.root, submitted.taskId, replacement, approved.contract_hash, 'human-owner', 'Correct dependency after M'), /only before M submission/)
})

async function fixture(name = 'acceptance-v2-', taskId = 'TASK-PMVR-1', contractOverrides = {}, requireOrchestration = false, startRun = true, extraGates = [], environmentPassthrough = []) {
  const root = await tempRoot(name), repository = path.join(root, 'repo')
  const level = contractOverrides.risk ?? 'standard'
  await mkdir(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.email', 'test@example.com'])
  git(repository, ['config', 'user.name', 'Test'])
  await writeFile(path.join(repository, 'check.mjs'), "console.log('acceptance pass')\n")
  await mkdir(path.join(repository, 'scripts', 'gates'), { recursive: true })
  await writeFile(path.join(repository, 'scripts', 'gates', 'check.sh'), '#!/usr/bin/env bash\nset -euo pipefail\nnode check.mjs\n')
  await chmod(path.join(repository, 'scripts', 'gates', 'check.sh'), 0o755)
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'initial'])
  const initialized = cli(['project', 'init', root, '--id', 'PROJ-PMVR', '--name', 'PMVR fixture', '--repository', repository])
  assert.equal(initialized.code, 0, initialized.stderr)
  if (requireOrchestration) assert.equal(cli(['project', 'protocol', root, '--set', 'v2']).code, 0)
  const contractFile = path.join(root, `${taskId}-contract.json`)
  const contractValue = contract(taskId, contractOverrides)
  await writeFile(contractFile, `${JSON.stringify(contractValue, null, 2)}\n`)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved specification', '--goal', 'Exercise P M V R acceptance', '--reason', 'Need independent acceptance', '--risk', level, '--contract', contractFile])
  assert.equal(proposal.code, 0, proposal.stderr)
  const proposalId = proposal.stdout.trim()
  assert.equal(cli(['triage', 'approve', root, proposalId, '--by', 'human-owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', root, proposalId, '--id', taskId, '--title', 'P M V R acceptance']).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase())
  await fillContracts(taskRoot, { id: taskId, title: 'P M V R acceptance', level })
  await writeMd(path.join(taskRoot, 'SPEC.md'), {
    schema_version: 1, task_id: taskId, title: 'P M V R acceptance', level, target_spec: path.join('spec', '04-task', `${taskId}.md`), proposal_id: proposalId,
  }, '# Goal\n\nExercise the approved P M V R acceptance protocol.\n\n## Scope\n\nChange the fixture candidate.\n\n## Non-goals\n\nDo not change unrelated behavior.')
  assert.equal(cli(['plan', taskRoot]).code, 0)
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    environment_passthrough: environmentPassthrough,
    gates: [{ id: 'acceptance-test', ac: contractValue.criteria.map(item => item.id), command: contractValue.tools[0].command, timeout_seconds: 30 }, ...extraGates],
  }, '# Gates\n\nThe v2 fixture executes the approved unit acceptance tool.')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'approved project specification'])
  assert.equal(await readFile(path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), 'utf8').then((value) => value.includes('approved_by: human-owner')), true)
  let providers = null, maker = null
  if (requireOrchestration) {
    providers = path.join(root, '.spec-loop', 'PROVIDERS.md')
    maker = path.join(root, 'maker-provider.sh')
    await writeFile(maker, '#!/bin/sh\nset -eu\nprintf "candidate one\\n" > candidate.txt\nprintf "EXAMPLE_TOKEN=public-fixture\\n" > .env.example\nprintf "windows wrapper\\r\\n" > wrapper.cmd\ngit add candidate.txt .env.example wrapper.cmd\ngit commit -m "candidate one" >/dev/null\nprintf "M self-test passed\\n" > "$SPEC_LOOP_EVIDENCE_ROOT/self-test.txt"\nprintf \'%s\\n\' \'{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30,"reasoning_tokens":10,"total_tokens":150}}\'\n')
    await chmod(maker, 0o755)
    await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: codex', `executable: ${maker}`))
  }
  if (!startRun) return { root, repository, taskRoot, taskId, workspace: null, selfTest: null, mInvocation: null }
  await startAcceptanceRun(root, taskId)
  const workspaceResult = cli(['workspace', 'create', root, taskId, '--json'])
  assert.equal(workspaceResult.code, 0, workspaceResult.stderr)
  const workspace = JSON.parse(workspaceResult.stdout).worktree
  let mInvocation = null
  if (requireOrchestration) {
    mInvocation = await prepareRoleInvocation(root, taskId, 'M')
    assert.equal((await runRoleInvocation(root, taskId, mInvocation.invocation_id)).status, 'succeeded')
    await writeFile(providers, (await readFile(providers, 'utf8')).replace(`executable: ${maker}`, 'executable: /usr/bin/true'))
  } else {
    await writeFile(path.join(workspace, 'candidate.txt'), 'candidate one\n')
    git(workspace, ['add', '.'])
    git(workspace, ['commit', '-m', 'candidate one'])
  }
  const selfTest = requireOrchestration ? path.join(mInvocation.evidence_root, 'self-test.txt') : path.join(root, `${taskId}-self-test.txt`)
  if (!requireOrchestration) await writeFile(selfTest, 'M self-test passed\n')
  if (requireOrchestration) {
    assert.equal((await ingestSucceededRoleResult(root, taskId, mInvocation.invocation_id)).result_status, 'ingested')
  } else {
    await submitMakerCandidate(root, taskId, [selfTest])
    await compileAcceptancePlan(root, taskId)
  }
  return { root, repository, taskRoot, taskId, workspace, selfTest, mInvocation }
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

test('V and R resolve relative Evidence paths from the Project root', async () => {
  const f = await fixture('acceptance-relative-evidence-', 'TASK-RELATIVE-EVIDENCE-1')
  const v = await roleInput(f.root, f.taskId, 'V', 'relative', { invocation_id: 'relative-verifier', verdict: 'pass', classification: null, failed_ac: [], message: 'relative verifier evidence passed' })
  const vInput = JSON.parse(await readFile(v, 'utf8'))
  vInput.evidence = vInput.evidence.map((item) => ({ ...item, file: path.relative(f.root, item.file) }))
  await writeFile(v, `${JSON.stringify(vInput, null, 2)}\n`)
  assert.equal((await recordVResult(f.root, f.taskId, v)).stage, 'v_passed')

  const r = await roleInput(f.root, f.taskId, 'R', 'relative', { invocation_id: 'relative-reviewer', verdict: 'pass', classification: null, failed_ac: [], message: 'relative reviewer evidence passed' })
  const rInput = JSON.parse(await readFile(r, 'utf8'))
  rInput.evidence = rInput.evidence.map((item) => ({ ...item, file: path.relative(f.root, item.file) }))
  await writeFile(r, `${JSON.stringify(rInput, null, 2)}\n`)
  assert.equal((await recordRResult(f.root, f.taskId, r)).stage, 'candidate')
})

test('V and R accept plain Evidence filenames beside their RESULT file', async () => {
  const f = await fixture('acceptance-sibling-evidence-', 'TASK-SIBLING-EVIDENCE-1')
  for (const role of ['V', 'R']) {
    const file = await roleInput(f.root, f.taskId, role, 'sibling', {
      invocation_id: `${role}-sibling`, verdict: 'pass', classification: null, failed_ac: [], message: 'sibling evidence passed',
    })
    const result = JSON.parse(await readFile(file, 'utf8'))
    const directory = path.join(f.root, 'role-evidence', role)
    await mkdir(directory, { recursive: true })
    const evidenceName = path.basename(result.evidence[0].file)
    await writeFile(path.join(directory, evidenceName), await readFile(result.evidence[0].file))
    result.evidence = result.evidence.map((item) => ({ ...item, file: evidenceName }))
    const siblingResult = path.join(directory, 'RESULT.json')
    await writeFile(siblingResult, `${JSON.stringify(result, null, 2)}\n`)
    assert.equal((role === 'V' ? await recordVResult(f.root, f.taskId, siblingResult) : await recordRResult(f.root, f.taskId, siblingResult)).stage, role === 'V' ? 'v_passed' : 'candidate')
  }
})

test('Candidate baseline drift is detected read-only and explicitly requeues M/V/R without merging', async () => {
  const f = await fixture('acceptance-rebaseline-', 'TASK-REBASELINE-1')
  const v = await roleInput(f.root, f.taskId, 'V', 'pass', { invocation_id: 'verifier-rebaseline', verdict: 'pass', classification: null, failed_ac: [], message: 'candidate passed before baseline drift' })
  await recordVResult(f.root, f.taskId, v)
  const r = await roleInput(f.root, f.taskId, 'R', 'pass', { invocation_id: 'reviewer-rebaseline', verdict: 'pass', classification: null, failed_ac: [], message: 'candidate review passed before baseline drift' })
  const candidate = await recordRResult(f.root, f.taskId, r)
  const candidateFile = path.join(f.root, '.spec-loop', 'output', `${f.taskId}-acceptance-v2`, 'CANDIDATE.json')
  const preserved = await readFile(candidateFile, 'utf8')
  await writeFile(path.join(f.repository, 'baseline.txt'), 'main advanced independently\n')
  git(f.repository, ['add', '.'])
  git(f.repository, ['commit', '-m', 'advance baseline'])

  const inspected = await reconcileCandidateBaseline(f.root, f.taskId)
  assert.equal(inspected.status, 'baseline_drift')
  assert.equal(inspected.applied, false)
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).candidate_id, candidate.candidate_id)
  const applied = await reconcileCandidateBaseline(f.root, f.taskId, true)
  assert.equal(applied.applied, true)
  assert.equal(applied.preserved_candidate_id, candidate.candidate_id)
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'm_working')
  assert.deepEqual(await readFile(candidateFile, 'utf8'), preserved)
  assert.deepEqual((await buildAcceptanceSchedule(f.root)).ready, [f.taskId])
  assert.equal(git(f.repository, ['log', '-1', '--pretty=%s']), 'advance baseline')
})

test('managed role invocations isolate M/V/R and fail closed after snapshot mutation or interruption', async () => {
  const f = await fixture('acceptance-roles-', 'TASK-ROLES-1', {}, true)
  const run = await readAcceptanceRun(f.root, f.taskId)
  assert.equal(run.orchestration_required, true)
  assert.equal(run.last_m_invocation, f.mInvocation.invocation_id)
  const makerRecord = await readRoleInvocation(f.root, f.taskId, f.mInvocation.invocation_id)
  assert.deepEqual(makerRecord.usage, { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30, reasoning_tokens: 10, total_tokens: 150, cost_usd: null, recorded: true })
  const usage = await summarizeRoleUsage(f.root, f.taskId)
  assert.equal(usage.totals.total_tokens, 150)
  assert.equal(usage.totals.recorded_runs, 1)
  assert.equal(usage.totals.cost_recorded_runs, 0)

  const unmanaged = await roleInput(f.root, f.taskId, 'V', 'unmanaged', { invocation_id: 'unmanaged-verifier', verdict: 'pass', classification: null, failed_ac: [], message: 'unmanaged result must fail closed' })
  await assert.rejects(recordVResult(f.root, f.taskId, unmanaged), /succeeded managed invocation|ENOENT/)

  const slowProvider = path.join(f.root, 'slow-provider.sh')
  await writeFile(slowProvider, '#!/bin/sh\nsleep 5\n')
  await chmod(slowProvider, 0o755)
  const providersFile = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  const fastProviderConfig = await readFile(providersFile, 'utf8')
  await writeFile(providersFile, fastProviderConfig.replace('executable: /usr/bin/true', `executable: ${slowProvider}`).replace('timeout_seconds: 1800', 'timeout_seconds: 1'))
  const timed = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, timed.invocation_id)).status, 'timed_out')
  const verifierArgs = buildProviderArgs('codex', ['exec', '--json', '--sandbox', 'read-only'], 'V', '/snapshot', 'verify', '/evidence')
  assert.ok(verifierArgs.includes('--skip-git-repo-check'))
  assert.deepEqual(verifierArgs.slice(verifierArgs.indexOf('--add-dir'), verifierArgs.indexOf('--add-dir') + 2), ['--add-dir', '/evidence'])
  assert.equal(verifierArgs[verifierArgs.indexOf('--sandbox') + 1], 'workspace-write')
  assert.equal(buildProviderArgs('codex', ['exec', '--json', '--sandbox', 'read-only'], 'M', '/worktree', 'make').includes('--skip-git-repo-check'), false)
  const makerArgs = addWritableRoots(buildProviderArgs('codex', ['exec', '--json', '--sandbox', 'read-only'], 'M', '/worktree', 'make', '/evidence'), ['/repo/.git/worktrees/task-1', '/repo/.git', '/evidence'])
  assert.deepEqual(makerArgs.filter((value, index) => makerArgs[index - 1] === '--add-dir'), ['/evidence', '/repo/.git/worktrees/task-1', '/repo/.git'])

  await writeFile(providersFile, fastProviderConfig.replace('executable: /usr/bin/true', `executable: ${slowProvider}`).replace('timeout_seconds: 1800', 'timeout_seconds: 30'))
  const cancellable = await prepareRoleInvocation(f.root, f.taskId, 'V')
  const running = runRoleInvocation(f.root, f.taskId, cancellable.invocation_id)
  for (let attempt = 0; attempt < 50 && (await readRoleInvocation(f.root, f.taskId, cancellable.invocation_id)).status !== 'running'; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  const heartbeatFile = path.join(f.root, '.spec-loop', 'output', `${f.taskId}-acceptance-v2`, 'invocations', cancellable.invocation_id, 'HEARTBEAT.json')
  const firstHeartbeat = JSON.parse(await readFile(heartbeatFile, 'utf8')).heartbeat_at
  await new Promise(resolve => setTimeout(resolve, 2200))
  const secondHeartbeat = JSON.parse(await readFile(heartbeatFile, 'utf8')).heartbeat_at
  assert.ok(Date.parse(secondHeartbeat) > Date.parse(firstHeartbeat))
  assert.equal((await inspectSchedulerLiveness(f.root, 3)).invocations.find(item => item.invocation_id === cancellable.invocation_id).status, 'healthy')
  const beforeUnknown = await readRoleInvocation(f.root, f.taskId, cancellable.invocation_id)
  await assert.rejects(reconcileRoleInvocation(f.root, f.taskId, cancellable.invocation_id, { identifyProcess: async () => null }), /identity.*unknown|cannot.*identity/i)
  assert.deepEqual(await readRoleInvocation(f.root, f.taskId, cancellable.invocation_id), beforeUnknown)
  assert.equal((await cancelRoleInvocation(f.root, f.taskId, cancellable.invocation_id)).status, 'cancelled')
  assert.equal((await running).status, 'cancelled')
  await writeFile(providersFile, fastProviderConfig)

  const corrupted = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal(corrupted.candidate.access, 'read_only_snapshot')
  assert.equal(await realpath(git(corrupted.candidate.path, ['rev-parse', '--show-toplevel'])), await realpath(corrupted.candidate.path))
  assert.equal(git(corrupted.candidate.path, ['rev-parse', 'HEAD']), corrupted.candidate.head)
  await chmod(corrupted.candidate.path, 0o755)
  await writeFile(path.join(corrupted.candidate.path, 'tampered.txt'), 'tampered snapshot\n')
  const rejected = await runRoleInvocation(f.root, f.taskId, corrupted.invocation_id)
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.last_error, /modified its read-only candidate snapshot/)

  const verifier = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, verifier.invocation_id)).status, 'succeeded')
  const v = await roleInput(f.root, f.taskId, 'V', 'managed-pass', { invocation_id: verifier.invocation_id, verdict: 'pass', classification: null, failed_ac: [], message: 'managed acceptance passed' })
  assert.equal((await recordVResult(f.root, f.taskId, v)).stage, 'v_passed')

  const reviewer = await prepareRoleInvocation(f.root, f.taskId, 'R')
  assert.notEqual(reviewer.invocation_id, verifier.invocation_id)
  assert.notEqual(reviewer.evidence_root, verifier.evidence_root)
  assert.equal((await runRoleInvocation(f.root, f.taskId, reviewer.invocation_id)).status, 'succeeded')
  const r = await roleInput(f.root, f.taskId, 'R', 'managed-pass', { invocation_id: reviewer.invocation_id, verdict: 'pass', classification: null, failed_ac: [], message: 'managed evidence review passed' })
  assert.equal((await recordRResult(f.root, f.taskId, r)).stage, 'candidate')

  const snapshot = await buildExecutionSnapshot(f.root)
  const projected = snapshot.tasks.find(task => task.task_id === f.taskId)
  assert.equal(projected.protocol, 'v2')
  assert.equal(projected.acceptance.stage, 'candidate')
  assert.equal(projected.acceptance.fresh, true)
  assert.equal(projected.acceptance.last_v_invocation, verifier.invocation_id)
  assert.equal(projected.acceptance.last_r_invocation, reviewer.invocation_id)
  const roleEvents = (await readExecutionEvents(f.root)).filter(event => event.step_type?.startsWith('role.'))
  assert.ok(roleEvents.some(event => event.step_type === 'role.m' && event.kind === 'step_succeeded'))
  assert.ok(roleEvents.some(event => event.step_type === 'role.v' && event.kind === 'step_failed'))
  assert.ok(roleEvents.some(event => event.step_type === 'role.r' && event.kind === 'step_succeeded'))

  const manifest = await readRoleInvocation(f.root, f.taskId, reviewer.invocation_id)
  assert.deepEqual(manifest.forbidden_actions, ['merge', 'push', 'deploy', 'credential_write', 'production_data', 'external_side_effect'])
  const fakeRunning = { ...manifest, status: 'running', pid: 99999999, finished_at: null, last_error: null }
  await writeFile(path.join(f.root, '.spec-loop', 'output', `${f.taskId}-acceptance-v2`, 'invocations', reviewer.invocation_id, 'INVOCATION.json'), `${JSON.stringify(fakeRunning, null, 2)}\n`)
  const reconciled = await reconcileRoleInvocation(f.root, f.taskId, reviewer.invocation_id)
  assert.equal(reconciled.status, 'interrupted')
  assert.match(reconciled.last_error, /result remains unknown/)
})

test('Controlled V freezes a clean v2 candidate and runs only its exactly approved repository Bash Gate', async () => {
  const f = await fixture('acceptance-controlled-v-', 'TASK-CONTROLLED-V-1', { tools: [{ id: 'acceptance-tool', kind: 'command', gate_id: 'acceptance-test', command: ['bash', 'scripts/gates/check.sh'], playwright: null }] }, true, true, [
    { id: 'other-task-gate', ac: ['AC-99'], command: [process.execPath, '--version'], timeout_seconds: 30 },
  ])
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'succeeded')
  const result = await runControlledV(f.root, f.taskId, invocation.invocation_id)
  assert.equal(result.run.stage, 'v_passed')
  assert.equal(result.gates.length, 1)
  assert.equal(result.gates[0].exit_code, 0)
  const harness = JSON.parse(await readFile(path.join(f.root, '.spec-loop', 'output', `${f.taskId}-harness-state.json`), 'utf8'))
  assert.equal(harness.stage, 'verified')
  assert.equal(harness.head, git(f.workspace, ['rev-parse', 'HEAD']))
})

test('Controlled V rejects an approved Bash Gate with an absolute interpreter path', async () => {
  const f = await fixture('acceptance-absolute-bash-', 'TASK-ABSOLUTE-BASH', {
    tools: [{ id: 'acceptance-tool', kind: 'command', gate_id: 'acceptance-test', command: ['/bin/bash', 'scripts/gates/check.sh'], playwright: null }],
  })
  await freezeControlledVerificationCandidate(f.root, f.taskId)
  await assert.rejects(runGates(f.root, f.taskId), /shell or command dispatcher is forbidden/)
  await assert.rejects(lstat(path.join(f.root, '.spec-loop', 'output', `${f.taskId}-gate-acceptance-test.txt`)), { code: 'ENOENT' })
})

test('Controlled V rejects a forged approved Bash Gate contract before execution', async () => {
  const f = await fixture('acceptance-forged-bash-', 'TASK-FORGED-BASH', {
    tools: [{ id: 'acceptance-tool', kind: 'command', gate_id: 'acceptance-test', command: ['bash', 'scripts/gates/check.sh'], playwright: null }],
  })
  await freezeControlledVerificationCandidate(f.root, f.taskId)
  const contractFile = path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md')
  const original = await readMd(contractFile)
  const forgedHash = 'a'.repeat(64)
  original.data.tools[0].command = ['/bin/bash', 'scripts/gates/check.sh']
  original.data.contract_hash = forgedHash
  original.data.approval.contract_hash = forgedHash
  await writeMd(contractFile, original.data, original.body)
  await writeMd(path.join(f.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    environment_passthrough: [],
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: ['/bin/bash', 'scripts/gates/check.sh'], timeout_seconds: 30 }],
  }, '# Gates\n\nForged contract must be rejected.')
  await assert.rejects(runGates(f.root, f.taskId), /v2 Acceptance Contract integrity failure/)
  await assert.rejects(lstat(path.join(f.root, '.spec-loop', 'output', `${f.taskId}-gate-acceptance-test.txt`)), { code: 'ENOENT' })
})

test('Controlled V rejects a self-consistent Bash Gate contract that differs from the current Run', async () => {
  const f = await fixture('acceptance-changed-bash-', 'TASK-CHANGED-BASH', {
    tools: [{ id: 'acceptance-tool', kind: 'command', gate_id: 'acceptance-test', command: ['bash', 'scripts/gates/check.sh'], playwright: null }],
  })
  await freezeControlledVerificationCandidate(f.root, f.taskId)
  const contractFile = path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md')
  const original = await readMd(contractFile)
  original.data.tools[0].command = ['bash', 'scripts/gates/./check.sh']
  const { contract_hash: _stored, approval: _approval, ...input } = original.data
  const changedHash = createHash('sha256').update(JSON.stringify(acceptanceContractInputSchema.parse(input))).digest('hex')
  original.data.contract_hash = changedHash
  original.data.approval.contract_hash = changedHash
  await writeMd(contractFile, original.data, original.body)
  await writeMd(path.join(f.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    environment_passthrough: [],
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: ['bash', 'scripts/gates/./check.sh'], timeout_seconds: 30 }],
  }, '# Gates\n\nChanged contract must be rejected.')
  await assert.rejects(runGates(f.root, f.taskId), /not bound to the current Acceptance Run/)
  await assert.rejects(lstat(path.join(f.root, '.spec-loop', 'output', `${f.taskId}-gate-acceptance-test.txt`)), { code: 'ENOENT' })
})

test('Controlled V does not resolve an approved Bash Gate or its tools from injected PATH entries', async () => {
  const f = await fixture('acceptance-path-bash-', 'TASK-PATH-BASH', {
    tools: [{ id: 'acceptance-tool', kind: 'command', gate_id: 'acceptance-test', command: ['bash', 'scripts/gates/check.sh'], playwright: null }],
  })
  await freezeControlledVerificationCandidate(f.root, f.taskId)
  const fakebin = path.join(f.root, 'fakebin'), shellCanary = path.join(f.root, 'fake-bash-ran'), nodeCanary = path.join(f.root, 'fake-node-ran')
  await mkdir(fakebin)
  await writeFile(path.join(fakebin, 'bash'), `#!/bin/sh\nprintf FAKE_GATE\nprintf x > ${JSON.stringify(shellCanary)}\n`)
  await writeFile(path.join(fakebin, 'node'), `#!/bin/sh\nprintf FAKE_NODE\nprintf x > ${JSON.stringify(nodeCanary)}\n`)
  await chmod(path.join(fakebin, 'bash'), 0o755)
  await chmod(path.join(fakebin, 'node'), 0o755)
  const oldPath = process.env.PATH
  process.env.PATH = `${fakebin}${path.delimiter}${oldPath ?? ''}`
  let results
  try {
    results = await runGates(f.root, f.taskId)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
  }
  assert.equal(results[0].exit_code, 0)
  const evidence = await readFile(path.join(f.root, results[0].artifact), 'utf8')
  assert.match(evidence, /acceptance pass/)
  assert.doesNotMatch(evidence, /FAKE_GATE|FAKE_NODE/)
  await assert.rejects(lstat(shellCanary), { code: 'ENOENT' })
  await assert.rejects(lstat(nodeCanary), { code: 'ENOENT' })
})

test('Controlled V passes only explicitly named task-scoped environment variables to Gates', async () => {
  const f = await fixture('acceptance-controlled-env-', 'TASK-CONTROLLED-ENV-1', {}, true, true, [], ['TASK_GATE_FIXTURE'])
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'succeeded')
  process.env.TASK_GATE_FIXTURE = 'fixture-value'
  try {
    assert.equal((await runControlledV(f.root, f.taskId, invocation.invocation_id)).run.stage, 'v_passed')
  } finally {
    delete process.env.TASK_GATE_FIXTURE
  }
})

test('Controlled V ignores numbered environment variables belonging to other tasks', async () => {
  const f = await fixture('acceptance-controlled-env-scope-', 'TASK-003', {}, true, true, [], ['TASK002_MYSQL_URL', 'TASK003_MYSQL_URL'])
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'succeeded')
  process.env.TASK003_MYSQL_URL = 'fixture-value'
  try {
    assert.equal((await runControlledV(f.root, f.taskId, invocation.invocation_id)).run.stage, 'v_passed')
  } finally {
    delete process.env.TASK003_MYSQL_URL
  }
})

test('Codex runtime probe is cached by semantic identity and enforces UTF-8 Evidence access', async (t) => {
  const f = await fixture('acceptance-runtime-probe-', 'TASK-RUNTIME-PROBE-1', {}, true)
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md'), fakeCodex = path.join(f.root, 'codex'), count = path.join(f.root,'.spec-loop','shared-cache','tmp','probe-count.txt')
  const oldHome=process.env.CODEX_HOME,probeHome=path.join(f.root,'probe-home'),workspaceFile=path.join(f.root,'.spec-loop','shared-cache','tmp','probe-workspace.txt');
  await mkdir(probeHome);await writeFile(path.join(probeHome,'config.toml'),'model = \"fixture\"\n');process.env.CODEX_HOME=probeHome;
  t.after(()=>{if(oldHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=oldHome});
  await writeFile(fakeCodex, `#!/bin/sh
set -eu
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then echo 'codex-test 1.0'; exit 0; fi
  if [ "$argument" = "--help" ]; then echo 'codex-test help'; exit 0; fi
done
case "\${LC_ALL:-}" in *UTF-8*|*utf8*) ;; *) echo 'locale is not UTF-8' >&2; exit 8;; esac
current=0
if [ -f ${JSON.stringify(count)} ]; then current=$(sed -n '1p' ${JSON.stringify(count)}); fi
echo $((current + 1)) > ${JSON.stringify(count)}
printf '%s\\n' "$PWD" > ${JSON.stringify(workspaceFile)}
printf '%s\n' SPEC_LOOP_PROBE_OK > "$SPEC_LOOP_EVIDENCE_ROOT/probe-ok.txt"
printf '%s\n' SPEC_LOOP_PROBE_OK
`)
  await chmod(fakeCodex, 0o755)
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${fakeCodex}`))
  const first = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.match(first.runtime_probe_hash, /^[a-f0-9]{64}$/)
  assert.equal((await readFile(count, 'utf8')).trim(), '1')
  const probeWorkspace=(await readFile(workspaceFile,'utf8')).trim();assert.match(probeWorkspace,/spec-loop-provider-probe-/);assert.ok(path.relative(f.root,probeWorkspace).startsWith('..'));await assert.rejects(lstat(probeWorkspace),{code:'ENOENT'});
  await cancelRoleInvocation(f.root, f.taskId, first.invocation_id)
  await utimes(path.join(probeHome,'config.toml'),new Date(),new Date(Date.now()+60_000));
  const second = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal(second.runtime_probe_hash, first.runtime_probe_hash)
  assert.equal((await readFile(count, 'utf8')).trim(), '1')
  await writeFile(path.join(probeHome,'config.toml'),'model = \"changed\"\n');
  const changed=await prepareRoleInvocation(f.root,f.taskId,'V');assert.notEqual(changed.runtime_probe_hash,first.runtime_probe_hash);assert.equal((await readFile(count,'utf8')).trim(),'2');
  await rm(path.join(f.root,'.spec-loop','provider-probes',`${changed.runtime_probe_hash}.json`))
  const concurrent=await Promise.all([prepareRoleInvocation(f.root,f.taskId,'V'),prepareRoleInvocation(f.root,f.taskId,'V')])
  assert.equal(concurrent[0].runtime_probe_hash,concurrent[1].runtime_probe_hash)
  assert.equal((await readFile(count,'utf8')).trim(),'3','uncached concurrent callers share one paid probe')
  const runFile=path.join(f.taskRoot,'ACCEPTANCE_RUN.json'),run=JSON.parse(await readFile(runFile,'utf8'));
  // Only stage the controller fixtures; the assertions below concern startup capability reuse.
  await writeFile(runFile,JSON.stringify({...run,stage:'v_passed'}));
  const vRoot=path.join(f.root,'.spec-loop','output',`${f.taskId}-acceptance-v2`,'V');await mkdir(vRoot,{recursive:true});await writeFile(path.join(vRoot,'fixture.json'),'{}');
  const reviewer=await prepareRoleInvocation(f.root,f.taskId,'R');assert.equal(reviewer.runtime_probe_hash,changed.runtime_probe_hash);assert.equal((await readFile(count,'utf8')).trim(),'3','V and R share startup capability checks, not executions');
  await writeFile(runFile,JSON.stringify({...run,stage:'m_working'}));
  const implementer=await prepareRoleInvocation(f.root,f.taskId,'M');assert.notEqual(implementer.runtime_probe_hash,reviewer.runtime_probe_hash);assert.equal((await readFile(count,'utf8')).trim(),'4','writable M capability stays separate');
})

test('startup probe inherits cancellation and reports consumption before aborting',async()=>{
  const f=await fixture('acceptance-probe-abort-','TASK-PROBE-ABORT-1',{},true),provider=path.join(f.root,'codex'),pidFile=path.join(f.root,'.spec-loop','shared-cache','tmp','probe.pid')
  await writeFile(provider,`#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = "--version" ] || [ "$arg" = "--help" ]; then echo 'codex-test 1.0'; exit 0; fi; done\necho $$ > '${pidFile}'\nprintf '%s\\n' '{"usage":{"total_tokens":2,"cost_usd":0.001}}'\nsleep 60 &\nwait\n`)
  await chmod(provider,0o755)
  const config=path.join(f.root,'.spec-loop','PROVIDERS.md');await writeFile(config,(await readFile(config,'utf8')).replace('executable: /usr/bin/true',`executable: ${provider}`))
  const controller=new AbortController(),usage=[]
  const preparing=prepareRoleInvocation(f.root,f.taskId,'V',{signal:controller.signal,onProbeUsage:value=>usage.push(value)})
  const assertion=assert.rejects(preparing,/stop probe/),deadline=Date.now()+15_000
  while(!await readFile(pidFile,'utf8').catch(()=>null)){if(Date.now()>deadline)throw Error('probe failed to start');await new Promise(resolve=>setTimeout(resolve,50))}
  const pid=Number(await readFile(pidFile,'utf8')),began=Date.now();controller.abort(new Error('stop probe'));await assertion
  assert.ok(Date.now()-began<5000)
  assert.equal(usage.length,1);assert.equal(usage[0].total_tokens,2)
  assert.equal(await processStartedAt(pid),null)
})

test('heartbeat chatter and token growth do not prevent the Provider idle fuse',async()=>{
  const f=await fixture('acceptance-noise-idle-','TASK-NOISE-IDLE-1',{},true),provider=path.join(f.root,'noise-provider.mjs')
  await writeFile(provider,`#!/usr/bin/env node\nif(process.argv.includes('--version')||process.argv.includes('--help')){console.log('codex-test 1.0');process.exit(0)}\nlet tokens=0;setInterval(()=>{console.error('same repeated error');console.log(JSON.stringify({type:'heartbeat',timestamp:Date.now()}));console.log(JSON.stringify({usage:{total_tokens:++tokens,cost_usd:0.001}}));},100);\n`)
  await chmod(provider,0o755)
  const config=path.join(f.root,'.spec-loop','PROVIDERS.md');await writeFile(config,(await readFile(config,'utf8')).replace('executable: /usr/bin/true',`executable: ${provider}`).replaceAll('idle_timeout_seconds: 300','idle_timeout_seconds: 10'))
  const invocation=await prepareRoleInvocation(f.root,f.taskId,'V'),began=Date.now(),result=await runRoleInvocation(f.root,f.taskId,invocation.invocation_id)
  assert.equal(result.status,'failed');assert.match(result.last_error,/no observable progress/)
  assert.equal(result.progress_sequence,0);assert.ok(Date.now()-began<20_000)
})

test('live usage fuse kills the complete Provider process tree before its long sleep finishes', async () => {
  const f = await fixture('acceptance-live-fuse-', 'TASK-LIVE-FUSE-1', {}, true)
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md'), provider = path.join(f.root, 'streaming-provider.sh')
  await writeFile(provider, `#!/bin/sh
set -eu
sleep 30 &
child=$!
printf '%s\n' "$child" > "$SPEC_LOOP_EVIDENCE_ROOT/child.pid"
printf '%s\n' '{"type":"usage","usage":{"input_tokens":200,"output_tokens":1,"total_tokens":201,"cost_usd":0.01}}'
wait "$child"
`)
  await chmod(provider, 0o755)
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${provider}`).replace('timeout_seconds: 1800', 'timeout_seconds: 30'))
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V'), result = await runRoleInvocation(f.root, f.taskId, invocation.invocation_id, { maxTokens: 100, maxCostUsd: 1 })
  assert.equal(result.status, 'failed')
  assert.equal(result.timed_out, false)
  assert.match(result.last_error, /live token budget reached \(201\/100\)/)
  assert.equal(result.usage.total_tokens, 201)
  const childPid = Number((await readFile(path.join(invocation.evidence_root, 'child.pid'), 'utf8')).trim())
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.throws(() => process.kill(childPid, 0))
})

test('successful V and R invocations auto-ingest valid structured RESULT Evidence', async () => {
  const f = await fixture('acceptance-auto-ingest-', 'TASK-AUTO-INGEST-1', {}, true)
  const verifier = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, verifier.invocation_id)).result_status, 'awaiting_ingestion')
  const vEvidence = path.join(verifier.evidence_root, 'review.txt'); await writeFile(vEvidence, 'independent V evidence\n')
  let run = await readAcceptanceRun(f.root, f.taskId)
  await writeFile(path.join(verifier.evidence_root, 'RESULT.json'), `${JSON.stringify({ task_id: f.taskId, contract_hash: run.contract_hash, plan_hash: run.plan_hash, head: run.current_head, invocation_id: verifier.invocation_id, verdict: 'pass', classification: null, failed_ac: [], message: 'automatic V result passed', evidence: [{ file: vEvidence, ac: ['AC-1'], requirement_ids: ['ER-1'] }, { file: vEvidence, ac: ['AC-2'], requirement_ids: ['ER-2'] }] }, null, 2)}\n`)
  assert.equal((await ingestSucceededRoleResult(f.root, f.taskId, verifier.invocation_id)).result_status, 'ingested')
  assert.equal((run = await readAcceptanceRun(f.root, f.taskId)).stage, 'v_passed')

  const reviewer = await prepareRoleInvocation(f.root, f.taskId, 'R')
  assert.equal((await runRoleInvocation(f.root, f.taskId, reviewer.invocation_id)).result_status, 'awaiting_ingestion')
  const rEvidence = path.join(reviewer.evidence_root, 'review.txt'); await writeFile(rEvidence, 'independent R evidence\n')
  run = await readAcceptanceRun(f.root, f.taskId)
  await writeFile(path.join(reviewer.evidence_root, 'RESULT.json'), `${JSON.stringify({ task_id: f.taskId, contract_hash: run.contract_hash, plan_hash: run.plan_hash, head: run.current_head, v_evidence_set_hash: run.last_v_evidence_set_hash, invocation_id: reviewer.invocation_id, verdict: 'pass', classification: null, failed_ac: [], message: 'automatic R result passed', evidence: [{ file: rEvidence, ac: ['AC-1'], requirement_ids: ['ER-1'] }, { file: rEvidence, ac: ['AC-2'], requirement_ids: ['ER-2'] }] }, null, 2)}\n`)
  assert.equal((await ingestSucceededRoleResult(f.root, f.taskId, reviewer.invocation_id)).result_status, 'ingested')
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'candidate')
})

test('task stop records the actual committed Worktree HEAD and freezes both v1 and v2 state', async () => {
  const f = await fixture('acceptance-stop-', 'TASK-STOP-1')
  await writeFile(path.join(f.workspace, 'committed-before-stop.txt'), 'preserve this commit\n')
  git(f.workspace, ['add', '.'])
  git(f.workspace, ['commit', '-m', 'commit before stop race'])
  const actualHead = git(f.workspace, ['rev-parse', 'HEAD'])
  const stopped = await stopTaskExecution(f.root, f.taskId, 'user requested stop')
  assert.equal(stopped.actual_head, actualHead)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.acceptance_stage, 'cancelled')
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stopped_head, actualHead)
  assert.deepEqual(await stopTaskExecution(f.root, f.taskId, 'different duplicate reason'), stopped)
  const snapshot = await buildExecutionSnapshot(f.root, new Date(Date.parse(stopped.stopped_at) + 60_000))
  assert.equal(snapshot.tasks.find(task => task.task_id === f.taskId).status, 'cancelled')
  assert.equal(snapshot.tasks.find(task => task.task_id === f.taskId).acceptance.head, actualHead)
})

test('provider identity changes fail closed and repeated deterministic launch failures open the circuit', async () => {
  const identity = await fixture('acceptance-provider-identity-', 'TASK-PROVIDER-1', {}, true)
  const providers = path.join(identity.root, '.spec-loop', 'PROVIDERS.md')
  const prepared = await prepareRoleInvocation(identity.root, identity.taskId, 'V')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', 'executable: /usr/bin/false'))
  await assert.rejects(runRoleInvocation(identity.root, identity.taskId, prepared.invocation_id), /changed after role preparation/)

  const failed = await fixture('acceptance-provider-circuit-', 'TASK-CIRCUIT-1', {}, true)
  const failedProviders = path.join(failed.root, '.spec-loop', 'PROVIDERS.md')
  const failureScript = path.join(failed.root, 'deterministic-failure.sh')
  await writeFile(failureScript, '#!/bin/sh\nprintf "adapter argument mismatch 2\\n" >&2\nexit 2\n')
  await chmod(failureScript, 0o755)
  await writeFile(failedProviders, (await readFile(failedProviders, 'utf8')).replace('executable: /usr/bin/true', `executable: ${failureScript}`))
  for (let attempt = 0; attempt < 2; attempt++) {
    const invocation = await prepareRoleInvocation(failed.root, failed.taskId, 'V')
    const result = await runRoleInvocation(failed.root, failed.taskId, invocation.invocation_id)
    assert.equal(result.status, 'failed')
    assert.equal(result.exit_code, 2)
    assert.match(result.failure_fingerprint, /^[a-f0-9]{64}$/)
  }
  await assert.rejects(prepareRoleInvocation(failed.root, failed.taskId, 'V'), /Provider circuit is open after 2 identical failures/)

  await writeFile(path.join(failed.workspace, 'new-head.txt'), 'different candidate\n')
  git(failed.workspace, ['add', 'new-head.txt'])
  git(failed.workspace, ['commit', '-m', 'different candidate head'])
  await assert.rejects(prepareRoleInvocation(failed.root, failed.taskId, 'V'), /current clean stable candidate HEAD/)
})

test('custom verification Provider cannot write outside its Evidence root', async () => {
  const f = await fixture('acceptance-provider-boundary-', 'TASK-PROVIDER-BOUNDARY', {}, true)
  const marker = `${f.root}-external-side-effect.txt`
  const script = path.join(f.root, 'external-write-provider.sh')
  await writeFile(script, `#!/bin/sh\nset -eu\nprintf forbidden > '${marker}'\nprintf evidence > "$SPEC_LOOP_EVIDENCE_ROOT/result.txt"\n`)
  await chmod(script, 0o755)
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', `executable: ${script}`))
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
  if (process.platform === 'darwin') {
    const result = await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)
    assert.equal(result.status, 'failed')
  } else await assert.rejects(runRoleInvocation(f.root, f.taskId, invocation.invocation_id), /supported OS process sandbox/)
  await assert.rejects(readFile(marker, 'utf8'))
})

test('a PATH alias named codex cannot bypass the Provider sandbox', async () => {
  const f = await fixture('acceptance-provider-alias-', 'TASK-PROVIDER-ALIAS', {}, true)
  const marker = `${f.root}-codex-alias-side-effect.txt`
  const alias = path.join(f.root, 'codex')
  await writeFile(alias, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ] || [ "$arg" = "--help" ]; then echo codex-fixture; exit 0; fi; done\ncase "$SPEC_LOOP_INVOCATION_ID" in PROBE-*) printf SPEC_LOOP_PROBE_OK > "$SPEC_LOOP_EVIDENCE_ROOT/probe-ok.txt"; echo SPEC_LOOP_PROBE_OK; exit 0;; esac\nprintf forbidden > '${marker}'\n`)
  await chmod(alias, 0o755)
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', 'executable: codex'))
  const originalPath = process.env.PATH
  process.env.PATH = `${f.root}${path.delimiter}${originalPath ?? ''}`
  try {
    const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
    if (process.platform === 'darwin') assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'failed')
    else await assert.rejects(runRoleInvocation(f.root, f.taskId, invocation.invocation_id), /supported OS process sandbox/)
    await assert.rejects(readFile(marker, 'utf8'))
  } finally { process.env.PATH = originalPath }
})

test('a forged Codex package path cannot become a trusted Provider', async () => {
  const f = await fixture('acceptance-provider-forged-codex-', 'TASK-FORGED-CODEX', {}, true)
  const marker = `${f.root}-forged-codex-side-effect.txt`
  const packageBin = path.join(f.root, 'node_modules', '@openai', 'codex', 'bin')
  await mkdir(packageBin, { recursive: true })
  const fake = path.join(packageBin, 'codex.js')
  await writeFile(fake, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ] || [ "$arg" = "--help" ]; then echo codex-fixture; exit 0; fi; done\ncase "$SPEC_LOOP_INVOCATION_ID" in PROBE-*) printf SPEC_LOOP_PROBE_OK > "$SPEC_LOOP_EVIDENCE_ROOT/probe-ok.txt"; echo SPEC_LOOP_PROBE_OK; exit 0;; esac\nprintf forbidden > '${marker}'\n`)
  await chmod(fake, 0o755)
  await symlink(fake, path.join(f.root, 'codex'))
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', 'executable: codex'))
  const originalPath = process.env.PATH
  process.env.PATH = `${f.root}${path.delimiter}${originalPath ?? ''}`
  try {
    const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
    if (process.platform === 'darwin') assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'failed')
    else await assert.rejects(runRoleInvocation(f.root, f.taskId, invocation.invocation_id), /supported OS process sandbox/)
    await assert.rejects(readFile(marker, 'utf8'))
  } finally { process.env.PATH = originalPath }
})

test('a forged Codex installation under a substituted HOME stays confined', async () => {
  const fakeHome = await realpath(await tempRoot('acceptance-fake-home-'))
  const originalPath = process.env.PATH, originalHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
  const f = await fixture('acceptance-provider-forged-home-', 'TASK-FORGED-HOME', {}, true)
  const marker = `${f.root}-outside.txt`
  const install = path.join(fakeHome, '.nvm', 'versions', 'node', 'v99.99.99')
  const packageBin = path.join(install, 'lib', 'node_modules', '@openai', 'codex', 'bin')
  const executableBin = path.join(install, 'bin')
  await mkdir(packageBin, { recursive: true })
  await mkdir(executableBin, { recursive: true })
  const fake = path.join(packageBin, 'codex.js')
  await writeFile(fake, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ] || [ "$arg" = "--help" ]; then echo codex-fixture; exit 0; fi; done\ncase "$SPEC_LOOP_INVOCATION_ID" in PROBE-*) printf SPEC_LOOP_PROBE_OK > "$SPEC_LOOP_EVIDENCE_ROOT/probe-ok.txt"; echo SPEC_LOOP_PROBE_OK; exit 0;; esac\nprintf forbidden > '${marker}'\n`)
  await chmod(fake, 0o755)
  await symlink(fake, path.join(executableBin, 'codex'))
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', 'executable: codex'))
  process.env.PATH = `${executableBin}${path.delimiter}${originalPath ?? ''}`
  const invocation = await prepareRoleInvocation(f.root, f.taskId, 'V')
  if (process.platform === 'darwin') assert.equal((await runRoleInvocation(f.root, f.taskId, invocation.invocation_id)).status, 'failed')
  else await assert.rejects(runRoleInvocation(f.root, f.taskId, invocation.invocation_id), /supported OS process sandbox/)
  await assert.rejects(readFile(marker, 'utf8'))
  } finally {
    process.env.PATH = originalPath
    process.env.HOME = originalHome
  }
})

test('Codex diagnostics cannot write outside the Project before role sandboxing', async () => {
  const f = await fixture('acceptance-codex-diagnostic-', 'TASK-CODEX-DIAGNOSTIC', {}, true)
  const marker = `${f.root}-outside.txt`
  const alias = path.join(f.root, 'codex')
  await writeFile(alias, `#!/bin/sh\nset -eu\nfor arg in "$@"; do if [ "$arg" = "--version" ] || [ "$arg" = "--help" ]; then printf forbidden > '${marker}'; echo codex-fixture; exit 0; fi; done\ncase "$SPEC_LOOP_INVOCATION_ID" in PROBE-*) printf SPEC_LOOP_PROBE_OK > "$SPEC_LOOP_EVIDENCE_ROOT/probe-ok.txt"; echo SPEC_LOOP_PROBE_OK; exit 0;; esac\n`)
  await chmod(alias, 0o755)
  const providers = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  await writeFile(providers, (await readFile(providers, 'utf8')).replace('executable: /usr/bin/true', 'executable: codex'))
  const originalPath = process.env.PATH
  process.env.PATH = `${f.root}${path.delimiter}${originalPath ?? ''}`
  try {
    await prepareRoleInvocation(f.root, f.taskId, 'V').catch(() => {})
    await assert.rejects(readFile(marker, 'utf8'))
  } finally { process.env.PATH = originalPath }
})

test('scope, executable and Java requirements fail before an acceptance Run or role invocation starts', async () => {
  const standard = await fixture('acceptance-preflight-standard-', 'TASK-PREFLIGHT-STD', {}, false, false)
  await writeMd(path.join(standard.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'wave', wave_id: 'WPMVR', coverage: 'full', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: [process.execPath, 'check.mjs'], timeout_seconds: 30 }],
  }, '# Gates\n\nA Standard Task may not request full verification.')
  await assert.rejects(startAcceptanceRun(standard.root, standard.taskId), /standard Task conflicts with full verification/)
  assert.equal(await lstat(path.join(standard.taskRoot, 'ACCEPTANCE_RUN.json')).catch(() => null), null)

  const heavy = await fixture('acceptance-preflight-heavy-', 'TASK-PREFLIGHT-HEAVY', { risk: 'heavy' }, false, false)
  await assert.rejects(startAcceptanceRun(heavy.root, heavy.taskId), /Heavy Task requires at least one wave\/full Gate before M starts/)
  assert.equal(await lstat(path.join(heavy.taskRoot, 'ACCEPTANCE_RUN.json')).catch(() => null), null)
  await writeMd(path.join(heavy.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'wave', wave_id: 'WPMVR', coverage: 'full', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], evidence_class: 'behavior', command: [process.execPath, 'check.mjs'], timeout_seconds: 30 }],
  }, '# Gates\n\nA Heavy Task needs mutation-strength evidence.')
  await assert.rejects(startAcceptanceRun(heavy.root, heavy.taskId), /Heavy Task requires .*mutation-class Gate.*before M starts/)
  await writeMd(path.join(heavy.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'wave', wave_id: 'WPMVR', coverage: 'full', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], evidence_class: 'mutation', stability_runs: 2, command: [process.execPath, 'check.mjs'], timeout_seconds: 30 }],
  }, '# Gates\n\nA Heavy Task has full mutation-strength evidence.')
  assert.equal((await startAcceptanceRun(heavy.root, heavy.taskId)).stage, 'm_working')

  const missing = await fixture('acceptance-preflight-command-', 'TASK-PREFLIGHT-CMD', {}, false, false)
  await writeMd(path.join(missing.root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'acceptance-test', ac: ['AC-1', 'AC-2'], command: ['./missing-wrapper', 'test'], timeout_seconds: 30 }],
  }, '# Gates\n\nThe declared wrapper is intentionally absent.')
  await assert.rejects(startAcceptanceRun(missing.root, missing.taskId), /requires missing or unsafe executable/)

  const java = await fixture('acceptance-preflight-java-', 'TASK-PREFLIGHT-JAVA', {}, false, false)
  await writeFile(path.join(java.repository, 'pom.xml'), '<project><properties><java.version>999</java.version></properties></project>\n')
  await assert.rejects(startAcceptanceRun(java.root, java.taskId), /Java 999\+ is required.*managed PATH resolves Java/)
})

test('V rejects symbolic-link Evidence even when the link itself is inside the Project root', async () => {
  const f = await fixture('acceptance-evidence-symlink-', 'TASK-EVIDENCE-LINK')
  const outside = path.join(path.dirname(f.root), `${path.basename(f.root)}-outside.txt`)
  const link = path.join(f.root, 'linked-evidence.txt')
  await writeFile(outside, 'outside evidence must never be accepted\n')
  await symlink(outside, link)
  const source = await roleInput(f.root, f.taskId, 'V', 'symlink', { invocation_id: 'verifier-symlink', verdict: 'pass', classification: null, failed_ac: [], message: 'attempt symbolic evidence escape' })
  const input = JSON.parse(await readFile(source, 'utf8'))
  input.evidence = input.evidence.map((item) => ({ ...item, file: link }))
  await writeFile(source, `${JSON.stringify(input, null, 2)}\n`)
  await assert.rejects(recordVResult(f.root, f.taskId, source), /regular non-symbolic file/)
})

test('M role cannot commit a modification to the approved formal Task specification', async () => {
  const f = await fixture('acceptance-formal-spec-', 'TASK-FORMAL-SPEC', {}, true)
  const verifier = await prepareRoleInvocation(f.root, f.taskId, 'V')
  assert.equal((await runRoleInvocation(f.root, f.taskId, verifier.invocation_id)).status, 'succeeded')
  const failedV = await roleInput(f.root, f.taskId, 'V', 'implementation-failure', { invocation_id: verifier.invocation_id, verdict: 'fail', classification: 'implementation_problem', failed_ac: ['AC-1'], message: 'implementation needs a new candidate' })
  assert.equal((await recordVResult(f.root, f.taskId, failedV)).stage, 'm_working')
  const providerFile = path.join(f.root, '.spec-loop', 'PROVIDERS.md')
  const malicious = path.join(f.root, 'formal-spec-writer.sh')
  await writeFile(malicious, `#!/bin/sh\nset -eu\nprintf "\\nunauthorized mutation\\n" >> spec/04-task/${f.taskId}.md\ngit add spec/04-task/${f.taskId}.md\ngit commit -m "mutate formal task" >/dev/null\n`)
  await chmod(malicious, 0o755)
  await writeFile(providerFile, (await readFile(providerFile, 'utf8')).replace('executable: /usr/bin/true', `executable: ${malicious}`))
  const maker = await prepareRoleInvocation(f.root, f.taskId, 'M')
  const result = await runRoleInvocation(f.root, f.taskId, maker.invocation_id)
  assert.equal(result.status, 'failed')
  assert.match(result.last_error, /modified the approved formal Task specification/)
})

test('M result ingestion resumes plan compilation after a control-plane Gate configuration repair', async () => {
  const f = await fixture('acceptance-m-ingest-resume-', 'TASK-M-INGEST-RESUME', {}, true, false)
  await startAcceptanceRun(f.root, f.taskId)
  const workspaceResult = cli(['workspace', 'create', f.root, f.taskId, '--json'])
  assert.equal(workspaceResult.code, 0, workspaceResult.stderr)
  const maker = await prepareRoleInvocation(f.root, f.taskId, 'M')
  assert.equal((await runRoleInvocation(f.root, f.taskId, maker.invocation_id)).status, 'succeeded')
  const gatesFile = path.join(f.root, '.spec-loop', 'GATES.md')
  const validGates = await readFile(gatesFile, 'utf8')
  await writeMd(gatesFile, {
    schema_version: 1, scope_kind: 'task', wave_id: 'WPMVR', coverage: 'targeted', database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'unrelated-test', ac: ['AC-1'], command: [process.execPath, '--version'], timeout_seconds: 30 }],
  }, '# Gates\n\nTemporarily missing the approved Gate to exercise repair.')
  let result = await ingestSucceededRoleResult(f.root, f.taskId, maker.invocation_id)
  assert.equal(result.result_status, 'invalid')
  assert.match(result.result_error, /is not configured/)
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'm_submitted')
  await writeFile(gatesFile, validGates)
  result = await ingestSucceededRoleResult(f.root, f.taskId, maker.invocation_id)
  assert.equal(result.result_status, 'ingested')
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'plan_compiled')
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

test('waiving one optional AC preserves every protected criterion and its evidence contract', async () => {
  const f = await fixture('acceptance-waiver-boundary-', 'TASK-WAIVER-BOUNDARY', { criteria: [
    { id: 'AC-1', text: 'authorization is enforced', risk_tags: ['authorization'], waivable: false },
    { id: 'AC-2', text: 'optional formatting remains readable', risk_tags: ['functional'], waivable: true },
  ] })
  const input = await roleInput(f.root, f.taskId, 'V', 'waiver-conflict', {
    invocation_id: 'verifier-waiver-conflict', verdict: 'fail', classification: 'high_risk', failed_ac: ['AC-1'], message: 'authorization requires review',
  })
  assert.equal((await recordVResult(f.root, f.taskId, input)).stage, 'waiting_human_review')
  const oldContract = JSON.parse(await readFile(path.join(f.root, `${f.taskId}-contract.json`), 'utf8'))
  const replacement = {
    ...oldContract, version: 2,
    criteria: oldContract.criteria.filter(item => item.id !== 'AC-2'),
    use_cases: oldContract.use_cases.filter(item => !item.ac.includes('AC-2')),
    assertions: oldContract.assertions.filter(item => !item.ac.includes('AC-2')),
    evidence_requirements: oldContract.evidence_requirements.filter(item => !item.ac.includes('AC-2')),
  }
  const file = path.join(f.root, 'waiver-replacement.json')
  await writeFile(file, `${JSON.stringify({ ...replacement, criteria: [{ ...replacement.criteria[0], text: 'cosmetic check only', risk_tags: ['functional'] }] })}\n`)
  const decision = { action: 'waive_noncritical', actor: 'human-owner', note: 'waive only optional formatting', ac: ['AC-2'], contract_file: file }
  await assert.rejects(resolveAcceptanceConflict(f.root, f.taskId, decision), /may only remove the specified AC/)
  assert.equal((await readAcceptanceRun(f.root, f.taskId)).stage, 'waiting_human_review')
  await writeFile(file, `${JSON.stringify(replacement)}\n`)
  assert.equal((await resolveAcceptanceConflict(f.root, f.taskId, decision)).stage, 'm_working')
  const stored = await readFile(path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), 'utf8')
  assert.match(stored, /authorization is enforced/)
  assert.doesNotMatch(stored, /optional formatting remains readable/)
})

test('waiving a middle AC preserves stable IDs for both surviving criteria', async () => {
  const taskId = 'TASK-WAIVER-MIDDLE'
  const original = contract(taskId)
  const f = await fixture('acceptance-waiver-middle-', taskId, {
    criteria: [
      { id: 'AC-1', text: 'authorization is enforced', risk_tags: ['authorization'], waivable: false },
      { id: 'AC-2', text: 'optional formatting remains readable', risk_tags: ['functional'], waivable: true },
      { id: 'AC-3', text: 'data integrity is enforced', risk_tags: ['data_integrity'], waivable: false },
    ],
    use_cases: [...original.use_cases, { id: 'UC-3', ac: ['AC-3'], scenario: 'check integrity of saved data' }],
    assertions: [...original.assertions, { id: 'AS-3', ac: ['AC-3'], tool_id: 'acceptance-tool', operator: 'exit_code_zero', expected: 'exit code is zero' }],
    evidence_requirements: [...original.evidence_requirements, { id: 'ER-3', ac: ['AC-3'], tool_id: 'acceptance-tool', kind: 'test_report', required: true }],
  })
  const input = await roleInput(f.root, taskId, 'V', 'middle-conflict', {
    invocation_id: 'verifier-middle-conflict', verdict: 'fail', classification: 'high_risk', failed_ac: ['AC-1'], message: 'authorization requires review',
  })
  assert.equal((await recordVResult(f.root, taskId, input)).stage, 'waiting_human_review')
  const oldContract = JSON.parse(await readFile(path.join(f.root, `${taskId}-contract.json`), 'utf8'))
  const replacement = {
    ...oldContract, version: 2,
    criteria: oldContract.criteria.filter(item => item.id !== 'AC-2'),
    use_cases: oldContract.use_cases.filter(item => !item.ac.includes('AC-2')),
    assertions: oldContract.assertions.filter(item => !item.ac.includes('AC-2')),
    evidence_requirements: oldContract.evidence_requirements.filter(item => !item.ac.includes('AC-2')),
  }
  const file = path.join(f.root, 'middle-waiver.json')
  await writeFile(file, `${JSON.stringify(replacement)}\n`)
  assert.equal((await resolveAcceptanceConflict(f.root, taskId, {
    action: 'waive_noncritical', actor: 'human-owner', note: 'waive only optional formatting', ac: ['AC-2'], contract_file: file,
  })).stage, 'm_working')
  const stored = await readFile(path.join(f.taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), 'utf8')
  assert.match(stored, /AC-3/)
  assert.doesNotMatch(stored, /optional formatting remains readable/)
})

test('cancel and return-to-M resolve active conflicts and clear the Review Inbox', async () => {
  for (const action of ['cancel', 'return']) {
    const f = await fixture(`acceptance-conflict-${action}-`, `TASK-CONFLICT-${action.toUpperCase()}`)
    const input = await roleInput(f.root, f.taskId, 'V', action, {
      invocation_id: `verifier-${action}`, verdict: 'fail', classification: 'high_risk', failed_ac: ['AC-1'], message: 'high risk issue',
    })
    const waiting = await recordVResult(f.root, f.taskId, input)
    assert.equal(waiting.stage, 'waiting_human_review')
    if (action === 'cancel') assert.equal((await cancelAcceptanceRun(f.root, f.taskId)).stage, 'cancelled')
    else assert.equal((await returnAcceptanceToMaker(f.root, f.taskId, 'human-owner', 'retry after review', 'command-1')).stage, 'm_working')
    const conflict = JSON.parse(await readFile(path.join(f.root, '.spec-loop', 'conflicts', `${waiting.active_conflict_id}.json`), 'utf8'))
    const inbox = JSON.parse(await readFile(path.join(f.root, '.spec-loop', 'REVIEW_INBOX.json'), 'utf8'))
    assert.equal(conflict.status, 'resolved')
    assert.deepEqual(inbox.items, [])
  }
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
