import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { tempRoot } from './helpers.mjs'
import { FakeFeishuTransport, feishuConnectorStatus, initFeishuConfig } from '../dist/connectors/feishu.js'
import {
  assertSafeFeishuCard,
  buildProgressSnapshot,
  dispatchFeishuOutboxOnce,
  enqueueCriticalCard,
  enqueueProgressCard,
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
    nextAction: '继续定向实现进度通知',
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
  const value = snapshot({ nextUserIntervention: 'authorize_verification', nextAction: '等待候选授权' })
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
  const latest = await enqueueProgressCard(root, snapshot({ harnessStep: 'collected', nextAction: '等待定向 Gate' }), target, 0)
  assert.equal(first.id, latest.id)
  assert.equal((await readFeishuOutboxRecords(root)).length, 1)

  const transport = new FakeFeishuTransport()
  const sent = await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  assert.equal(sent.status, 'sent')
  assert.equal(transport.sent.length, 1)

  await enqueueProgressCard(root, snapshot({ harnessStep: 'verified', verifier: 'pass', nextAction: '准备候选' }), target, 0)
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
  const latest = await enqueueProgressCard(root, snapshot({ harnessStep: 'collected', nextAction: '网络发送期间的新快照' }), target, 0)
  assert.equal(latest.status, 'sending')
  releaseSend()
  const result = await dispatch
  assert.equal(result.status, 'pending')
  assert.equal(result.message_id, 'slow-message')
})

test('critical events use a durable idempotency key across duplicate enqueue', async () => {
  const root = await projectRoot()
  const input = { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'gate-reject-1', title: 'Gate 未通过', summary: '定向 Gate 失败，请查看本地摘要。', target }
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
    await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: `failure-${fixture.category}`, title: '关键通知', summary: '仅包含公开摘要。', target })
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
  await enqueueProgressCard(root, snapshot({ nextAction: '更新后的动作' }), target, 0)

  const missing = Object.assign(new Error('message missing'), { code: 'MESSAGE_NOT_FOUND' })
  const retry = await dispatchFeishuOutboxOnce(root, failingTransport(missing), new Date(Date.now() + 1000))
  assert.equal(retry.status, 'retry_wait')
  assert.equal(retry.message_id, null)
})

test('restart reconcile fails ambiguous critical sends closed and status exposes dead-letter', async () => {
  const root = await projectRoot()
  await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'restart-1', title: '关键通知', summary: '进程恢复测试。', target })
  const outboxFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox.json')
  const outbox = JSON.parse(await readFile(outboxFile, 'utf8'))
  outbox.records[0].status = 'sending'
  outbox.records[0].delivery_token = '82cc3c82-453f-4d6c-9ca0-78b0d60bea72'
  await writeFile(outboxFile, JSON.stringify(outbox, null, 2))

  assert.equal(await reconcileFeishuOutbox(root), 1)
  const summary = await readFeishuOutboxSummary(root)
  assert.equal(summary.dead_letter, 1)
  const connector = await feishuConnectorStatus(root)
  assert.equal(connector.outbox.dead_letter, 1)
})

test('unsafe card payloads are rejected and notification failures do not touch task state', async () => {
  for (const canary of [
    'Authorization: Bearer abcdefghijklmnop',
    'app_secret=do-not-send-this',
    'source diff: + private implementation',
    'evidence/private.log',
    '-----BEGIN PRIVATE KEY-----',
  ]) assert.throws(() => assertSafeFeishuCard({ text: canary }), /sensitive/i)

  const root = await projectRoot()
  const taskDir = path.join(root, '.spec-loop', 'tasks', 'task-022')
  const taskState = path.join(taskDir, 'TASK_STATE.md')
  await mkdir(taskDir, { recursive: true })
  await writeFile(taskState, 'authoritative-local-state\n')
  await enqueueCriticalCard(root, { projectId: 'PROJ-ERP', waveId: 'W4', eventId: 'network-failure', title: '通知', summary: '安全摘要。', target })
  await dispatchFeishuOutboxOnce(root, failingTransport(new Error('offline')), new Date(Date.now() + 1000))
  assert.equal(await readFile(taskState, 'utf8'), 'authoritative-local-state\n')
})
