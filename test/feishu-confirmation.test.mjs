import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { tempRoot } from './helpers.mjs'
import { initFeishuConfig } from '../dist/connectors/feishu.js'
import { readExecutionEvents } from '../dist/execution-events.js'
import {
  checkConfirmationProjection,
  confirmationRequestSchema,
  consumeConfirmationRequest,
  createConfirmationRequest,
  expireConfirmationRequests,
  invalidateIfConfirmationFactsChanged,
  listConfirmationRequests,
  rebuildConfirmationProjection,
  regenerateConfirmationRequest,
  renderConfirmationCard,
} from '../dist/connectors/feishu-confirmation.js'

const actor = 'ou_12345678_actor'
const digest = (character) => character.repeat(64)

async function projectRoot(name = 'feishu-confirmation-') {
  const root = await tempRoot(name)
  await mkdir(path.join(root, '.spec-loop'))
  await initFeishuConfig(root)
  return root
}

function facts(overrides = {}) {
  return {
    scope_summary: '验证当前任务候选的既定范围',
    evidence_summary: ['定向构建通过', '独立复核结论可在本地查看'],
    invalidation_summary: 'revision、Acceptance、截图或 Gate Plan 任一变化即失效',
    acceptance_hash: digest('a'),
    screenshot_hashes: [],
    gate_plan_hash: digest('b'),
    reference_ids: ['AC-1', 'GATE-1'],
    options: [],
    ...overrides,
  }
}

async function create(root, type = 'verification', overrides = {}) {
  return createConfirmationRequest(root, {
    type,
    projectId: 'PROJ-SPEC-LOOP',
    taskId: 'TASK-023',
    round: 1,
    revision: '1234567890abcdef',
    risk: type === 'heavy_acceptance' ? 'heavy' : 'standard',
    facts: facts(type === 'needs_user' ? { options: [{ id: 'OPTION_A', label: '采用推荐方案' }, { id: 'OPTION_B', label: '暂停处理' }] } : {}),
    allowedActorIds: [actor],
    ttlSeconds: 3600,
    now: new Date('2026-08-04T10:00:00.000Z'),
    ...overrides,
  })
}

test('managed confirmation requests produce classified and paired user waits',async()=>{
  const root=await projectRoot('feishu-wait-events-')
  await writeFile(path.join(root,'.spec-loop','PROJECT.md'),'---\nproject_id: PROJ-SPEC-LOOP\n---\nManaged confirmation fixture.\n')
  const cases=[['proposal','approve_proposal','等待用户确认任务规格'],['needs_user','choose_option','等待用户提供结构化输入'],['verification','authorize_verification','等待正式验证授权'],['heavy_acceptance','accept_heavy','等待 Heavy 验收']]
  for(let index=0;index<cases.length;index++){
    const [kind,action,label]=cases[index],created=new Date(Date.parse('2026-08-04T10:00:00.000Z')+index*120_000)
    const request=await create(root,kind,{now:created})
    const start=(await readExecutionEvents(root)).find(event=>event.kind==='wait_started'&&event.run_id===request.request_id)
    assert.equal(start?.label,label)
    await consumeConfirmationRequest(root,request.request_id,action,actor,new Date(created.getTime()+60_000))
    const terminal=(await readExecutionEvents(root)).find(event=>event.kind==='wait_ended'&&event.step_run_id===start.step_run_id)
    assert.equal(terminal?.outcome,'success')
  }
})

test('a committed confirmation wait is recovered after event-store failure',async()=>{
  const root=await projectRoot('feishu-wait-recovery-'),control=path.join(root,'.spec-loop')
  await writeFile(path.join(control,'PROJECT.md'),'---\nproject_id: PROJ-SPEC-LOOP\n---\nManaged fixture.\n')
  const eventFile=path.join(control,'EXECUTION_EVENTS.jsonl'),outside=path.join(root,'outside.jsonl')
  await writeFile(outside,'')
  await symlink(outside,eventFile)
  await assert.rejects(create(root,'verification'),/symbolic|execution event/)
  await rm(eventFile)
  const [request]=await listConfirmationRequests(root)
  assert.equal(request.status,'pending')
  let starts=(await readExecutionEvents(root)).filter(event=>event.kind==='wait_started'&&event.run_id===request.request_id)
  assert.equal(starts.length,1)
  await expireConfirmationRequests(root,new Date('2026-08-04T11:01:00.000Z'))
  await listConfirmationRequests(root)
  const events=await readExecutionEvents(root)
  starts=events.filter(event=>event.kind==='wait_started'&&event.run_id===request.request_id)
  assert.equal(starts.length,1)
  assert.equal(events.filter(event=>event.kind==='wait_ended'&&event.step_run_id===starts[0].step_run_id).length,1)
})

test('all five request types bind immutable authority facts and fixed action allowlists', async () => {
  const root = await projectRoot()
  const fixtures = {
    proposal: ['approve_proposal', 'reject_proposal'],
    needs_user: ['choose_option', 'pause_task'],
    visual_review: ['approve_visual', 'reject_visual'],
    verification: ['authorize_verification', 'defer_verification'],
    heavy_acceptance: ['accept_heavy', 'reject_heavy'],
  }
  for (const [type, actions] of Object.entries(fixtures)) {
    const request = await create(root, type)
    assert.equal(request.task_id, 'TASK-023')
    assert.equal(request.round, 1)
    assert.equal(request.revision, '1234567890abcdef')
    assert.match(request.content_hash, /^[a-f0-9]{64}$/)
    assert.deepEqual(request.allowed_actions, actions)
    assert.deepEqual(request.allowed_actor_ids, [actor])
    assert.equal(request.status, 'pending')
  }
  assert.equal((await checkConfirmationProjection(root)).request_count, 5)
})

test('cards show decision context while action payloads contain only opaque request and fixed action ids', async () => {
  for (const type of ['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance']) {
    const root = await projectRoot()
    const request = await create(root, type)
    const card = renderConfirmationCard(request)
    const rendered = JSON.stringify(card)
    assert.match(rendered, /验证当前任务候选的既定范围/)
    assert.match(rendered, /失效条件/)
    assert.match(rendered, /有效期至/)
    const actionBlock = card.body.elements.find((element) => element.tag === 'action')
    for (const action of actionBlock.actions) {
      assert.deepEqual(Object.keys(action.value).sort(), ['action_id', 'request_id'])
      assert.equal(action.value.request_id, request.request_id)
      assert.equal('revision' in action.value, false)
      assert.equal('risk' in action.value, false)
      assert.equal('scope' in action.value, false)
    }
    assert.doesNotMatch(rendered, /"action_id":"(?:merge|push|deploy)/i)
  }
})

test('revision, Acceptance, screenshots and Gate Plan changes invalidate the old request', async () => {
  const changes = [
    { revision: 'fedcba0987654321' },
    { facts: facts({ acceptance_hash: digest('c') }) },
    { facts: facts({ screenshot_hashes: [digest('d')] }) },
    { facts: facts({ gate_plan_hash: digest('e') }) },
  ]
  for (const change of changes) {
    const root = await projectRoot()
    const request = await create(root)
    const result = await invalidateIfConfirmationFactsChanged(root, request.request_id, {
      revision: request.revision,
      round: request.round,
      risk: request.risk,
      facts: request.facts,
      ...change,
    }, new Date('2026-08-04T10:01:00.000Z'))
    assert.equal(result.status, 'invalidated')
  }
})

test('requests are single-consumption, actor-bound, action-bound and expiry-bound', async () => {
  const root = await projectRoot()
  const request = await create(root)
  const now = new Date('2026-08-04T10:02:00.000Z')
  await assert.rejects(consumeConfirmationRequest(root, request.request_id, 'approve_proposal', actor, now), /action is not allowed/i)
  await assert.rejects(consumeConfirmationRequest(root, request.request_id, 'authorize_verification', 'ou_87654321_other', now), /actor is not allowed/i)
  const consumed = await consumeConfirmationRequest(root, request.request_id, 'authorize_verification', actor, now)
  assert.equal(consumed.status, 'consumed')
  await assert.rejects(consumeConfirmationRequest(root, request.request_id, 'authorize_verification', actor, now), /already consumed/i)

  const expired = await create(root, 'proposal', { now: new Date('2026-08-04T11:00:00.000Z'), ttlSeconds: 60 })
  assert.equal(await expireConfirmationRequests(root, new Date('2026-08-04T11:02:00.000Z')), 1)
  assert.equal((await listConfirmationRequests(root)).find((item) => item.request_id === expired.request_id).status, 'expired')
})

test('confirmation store reclaims a lock left by a crashed process', async () => {
  const root = await projectRoot()
  await create(root)
  const lock = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'mutation.lock')
  await mkdir(lock)
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({
    schema_version: 1,
    pid: 2147483647,
    token: 'crashed-process-token',
    acquired_at: '2026-08-04T09:00:00.000Z',
  }))
  assert.equal((await listConfirmationRequests(root)).length, 1)
  await assert.rejects(readFile(path.join(lock, 'owner.json')), /ENOENT/)
})

test('authority changes atomically invalidate the request before consumption', async () => {
  const root = await projectRoot()
  const request = await create(root)
  const result = await invalidateIfConfirmationFactsChanged(root, request.request_id, {
    revision: 'fedcba0987654321',
    round: request.round,
    risk: request.risk,
    facts: request.facts,
  }, new Date('2026-08-04T10:03:00.000Z'))
  assert.equal(result.status, 'invalidated')
  assert.equal(result.consumed_action, null)
  assert.match(result.invalidation_reason, /候选 revision/)
  await assert.rejects(consumeConfirmationRequest(root, request.request_id, 'authorize_verification', actor, new Date('2026-08-04T10:04:00.000Z')), /already invalidated/i)
})

test('consumption reads an independently persisted current authority projection', async () => {
  const root = await projectRoot()
  const request = await create(root)
  const authorityFile = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'current-authority.json')
  const authority = JSON.parse(await readFile(authorityFile, 'utf8'))
  authority.authorities[0].revision = 'fedcba0987654321'
  authority.authorities[0].generation += 1
  authority.authorities[0].updated_at = '2026-08-04T10:01:00.000Z'
  authority.projection_hash = createHash('sha256').update(JSON.stringify(authority.authorities)).digest('hex')
  await writeFile(authorityFile, JSON.stringify(authority, null, 2))
  await rm(path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'projection.json'))
  assert.equal((await listConfirmationRequests(root)).length, 1)
  const result = await consumeConfirmationRequest(root, request.request_id, 'authorize_verification', actor, new Date('2026-08-04T10:02:00.000Z'))
  assert.equal(result.status, 'invalidated')
  assert.match(result.invalidation_reason, /当前权威 revision/)
})

test('regeneration invalidates the old request and binds a new revision and content hash', async () => {
  const root = await projectRoot()
  const old = await create(root, 'visual_review', { facts: facts({ screenshot_hashes: [digest('c')] }) })
  const replacement = await regenerateConfirmationRequest(root, old.request_id, {
    revision: 'abcdef0123456789',
    round: 2,
    risk: 'standard',
    facts: facts({ screenshot_hashes: [digest('d')] }),
    ttlSeconds: 3600,
    now: new Date('2026-08-04T10:05:00.000Z'),
  })
  const all = await listConfirmationRequests(root)
  assert.equal(all.find((item) => item.request_id === old.request_id).status, 'invalidated')
  assert.equal(replacement.status, 'pending')
  assert.equal(replacement.revision, 'abcdef0123456789')
  assert.notEqual(replacement.content_hash, old.content_hash)
})

test('projection deletion is rebuildable while projection or history tampering fails closed', async () => {
  const root = await projectRoot()
  await create(root)
  const store = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations')
  const projection = path.join(store, 'projection.json')
  await rm(projection)
  assert.equal((await listConfirmationRequests(root)).length, 1)
  assert.equal((await checkConfirmationProjection(root)).valid, true)

  const projectionValue = JSON.parse(await readFile(projection, 'utf8'))
  projectionValue.requests[0].risk = 'heavy'
  await writeFile(projection, JSON.stringify(projectionValue, null, 2))
  await assert.rejects(checkConfirmationProjection(root), /projection integrity|content hash/i)

  await rebuildConfirmationProjection(root)
  const history = path.join(store, 'history.jsonl')
  const historyText = await readFile(history, 'utf8')
  await writeFile(history, historyText.replace('1234567890abcdef', 'fedcba0987654321'))
  await assert.rejects(rebuildConfirmationProjection(root), /history integrity|content hash/i)
})

test('missing history can never be replaced by empty rebuilt projections', async () => {
  const root = await projectRoot()
  await create(root)
  const store = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations')
  await rm(path.join(store, 'history.jsonl'))
  await assert.rejects(rebuildConfirmationProjection(root), /history is missing/i)

  const fullyMissingRoot = await projectRoot()
  await create(fullyMissingRoot)
  const fullyMissingStore = path.join(fullyMissingRoot, '.spec-loop', 'connectors', 'feishu', 'confirmations')
  await Promise.all(['history.jsonl', 'projection.json', 'current-authority.json'].map((name) => rm(path.join(fullyMissingStore, name))))
  await assert.rejects(rebuildConfirmationProjection(fullyMissingRoot), /history is missing/i)
})

test('sensitive summaries and non-predefined options fail before persistence', async () => {
  const root = await projectRoot()
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'Authorization: Bearer abcdefghijklmnop' }) }), /sensitive/i)
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'password=hunter2' }) }), /sensitive/i)
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'api_key=abcdefghijklmnopqrstuvxyz0123456789' }) }), /sensitive/i)
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'AKIAIOSFODNN7EXAMPLE' }) }), /sensitive/i)
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'AIzaSyD8xYQf8JkY0xM6wQ2pN4rS7tU9vW1zA' }) }), /sensitive/i)
  await assert.rejects(create(root, 'proposal', { facts: facts({ scope_summary: 'glpat-abcdefghijklmnopqrst' }) }), /sensitive/i)
  await assert.rejects(create(root, 'needs_user', { facts: facts({ options: [] }) }), /predefined options/i)
  assert.equal((await listConfirmationRequests(root)).length, 0)
})

test('request schema rejects semantically inconsistent terminal snapshots', async () => {
  const root = await projectRoot()
  const request = await create(root)
  assert.equal(confirmationRequestSchema.safeParse({ ...request, status: 'consumed' }).success, false)
  assert.equal(confirmationRequestSchema.safeParse({ ...request, status: 'invalidated', invalidation_reason: null }).success, false)
  assert.equal(confirmationRequestSchema.safeParse({
    ...request,
    status: 'consumed',
    consumed_at: '2026-08-04T10:02:00.000Z',
    consumed_action: 'reject_visual',
    consumed_actor_id: actor,
  }).success, false)
  assert.equal(confirmationRequestSchema.safeParse({
    ...request,
    status: 'consumed',
    consumed_at: request.expires_at,
    consumed_action: 'authorize_verification',
    consumed_actor_id: actor,
  }).success, false)
})

test('history rejects creation, expiry and consumption events at impossible times', async () => {
  for (const mutate of [
    (event) => { event.occurred_at = '2026-08-04T10:00:01.000Z' },
    (event) => { event.event_type = 'expired'; event.request.status = 'expired'; event.request.invalidation_reason = '请求已过有效期' },
  ]) {
    const root = await projectRoot()
    await create(root)
    const history = path.join(root, '.spec-loop', 'connectors', 'feishu', 'confirmations', 'history.jsonl')
    const event = JSON.parse((await readFile(history, 'utf8')).trim())
    mutate(event)
    await writeFile(history, `${JSON.stringify(event)}\n`)
    await assert.rejects(rebuildConfirmationProjection(root), /history integrity|creation time|expired before/i)
  }
})

test('global history time cannot move backwards and invalid events are rejected before persistence', async () => {
  const root = await projectRoot()
  const request = await create(root)
  await assert.rejects(create(root, 'proposal', { now: new Date('2026-08-04T09:59:00.000Z') }), /time may not move backwards/i)
  await assert.rejects(invalidateIfConfirmationFactsChanged(root, request.request_id, {
    revision: 'fedcba0987654321', round: request.round, risk: request.risk, facts: request.facts,
  }, new Date('2026-08-04T09:59:00.000Z')), /time may not move backwards/i)
  const current = (await listConfirmationRequests(root)).find((item) => item.request_id === request.request_id)
  assert.equal(current.status, 'pending')
})
