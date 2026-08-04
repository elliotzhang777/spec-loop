import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { cli, tempRoot } from './helpers.mjs'
import {
  FakeFeishuTransport,
  LocalSecretProvider,
  OfficialFeishuTransport,
  acquireFeishuLease,
  defaultFeishuConfig,
  feishuConnectorStatus,
  initFeishuConfig,
  readFeishuLease,
  readFeishuConfig,
  redactFeishuText,
  releaseFeishuLease,
  renewFeishuLease,
  runFeishuConnector,
  stopFeishuConnector,
  resolveFeishuCredentials,
} from '../dist/connectors/feishu.js'

async function projectRoot(name = 'feishu-connector-') {
  const root = await tempRoot(name)
  await mkdir(path.join(root, '.spec-loop'))
  return root
}

function enabledConfig() {
  return {
    ...defaultFeishuConfig(),
    enabled: true,
    tenant_key: 'tenant-test',
    targets: [{ project_id: 'PROJ-TEST', receive_id_type: 'chat_id', receive_id: 'oc_test_chat' }],
    approvers: [{
      project_id: 'PROJ-TEST', open_id: 'ou_test_user', local_actor: 'zhangbo',
      request_types: ['proposal', 'verification', 'heavy_acceptance'],
    }],
  }
}

test('feishu config initializes disabled and validates strictly', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  const config = await readFeishuConfig(root)
  assert.equal(config.enabled, false)
  assert.equal(config.targets.length, 0)
  assert.match(file, /\.spec-loop\/connectors\/feishu\/config\.json$/)

  await writeFile(file, JSON.stringify({ ...config, unexpected: true }))
  await assert.rejects(readFeishuConfig(root), /unrecognized key|unrecognized_keys/i)
})

test('enabled config requires targets, approvers and valid retry bounds', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  const config = defaultFeishuConfig()
  await writeFile(file, JSON.stringify({ ...config, enabled: true }))
  await assert.rejects(readFeishuConfig(root), /target|approver/i)

  await writeFile(file, JSON.stringify({ ...enabledConfig(), retry: { max_attempts: 2, base_delay_ms: 5000, max_delay_ms: 1000 } }))
  await assert.rejects(readFeishuConfig(root), /max delay/i)
})

test('config and connector paths reject symbolic links', async () => {
  const root = await projectRoot()
  const outside = await tempRoot('feishu-outside-')
  await mkdir(path.join(root, '.spec-loop', 'connectors'))
  await symlink(outside, path.join(root, '.spec-loop', 'connectors', 'feishu'))
  await assert.rejects(initFeishuConfig(root), /symbolic/i)
})

test('secret provider resolves references without exposing values', async () => {
  const config = enabledConfig()
  const secret = 'super-private-secret-value'
  const provider = new LocalSecretProvider({
    SPEC_LOOP_FEISHU_APP_ID: 'cli_test_app',
    SPEC_LOOP_FEISHU_APP_SECRET: secret,
  })
  assert.deepEqual(await resolveFeishuCredentials(config, provider), { appId: 'cli_test_app', appSecret: secret })
  assert.equal(redactFeishuText(`app_secret=${secret} Authorization: Bearer abcdefghijklmnop`, [secret]), 'app_secret=[REDACTED] Authorization=[REDACTED]')

  await assert.rejects(resolveFeishuCredentials(config, new LocalSecretProvider({})), /reference is unavailable/)
})

test('fake and official transports share the lifecycle contract', async () => {
  const fake = new FakeFeishuTransport()
  const actions = []
  await fake.connect(async (action) => actions.push(action))
  assert.equal(fake.connectionState(), 'connected')
  const target = enabledConfig().targets[0]
  const sent = await fake.sendCard(target, { header: { title: 'progress' } })
  await fake.updateCard(sent.messageId, { header: { title: 'updated' } })
  await fake.emitCardAction({
    messageId: sent.messageId, chatId: 'oc_test_chat', operatorOpenId: 'ou_test_user',
    action: { value: { request_id: 'REQ-1' }, tag: 'button', name: 'approve' },
  })
  assert.equal(fake.sent.length, 1)
  assert.equal(fake.updated.length, 1)
  assert.equal(actions.length, 1)
  await fake.disconnect()
  assert.equal(fake.connectionState(), 'idle')

  const official = new OfficialFeishuTransport({ appId: 'cli_test', appSecret: 'not-used' })
  assert.equal(official.connectionState(), 'idle')
})

test('official transport sends with the configured receive id type', async () => {
  const calls = []
  const channel = {
    rawClient: { im: { v1: { message: { create: async (payload) => {
      calls.push(payload)
      return { data: { message_id: 'om_explicit' } }
    } } } } },
    connect: async () => {}, disconnect: async () => {}, getConnectionStatus: () => ({ state: 'connected' }),
    on: () => () => {}, send: async () => ({ messageId: 'unused' }), updateCard: async () => {},
  }
  const transport = new OfficialFeishuTransport({ appId: 'cli_test', appSecret: 'not-used' }, async () => channel)
  const result = await transport.sendCard(
    { project_id: 'PROJ-TEST', receive_id_type: 'user_id', receive_id: 'ou_prefix_must_not_override_config' },
    { header: { title: 'explicit route' } },
  )
  assert.equal(result.messageId, 'om_explicit')
  assert.equal(calls[0].params.receive_id_type, 'user_id')
})

test('connector lease prevents a second local consumer', async () => {
  const root = await projectRoot()
  const first = await acquireFeishuLease(root, 'first-holder')
  await assert.rejects(acquireFeishuLease(root, 'second-holder'), /held by first-holder/)
  await assert.rejects(releaseFeishuLease(root, 'wrong-token'), /token does not match/)
  await releaseFeishuLease(root, first.token)
  const second = await acquireFeishuLease(root, 'second-holder')
  assert.equal(second.holder, 'second-holder')
  await releaseFeishuLease(root, second.token)
})

test('running connector renews its lease until stopped', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  const fake = new FakeFeishuTransport()
  const controller = new AbortController()
  const running = runFeishuConnector(root, { holder: 'renewing-holder', transport: fake, signal: controller.signal, leaseTtlMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 1250))
  await assert.rejects(acquireFeishuLease(root, 'competing-holder', 1000), /held by renewing-holder/)
  controller.abort()
  await running
  const next = await acquireFeishuLease(root, 'next-holder', 1000)
  await releaseFeishuLease(root, next.token)
})

test('stop requests are token-bound and handled cooperatively without signalling a pid', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  const fake = new FakeFeishuTransport()
  const originalKill = process.kill
  let killCalled = false
  process.kill = () => { killCalled = true; return true }
  try {
    const running = runFeishuConnector(root, { holder: 'cooperative-holder', transport: fake, leaseTtlMs: 1000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(await stopFeishuConnector(root), { stopped: true, holder: 'cooperative-holder' })
    await running
    assert.equal(killCalled, false)
    assert.equal(await readFeishuLease(root), null)
  } finally {
    process.kill = originalKill
  }
})

test('an expired owner cannot renew over a replacement lease', async () => {
  const root = await projectRoot()
  const oldLease = await acquireFeishuLease(root, 'expired-holder', 1000)
  await new Promise((resolve) => setTimeout(resolve, 1050))
  const replacement = await acquireFeishuLease(root, 'replacement-holder', 1000)
  await assert.rejects(
    renewFeishuLease(root, oldLease.token, 1000),
    /lease was lost/,
  )
  assert.equal((await readFeishuLease(root)).token, replacement.token)
  await releaseFeishuLease(root, replacement.token)
})

test('pre-aborted external signals stop before connecting and release the lease', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  const fake = new FakeFeishuTransport()
  const controller = new AbortController()
  controller.abort()
  await runFeishuConnector(root, { holder: 'aborted-holder', transport: fake, signal: controller.signal })
  assert.equal(fake.connectionState(), 'idle')
  assert.equal(await readFeishuLease(root), null)
})

test('credential resolution failure happens before lease acquisition', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  await assert.rejects(
    runFeishuConnector(root, { holder: 'missing-secret-holder', secretProvider: new LocalSecretProvider({}) }),
    /reference is unavailable/,
  )
  assert.equal(await readFeishuLease(root), null)
})

test('concurrent renewals are serialized without losing lease ownership', async () => {
  const root = await projectRoot()
  const lease = await acquireFeishuLease(root, 'serialized-holder', 1000)
  await Promise.all(Array.from({ length: 12 }, () => renewFeishuLease(root, lease.token, 1000)))
  assert.equal((await readFeishuLease(root)).token, lease.token)
  await releaseFeishuLease(root, lease.token)
})

test('CLI config and status never print credential values', async () => {
  const root = await projectRoot()
  const initialized = cli(['connectors', 'feishu', 'init', root, '--json'])
  assert.equal(initialized.code, 0, initialized.stderr)
  const file = path.join(root, '.spec-loop', 'connectors', 'feishu', 'config.json')
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)

  const secret = 'never-print-this-secret'
  const env = { ...process.env, SPEC_LOOP_FEISHU_APP_ID: 'cli_test_app', SPEC_LOOP_FEISHU_APP_SECRET: secret }
  const checked = cli(['connectors', 'feishu', 'check', root, '--json'], { env })
  assert.equal(checked.code, 0, checked.stderr)
  const status = cli(['connectors', 'feishu', 'status', root, '--json'], { env })
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).credentials_available, true)
  assert.equal(`${checked.stdout}${checked.stderr}${status.stdout}${status.stderr}`.includes(secret), false)
  const help = cli(['connectors', 'feishu', '--help'])
  assert.equal(help.code, 0, help.stderr)
  assert.match(help.stdout, /start/)
  assert.match(help.stdout, /stop/)
})

test('default config is stable JSON without credential values', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  const raw = await readFile(file, 'utf8')
  assert.match(raw, /SPEC_LOOP_FEISHU_APP_SECRET/)
  assert.doesNotMatch(raw, /app_secret"\s*:\s*"(?!SPEC_LOOP_)/)
  await rm(root, { recursive: true, force: true })
})
