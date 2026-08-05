import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { cli, fillContracts, readMd, tempRoot } from './helpers.mjs'
import { createConfirmationRequest, listConfirmationRequests } from '../dist/connectors/feishu-confirmation.js'
import {
  acceptFeishuAction,
  acceptLocalConfirmationAction,
  createFeishuCardActionHandler,
  listFeishuActionInbox,
  processFeishuAction,
  reconcileFeishuActions,
} from '../dist/connectors/feishu-callback.js'
import { createLocalSpecLoopConfirmationController } from '../dist/connectors/feishu-controller.js'
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

async function controlledProject() {
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
  assert.equal(cli(['init', taskRoot, '--id', 'TASK-024', '--title', 'Feishu callback fixture', '--level', 'standard', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-024', title: 'Feishu callback fixture', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
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
    type: 'verification', projectId: project, taskId: 'TASK-024', round: 1, revision, risk: 'standard',
    facts: {
      scope_summary: '授权当前候选执行正式验证', evidence_summary: ['定向回调证据'], invalidation_summary: '候选事实变化即失效',
      acceptance_hash: createHash('sha256').update(JSON.stringify(acceptance)).digest('hex'), screenshot_hashes: [],
      gate_plan_hash: createHash('sha256').update(JSON.stringify(gates)).digest('hex'), reference_ids: ['AC-1'], options: [],
    },
    allowedActorIds: [actor], ttlSeconds: 3600,
  })
  return { root, repository, taskRoot, current }
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
