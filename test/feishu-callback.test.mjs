import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { cli, fillContracts, fillRound, readMd, tempRoot, writeMd } from './helpers.mjs'
import { createConfirmationRequest, executeConfirmationRequest, listConfirmationRequests } from '../dist/connectors/feishu-confirmation.js'
import {
  acceptFeishuAction,
  acceptLocalConfirmationAction,
  createFeishuCardActionHandler,
  listFeishuActionInbox,
  processFeishuAction,
  reconcileFeishuActions,
} from '../dist/connectors/feishu-callback.js'
import { createLocalSpecLoopConfirmationController } from '../dist/connectors/feishu-controller.js'
import { listConfirmationDecisions } from '../dist/confirmation-decisions.js'
import { defaultFeishuConfig, FakeFeishuTransport, initFeishuConfig, runFeishuConnector } from '../dist/connectors/feishu.js'
import { initGateConfig } from '../dist/execution.js'

const tenant = '736588c9260f175c'
const project = 'PROJ-TEST'
const openId = 'ou_test_user'
const actor = 'zhangbo'
const digest = (character) => character.repeat(64)

async function projectRoot(enabled = true, requestTypes = ['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance']) {
  const root = await tempRoot('feishu-callback-')
  await mkdir(path.join(root, '.spec-loop'))
  const file = await initFeishuConfig(root)
  if (enabled) {
    await writeFile(file, JSON.stringify({
      ...defaultFeishuConfig(), enabled: true, tenant_key: tenant,
      targets: [{ project_id: project, receive_id_type: 'chat_id', receive_id: 'oc_test_chat' }],
      approvers: [{ project_id: project, open_id: openId, local_actor: actor, request_types: requestTypes }],
    }))
  }
  return root
}

function facts(type = 'verification') {
  return {
    scope_summary: '验证当前飞书动作的既定授权范围',
    evidence_summary: ['定向回调测试'],
    invalidation_summary: '候选或授权事实变化即失效',
    acceptance_hash: digest('a'), screenshot_hashes: [], gate_plan_hash: digest('b'),
    reference_ids: ['AC-1'],
    options: type === 'needs_user' ? [{ id: 'OPTION_A', label: '采用方案 A' }] : [],
  }
}

async function request(root, type = 'verification', overrides = {}) {
  return createConfirmationRequest(root, {
    type, projectId: project, taskId: 'TASK-024', round: 1, revision: '1234567890abcdef', risk: 'standard',
    facts: facts(type), allowedActorIds: [actor], ttlSeconds: 3600,
    now: new Date('2026-08-05T00:00:00.000Z'), ...overrides,
  })
}

function callbackInput(value, overrides = {}) {
  return {
    event_id: 'evt_00000001', tenant_key: tenant, project_id: project, operator_open_id: openId,
    request_id: value.request_id, action_id: value.type === 'proposal' ? 'approve_proposal' : value.type === 'needs_user' ? 'choose_option' : 'authorize_verification',
    option_id: value.type === 'needs_user' ? 'OPTION_A' : null, message_id: 'om_message_123',
    receivedAt: new Date('2026-08-05T00:01:00.000Z'), ...overrides,
  }
}

class FakeController {
  constructor({ delay = 0, failure = null } = {}) { this.delay = delay; this.failure = failure; this.calls = []; this.results = new Map() }
  async execute(command) {
    if (this.results.has(command.idempotency_key)) return { status: 'duplicate', audit_id: this.results.get(command.idempotency_key) }
    this.calls.push(command)
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay))
    if (this.failure) throw new Error(this.failure)
    const audit = `audit_${String(this.calls.length).padStart(8, '0')}`
    this.results.set(command.idempotency_key, audit)
    return { status: 'applied', audit_id: audit }
  }
}

async function controlledProject({ level = 'standard' } = {}) {
  const root = await tempRoot('feishu-controlled-')
  const repository = path.join(root, 'repo')
  await mkdir(repository)
  spawnSync('git', ['init', '-b', 'main'], { cwd: repository })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repository })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repository })
  await writeFile(path.join(repository, 'README.md'), 'controlled fixture\n')
  spawnSync('git', ['add', 'README.md'], { cwd: repository })
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repository })
  assert.equal(cli(['project', 'init', root, '--id', project, '--name', 'Feishu fixture', '--repository', repository, '--branch', 'main', '--risk', 'standard']).code, 0)
  await initGateConfig(root)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-024')
  assert.equal(cli(['init', taskRoot, '--id', 'TASK-024', '--title', 'Feishu callback fixture', '--level', level, '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-024', title: 'Feishu callback fixture', level })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  await fillRound(taskRoot, 1)
  const configFile = await initFeishuConfig(root)
  await writeFile(configFile, JSON.stringify({
    ...defaultFeishuConfig(), enabled: true, tenant_key: tenant,
    targets: [{ project_id: project, receive_id_type: 'chat_id', receive_id: 'oc_test_chat' }],
    approvers: [{ project_id: project, open_id: openId, local_actor: actor, request_types: ['verification'] }],
  }))
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const acceptance = (await readMd(path.join(taskRoot, 'ACCEPTANCE.md'))).data
  const gates = (await readMd(path.join(root, '.spec-loop', 'GATES.md'))).data
  const current = await createConfirmationRequest(root, {
    type: 'verification', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: level,
    facts: {
      scope_summary: '授权当前候选执行正式验证', evidence_summary: ['定向回调证据'], invalidation_summary: '候选事实变化即失效',
      acceptance_hash: createHash('sha256').update(JSON.stringify(acceptance)).digest('hex'), screenshot_hashes: [],
      gate_plan_hash: createHash('sha256').update(JSON.stringify(gates)).digest('hex'), reference_ids: ['AC-1'], options: [],
    },
    allowedActorIds: [actor], ttlSeconds: 3600,
  })
  return { root, repository, taskRoot, current }
}

async function authorityFacts(root, taskRoot, referenceIds, options = []) {
  const acceptance = (await readMd(path.join(taskRoot, 'ACCEPTANCE.md'))).data
  const gates = (await readMd(path.join(root, '.spec-loop', 'GATES.md'))).data
  return {
    scope_summary: '通过结构化领域命令处理当前确认决定',
    evidence_summary: ['定向领域状态与消费链验证'],
    invalidation_summary: '候选、验收标准或门禁变化即失效',
    acceptance_hash: createHash('sha256').update(JSON.stringify(acceptance)).digest('hex'),
    screenshot_hashes: [],
    gate_plan_hash: createHash('sha256').update(JSON.stringify(gates)).digest('hex'),
    reference_ids: referenceIds,
    options,
  }
}

function controllerCommand(request, action, optionId = null) {
  const commandId = randomUUID()
  return {
    command_id: commandId,
    idempotency_key: commandId,
    project_id: request.project_id,
    task_id: request.task_id,
    request_id: request.request_id,
    request_type: request.type,
    round: request.round,
    revision: request.revision,
    content_hash: request.content_hash,
    risk: request.risk,
    facts: request.facts,
    action,
    option_id: optionId,
    actor,
    source: 'local',
  }
}

test('long-connection handler persists and acknowledges before a slow Controller completes', async () => {
  const root = await projectRoot()
  const current = await request(root)
  const controller = new FakeController({ delay: 200 })
  let resolveResult
  let controllerCompleted = false
  const result = new Promise((resolve) => { resolveResult = resolve })
  const handler = createFeishuCardActionHandler(root, {
    projectId: project, controller,
    now: () => new Date('2026-08-05T00:01:00.000Z'), onResult: (record) => { controllerCompleted = true; resolveResult(record) },
  })
  await handler({
    eventId: 'evt_00000001', tenantKey: tenant, messageId: 'om_message_123', chatId: 'oc_test_chat', operatorOpenId: openId,
    action: { tag: 'button', value: { request_id: current.request_id, action_id: 'authorize_verification' } },
  })
  assert.equal(controllerCompleted, false)
  assert.equal((await listFeishuActionInbox(root)).length, 1)
  const completed = await result
  assert.equal(completed.status, 'succeeded')
  assert.equal(controller.calls.length, 1)
})

test('callback acceptance does not wait for a Confirmation lock held by a running Controller', async () => {
  const root = await projectRoot()
  const current = await request(root)
  let releaseController
  let controllerStarted
  const started = new Promise((resolve) => { controllerStarted = resolve })
  const release = new Promise((resolve) => { releaseController = resolve })
  const running = executeConfirmationRequest(root, current.request_id, 'authorize_verification', actor, async () => {
    controllerStarted()
    await release
  }, new Date('2026-08-05T00:01:00.000Z'))
  await started
  const startedAt = Date.now()
  const accepted = await acceptFeishuAction(root, callbackInput(current, { event_id: 'evt_lock_independent' }))
  assert.ok(Date.now() - startedAt < 500)
  assert.equal(accepted.record.status, 'pending')
  releaseController()
  await running
})

test('tenant, project, open_id and request-type authorization fail closed and are audited', async () => {
  for (const overrides of [
    { tenant_key: 'ffffffffffffffff' },
    { project_id: 'PROJ-OTHER' },
    { operator_open_id: 'ou_other_user' },
  ]) {
    const root = await projectRoot()
    const current = await request(root)
    const controller = new FakeController()
    const accepted = await acceptFeishuAction(root, callbackInput(current, overrides))
    const result = await processFeishuAction(root, accepted.record.inbox_id, controller, new Date('2026-08-05T00:01:01.000Z'))
    assert.equal(result.status, 'rejected')
    assert.match(result.reason, /tenant|project|operator|actor/i)
    assert.equal(controller.calls.length, 0)
    assert.equal((await listConfirmationRequests(root))[0].status, 'pending')
  }
  const typeRoot = await projectRoot(true, ['proposal'])
  const typeRequest = await request(typeRoot)
  const typeController = new FakeController()
  const typeInbox = await acceptFeishuAction(typeRoot, callbackInput(typeRequest))
  const typeResult = await processFeishuAction(typeRoot, typeInbox.record.inbox_id, typeController, new Date('2026-08-05T00:01:01.000Z'))
  assert.equal(typeResult.status, 'rejected')
  assert.match(typeResult.reason, /request type/i)
  assert.equal(typeController.calls.length, 0)
})

test('expired, stale-authority and tampered actions cannot invoke the Controller', async () => {
  const expiredRoot = await projectRoot()
  const expired = await request(expiredRoot, 'verification', { ttlSeconds: 60 })
  const expiredController = new FakeController()
  const expiredInbox = await acceptFeishuAction(expiredRoot, callbackInput(expired, { receivedAt: new Date('2026-08-05T00:02:00.000Z') }))
  const expiredResult = await processFeishuAction(expiredRoot, expiredInbox.record.inbox_id, expiredController, new Date('2026-08-05T00:02:00.000Z'))
  assert.equal(expiredResult.status, 'rejected')
  assert.equal(expiredResult.confirmation_status, 'expired')
  assert.equal(expiredController.calls.length, 0)

  const staleRoot = await projectRoot()
  const stale = await request(staleRoot)
  const authorityFile = path.join(staleRoot, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'current-authority.json')
  const authority = JSON.parse(await readFile(authorityFile, 'utf8'))
  authority.authorities[0].revision = 'fedcba0987654321'
  authority.authorities[0].generation += 1
  authority.projection_hash = createHash('sha256').update(JSON.stringify(authority.authorities)).digest('hex')
  await writeFile(authorityFile, JSON.stringify(authority))
  const staleController = new FakeController()
  const staleInbox = await acceptFeishuAction(staleRoot, callbackInput(stale))
  const staleResult = await processFeishuAction(staleRoot, staleInbox.record.inbox_id, staleController, new Date('2026-08-05T00:01:01.000Z'))
  assert.equal(staleResult.status, 'rejected')
  assert.equal(staleResult.confirmation_status, 'invalidated')
  assert.equal(staleController.calls.length, 0)

  await assert.rejects(acceptFeishuAction(staleRoot, callbackInput(stale, { event_id: 'evt_00000002', action_id: 'merge' })), /invalid option|action/i)
})

test('event, request and action dedupe make concurrent clicks execute one effective command', async () => {
  const root = await projectRoot()
  const current = await request(root)
  const first = await acceptFeishuAction(root, callbackInput(current))
  const repeated = await acceptFeishuAction(root, callbackInput(current, { event_id: 'evt_00000002' }))
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.record.inbox_id, first.record.inbox_id)
  assert.deepEqual(repeated.record.event_ids, ['evt_00000001', 'evt_00000002'])

  const controller = new FakeController({ delay: 80 })
  const [left, right] = await Promise.all([
    processFeishuAction(root, first.record.inbox_id, controller, new Date('2026-08-05T00:01:01.000Z')),
    processFeishuAction(root, first.record.inbox_id, controller, new Date('2026-08-05T00:01:01.000Z')),
  ])
  assert.equal(left.status, 'succeeded')
  assert.equal(right.status, 'succeeded')
  assert.equal(left.controller_result.audit_id, right.controller_result.audit_id)
  assert.equal(controller.calls.length, 1)
  assert.equal((await listConfirmationRequests(root))[0].status, 'consumed')
})

test('a competing action for the same request is deterministically rejected before execution', async () => {
  const root = await projectRoot()
  const current = await request(root, 'proposal')
  const accepted = await acceptFeishuAction(root, callbackInput(current))
  const competing = await acceptFeishuAction(root, callbackInput(current, { event_id: 'evt_00000002', action_id: 'reject_proposal' }))
  assert.equal(accepted.record.status, 'pending')
  assert.equal(competing.record.status, 'rejected')
  assert.match(competing.record.reason, /already claimed/i)
})

test('Controller state rejection does not consume the confirmation request', async () => {
  const root = await projectRoot()
  const current = await request(root)
  const accepted = await acceptFeishuAction(root, callbackInput(current))
  const controller = new FakeController({ failure: 'controller state transition is not allowed' })
  const result = await processFeishuAction(root, accepted.record.inbox_id, controller, new Date('2026-08-05T00:01:01.000Z'))
  assert.equal(result.status, 'rejected')
  assert.match(result.reason, /state transition/i)
  assert.equal((await listConfirmationRequests(root))[0].status, 'pending')
})

test('disabled Feishu connector still allows the same request through the local fallback entry', async () => {
  const root = await projectRoot(false)
  const current = await request(root, 'needs_user')
  const accepted = await acceptLocalConfirmationAction(root, {
    eventId: 'local_00000001', projectId: project, actor, requestId: current.request_id,
    action: 'choose_option', optionId: 'OPTION_A', receivedAt: new Date('2026-08-05T00:01:00.000Z'),
  })
  const controller = new FakeController()
  const result = await processFeishuAction(root, accepted.record.inbox_id, controller, new Date('2026-08-05T00:01:01.000Z'))
  assert.equal(result.status, 'succeeded')
  assert.equal(result.envelope.source, 'local')
  assert.equal(controller.calls[0].option_id, 'OPTION_A')
  assert.equal(controller.calls[0].source, 'local')
})

test('local CLI completes a current request through the production Controller', async () => {
  const { root, current } = await controlledProject()
  const result = cli([
    'connectors', 'feishu', 'confirm-local', root,
    '--request', current.request_id, '--action', 'authorize_verification', '--actor', actor, '--json',
  ])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).record.status, 'succeeded')
  assert.equal((await listConfirmationRequests(root))[0].status, 'consumed')
})

test('production Controller rejection becomes a proposal-domain constraint', async () => {
  const { root, repository, taskRoot } = await controlledProject()
  const proposal = cli([
    'triage', 'propose', root, '--source', '飞书确认', '--goal', '拒绝当前提案', '--risk', 'standard',
    '--priority', 'P1', '--reason', '验证拒绝动作会约束后续领域命令', '--ac', '拒绝决定持续生效',
  ])
  assert.equal(proposal.code, 0, proposal.stderr)
  const proposalId = proposal.stdout.trim()
  assert.equal(cli(['triage', 'approve', root, proposalId, '--by', actor]).code, 0)
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'proposal', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: await authorityFacts(root, taskRoot, [proposalId]), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  await createLocalSpecLoopConfirmationController(root).execute(controllerCommand(current, 'reject_proposal'))
  const approval = cli(['triage', 'approve', root, proposalId, '--by', actor])
  assert.notEqual(approval.code, 0)
  assert.match(approval.stderr, /rejected by a current structured decision/i)
  const task = cli(['triage', 'create-task', root, proposalId, '--id', 'TASK-REJECTED-1', '--title', 'Rejected proposal'])
  assert.notEqual(task.code, 0)
  assert.match(task.stderr, /approval was invalidated by a current structured rejection/i)
})

test('production Controller resumes an iterating task from a predefined needs-user choice', async () => {
  const { root, repository, taskRoot } = await controlledProject()
  const artifact = path.join(root, 'failed-check.txt')
  await writeFile(artifact, 'targeted verifier requested a user choice\n')
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const failed = cli(['verify', taskRoot, '--result', 'fail', '--evidence', artifact, '--verifier', 'independent-test', '--independent', '--revision', revision])
  assert.equal(failed.code, 0, failed.stderr)
  const current = await createConfirmationRequest(root, {
    type: 'needs_user', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: await authorityFacts(root, taskRoot, ['AC-1'], [{ id: 'OPTION_A', label: '采用方案 A' }]),
    allowedActorIds: [actor], ttlSeconds: 3600,
  })
  const command = controllerCommand(current, 'choose_option', 'OPTION_A')
  await createLocalSpecLoopConfirmationController(root).execute(command)
  const state = (await readMd(path.join(taskRoot, 'TASK_STATE.md'))).data
  assert.equal(state.status, 'working')
  assert.equal(state.current_round, 2)
  assert.equal((await listConfirmationDecisions(root)).find((item) => item.command_id === command.command_id).status, 'active')
})

test('pause_task stops a working Task until a later structured choice resumes the same Round', async () => {
  const { root, repository, taskRoot } = await controlledProject()
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const pause = await createConfirmationRequest(root, {
    type: 'needs_user', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: await authorityFacts(root, taskRoot, ['AC-1'], [{ id: 'OPTION_A', label: '稍后继续' }]),
    allowedActorIds: [actor], ttlSeconds: 3600,
  })
  await createLocalSpecLoopConfirmationController(root).execute(controllerCommand(pause, 'pause_task'))
  assert.equal((await readMd(path.join(taskRoot, 'TASK_STATE.md'))).data.status, 'iterating')
  const bypass = cli(['round', taskRoot])
  assert.notEqual(bypass.code, 0)
  assert.match(bypass.stderr, /paused by a structured user decision/i)

  const resume = await createConfirmationRequest(root, {
    type: 'needs_user', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: await authorityFacts(root, taskRoot, ['AC-1'], [{ id: 'OPTION_A', label: '继续当前 Round' }]),
    allowedActorIds: [actor], ttlSeconds: 3600,
  })
  await createLocalSpecLoopConfirmationController(root).execute(controllerCommand(resume, 'choose_option', 'OPTION_A'))
  const state = (await readMd(path.join(taskRoot, 'TASK_STATE.md'))).data
  assert.equal(state.status, 'working')
  assert.equal(state.current_round, 1)
})

test('structured Heavy acceptance is consumed by task verification as the local human check', async () => {
  const { root, repository, taskRoot } = await controlledProject({ level: 'heavy' })
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'heavy_acceptance', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'heavy',
    facts: await authorityFacts(root, taskRoot, ['AC-1']), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  const command = controllerCommand(current, 'accept_heavy')
  await createLocalSpecLoopConfirmationController(root).execute(command)
  const artifact = path.join(root, 'heavy-pass.txt')
  await writeFile(artifact, 'independent Heavy verification passed\n')
  const verified = cli(['verify', taskRoot, '--result', 'pass', '--evidence', artifact, '--verifier', 'independent-heavy', '--independent', '--revision', revision])
  assert.equal(verified.code, 0, verified.stderr)
  assert.equal((await readMd(path.join(taskRoot, 'VERIFY.md'))).data.human_checked, true)
  assert.equal((await listConfirmationDecisions(root)).find((item) => item.command_id === command.command_id).status, 'consumed')
})

test('structured Heavy rejection cannot be bypassed with the local human-check flag', async () => {
  const { root, repository, taskRoot } = await controlledProject({ level: 'heavy' })
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'heavy_acceptance', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'heavy',
    facts: await authorityFacts(root, taskRoot, ['AC-1']), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  await createLocalSpecLoopConfirmationController(root).execute(controllerCommand(current, 'reject_heavy'))
  const artifact = path.join(root, 'heavy-rejected.txt')
  await writeFile(artifact, 'independent Heavy verification passed but the user rejected the candidate\n')
  const verified = cli([
    'verify', taskRoot, '--result', 'pass', '--evidence', artifact, '--verifier', 'independent-heavy',
    '--independent', '--human-check', '--revision', revision,
  ])
  assert.notEqual(verified.code, 0)
  assert.match(verified.stderr, /rejected by a structured user decision/i)
})

test('Heavy decision is rejected after its bound Gate Plan changes', async () => {
  const { root, repository, taskRoot } = await controlledProject({ level: 'heavy' })
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'heavy_acceptance', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'heavy',
    facts: await authorityFacts(root, taskRoot, ['AC-1']), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  await createLocalSpecLoopConfirmationController(root).execute(controllerCommand(current, 'accept_heavy'))
  await writeMd(path.join(root, '.spec-loop', 'GATES.md'), {
    schema_version: 1, scope_kind: 'task', coverage: 'targeted',
    database: { lifecycle: 'persistent', reset: 'fixtures' },
    gates: [{ id: 'changed-gate', ac: ['AC-1'], command: [process.execPath, '--version'], timeout_seconds: 30 }],
  }, '# Gates\n\nChanged after the structured decision.')
  const artifact = path.join(root, 'heavy-authority-drift.txt')
  await writeFile(artifact, 'the bound Gate Plan changed\n')
  const verified = cli([
    'verify', taskRoot, '--result', 'pass', '--evidence', artifact, '--verifier', 'independent-heavy',
    '--independent', '--human-check', '--revision', revision,
  ])
  assert.notEqual(verified.code, 0)
  assert.match(verified.stderr, /structured Heavy decision authority is not current/i)
})

test('Heavy acceptance from an earlier Round is not consumed by a later Round with the same revision', async () => {
  const { root, repository, taskRoot } = await controlledProject({ level: 'heavy' })
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'heavy_acceptance', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'heavy',
    facts: await authorityFacts(root, taskRoot, ['AC-1']), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  const command = controllerCommand(current, 'accept_heavy')
  await createLocalSpecLoopConfirmationController(root).execute(command)
  const failedArtifact = path.join(root, 'round-one-failed.txt')
  await writeFile(failedArtifact, 'round one failed independently\n')
  assert.equal(cli(['verify', taskRoot, '--result', 'fail', '--evidence', failedArtifact, '--verifier', 'independent-heavy', '--independent', '--revision', revision]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  await fillRound(taskRoot, 2)
  const passedArtifact = path.join(root, 'round-two-passed.txt')
  await writeFile(passedArtifact, 'round two passed with a separate local human check\n')
  const verified = cli([
    'verify', taskRoot, '--result', 'pass', '--evidence', passedArtifact, '--verifier', 'independent-heavy',
    '--independent', '--human-check', '--revision', revision,
  ])
  assert.equal(verified.code, 0, verified.stderr)
  assert.equal((await listConfirmationDecisions(root)).find((item) => item.command_id === command.command_id).status, 'active')
})

test('structured verification authorization is consumed when Harness prepares the exact candidate', async () => {
  const { root, repository, taskRoot } = await controlledProject()
  const proposal = cli([
    'triage', 'propose', root, '--source', '飞书确认', '--goal', '验证当前候选', '--risk', 'standard',
    '--priority', 'P1', '--reason', '为工作区执行建立有效授权', '--ac', '定向验证可以启动',
  ])
  assert.equal(proposal.code, 0, proposal.stderr)
  const proposalId = proposal.stdout.trim()
  assert.equal(cli(['triage', 'approve', root, proposalId, '--by', actor]).code, 0)
  const spec = await readMd(path.join(taskRoot, 'SPEC.md'))
  await writeFile(path.join(taskRoot, 'SPEC.md'), `---\n${[
    'schema_version: 1', 'task_id: TASK-024', 'title: Feishu callback fixture', 'level: standard', `proposal_id: ${proposalId}`,
  ].join('\n')}\n---\n\n${spec.body}\n`)
  spawnSync('git', ['add', '.'], { cwd: repository })
  spawnSync('git', ['commit', '-m', '补充目标规格'], { cwd: repository })
  const workspace = cli(['workspace', 'create', root, 'TASK-024', '--json'])
  assert.equal(workspace.code, 0, workspace.stderr)
  const manifest = JSON.parse(workspace.stdout)
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: manifest.worktree, encoding: 'utf8' }).stdout.trim()
  const current = await createConfirmationRequest(root, {
    type: 'verification', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: await authorityFacts(root, taskRoot, ['AC-1']), allowedActorIds: [actor], ttlSeconds: 3600,
  })
  const command = controllerCommand(current, 'authorize_verification')
  await createLocalSpecLoopConfirmationController(root).execute(command)
  const prepared = cli(['harness', 'prepare', root, 'TASK-024', '--prompt', '只验证当前候选'])
  assert.equal(prepared.code, 0, prepared.stderr)
  assert.equal((await listConfirmationDecisions(root)).find((item) => item.command_id === command.command_id).status, 'consumed')
})

test('production Controller rejects a request after the actual repository HEAD changes', async () => {
  const { root, repository, current } = await controlledProject()
  await writeFile(path.join(repository, 'changed.txt'), 'new candidate\n')
  spawnSync('git', ['add', 'changed.txt'], { cwd: repository })
  spawnSync('git', ['commit', '-m', 'change candidate'], { cwd: repository })
  const accepted = await acceptLocalConfirmationAction(root, {
    eventId: 'local_stale_001', projectId: project, actor, requestId: current.request_id,
    action: 'authorize_verification', receivedAt: new Date(),
  })
  const result = await processFeishuAction(root, accepted.record.inbox_id, createLocalSpecLoopConfirmationController(root))
  assert.equal(result.status, 'failed')
  assert.match(result.reason, /revision changed/i)
  assert.equal((await listConfirmationRequests(root))[0].status, 'pending')
})

test('an unauthorized click cannot poison the authorized actor action key', async () => {
  const root = await projectRoot()
  const current = await request(root)
  const unauthorized = await acceptFeishuAction(root, callbackInput(current, { operator_open_id: 'ou_other_user' }))
  assert.equal(unauthorized.record.status, 'rejected')
  const authorized = await acceptFeishuAction(root, callbackInput(current, { event_id: 'evt_authorized_2' }))
  assert.equal(authorized.duplicate, false)
  assert.equal(authorized.record.status, 'pending')
  const result = await processFeishuAction(root, authorized.record.inbox_id, new FakeController(), new Date('2026-08-05T00:01:01.000Z'))
  assert.equal(result.status, 'succeeded')
})

test('startup reconcile reclaims a stale processing action and completes it idempotently', async () => {
  const root = await projectRoot()
  const current = await request(root)
  const accepted = await acceptFeishuAction(root, callbackInput(current))
  const file = path.join(root, '.spec-loop', 'connectors', 'feishu', 'actions', 'inbox.json')
  const inbox = JSON.parse(await readFile(file, 'utf8'))
  inbox.records[0].status = 'processing'
  inbox.records[0].attempts = 1
  inbox.records[0].claim_token = 'a0c1f841-55d7-4f2c-a2aa-b2de52fed001'
  inbox.records[0].claimed_at = '2026-08-05T00:00:00.000Z'
  inbox.records[0].updated_at = '2026-08-05T00:00:00.000Z'
  inbox.projection_hash = createHash('sha256').update(JSON.stringify(inbox.records)).digest('hex')
  await writeFile(file, JSON.stringify(inbox))
  const controller = new FakeController()
  const results = await reconcileFeishuActions(root, controller, new Date('2026-08-05T00:01:01.000Z'), 0)
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'succeeded')
  assert.equal(controller.calls.length, 1)
})

test('startup reconcile never steals a stale claim from a live process', async () => {
  const root = await projectRoot()
  const current = await request(root)
  await acceptFeishuAction(root, callbackInput(current))
  const file = path.join(root, '.spec-loop', 'connectors', 'feishu', 'actions', 'inbox.json')
  const inbox = JSON.parse(await readFile(file, 'utf8'))
  inbox.records[0].status = 'processing'
  inbox.records[0].attempts = 1
  inbox.records[0].claim_token = 'a0c1f841-55d7-4f2c-a2aa-b2de52fed002'
  inbox.records[0].claim_pid = process.pid
  inbox.records[0].claimed_at = '2026-08-05T00:00:00.000Z'
  inbox.records[0].updated_at = '2026-08-05T00:00:00.000Z'
  inbox.projection_hash = createHash('sha256').update(JSON.stringify(inbox.records)).digest('hex')
  await writeFile(file, JSON.stringify(inbox))
  const results = await reconcileFeishuActions(root, new FakeController(), new Date('2026-08-05T00:01:01.000Z'), 0)
  assert.equal(results.length, 0)
  assert.equal((await listFeishuActionInbox(root))[0].status, 'processing')
})

test('concurrent startup reconcile recovers a hard crash after the Controller persisted success', async () => {
  const { root, current } = await controlledProject()
  const accepted = await acceptLocalConfirmationAction(root, {
    eventId: 'local_hard_crash_001', projectId: project, actor, requestId: current.request_id,
    action: 'authorize_verification', receivedAt: new Date(),
  })
  const marker = path.join(root, 'controller-success.json')
  const child = spawnSync(process.execPath, [
    path.resolve('test/fixtures/feishu-hard-crash-child.mjs'), root, accepted.record.inbox_id, marker,
  ], { encoding: 'utf8' })
  assert.equal(child.status, 91, child.stderr)
  const lock = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'mutation.lock')
  assert.equal((await lstat(lock)).isDirectory(), true)
  assert.equal((await listFeishuActionInbox(root))[0].status, 'processing')

  let executeCalls = 0
  const productionController = createLocalSpecLoopConfirmationController(root)
  const controller = {
    lookup: (commandId) => productionController.lookup(commandId),
    async execute(command) {
      const persisted = JSON.parse(await readFile(marker, 'utf8'))
      assert.equal(persisted.command_id, command.command_id)
      executeCalls += 1
      return productionController.execute(command)
    },
  }
  const failingTransport = () => ({
    async preflight() { throw new Error('simulated preflight unavailable') },
    async connect() {}, async disconnect() {}, connectionState() { return 'idle' },
    async sendCard() { throw new Error('not reached') }, async updateCard() { throw new Error('not reached') },
  })
  const startups = await Promise.allSettled([
    runFeishuConnector(root, { transport: failingTransport(), confirmationController: controller }),
    runFeishuConnector(root, { transport: failingTransport(), confirmationController: controller }),
  ])
  assert.equal(startups.every((item) => item.status === 'rejected' && /preflight unavailable/.test(item.reason.message)), true)
  assert.equal(executeCalls, 0)
  const recoveredInbox = (await listFeishuActionInbox(root))[0]
  assert.equal(recoveredInbox.status, 'succeeded', JSON.stringify(recoveredInbox))
  assert.equal((await listConfirmationRequests(root))[0].status, 'consumed')
  assert.equal((await listConfirmationDecisions(root)).filter((item) => item.command_id === accepted.record.controller_command_id).length, 1)
  assert.equal(await lstat(lock).catch(() => null), null)
})

test('startup reconcile restores a Controller success even after the confirmation TTL elapsed', async () => {
  const { root, current } = await controlledProject()
  const accepted = await acceptLocalConfirmationAction(root, {
    eventId: 'local_expired_crash_001', projectId: project, actor, requestId: current.request_id,
    action: 'authorize_verification', receivedAt: new Date(),
  })
  const marker = path.join(root, 'controller-expired-success.json')
  const child = spawnSync(process.execPath, [
    path.resolve('test/fixtures/feishu-hard-crash-child.mjs'), root, accepted.record.inbox_id, marker,
  ], { encoding: 'utf8' })
  assert.equal(child.status, 91, child.stderr)
  const controller = createLocalSpecLoopConfirmationController(root)
  const afterExpiry = new Date(Date.parse(current.expires_at) + 1_000)
  const results = await reconcileFeishuActions(root, controller, afterExpiry, 0)
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'succeeded', JSON.stringify(results[0]))
  const recovered = (await listConfirmationRequests(root))[0]
  assert.equal(recovered.status, 'consumed')
  assert.equal(Date.parse(recovered.consumed_at), Date.parse(results[0].controller_result.committed_at))
  assert.equal(Date.parse(recovered.consumed_at) < Date.parse(recovered.expires_at), true)
})

test('running connector processes a real card action and updates its result card', async () => {
  const { root, current } = await controlledProject()
  const transport = new FakeFeishuTransport()
  const abort = new AbortController()
  let resolveResult
  const completed = new Promise((resolve) => { resolveResult = resolve })
  const running = runFeishuConnector(root, {
    transport, signal: abort.signal, leaseTtlMs: 1000, outboxPollMs: 100,
    confirmationController: createLocalSpecLoopConfirmationController(root),
    onConfirmationResult: resolveResult,
  })
  while (transport.connectionState() !== 'connected') await new Promise((resolve) => setTimeout(resolve, 10))
  await transport.emitCardAction({
    eventId: 'evt_runtime_001', tenantKey: tenant, messageId: 'om_runtime', chatId: 'oc_test_chat', operatorOpenId: openId,
    action: { tag: 'button', value: { request_id: current.request_id, action_id: 'authorize_verification' } },
  })
  const result = await completed
  assert.equal(result.status, 'succeeded')
  assert.equal(transport.updated.length, 1)
  abort.abort()
  await running
})

test('Connector writes only its inbox and calls a structured Controller Adapter', async () => {
  const source = await readFile(new URL('../src/connectors/feishu-callback.ts', import.meta.url), 'utf8')
  const cliSource = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /TASK_STATE\.md|APPROVAL\.md|DELIVERY\.md|reviews\//)
  assert.match(source, /controller\.execute\(\{/)
  assert.match(source, /executeConfirmationRequest\(/)
  assert.match(cliSource, /confirmationController:createLocalSpecLoopConfirmationController\(projectRoot\)/)
})
