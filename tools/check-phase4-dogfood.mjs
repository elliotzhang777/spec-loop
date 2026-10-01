import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readApprovedAcceptanceContract } from '../dist/acceptance-loop.js'
import { readRoleInvocation } from '../dist/role-orchestrator.js'

// Audit two real, approved Project Tasks and their managed Provider and
// Controller records. The Gate is read-only with respect to both Tasks.
const gitCommon = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
  cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
})
assert.equal(gitCommon.status, 0, gitCommon.stderr)
const root = path.dirname(gitCommon.stdout.trim())
const output = path.resolve(process.env.SPEC_LOOP_PHASE4_DOGFOOD_OUTPUT ??
  path.join(root, '.spec-loop/output/TASK-037-phase4-dogfood'))
await mkdir(output, { recursive: true })
const sha256 = value => createHash('sha256').update(value).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const evidenceRoot = path.join(root, '.spec-loop/output')
const evidenceFile = async (relative, taskId) => {
  assert.equal(typeof relative, 'string')
  assert.ok(relative.startsWith('.spec-loop/output/') ||
    relative.startsWith(`.spec-loop/tasks/${taskId.toLowerCase()}/reviews/`),
  `Evidence path is outside controlled Task records: ${relative}`)
  const file = path.resolve(root, relative)
  assert.ok(file.startsWith(`${path.join(root, '.spec-loop')}${path.sep}`), `Evidence escapes controlled Task records: ${relative}`)
  assert.ok((await lstat(file)).isFile(), `Evidence is not a regular file: ${relative}`)
  assert.equal(await realpath(file), file, `Evidence resolves through a symlink: ${relative}`)
  return { file: relative, sha256: sha256(await readFile(file)) }
}

async function roleReceipt(taskId, role, invocationId, binding) {
  const directory = path.join(evidenceRoot, `${taskId}-acceptance-v2`, role)
  const matches = (await readdir(directory)).filter(name => name.endsWith(`-${invocationId}.json`))
  assert.equal(matches.length, 1, `${taskId} ${role} must have exactly one current receipt`)
  const file = path.join(directory, matches[0]), raw = await readFile(file)
  const receipt = JSON.parse(raw.toString('utf8'))
  assert.equal(receipt.role, role)
  assert.equal(receipt.task_id, taskId)
  assert.equal(receipt.invocation_id, invocationId)
  assert.equal(receipt.verdict, 'pass')
  assert.deepEqual(receipt.failed_ac, [])
  for (const [key, value] of Object.entries(binding)) assert.equal(receipt[key], value, `${taskId} ${role} ${key} binding`)
  assert.ok(receipt.evidence.length > 0, `${taskId} ${role} Evidence missing`)
  for (const item of receipt.evidence) {
    const actual = await evidenceFile(item.file, taskId)
    assert.equal(actual.sha256, item.sha256, `${taskId} ${role} Evidence hash`)
  }
  return { receipt: path.relative(root, file), sha256: sha256(raw), evidence_count: receipt.evidence.length }
}

async function taskEvidence(taskId, expectedRisk) {
  const taskRoot = path.join(root, '.spec-loop/tasks', taskId.toLowerCase())
  const contract = await readApprovedAcceptanceContract(taskRoot)
  assert.equal(contract.risk, expectedRisk)
  assert.equal(contract.task_id, taskId)
  assert.ok(contract.approval.approved_by && contract.approval.contract_hash === contract.contract_hash)
  const run = await json(path.join(taskRoot, 'ACCEPTANCE_RUN.json'))
  assert.equal(run.stage, 'candidate', `${taskId} has not reached Candidate`)
  assert.equal(run.contract_hash, contract.contract_hash)
  const candidateFile = path.join(evidenceRoot, `${taskId}-acceptance-v2/CANDIDATE.json`)
  const candidateRaw = await readFile(candidateFile), candidate = JSON.parse(candidateRaw.toString('utf8'))
  for (const [key, value] of Object.entries({
    task_id: taskId, run_id: run.run_id, contract_hash: run.contract_hash,
    plan_hash: run.plan_hash, head: run.current_head,
    v_evidence_set_hash: run.last_v_evidence_set_hash,
    r_evidence_set_hash: run.last_r_evidence_set_hash,
  })) assert.equal(candidate[key], value, `${taskId} Candidate ${key} binding`)
  assert.equal(run.candidate_id, candidate.candidate_id)
  assert.ok(run.last_m_invocation && run.last_v_invocation && run.last_r_invocation)
  assert.notEqual(run.last_v_invocation, run.last_r_invocation)
  const invocations = {}
  for (const role of ['M', 'V', 'R']) {
    const invocationId = run[`last_${role.toLowerCase()}_invocation`]
    const invocation = await readRoleInvocation(root, taskId, invocationId)
    assert.equal(invocation.role, role)
    assert.equal(invocation.status, 'succeeded')
    assert.equal(invocation.result_status, 'ingested')
    invocations[role] = invocationId
  }
  const binding = { run_id: run.run_id, contract_hash: run.contract_hash,
    plan_hash: run.plan_hash, head: run.current_head }
  const makerFile = path.join(evidenceRoot, `${taskId}-acceptance-v2/M-${run.current_head.slice(0, 12)}.json`)
  const makerRaw = await readFile(makerFile), maker = JSON.parse(makerRaw.toString('utf8'))
  assert.equal(maker.head, run.current_head)
  assert.equal(maker.run_id, run.run_id)
  assert.ok(maker.self_test_evidence.length > 0)
  for (const item of maker.self_test_evidence) {
    const actual = await evidenceFile(item.file, taskId)
    assert.equal(actual.sha256, item.sha256, `${taskId} M self-test Evidence hash`)
  }
  const v = await roleReceipt(taskId, 'V', invocations.V, binding)
  const r = await roleReceipt(taskId, 'R', invocations.R,
    { ...binding, v_evidence_set_hash: run.last_v_evidence_set_hash })
  const gatesFile = path.join(evidenceRoot, `${taskId}-gates.json`)
  const gatesRaw = await readFile(gatesFile), gates = JSON.parse(gatesRaw.toString('utf8'))
  assert.ok(Array.isArray(gates) && gates.length > 0, `${taskId} controlled Gate records missing`)
  for (const gate of gates) {
    assert.equal(gate.task_id, taskId)
    assert.equal(gate.head, run.current_head, `${taskId} Gate ${gate.id} uses an old HEAD`)
    assert.equal(gate.exit_code, 0, `${taskId} Gate ${gate.id} failed`)
    assert.equal(gate.timed_out, false)
    const actual = await evidenceFile(gate.artifact, taskId)
    assert.equal(actual.sha256, gate.sha256, `${taskId} Gate ${gate.id} log hash`)
  }
  return {
    task_id: taskId, risk: expectedRisk, approved_by: contract.approval.approved_by,
    head: run.current_head, contract_hash: run.contract_hash, plan_hash: run.plan_hash,
    candidate_id: candidate.candidate_id, candidate_sha256: sha256(candidateRaw),
    invocations, maker_sha256: sha256(makerRaw), v, r,
    gates: { count: gates.length, sha256: sha256(gatesRaw), ids: gates.map(gate => gate.id) },
  }
}

const tasks = [await taskEvidence('TASK-049', 'standard'), await taskEvidence('TASK-029', 'heavy')]
const phaseRun = await json(path.join(root, '.spec-loop/tasks/task-037/ACCEPTANCE_RUN.json'))
const phaseHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).stdout.trim()
assert.equal(phaseRun.current_head, phaseHead, 'Dogfood Gate must bind the current Phase 4 candidate')
assert.ok(phaseRun.plan_hash && phaseRun.contract_hash, 'Phase 4 plan or Contract binding missing')
const report = { schema_version: 1, kind: 'phase4-real-standard-heavy-dogfood',
  candidate_head: phaseHead, acceptance_run_id: phaseRun.run_id,
  plan_hash: phaseRun.plan_hash, contract_hash: phaseRun.contract_hash,
  tasks, status: 'PASS', checked_at: new Date().toISOString() }
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ status: report.status, tasks: tasks.map(task => ({
  id: task.task_id, risk: task.risk, head: task.head, candidate: task.candidate_id, gates: task.gates.count,
})) }))
