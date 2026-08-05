import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { tempRoot } from './helpers.mjs'
import {
  defaultFeishuConfig,
  disableFeishuConnector,
  feishuConnectorStatus,
  initFeishuConfig,
  readFeishuConfig,
  redactFeishuText,
  superviseFeishuConnector,
} from '../dist/connectors/feishu.js'
import { createConfirmationRequest, listConfirmationRequests } from '../dist/connectors/feishu-confirmation.js'
import { readFeishuActionInboxSummary } from '../dist/connectors/feishu-callback.js'
import {
  dispatchFeishuOutboxOnce,
  enqueueCriticalCard,
  readFeishuOutboxRecords,
  retryFeishuDeadLetters,
} from '../dist/connectors/feishu-progress.js'
import {
  classifyFeishuOperationalError,
  readFeishuOperationalState,
  reconcileFeishuConnector,
} from '../dist/connectors/feishu-operations.js'
import { checkFeishuConnectorContracts } from '../tools/check-feishu-connector-contracts.mjs'

const target = { project_id: 'PROJ-TEST', receive_id_type: 'chat_id', receive_id: 'oc_recovery_room' }
const digest = (character) => character.repeat(64)

async function projectRoot(name = 'feishu-recovery-') {
  const root = await tempRoot(name)
  await mkdir(path.join(root, '.spec-loop'))
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify({
    ...defaultFeishuConfig(), enabled: true, tenant_key: '736588c9260f175c',
    targets: [target],
    approvers: [{ project_id: 'PROJ-TEST', open_id: 'ou_recovery_user', local_actor: 'zhangbo', request_types: ['verification'] }],
    retry: { max_attempts: 3, base_delay_ms: 100, max_delay_ms: 1_000 },
  }, null, 2)}\n`)
  return root
}

function facts() {
  return {
    scope_summary: '验证连接器恢复边界', evidence_summary: ['定向恢复测试'],
    invalidation_summary: '候选事实变化后失效', acceptance_hash: digest('a'), screenshot_hashes: [],
    gate_plan_hash: digest('b'), reference_ids: ['AC-1'], options: [],
  }
}

test('startup reconcile expires confirmations and requeues ambiguous outbox sends before networking', async () => {
  const root = await projectRoot()
  const request = await createConfirmationRequest(root, {
    type: 'verification', projectId: 'PROJ-TEST', taskId: 'TASK-025', round: 1, revision: '1234567890abcdef',
    risk: 'standard', facts: facts(), allowedActorIds: ['zhangbo'], ttlSeconds: 60,
    now: new Date('2026-08-05T00:00:00.000Z'),
  })
  await enqueueCriticalCard(root, { projectId: 'PROJ-TEST', waveId: 'WPHASE4-FEISHU', eventId: 'recovery-1', eventType: 'connector_error', target })
  const outboxFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'outbox.json')
  const outbox = JSON.parse(await readFile(outboxFile, 'utf8'))
  outbox.records[0].status = 'sending'; outbox.records[0].delivery_token = '9effec3c-78b4-4fae-a1ac-27815e223149'; outbox.records[0].attempts = 1
  await writeFile(outboxFile, JSON.stringify(outbox))
  const result = await reconcileFeishuConnector(root, undefined, new Date('2026-08-05T00:02:00.000Z'))
  assert.deepEqual(result, { confirmations_expired: 1, outbox_recovered: 1, inbox_processed: 0 })
  assert.equal((await listConfirmationRequests(root)).find((item) => item.request_id === request.request_id).status, 'expired')
  assert.equal((await readFeishuOutboxRecords(root))[0].status, 'retry_wait')
})

test('dead letters require an explicit operator retry and retain deterministic delivery facts', async () => {
  const root = await projectRoot()
  await enqueueCriticalCard(root, { projectId: 'PROJ-TEST', waveId: 'WPHASE4-FEISHU', eventId: 'permission-1', eventType: 'connector_error', target })
  const denied = Object.assign(new Error('permission denied for ou_recovery_user'), { status: 403 })
  const transport = { preflight: async () => {}, connect: async () => {}, disconnect: async () => {}, connectionState: () => 'idle', sendCard: async () => { throw denied }, updateCard: async () => { throw denied } }
  assert.equal((await dispatchFeishuOutboxOnce(root, transport, new Date(Date.now() + 1_000))).status, 'dead_letter')
  assert.equal(await retryFeishuDeadLetters(root), 1)
  const retried = (await readFeishuOutboxRecords(root))[0]
  assert.equal(retried.status, 'retry_wait')
  assert.equal(retried.attempts, 0)
  assert.match(retried.platform_request_id, /^[a-f0-9]{32}$/)
})

test('central redaction removes credentials, Authorization data and raw platform identities', () => {
  const source = 'Authorization: Bearer abcdefghijklmnop app_secret=plain ghp_12345678901234567890 ou_recovery_user user@example.com'
  const redacted = redactFeishuText(source)
  assert.doesNotMatch(redacted, /abcdefghijklmnop|plain|ghp_12345678901234567890|ou_recovery_user|user@example\.com/)
  assert.match(redacted, /REDACTED|HASH|EMAIL/)
  const classified = classifyFeishuOperationalError(Object.assign(new Error(source), { status: 403 }))
  assert.equal(classified.retryable, false)
  assert.doesNotMatch(classified.summary, /ou_recovery_user|user@example\.com|ghp_12345678901234567890/)
})

test('supervisor retries transient preflight failures and records a safe operational state', async () => {
  const root = await projectRoot(), abort = new AbortController()
  let preflights = 0, connected = false
  const transport = {
    async preflight() { preflights += 1; if (preflights === 1) throw Object.assign(new Error('socket unavailable for ou_recovery_user'), { code: 'ECONNRESET' }) },
    async connect() { connected = true; setTimeout(() => abort.abort(), 25) }, async disconnect() { connected = false },
    connectionState() { return connected ? 'connected' : 'idle' }, async sendCard() { return { messageId: 'om_test' } }, async updateCard() {},
  }
  await superviseFeishuConnector(root, { transport, signal: abort.signal, leaseTtlMs: 1_000, outboxPollMs: 20 })
  assert.equal(preflights, 2)
  const status = await readFeishuOperationalState(root)
  assert.equal(status.status, 'stopped')
  assert.equal(status.error_summary, null)
})

test('disable is fail-safe and does not modify local task facts', async () => {
  const root = await projectRoot(), task = path.join(root, '.spec-loop', 'tasks', 'task-025')
  await mkdir(task, { recursive: true }); await writeFile(path.join(task, 'TASK_STATE.md'), 'authoritative-local-state\n')
  assert.deepEqual(await disableFeishuConnector(root), { disabled: true, stop_requested: false })
  assert.equal((await readFeishuConfig(root)).enabled, false)
  assert.equal(await readFile(path.join(task, 'TASK_STATE.md'), 'utf8'), 'authoritative-local-state\n')
  assert.equal((await readFeishuOperationalState(root)).status, 'disabled')
  const status = await feishuConnectorStatus(root)
  assert.equal(status.operations.status, 'disabled')
  assert.match(status.remediation.join(' '), /本地 Task/)
  assert.doesNotMatch(JSON.stringify(status), /ou_recovery_user|oc_recovery_room/)
})

test('dead process inbox locks are reclaimed without stealing an active owner', async () => {
  const root = await projectRoot(), lock = path.join(root, '.spec-loop', 'connectors', 'feishu', 'actions', 'mutation.lock')
  await mkdir(lock, { recursive: true })
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ schema_version: 1, pid: 999999, created_at: new Date().toISOString() }))
  assert.deepEqual(await readFeishuActionInboxSummary(root), { pending: 0, processing: 0, failed: 0, rejected: 0, last_rejection: null })
  await assert.rejects(readFile(path.join(lock, 'owner.json')), /ENOENT/)
})

test('continuous Gate rejects unknown actions, Controller Adapters and remote write entrypoints', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.test, 'npm run quality:standard')
  assert.match(packageJson.scripts['quality:standard'], /check:feishu-contracts/)
  const fixture = await tempRoot('feishu-contract-gate-')
  for (const directory of ['src/connectors', 'tools']) await mkdir(path.join(fixture, directory), { recursive: true })
  for (const file of ['feishu-callback.ts', 'feishu-confirmation.ts', 'feishu-controller.ts', 'feishu-progress.ts', 'feishu.ts']) {
    await cp(path.join(process.cwd(), 'src', 'connectors', file), path.join(fixture, 'src', 'connectors', file))
  }
  await cp(path.join(process.cwd(), 'src', 'cli.ts'), path.join(fixture, 'src', 'cli.ts'))
  await cp(path.join(process.cwd(), 'tools', 'feishu-connector-contract.json'), path.join(fixture, 'tools', 'feishu-connector-contract.json'))
  assert.equal((await checkFeishuConnectorContracts(fixture)).actions, 10)
  await writeFile(path.join(fixture, 'src', 'connectors', 'feishu-unknown.ts'), 'class Unknown implements ConfirmationControllerAdapter {}\n')
  await assert.rejects(checkFeishuConnectorContracts(fixture), /Controller Adapter discovery/)
  await rm(path.join(fixture, 'src', 'connectors', 'feishu-unknown.ts'))
  const callbackFile = path.join(fixture, 'src', 'connectors', 'feishu-callback.ts'), original = await readFile(callbackFile, 'utf8')
  await writeFile(callbackFile, original.replace("'accept_heavy', 'reject_heavy',", "'accept_heavy', 'reject_heavy', 'unknown_action',"))
  await assert.rejects(checkFeishuConnectorContracts(fixture), /action schemas differ/)
  await writeFile(callbackFile, original)
  const controllerFile = path.join(fixture, 'src', 'connectors', 'feishu-controller.ts'), controllerSource = await readFile(controllerFile, 'utf8')
  await writeFile(controllerFile, controllerSource.replace("heavy_acceptance: ['accept_heavy', 'reject_heavy']", "heavy_acceptance: ['accept_heavy']"))
  await assert.rejects(checkFeishuConnectorContracts(fixture), /Controller action mapping/)
  await writeFile(controllerFile, controllerSource)
  await writeFile(callbackFile, `${original}\nexport async function hiddenWrite(){ return processFeishuAction('x','y',{}) }\n`)
  await assert.rejects(checkFeishuConnectorContracts(fixture), /unregistered remote write entrypoint/)
})
