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
  createRedactingFeishuLogger,
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
  withFeishuLeaseFence,
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
    tenant_key: '736588c9260f175c',
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

  await writeFile(file, JSON.stringify({ ...enabledConfig(), tenant_key: 'configure-tenant-key' }))
  await assert.rejects(readFeishuConfig(root), /valid tenant key/i)

  await writeFile(file, JSON.stringify({ ...enabledConfig(), tenant_key: 'TODO' }))
  await assert.rejects(readFeishuConfig(root), /valid tenant key/i)

  await writeFile(file, JSON.stringify({ ...enabledConfig(), targets: [{ project_id: 'PROJ-TEST', receive_id_type: 'chat_id', receive_id: 'todo' }] }))
  await assert.rejects(readFeishuConfig(root), /invalid chat_id target/i)

  await writeFile(file, JSON.stringify({ ...enabledConfig(), approvers: [{
    project_id: 'PROJ-TEST', open_id: 'todo', local_actor: 'todo', request_types: ['proposal'],
  }] }))
  await assert.rejects(readFeishuConfig(root), /open_id|local actor/i)
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
  const jsonLog = '{"app_secret":"json-secret","tenant_access_token":"json-token"}'
  assert.equal(redactFeishuText(jsonLog), '{"app_secret":"[REDACTED]","tenant_access_token":"[REDACTED]"}')
  const genericLog = 'token=plain-canary-token refresh_token=refresh-canary-token Authorization: Basic Zm9vOmJhcg=='
  const genericRedacted = redactFeishuText(genericLog)
  assert.equal(genericRedacted.includes('plain-canary-token'), false)
  assert.equal(genericRedacted.includes('refresh-canary-token'), false)
  assert.equal(genericRedacted.includes('Zm9vOmJhcg=='), false)

  const sdkLogs = []
  const sdkLogger = createRedactingFeishuLogger(
    { appId: 'cli_sensitive_app', appSecret: secret },
    { error: (line) => sdkLogs.push(line), warn: (line) => sdkLogs.push(line), info: (line) => sdkLogs.push(line), debug: (line) => sdkLogs.push(line) },
  )
  sdkLogger.error({ app_secret: secret, tenant_access_token: 'json-token', authorization: 'Bearer abcdefghijklmnop' })
  assert.equal(sdkLogs.length, 1)
  assert.equal(sdkLogs[0].includes(secret), false)
  assert.equal(sdkLogs[0].includes('json-token'), false)
  assert.equal(sdkLogs[0].includes('abcdefghijklmnop'), false)

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

test('official preflight requires bot activation and message permission', async () => {
  let permissionGranted = true
  const channel = {
    rawClient: {
      application: { v6: { scope: { list: async () => ({
        code: 0, data: { scopes: [{ scope_name: 'im:message:send_as_bot', grant_status: 1, scope_type: 'tenant' }] },
      }) } } },
      im: { v1: { message: { create: async () => ({ data: { message_id: 'om_preflight' } }) } } },
      request: async ({ url }) => url.includes('/scopes')
        ? { code: 0, data: { scopes: permissionGranted ? [{ scope_name: 'im:message:send_as_bot', grant_status: 1, scope_type: 'tenant' }] : [] } }
        : { code: 0, bot: { activate_status: 2, open_id: 'ou_bot' } },
    },
    connect: async () => {}, disconnect: async () => {}, getConnectionStatus: () => ({ state: 'connected' }),
    on: () => () => {}, send: async () => ({ messageId: 'unused' }), updateCard: async () => {},
  }
  const transport = new OfficialFeishuTransport({ appId: 'cli_test', appSecret: 'not-used' }, async () => channel)
  await transport.preflight(enabledConfig())
  permissionGranted = false
  await assert.rejects(transport.preflight(enabledConfig()), /required permission/)
})

test('official preflight cancellation does not wait for a slow channel factory', async () => {
  const controller = new AbortController()
  const transport = new OfficialFeishuTransport(
    { appId: 'cli_test', appSecret: 'not-used' },
    async () => new Promise(() => {}),
  )
  const preflight = transport.preflight(enabledConfig(), controller.signal)
  controller.abort()
  await assert.rejects(preflight, /cancelled/)
})

test('official connect failure removes the old callback before retry', async () => {
  const handlers = []
  let attempts = 0
  const channel = {
    rawClient: {
      application: { v6: { scope: { list: async () => ({ code: 0, data: { scopes: [] } }) } } },
      im: { v1: { message: { create: async () => ({ data: { message_id: 'om_retry' } }) } } },
      request: async () => ({ code: 0, bot: { activate_status: 2, open_id: 'ou_bot' } }),
    },
    connect: async () => { if (attempts++ === 0) throw new Error('first connect fails') },
    disconnect: async () => {}, getConnectionStatus: () => ({ state: 'connected' }),
    on: (_name, handler) => { handlers.push(handler); return () => handlers.splice(handlers.indexOf(handler), 1) },
    send: async () => ({ messageId: 'unused' }), updateCard: async () => {},
  }
  const transport = new OfficialFeishuTransport({ appId: 'cli_test', appSecret: 'not-used' }, async () => channel)
  await assert.rejects(transport.connect(async () => {}), /first connect fails/)
  assert.equal(handlers.length, 0)
  await transport.connect(async () => {})
  assert.equal(handlers.length, 1)
  await transport.disconnect()
  assert.equal(handlers.length, 0)
})

test('channel factory errors are redacted for preflight and message methods', async () => {
  const secret = 'factory-secret-canary'
  const methods = ['preflight', 'sendCard', 'updateCard']
  for (const method of methods) {
    const transport = new OfficialFeishuTransport(
      { appId: 'factory-app-canary', appSecret: secret },
      async () => { throw new Error(`factory failed with ${secret}`) },
    )
    let error
    try {
      if (method === 'preflight') await transport.preflight(enabledConfig())
      else if (method === 'sendCard') await transport.sendCard(enabledConfig().targets[0], {})
      else await transport.updateCard('om_test', {})
    } catch (caught) { error = caught }
    assert.ok(error)
    assert.equal(error.message.includes(secret), false)
  }
})

test('disconnect during a slow factory prevents callbacks and concurrent retry', async () => {
  let releaseFactory
  let handler
  let handled = 0
  const channel = {
    rawClient: {
      application: { v6: { scope: { list: async () => ({ code: 0, data: { scopes: [] } }) } } },
      im: { v1: { message: { create: async () => ({ data: { message_id: 'om_cancel' } }) } } },
      request: async () => ({ code: 0, bot: { activate_status: 2, open_id: 'ou_bot' } }),
    },
    on: (_name, callback) => { handler = callback; return () => { handler = undefined } },
    connect: async () => { if (handler) await handler({ messageId: 'm', chatId: 'c', operator: { openId: 'o' }, action: { value: {}, tag: 'button' } }) },
    disconnect: async () => {}, getConnectionStatus: () => ({ state: 'idle' }),
    send: async () => ({ messageId: 'unused' }), updateCard: async () => {},
  }
  const factoryBarrier = new Promise((resolve) => { releaseFactory = () => resolve(channel) })
  const transport = new OfficialFeishuTransport({ appId: 'cli_test', appSecret: 'not-used' }, async () => factoryBarrier)
  const connecting = transport.connect(async () => { handled += 1 })
  await transport.disconnect()
  await assert.rejects(transport.connect(async () => {}), /cannot connect/)
  releaseFactory()
  await assert.rejects(connecting, /cancelled/)
  assert.equal(handled, 0)
  assert.equal(transport.connectionState(), 'idle')
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

test('lease competition failure still disconnects the preflight transport', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  const first = await acquireFeishuLease(root, 'existing-holder')
  let disconnects = 0
  class TrackedTransport extends FakeFeishuTransport {
    async disconnect() { disconnects += 1; await super.disconnect() }
  }
  await assert.rejects(
    runFeishuConnector(root, { holder: 'competing-runner', transport: new TrackedTransport() }),
    /held by existing-holder/,
  )
  assert.equal(disconnects, 1)
  await releaseFeishuLease(root, first.token)
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

test('slow transport connection keeps renewing before callbacks are accepted', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  class SlowTransport extends FakeFeishuTransport {
    async connect(handler) {
      await new Promise((resolve) => setTimeout(resolve, 1250))
      await super.connect(handler)
    }
  }
  const controller = new AbortController()
  const running = runFeishuConnector(root, {
    holder: 'slow-connecting-holder', transport: new SlowTransport(), signal: controller.signal, leaseTtlMs: 1000,
  })
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await assert.rejects(acquireFeishuLease(root, 'slow-connection-competitor', 1000), /held by slow-connecting-holder/)
  controller.abort()
  await running
})

test('abort can stop a connector whose transport connect never resolves', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  class HangingTransport extends FakeFeishuTransport {
    async connect() { await new Promise(() => {}) }
  }
  const controller = new AbortController()
  const running = runFeishuConnector(root, {
    holder: 'hanging-transport-holder', transport: new HangingTransport(), signal: controller.signal, leaseTtlMs: 1000,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(() => reject(new Error('connector did not stop after abort')), 500)),
  ])
  assert.equal(await readFeishuLease(root), null)
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

test('an expired lease cannot be revived by its original token', async () => {
  const root = await projectRoot()
  const lease = await acquireFeishuLease(root, 'expired-original-holder', 1000)
  await new Promise((resolve) => setTimeout(resolve, 1050))
  await assert.rejects(renewFeishuLease(root, lease.token, 1000), /lease was lost/)
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

test('abort cancels preflight and always disconnects transport before lease acquisition', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  let preflightAborted = false
  let disconnects = 0
  class AbortablePreflightTransport extends FakeFeishuTransport {
    async preflight(_config, signal) {
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
        preflightAborted = true
        reject(new Error('preflight aborted'))
      }, { once: true }))
    }
    async disconnect() { disconnects += 1; await super.disconnect() }
  }
  const controller = new AbortController()
  const running = runFeishuConnector(root, {
    holder: 'preflight-abort-holder', transport: new AbortablePreflightTransport(), signal: controller.signal,
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await running
  assert.equal(preflightAborted, true)
  assert.equal(disconnects, 1)
  assert.equal(await readFeishuLease(root), null)
})

test('aborting closes the action gate before transport disconnect completes', async () => {
  const root = await projectRoot()
  const file = await initFeishuConfig(root)
  await writeFile(file, `${JSON.stringify(enabledConfig(), null, 2)}\n`)
  let releaseDisconnect
  const disconnectBarrier = new Promise((resolve) => { releaseDisconnect = resolve })
  class SlowDisconnectTransport extends FakeFeishuTransport {
    async disconnect() {
      await disconnectBarrier
      await super.disconnect()
    }
  }
  const transport = new SlowDisconnectTransport()
  const controller = new AbortController()
  const running = runFeishuConnector(root, { holder: 'abort-gate-holder', transport, signal: controller.signal })
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await writeFile(path.join(root, '.spec-loop', 'connectors', 'feishu', 'lease.json'), 'invalid-json')
  await transport.emitCardAction({
    messageId: 'om_after_abort', chatId: 'oc_test_chat', operatorOpenId: 'ou_test_user',
    action: { value: {}, tag: 'button', name: 'approve' },
  })
  releaseDisconnect()
  await running
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

test('lease fencing prevents takeover until callback persistence finishes', async () => {
  const root = await projectRoot()
  const lease = await acquireFeishuLease(root, 'fenced-holder', 1000)
  let actionActive = false
  const fenced = withFeishuLeaseFence(root, lease.token, async () => {
    actionActive = true
    await new Promise((resolve) => setTimeout(resolve, 1150))
    actionActive = false
  })
  await new Promise((resolve) => setTimeout(resolve, 1050))
  const replacementPromise = acquireFeishuLease(root, 'post-fence-holder', 1000)
  await fenced
  const replacement = await replacementPromise
  assert.equal(actionActive, false)
  assert.equal(replacement.holder, 'post-fence-holder')
  await releaseFeishuLease(root, replacement.token)
})

test('orphaned mutation locks fail closed instead of being reclaimed concurrently', async () => {
  const root = await projectRoot()
  await initFeishuConfig(root)
  const lockDirectory = path.join(root, '.spec-loop', 'connectors', 'feishu', 'lease-mutation.lock')
  await mkdir(lockDirectory)
  await assert.rejects(acquireFeishuLease(root, 'blocked-holder', 1000), /explicit recovery is required/)
  await rm(lockDirectory, { recursive: true, force: true })
})

test('lease ttl starts only after mutation lock acquisition', async () => {
  const root = await projectRoot()
  await initFeishuConfig(root)
  const lockDirectory = path.join(root, '.spec-loop', 'connectors', 'feishu', 'lease-mutation.lock')
  await mkdir(lockDirectory)
  const removal = new Promise((resolve) => setTimeout(resolve, 500)).then(() => rm(lockDirectory, { recursive: true, force: true }))
  const lease = await acquireFeishuLease(root, 'delayed-holder', 1000)
  await removal
  assert.ok(Date.parse(lease.expires_at) - Date.now() > 850)
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
