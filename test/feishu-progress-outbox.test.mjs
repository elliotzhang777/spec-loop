import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { cli, fillContracts, tempRoot } from './helpers.mjs'
import { FakeFeishuTransport, OfficialFeishuTransport, defaultFeishuConfig, feishuConnectorStatus, initFeishuConfig, runFeishuConnector } from '../dist/connectors/feishu.js'
import {
  assertSafeFeishuCard,
  buildProgressSnapshot,
  dispatchFeishuOutboxOnce,
  enqueueCriticalCard,
  enqueueProgressCard,
  projectProgressSnapshot,
  readFeishuOutboxRecords,
  readFeishuOutboxSummary,
  reconcileFeishuOutbox,
  renderProgressCard,
} from '../dist/connectors/feishu-progress.js'

const target = { project_id: 'PROJ-ERP', receive_id_type: 'chat_id', receive_id: 'oc_progress_room' }

async function projectRoot(name = 'feishu-progress-') {
  const root = await tempRoot(name)
  await mkdir(path.join(root, '.spec-loop'))
  await initFeishuConfig(root)
  return root
}

function snapshot(overrides = {}) {
  return buildProgressSnapshot({
    projectId: 'PROJ-ERP',
    waveId: 'W4',
    tasks: [
      { task_id: 'TASK-021', status: 'delivered', round: 7 },
      { task_id: 'TASK-022', status: 'working', round: 1 },
      { task_id: 'TASK-023', status: 'planned', round: 0 },
    ],
    currentTaskId: 'TASK-022',
    harnessStep: 'executed',
    gate: 'pass',
    verifier: 'none',
    nextUserIntervention: 'none',
    nextAction: 'continue_execution',
    updatedAt: '2026-08-04T10:00:00.000Z',
    ...overrides,
  })
}

function failingTransport(error) {
  return {
    preflight: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    connectionState: () => 'connected',
    sendCard: async () => { throw error },
    updateCard: async () => { throw error },
  }
}

test('progress snapshot and card expose only the required project facts', () => {
  const value = snapshot({ nextUserIntervention: 'authorize_verification', nextAction: 'wait_for_verification_authorization' })
  assert.deepEqual(value.task_counts, { draft: 0, pending: 1, running: 1, verifying: 0, blocked: 0, completed: 1 })
  assert.deepEqual(value.current, { task_id: 'TASK-022', round: 1, harness_step: 'executed' })
  const rendered = JSON.stringify(renderProgressCard(value))
  assert.match(rendered, /1\/3/)
  assert.match(rendered, /TASK-022/)
  assert.match(rendered, /授权正式验证/)
})

test('high-frequency progress is aggregated and updates one existing card', async () => {
  const root = await projectRoot()
  const first = await enqueueProgressCard(root, snapshot(), target, 0)
  const latest = await enqueueProgressCard(root, snapshot({ harnessStep: 'collected', nextAction: 'continue_execution' }), target, 0)
  assert.equal(first.id, latest.id)
  assert.equal((await readFeishuOutboxRecords(root)).length, 1)

  const transport = new FakeFeishuTransport()
  const sent = await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  assert.equal(sent.status, 'sent')
  assert.equal(transport.sent.length, 1)

  await enqueueProgressCard(root, snapshot({ harnessStep: 'verified', verifier: 'pass', nextAction: 'wait_for_verification_authorization' }), target, 0)
  const updated = await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  assert.equal(updated.status, 'sent')
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.updated.length, 1)
  assert.equal(transport.updated[0].messageId, transport.sent[0].messageId)
})

test('new progress can enter the outbox while a slow network send is in flight', async () => {
  const root = await projectRoot()
  await enqueueProgressCard(root, snapshot(), target, 0)
  let releaseSend
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const released = new Promise((resolve) => { releaseSend = resolve })
  const transport = {
    preflight: async () => {}, connect: async () => {}, disconnect: async () => {}, connectionState: () => 'connected',
    sendCard: async () => { markStarted(); await released; return { messageId: 'slow-message' } },
    updateCard: async () => {},
  }
  const dispatch = dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  await started
  const latest = await enqueueProgressCard(root, snapshot({ harnessStep: 'collected', nextAction: 'wait_for_verification_authorization' }), target, 0)
  assert.equal(latest.status, 'sending')
  releaseSend()
  const result = await dispatch
  assert.equal(result.status, 'pending')
  assert.equal(result.message_id, 'slow-message')
})

test('a lost send response is retried with the same platform idempotency key', async () => {
  const root = await projectRoot()
  const fake = new FakeFeishuTransport()
  await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'ambiguous-send', eventType: 'gate_failed', taskId: 'TASK-022', target })
  const ambiguous = {
    preflight: async () => {}, connect: async () => {}, disconnect: async () => {}, connectionState: () => 'connected',
    sendCard: async (...args) => { await fake.sendCard(...args); throw Object.assign(new Error('response lost'), { code: 'ECONNRESET' }) },
    updateCard: async () => {},
  }
  const first = await dispatchFeishuOutboxOnce(root, ambiguous, new Date(Date.now() + 1000))
  assert.equal(first.status, 'retry_wait')
  const retryAt = new Date(Date.parse(first.next_attempt_at) + 1)
  const second = await dispatchFeishuOutboxOnce(root, fake, retryAt)
  assert.equal(second.status, 'sent')
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.sent[0].platformRequestId, second.platform_request_id)
})

test('critical events use a durable idempotency key across duplicate enqueue', async () => {
  const root = await projectRoot()
  const input = { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'gate-reject-1', eventType: 'gate_failed', taskId: 'TASK-022', target }
  const first = await enqueueCriticalCard(root, input)
  const duplicate = await enqueueCriticalCard(root, input)
  assert.equal(first.id, duplicate.id)
  assert.equal((await readFeishuOutboxRecords(root)).length, 1)
})

test('retryable and permanent delivery errors enter the correct outbox states', async () => {
  for (const fixture of [
    { error: Object.assign(new Error('limited'), { status: 429, retryAfterMs: 10 }), status: 'retry_wait', category: 'rate_limited' },
    { error: Object.assign(new Error('upstream'), { status: 503 }), status: 'retry_wait', category: 'server' },
    { error: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }), status: 'retry_wait', category: 'network' },
    { error: Object.assign(new Error('forbidden'), { status: 403 }), status: 'dead_letter', category: 'permission' },
    { error: Object.assign(new Error('target unavailable'), { code: 'TARGET_UNAVAILABLE' }), status: 'dead_letter', category: 'target' },
  ]) {
    const root = await projectRoot()
    await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: `failure-${fixture.category}`, eventType: 'connector_error', target })
    const result = await dispatchFeishuOutboxOnce(root, failingTransport(fixture.error), new Date(Date.now() + 1000))
    assert.equal(result.status, fixture.status)
    assert.equal(result.last_error, fixture.category)
  }
})

test('a missing progress card is retried as a new send instead of duplicating immediately', async () => {
  const root = await projectRoot()
  const transport = new FakeFeishuTransport()
  await enqueueProgressCard(root, snapshot(), target, 0)
  await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  await enqueueProgressCard(root, snapshot({ nextAction: 'wait_for_verification_authorization' }), target, 0)

  const missing = Object.assign(new Error('message missing'), { code: 'MESSAGE_NOT_FOUND' })
  const retry = await dispatchFeishuOutboxOnce(root, failingTransport(missing), new Date(Date.now() + 1000))
  assert.equal(retry.status, 'retry_wait')
  assert.equal(retry.message_id, null)
})

test('restart reconcile retries ambiguous critical sends with the same platform idempotency key', async () => {
  const root = await projectRoot()
  await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'restart-1', eventType: 'connector_error', target })
  const outboxFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox.json')
  const outbox = JSON.parse(await readFile(outboxFile, 'utf8'))
  outbox.records[0].status = 'sending'
  outbox.records[0].delivery_token = '82cc3c82-453f-4d6c-9ca0-78b0d60bea72'
  await writeFile(outboxFile, JSON.stringify(outbox, null, 2))

  assert.equal(await reconcileFeishuOutbox(root), 1)
  const summary = await readFeishuOutboxSummary(root)
  assert.equal(summary.retry_wait, 1)
  const connector = await feishuConnectorStatus(root)
  assert.equal(connector.outbox.retry_wait, 1)
})

test('a crashed process stale mutation lock is recovered before enqueue', async () => {
  const root = await projectRoot()
  const lock = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox-mutation.lock')
  await writeFile(lock, JSON.stringify({ schema_version: 1, token: 'stale', pid: 999999, created_at: '2020-01-01T00:00:00.000Z' }))
  const record = await enqueueProgressCard(root, snapshot(), target, 0)
  assert.equal(record.status, 'pending')
})

test('official delivery errors preserve status and retry metadata for outbox classification', async () => {
  const failure = Object.assign(new Error('permission denied'), { status: 403, code: 'PERMISSION_DENIED', retryAfterMs: 9000 })
  const channel = { rawClient: { im: { v1: { message: { create: async () => { throw failure } } } } } }
  const transport = new OfficialFeishuTransport({ appId: 'cli_test_app', appSecret: 'cli_test_secret' }, async () => channel)
  await assert.rejects(
    transport.sendCard(target, {}, 'platform-request'),
    (error) => error.status === 403 && error.code === 'PERMISSION_DENIED' && error.retryAfterMs === 9000,
  )
})

test('official SDK adapter preserves HTTP status and Retry-After metadata', async () => {
  const requester = async () => ({ ok: false, status: 429, headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '7' : null }, json: async () => ({}) })
  const transport = new OfficialFeishuTransport({ appId: 'cli_test_app', appSecret: 'cli_test_secret' }, undefined, requester)
  await assert.rejects(
    transport.sdkHttpInstance().request({ url: 'https://open.feishu.cn/open-apis/im/v1/messages', method: 'POST' }),
    (error) => error.status === 429 && error.code === 'HTTP_429' && error.retryAfterMs === 7000,
  )
})

test('persisted outbox payload must still match its allowlisted source after restart', async () => {
  const root = await projectRoot()
  await enqueueProgressCard(root, snapshot(), target, 0)
  const outboxFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox.json')
  const outbox = JSON.parse(await readFile(outboxFile, 'utf8'))
  outbox.records[0].payload = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'arbitrary persisted message' }] } }
  outbox.records[0].payload_hash = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(outbox.records[0].payload)).digest('hex')
  await writeFile(outboxFile, JSON.stringify(outbox, null, 2))
  await assert.rejects(readFeishuOutboxRecords(root), /deterministic rendering/i)
})

test('running connector projects local task facts and drains the outbox', async () => {
  const root = await tempRoot('feishu-progress-live-')
  const repository = path.join(root, 'repo')
  await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-LIVE', '--name', 'Live', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-live')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-LIVE', '--title', 'Live task', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-LIVE', title: 'Live task', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['runtime-init', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const configFile = await initFeishuConfig(root)
  await writeFile(configFile, JSON.stringify({
    ...defaultFeishuConfig(), enabled: true, tenant_key: '736588c9260f175c',
    targets: [{ project_id: 'PROJ-LIVE', receive_id_type: 'chat_id', receive_id: 'oc_progress_live' }],
    approvers: [{ project_id: 'PROJ-LIVE', open_id: 'ou_progress_user', local_actor: 'zhangbo', request_types: ['verification'] }],
  }, null, 2))
  const transport = new FakeFeishuTransport(), controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await runFeishuConnector(root, { transport, signal: controller.signal, leaseTtlMs: 1000, outboxPollMs: 10, progressAggregateWindowMs: 0 })
  assert.equal(transport.sent.length, 1)
  assert.match(JSON.stringify(transport.sent[0].card), /TASK-LIVE/)
})

test('project projection ignores Harness and Gate facts from another round or revision', async () => {
  const root = await tempRoot('feishu-progress-stale-')
  const repository = path.join(root, 'repo')
  await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-STALE', '--name', 'Stale', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-stale')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-STALE', '--title', 'Stale task', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-STALE', title: 'Stale task', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['runtime-init', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const output = path.join(root, '.spec-loop', 'output')
  const oldHead = '1'.repeat(40)
  await writeFile(path.join(output, 'TASK-STALE-prepare.json'), JSON.stringify({ task_id: 'TASK-STALE', round: 99, head: oldHead }))
  await writeFile(path.join(output, 'TASK-STALE-harness-state.json'), JSON.stringify({ task_id: 'TASK-STALE', head: oldHead, stage: 'reported', updated_at: '2026-08-04T10:00:00.000Z' }))
  await writeFile(path.join(output, 'TASK-STALE-gates.json'), JSON.stringify([{ task_id: 'TASK-STALE', head: oldHead, exit_code: 1, timed_out: false, created_at: '2026-08-04T10:00:00.000Z' }]))
  const projected = await projectProgressSnapshot(root)
  assert.deepEqual(projected.current, { task_id: 'TASK-STALE', round: 1, harness_step: 'none' })
  assert.deepEqual(projected.recent, { gate: 'none', verifier: 'none' })
})

test('unsafe card payloads are rejected and notification failures do not touch task state', async () => {
  for (const canary of [
    'Authorization: Bearer abcdefghijklmnop',
    'app_secret=do-not-send-this',
    'source diff: + private implementation',
    'evidence/private.log',
    '-----BEGIN PRIVATE KEY-----',
  ]) assert.throws(() => assertSafeFeishuCard({ text: canary }), /allowlisted|sensitive/i)

  const root = await projectRoot()
  const taskDir = path.join(root, '.spec-loop', 'tasks', 'task-022')
  const taskState = path.join(taskDir, 'TASK_STATE.md')
  await mkdir(taskDir, { recursive: true })
  await writeFile(taskState, 'authoritative-local-state\n')
  await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'network-failure', eventType: 'connector_error', target })
  await dispatchFeishuOutboxOnce(root, failingTransport(new Error('offline')), new Date(Date.now() + 1000))
  assert.equal(await readFile(taskState, 'utf8'), 'authoritative-local-state\n')
})
