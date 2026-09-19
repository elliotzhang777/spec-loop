import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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

async function attachManagedWorktree(root, repository, taskId) {
  for (const args of [
    ['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Spec Loop Test'],
  ]) assert.equal(spawnSync('git', ['-C', repository, ...args]).status, 0)
  await writeFile(path.join(repository, 'README.md'), 'fixture\n')
  assert.equal(spawnSync('git', ['-C', repository, 'add', 'README.md']).status, 0)
  assert.equal(spawnSync('git', ['-C', repository, 'commit', '-m', 'fixture']).status, 0)
  const base = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const worktree = path.join(root, '.spec-loop', 'worktrees', taskId.toLowerCase())
  await mkdir(path.dirname(worktree), { recursive: true })
  assert.equal(spawnSync('git', ['-C', repository, 'worktree', 'add', '-b', `spec-loop/${taskId.toLowerCase()}`, worktree, base]).status, 0)
  await writeFile(path.join(root, '.spec-loop', 'output', `${taskId}-workspace.json`), JSON.stringify({ task_id: taskId, worktree, base_commit: base }))
  return { base, worktree }
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
  assert.deepEqual(value.task_counts, { draft: 0, pending: 1, running: 1, verifying: 0, blocked: 0, completed: 1, cancelled: 0 })
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

test('a newer snapshot survives an ambiguous older send and is applied after idempotent recovery', async () => {
  const root = await projectRoot()
  const platform = new FakeFeishuTransport()
  await enqueueProgressCard(root, snapshot({ harnessStep: 'prepared' }), target, 0)
  let release, started
  const sending = new Promise((resolve) => { started = resolve })
  const blocked = new Promise((resolve) => { release = resolve })
  const ambiguous = {
    preflight: async () => {}, connect: async () => {}, disconnect: async () => {}, connectionState: () => 'connected',
    sendCard: async (...args) => { const result = await platform.sendCard(...args); started(); await blocked; throw Object.assign(new Error('response lost'), { code: 'ECONNRESET', result }) },
    updateCard: async () => {},
  }
  const firstDispatch = dispatchFeishuOutboxOnce(root, ambiguous, new Date(Date.now() + 1000))
  await sending
  await enqueueProgressCard(root, snapshot({ harnessStep: 'reported', verifier: 'pass' }), target, 0)
  release()
  const ambiguousResult = await firstDispatch
  assert.equal(ambiguousResult.status, 'retry_wait')
  const recovered = await dispatchFeishuOutboxOnce(root, platform, new Date(Date.parse(ambiguousResult.next_attempt_at) + 1))
  assert.equal(recovered.status, 'pending')
  assert.equal(platform.sent.length, 1)
  const updated = await dispatchFeishuOutboxOnce(root, platform, new Date(Date.now() + 5000))
  assert.equal(updated.status, 'sent')
  assert.equal(platform.updated.length, 1)
  assert.match(JSON.stringify(platform.updated[0].card), /reported/)
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

test('official SDK adapter classifies the documented Feishu rate-limit code for 200 and 400 responses', async () => {
  for (const responseStatus of [200, 400]) {
    const requester = async (url) => url.includes('tenant_access_token')
      ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ code: 0, tenant_access_token: 'tenant_test_value', expire: 300 }) }
      : { ok: responseStatus === 200, status: responseStatus, headers: { get: () => null }, json: async () => ({ code: 99991400 }) }
    const transport = new OfficialFeishuTransport({ appId: 'cli_test_app', appSecret: 'cli_test_secret' }, undefined, requester)
    for (const operation of [
      () => transport.sendCard(target, {}, 'platform-request'),
      () => transport.updateCard('om_existing', {}),
    ]) await assert.rejects(operation(), (error) => error.status === 429 && error.code === 'FEISHU_99991400')
  }
})

test('persisted outbox payload must still match its allowlisted source after restart', async () => {
  const root = await projectRoot()
  await enqueueProgressCard(root, snapshot(), target, 0)
  const outboxFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox.json')
  const outbox = JSON.parse(await readFile(outboxFile, 'utf8'))
  outbox.records[0].payload = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'arbitrary persisted message' }] } }
  outbox.records[0].payload_hash = createHash('sha256').update(JSON.stringify(outbox.records[0].payload)).digest('hex')
  await writeFile(outboxFile, JSON.stringify(outbox, null, 2))
  await assert.rejects(readFeishuOutboxRecords(root), /deterministic rendering/i)
})

test('official HTTP 404 while updating a card clears the old message and schedules recreation', async () => {
  const root = await projectRoot()
  const transport = new FakeFeishuTransport()
  await enqueueProgressCard(root, snapshot(), target, 0)
  await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1000))
  await enqueueProgressCard(root, snapshot({ harnessStep: 'reported' }), target, 0)
  const missing = Object.assign(new Error('HTTP 404'), { status: 404, code: 'HTTP_404' })
  const result = await dispatchFeishuOutboxOnce(root, failingTransport(missing), new Date(Date.now() + 2000))
  assert.equal(result.status, 'retry_wait')
  assert.equal(result.message_id, null)
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
  const originalSendCard = transport.sendCard.bind(transport)
  let markSent
  const sent = new Promise((resolve) => { markSent = resolve })
  transport.sendCard = async (...args) => {
    const result = await originalSendCard(...args)
    markSent()
    return result
  }
  const connector = runFeishuConnector(root, { transport, signal: controller.signal, leaseTtlMs: 1000, outboxPollMs: 10, progressAggregateWindowMs: 0 })
  let timeout
  try {
    await Promise.race([
      sent,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('connector did not send progress within 5s')), 5000) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
  }
  await connector
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
  await writeFile(path.join(output, 'TASK-STALE-harness-state.json'), JSON.stringify({ task_id: 'TASK-STALE', head: oldHead, stage: 'reported', evidence_hashes: { prepare: '0'.repeat(64) }, updated_at: '2026-08-04T10:00:00.000Z' }))
  await writeFile(path.join(output, 'TASK-STALE-gates.json'), JSON.stringify([{ task_id: 'TASK-STALE', head: oldHead, exit_code: 1, timed_out: false, created_at: '2026-08-04T10:00:00.000Z' }]))
  const projected = await projectProgressSnapshot(root)
  assert.deepEqual(projected.current, { task_id: 'TASK-STALE', round: 1, harness_step: 'none' })
  assert.deepEqual(projected.recent, { gate: 'none', verifier: 'none' })
})

test('project projection follows the current Prepare hash when Harness head advances', async () => {
  const root = await tempRoot('feishu-progress-current-')
  const repository = path.join(root, 'repo')
  await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-CURRENT', '--name', 'Current', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-current')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-CURRENT', '--title', 'Current task', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-CURRENT', title: 'Current task', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['runtime-init', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  const output = path.join(root, '.spec-loop', 'output')
  const managed = await attachManagedWorktree(root, repository, 'TASK-CURRENT')
  const preparedHead = managed.base
  const prepareText = JSON.stringify({ task_id: 'TASK-CURRENT', round: 1, head: preparedHead })
  await writeFile(path.join(output, 'TASK-CURRENT-prepare.json'), prepareText)
  await writeFile(path.join(managed.worktree, 'candidate.txt'), 'candidate\n')
  assert.equal(spawnSync('git', ['-C', managed.worktree, 'add', 'candidate.txt']).status, 0)
  assert.equal(spawnSync('git', ['-C', managed.worktree, 'commit', '-m', 'candidate']).status, 0)
  const executedHead = spawnSync('git', ['-C', managed.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const artifacts = {
    provider: 'provider\n', collect: '{}\n',
    gates: `${JSON.stringify([{ task_id: 'TASK-CURRENT', head: executedHead, exit_code: 0, timed_out: false, created_at: '2026-08-04T10:01:00.000Z' }])}\n`,
    report: 'report\n',
  }
  await writeFile(path.join(output, 'TASK-CURRENT-provider.txt'), artifacts.provider)
  await writeFile(path.join(output, 'TASK-CURRENT-collect.json'), artifacts.collect)
  await writeFile(path.join(output, 'TASK-CURRENT-gates.json'), artifacts.gates)
  await writeFile(path.join(output, 'TASK-CURRENT-harness-report.md'), artifacts.report)
  await writeFile(path.join(output, 'TASK-CURRENT-harness-state.json'), JSON.stringify({
    task_id: 'TASK-CURRENT', head: executedHead, stage: 'reported',
    evidence_hashes: {
      prepare: createHash('sha256').update(prepareText).digest('hex'),
      provider: createHash('sha256').update(artifacts.provider).digest('hex'),
      collect: createHash('sha256').update(artifacts.collect).digest('hex'),
      gates: createHash('sha256').update(artifacts.gates).digest('hex'),
      report: createHash('sha256').update(artifacts.report).digest('hex'),
    }, updated_at: '2026-08-04T10:01:00.000Z',
  }))
  const projected = await projectProgressSnapshot(root)
  assert.deepEqual(projected.current, { task_id: 'TASK-CURRENT', round: 1, harness_step: 'reported' })
  assert.equal(projected.recent.gate, 'pass')
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
