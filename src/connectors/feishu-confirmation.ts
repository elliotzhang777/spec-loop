import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteMany, sha256 } from '../files.js';
import { feishuConnectorRoot } from './feishu.js';

const requestTypeSchema = z.enum(['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance']);
const requestStatusSchema = z.enum(['pending', 'consumed', 'rejected', 'expired', 'invalidated']);
const actionSchema = z.enum([
  'approve_proposal', 'reject_proposal',
  'choose_option', 'pause_task',
  'approve_visual', 'reject_visual',
  'authorize_verification', 'defer_verification',
  'accept_heavy', 'reject_heavy',
]);

const actionsByType: Record<z.infer<typeof requestTypeSchema>, Array<z.infer<typeof actionSchema>>> = {
  proposal: ['approve_proposal', 'reject_proposal'],
  needs_user: ['choose_option', 'pause_task'],
  visual_review: ['approve_visual', 'reject_visual'],
  verification: ['authorize_verification', 'defer_verification'],
  heavy_acceptance: ['accept_heavy', 'reject_heavy'],
};

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const publicTextSchema = z.string().trim().min(1).max(500).refine(
  (value) => !/(?:authorization|bearer\s+|secret|token|完整日志|source\s*diff|evidence\/|-----BEGIN)/i.test(value),
  'confirmation summary contains forbidden sensitive content',
);

export const confirmationFactsSchema = z.object({
  scope_summary: publicTextSchema,
  evidence_summary: z.array(publicTextSchema.max(180)).max(8),
  invalidation_summary: publicTextSchema.max(240),
  acceptance_hash: digestSchema,
  screenshot_hashes: z.array(digestSchema).max(20),
  gate_plan_hash: digestSchema,
  reference_ids: z.array(z.string().regex(/^[A-Z][A-Z0-9-]{2,127}$/)).min(1).max(20),
  options: z.array(z.object({ id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/), label: publicTextSchema.max(80) }).strict()).max(8).default([]),
}).strict();

export type ConfirmationFacts = z.infer<typeof confirmationFactsSchema>;

export const confirmationRequestSchema = z.object({
  schema_version: z.literal(1),
  request_id: z.string().uuid(),
  type: requestTypeSchema,
  project_id: z.string().regex(/^PROJ-[A-Z0-9][A-Z0-9-]*$/),
  task_id: z.string().regex(/^TASK-[A-Z0-9][A-Z0-9-]*$/),
  round: z.number().int().positive(),
  revision: z.string().regex(/^[a-f0-9]{7,64}$/),
  content_hash: digestSchema,
  risk: z.enum(['light', 'standard', 'heavy']),
  facts: confirmationFactsSchema,
  allowed_actions: z.array(actionSchema).min(2),
  allowed_actor_ids: z.array(z.string().regex(/^ou_[A-Za-z0-9_-]{8,128}$/)).min(1),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  status: requestStatusSchema,
  consumed_at: z.iso.datetime().nullable(),
  consumed_action: actionSchema.nullable(),
  consumed_actor_id: z.string().nullable(),
  invalidation_reason: z.string().max(240).nullable(),
}).strict().superRefine((value, ctx) => {
  const expected = actionsByType[value.type];
  if (value.allowed_actions.length !== expected.length || expected.some((action) => !value.allowed_actions.includes(action))) {
    ctx.addIssue({ code: 'custom', path: ['allowed_actions'], message: 'actions do not match the fixed request-type allowlist' });
  }
  if (value.type === 'needs_user' && value.facts.options.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['facts', 'options'], message: 'needs_user requires predefined options' });
  }
  if (value.type !== 'needs_user' && value.facts.options.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['facts', 'options'], message: 'only needs_user may carry options' });
  }
  if (Date.parse(value.expires_at) <= Date.parse(value.created_at)) {
    ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'confirmation expiry must be after creation' });
  }
  const hasConsumption = value.consumed_at !== null && value.consumed_action !== null && value.consumed_actor_id !== null;
  const hasNoConsumption = value.consumed_at === null && value.consumed_action === null && value.consumed_actor_id === null;
  if ((value.status === 'consumed' || value.status === 'rejected') && !hasConsumption) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'consumed or rejected request requires complete consumption facts' });
  }
  if ((value.status === 'pending' || value.status === 'expired' || value.status === 'invalidated') && !hasNoConsumption) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'unconsumed request may not carry consumption facts' });
  }
  if ((value.status === 'expired' || value.status === 'invalidated') && !value.invalidation_reason) {
    ctx.addIssue({ code: 'custom', path: ['invalidation_reason'], message: 'expired or invalidated request requires a reason' });
  }
  if ((value.status === 'pending' || value.status === 'consumed' || value.status === 'rejected') && value.invalidation_reason !== null) {
    ctx.addIssue({ code: 'custom', path: ['invalidation_reason'], message: 'active or consumed request may not carry an invalidation reason' });
  }
  if (hasConsumption && value.consumed_action && !value.allowed_actions.includes(value.consumed_action)) {
    ctx.addIssue({ code: 'custom', path: ['consumed_action'], message: 'consumed action is outside the request allowlist' });
  }
  if (hasConsumption && value.consumed_actor_id && !value.allowed_actor_ids.includes(value.consumed_actor_id)) {
    ctx.addIssue({ code: 'custom', path: ['consumed_actor_id'], message: 'consumed actor is outside the request allowlist' });
  }
  if (hasConsumption && value.consumed_at && (Date.parse(value.consumed_at) < Date.parse(value.created_at)
    || Date.parse(value.consumed_at) >= Date.parse(value.expires_at))) {
    ctx.addIssue({ code: 'custom', path: ['consumed_at'], message: 'consumption must occur after creation and before expiry' });
  }
  const rejectionAction = value.consumed_action?.startsWith('reject_') || value.consumed_action === 'defer_verification' || value.consumed_action === 'pause_task';
  if (value.status === 'consumed' && rejectionAction) ctx.addIssue({ code: 'custom', path: ['consumed_action'], message: 'rejection action may not produce consumed status' });
  if (value.status === 'rejected' && !rejectionAction) ctx.addIssue({ code: 'custom', path: ['consumed_action'], message: 'approval action may not produce rejected status' });
  const expectedContentHash = confirmationContentHash({
    type: value.type, projectId: value.project_id, taskId: value.task_id, round: value.round,
    revision: value.revision, risk: value.risk, facts: value.facts,
  });
  if (value.content_hash !== expectedContentHash) ctx.addIssue({ code: 'custom', path: ['content_hash'], message: 'content hash does not match authority facts' });
});

export type ConfirmationRequest = z.infer<typeof confirmationRequestSchema>;
export type ConfirmationAction = z.infer<typeof actionSchema>;

const historyEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  event_id: z.string().uuid(),
  event_type: z.enum(['created', 'consumed', 'rejected', 'expired', 'invalidated']),
  request: confirmationRequestSchema,
  occurred_at: z.iso.datetime(),
  previous_hash: digestSchema.nullable(),
  event_hash: digestSchema,
}).strict();
type HistoryEvent = z.infer<typeof historyEventSchema>;

const projectionSchema = z.object({
  schema_version: z.literal(1),
  history_head: digestSchema.nullable(),
  projection_hash: digestSchema,
  requests: z.array(confirmationRequestSchema),
}).strict();

const authorityProjectionSchema = z.object({
  schema_version: z.literal(1),
  projection_hash: digestSchema,
  authorities: z.array(z.object({
    request_id: z.string().uuid(), revision: z.string(), round: z.number().int().positive(),
    risk: z.enum(['light', 'standard', 'heavy']), content_hash: digestSchema, facts: confirmationFactsSchema,
  }).strict()),
}).strict();

function confirmationContentHash(input: {
  type: z.infer<typeof requestTypeSchema>;
  projectId: string;
  taskId: string;
  round: number;
  revision: string;
  risk: 'light' | 'standard' | 'heavy';
  facts: ConfirmationFacts;
}): string {
  return sha256(JSON.stringify({
    type: input.type,
    project_id: input.projectId,
    task_id: input.taskId,
    round: input.round,
    revision: input.revision,
    risk: input.risk,
    facts: confirmationFactsSchema.parse(input.facts),
  }));
}

async function confirmationRoot(projectRoot: string): Promise<string> {
  const connector = await feishuConnectorRoot(projectRoot);
  const root = path.join(connector, 'confirmations');
  const info = await lstat(root).catch(() => null);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('confirmation path is symbolic or not a directory');
  if (!info) await mkdir(root, { mode: 0o700 });
  return root;
}

async function withConfirmationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, 'mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  if (!acquired) throw new Error('confirmation store is busy; explicit recovery is required');
  try { return await action(); } finally { await rmdir(lock); }
}

function eventHash(value: Omit<HistoryEvent, 'event_hash'>): string {
  return sha256(JSON.stringify(value));
}

async function readHistory(root: string): Promise<HistoryEvent[]> {
  const file = path.join(root, 'history.jsonl');
  const info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('confirmation history is symbolic or not a regular file');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  const events: HistoryEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const event = historyEventSchema.parse(JSON.parse(line));
    const { event_hash: storedHash, ...unsigned } = event;
    const previous = events.at(-1)?.event_hash ?? null;
    if (event.sequence !== index + 1 || event.previous_hash !== previous || eventHash(unsigned) !== storedHash) {
      throw new Error(`confirmation history integrity failure at sequence ${index + 1}`);
    }
    const priorEvent = [...events].reverse().find((candidate) => candidate.request.request_id === event.request.request_id);
    const prior = priorEvent?.request;
    const expectedStatus: Record<HistoryEvent['event_type'], ConfirmationRequest['status']> = {
      created: 'pending', consumed: 'consumed', rejected: 'rejected', expired: 'expired', invalidated: 'invalidated',
    };
    if (event.request.status !== expectedStatus[event.event_type]) throw new Error(`confirmation history semantic failure at sequence ${index + 1}`);
    if ((event.event_type === 'consumed' || event.event_type === 'rejected') && event.request.consumed_at !== event.occurred_at) {
      throw new Error(`confirmation history consumption time mismatch at sequence ${index + 1}`);
    }
    if (event.event_type === 'created' && event.occurred_at !== event.request.created_at) {
      throw new Error(`confirmation history creation time mismatch at sequence ${index + 1}`);
    }
    if ((event.event_type === 'consumed' || event.event_type === 'rejected')
      && Date.parse(event.occurred_at) >= Date.parse(event.request.expires_at)) {
      throw new Error(`confirmation history consumed after expiry at sequence ${index + 1}`);
    }
    if (event.event_type === 'expired' && Date.parse(event.occurred_at) < Date.parse(event.request.expires_at)) {
      throw new Error(`confirmation history expired before deadline at sequence ${index + 1}`);
    }
    if (Date.parse(event.occurred_at) < Date.parse(event.request.created_at) || (priorEvent && Date.parse(event.occurred_at) < Date.parse(priorEvent.occurred_at))) {
      throw new Error(`confirmation history time moved backwards at sequence ${index + 1}`);
    }
    if (event.event_type === 'created') {
      if (prior) throw new Error(`confirmation history duplicate creation at sequence ${index + 1}`);
    } else {
      if (!prior || prior.status !== 'pending') throw new Error(`confirmation history illegal transition at sequence ${index + 1}`);
      const immutableBefore = { ...prior, status: undefined, consumed_at: undefined, consumed_action: undefined, consumed_actor_id: undefined, invalidation_reason: undefined };
      const immutableAfter = { ...event.request, status: undefined, consumed_at: undefined, consumed_action: undefined, consumed_actor_id: undefined, invalidation_reason: undefined };
      if (sha256(JSON.stringify(immutableBefore)) !== sha256(JSON.stringify(immutableAfter))) throw new Error(`confirmation history authority changed at sequence ${index + 1}`);
    }
    events.push(event);
  }
  return events;
}

function deriveRequests(events: HistoryEvent[]): ConfirmationRequest[] {
  const current = new Map<string, ConfirmationRequest>();
  for (const event of events) current.set(event.request.request_id, event.request);
  return [...current.values()].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.request_id.localeCompare(right.request_id));
}

function makeProjection(events: HistoryEvent[]): z.infer<typeof projectionSchema> {
  const requests = deriveRequests(events);
  return projectionSchema.parse({
    schema_version: 1,
    history_head: events.at(-1)?.event_hash ?? null,
    projection_hash: sha256(JSON.stringify(requests)),
    requests,
  });
}

function makeAuthorityProjection(events: HistoryEvent[]): z.infer<typeof authorityProjectionSchema> {
  const authorities = deriveRequests(events).filter((request) => request.status === 'pending').map((request) => ({
    request_id: request.request_id, revision: request.revision, round: request.round, risk: request.risk,
    content_hash: request.content_hash, facts: request.facts,
  }));
  return authorityProjectionSchema.parse({ schema_version: 1, projection_hash: sha256(JSON.stringify(authorities)), authorities });
}

async function writeStore(projectRoot: string, root: string, events: HistoryEvent[]): Promise<void> {
  const projection = makeProjection(events);
  const authority = makeAuthorityProjection(events);
  await atomicWriteMany(projectRoot, [
    { file: path.join(root, 'history.jsonl'), content: events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '') },
    { file: path.join(root, 'projection.json'), content: `${JSON.stringify(projection, null, 2)}\n` },
    { file: path.join(root, 'current-authority.json'), content: `${JSON.stringify(authority, null, 2)}\n` },
  ]);
}

async function verifyProjection(root: string, events: HistoryEvent[]): Promise<boolean> {
  const file = path.join(root, 'projection.json');
  const info = await lstat(file).catch(() => null);
  const authorityFile = path.join(root, 'current-authority.json');
  const authorityInfo = await lstat(authorityFile).catch(() => null);
  if (!info || !authorityInfo) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('confirmation projection is symbolic or not a regular file');
  if (!authorityInfo.isFile() || authorityInfo.isSymbolicLink()) throw new Error('confirmation authority projection is symbolic or not a regular file');
  const actual = projectionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  const expected = makeProjection(events);
  if (actual.history_head !== expected.history_head || actual.projection_hash !== expected.projection_hash
    || sha256(JSON.stringify(actual.requests)) !== expected.projection_hash) {
    throw new Error('confirmation projection integrity failure');
  }
  const actualAuthority = authorityProjectionSchema.parse(JSON.parse(await readFile(authorityFile, 'utf8')));
  const expectedAuthority = makeAuthorityProjection(events);
  if (actualAuthority.projection_hash !== expectedAuthority.projection_hash
    || sha256(JSON.stringify(actualAuthority.authorities)) !== expectedAuthority.projection_hash) {
    throw new Error('confirmation current authority projection integrity failure');
  }
  return true;
}

async function readCurrentAuthority(root: string, requestId: string): Promise<z.infer<typeof authorityProjectionSchema>['authorities'][number] | null> {
  const file = path.join(root, 'current-authority.json');
  const info = await lstat(file).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error('confirmation current authority projection is unavailable');
  const projection = authorityProjectionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (projection.projection_hash !== sha256(JSON.stringify(projection.authorities))) throw new Error('confirmation current authority projection integrity failure');
  return projection.authorities.find((item) => item.request_id === requestId) ?? null;
}

async function appendEvent(projectRoot: string, root: string, events: HistoryEvent[], eventType: HistoryEvent['event_type'], request: ConfirmationRequest, now: string): Promise<void> {
  const unsigned: Omit<HistoryEvent, 'event_hash'> = {
    schema_version: 1,
    sequence: events.length + 1,
    event_id: randomUUID(),
    event_type: eventType,
    request: confirmationRequestSchema.parse(request),
    occurred_at: now,
    previous_hash: events.at(-1)?.event_hash ?? null,
  };
  events.push(historyEventSchema.parse({ ...unsigned, event_hash: eventHash(unsigned) }));
  await writeStore(projectRoot, root, events);
}

export async function createConfirmationRequest(projectRoot: string, input: {
  type: z.infer<typeof requestTypeSchema>;
  projectId: string;
  taskId: string;
  round: number;
  revision: string;
  risk: 'light' | 'standard' | 'heavy';
  facts: ConfirmationFacts;
  allowedActorIds: string[];
  ttlSeconds: number;
  now?: Date;
}): Promise<ConfirmationRequest> {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 7 * 24 * 60 * 60) throw new Error('confirmation ttl is outside the allowed range');
  const root = await confirmationRoot(projectRoot);
  return withConfirmationLock(root, async () => {
    const events = await readHistory(root);
    await verifyProjection(root, events).catch((error) => { throw error; });
    const createdAt = input.now ?? new Date();
    const facts = confirmationFactsSchema.parse(input.facts);
    const request = confirmationRequestSchema.parse({
      schema_version: 1,
      request_id: randomUUID(),
      type: input.type,
      project_id: input.projectId,
      task_id: input.taskId,
      round: input.round,
      revision: input.revision,
      content_hash: confirmationContentHash({ ...input, facts }),
      risk: input.risk,
      facts,
      allowed_actions: actionsByType[input.type],
      allowed_actor_ids: [...new Set(input.allowedActorIds)].sort(),
      created_at: createdAt.toISOString(),
      expires_at: new Date(createdAt.getTime() + input.ttlSeconds * 1000).toISOString(),
      status: 'pending',
      consumed_at: null,
      consumed_action: null,
      consumed_actor_id: null,
      invalidation_reason: null,
    });
    await appendEvent(projectRoot, root, events, 'created', request, request.created_at);
    return request;
  });
}

export async function listConfirmationRequests(projectRoot: string): Promise<ConfirmationRequest[]> {
  const root = await confirmationRoot(projectRoot);
  return withConfirmationLock(root, async () => {
    const events = await readHistory(root);
    if (!(await verifyProjection(root, events))) await writeStore(projectRoot, root, events);
    return deriveRequests(events);
  });
}

export async function rebuildConfirmationProjection(projectRoot: string): Promise<number> {
  const root = await confirmationRoot(projectRoot);
  return withConfirmationLock(root, async () => {
    const events = await readHistory(root);
    await writeStore(projectRoot, root, events);
    return deriveRequests(events).length;
  });
}

export async function checkConfirmationProjection(projectRoot: string): Promise<{ valid: true; request_count: number; history_head: string | null }> {
  const root = await confirmationRoot(projectRoot);
  const events = await readHistory(root);
  if (!(await verifyProjection(root, events))) throw new Error('confirmation projection is missing; rebuild is required');
  return { valid: true, request_count: deriveRequests(events).length, history_head: events.at(-1)?.event_hash ?? null };
}

async function mutateRequest(projectRoot: string, requestId: string, mutation: (request: ConfirmationRequest, now: Date, root: string) => { event: HistoryEvent['event_type']; request: ConfirmationRequest } | null | Promise<{ event: HistoryEvent['event_type']; request: ConfirmationRequest } | null>, now = new Date()): Promise<ConfirmationRequest> {
  const root = await confirmationRoot(projectRoot);
  return withConfirmationLock(root, async () => {
    const events = await readHistory(root);
    await verifyProjection(root, events);
    const current = deriveRequests(events).find((request) => request.request_id === requestId);
    if (!current) throw new Error('confirmation request does not exist');
    const result = await mutation(current, now, root);
    if (!result) return current;
    await appendEvent(projectRoot, root, events, result.event, result.request, now.toISOString());
    return result.request;
  });
}

export async function invalidateConfirmationRequest(projectRoot: string, requestId: string, reason: string, now = new Date()): Promise<ConfirmationRequest> {
  return mutateRequest(projectRoot, requestId, (current) => {
    if (current.status !== 'pending') throw new Error(`confirmation request is already ${current.status}`);
    return { event: 'invalidated', request: confirmationRequestSchema.parse({ ...current, status: 'invalidated', invalidation_reason: publicTextSchema.max(240).parse(reason) }) };
  }, now);
}

export async function invalidateIfConfirmationFactsChanged(projectRoot: string, requestId: string, input: {
  revision: string;
  round: number;
  risk: 'light' | 'standard' | 'heavy';
  facts: ConfirmationFacts;
}, now = new Date()): Promise<ConfirmationRequest> {
  return mutateRequest(projectRoot, requestId, (current) => {
    if (current.status !== 'pending') throw new Error(`confirmation request is already ${current.status}`);
    const facts = confirmationFactsSchema.parse(input.facts);
    const hash = confirmationContentHash({ type: current.type, projectId: current.project_id, taskId: current.task_id, ...input, facts });
    if (current.revision === input.revision && current.round === input.round && current.risk === input.risk && current.content_hash === hash) return null;
    return { event: 'invalidated', request: confirmationRequestSchema.parse({ ...current, status: 'invalidated', invalidation_reason: '候选 revision、Acceptance、截图或 Gate Plan 已变化' }) };
  }, now);
}

export async function consumeConfirmationRequest(projectRoot: string, requestId: string, action: ConfirmationAction, actorId: string, now = new Date()): Promise<ConfirmationRequest> {
  return mutateRequest(projectRoot, requestId, async (current, _now, root) => {
    if (current.status !== 'pending') throw new Error(`confirmation request is already ${current.status}`);
    if (Date.parse(current.expires_at) <= now.getTime()) {
      return { event: 'expired', request: confirmationRequestSchema.parse({ ...current, status: 'expired', invalidation_reason: '请求已过有效期' }) };
    }
    if (!current.allowed_actor_ids.includes(actorId)) throw new Error('actor is not allowed for this confirmation request');
    if (!current.allowed_actions.includes(action)) throw new Error('action is not allowed for this confirmation request');
    const authority = await readCurrentAuthority(root, requestId);
    if (!authority) throw new Error('current authority for this confirmation request is unavailable');
    const currentFacts = confirmationFactsSchema.parse(authority.facts);
    const currentHash = confirmationContentHash({
      type: current.type, projectId: current.project_id, taskId: current.task_id,
      revision: authority.revision, round: authority.round, risk: authority.risk, facts: currentFacts,
    });
    if (current.revision !== authority.revision || current.round !== authority.round || current.risk !== authority.risk || current.content_hash !== currentHash) {
      return {
        event: 'invalidated',
        request: confirmationRequestSchema.parse({ ...current, status: 'invalidated', invalidation_reason: '当前权威 revision、Acceptance、截图或 Gate Plan 与请求不一致' }),
      };
    }
    const rejected = action.startsWith('reject_') || action === 'defer_verification' || action === 'pause_task';
    return {
      event: rejected ? 'rejected' : 'consumed',
      request: confirmationRequestSchema.parse({
        ...current,
        status: rejected ? 'rejected' : 'consumed',
        consumed_at: now.toISOString(),
        consumed_action: action,
        consumed_actor_id: actorId,
      }),
    };
  }, now);
}

export async function expireConfirmationRequests(projectRoot: string, now = new Date()): Promise<number> {
  const root = await confirmationRoot(projectRoot);
  return withConfirmationLock(root, async () => {
    const events = await readHistory(root);
    await verifyProjection(root, events);
    const expired = deriveRequests(events).filter((request) => request.status === 'pending' && Date.parse(request.expires_at) <= now.getTime());
    for (const current of expired) {
      const request = confirmationRequestSchema.parse({ ...current, status: 'expired', invalidation_reason: '请求已过有效期' });
      await appendEvent(projectRoot, root, events, 'expired', request, now.toISOString());
    }
    return expired.length;
  });
}

export async function regenerateConfirmationRequest(projectRoot: string, requestId: string, input: {
  revision: string;
  round: number;
  risk: 'light' | 'standard' | 'heavy';
  facts: ConfirmationFacts;
  allowedActorIds?: string[];
  ttlSeconds: number;
  now?: Date;
}): Promise<ConfirmationRequest> {
  const requests = await listConfirmationRequests(projectRoot);
  const current = requests.find((request) => request.request_id === requestId);
  if (!current) throw new Error('confirmation request does not exist');
  if (current.status === 'pending') await invalidateConfirmationRequest(projectRoot, requestId, '已由新候选确认请求替代', input.now ?? new Date());
  return createConfirmationRequest(projectRoot, {
    type: current.type,
    projectId: current.project_id,
    taskId: current.task_id,
    round: input.round,
    revision: input.revision,
    risk: input.risk,
    facts: input.facts,
    allowedActorIds: input.allowedActorIds ?? current.allowed_actor_ids,
    ttlSeconds: input.ttlSeconds,
    now: input.now,
  });
}

const actionLabels: Record<ConfirmationAction, string> = {
  approve_proposal: '批准规格', reject_proposal: '拒绝规格', choose_option: '选择方案', pause_task: '暂停任务',
  approve_visual: '效果通过', reject_visual: '效果不通过', authorize_verification: '授权正式验证', defer_verification: '暂不验证',
  accept_heavy: 'Heavy 验收通过', reject_heavy: 'Heavy 验收不通过',
};

export function renderConfirmationCard(requestInput: ConfirmationRequest): Record<string, unknown> {
  const request = confirmationRequestSchema.parse(requestInput);
  const actionElements: Array<Record<string, unknown>> = request.allowed_actions.filter((action) => action !== 'choose_option').map((action) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: actionLabels[action] },
    type: action.startsWith('approve_') || action === 'authorize_verification' || action === 'accept_heavy' ? 'primary' : 'default',
    value: { request_id: request.request_id, action_id: action },
  }));
  if (request.type === 'needs_user') {
    actionElements.unshift({
      tag: 'select_static',
      text: { tag: 'plain_text', content: '选择预定义方案' },
      type: 'default',
      value: { request_id: request.request_id, action_id: 'choose_option' },
      options: request.facts.options.map((option) => ({ text: { tag: 'plain_text', content: option.label }, value: option.id })),
    });
  }
  const card = {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: `Spec-Loop 确认 · ${request.task_id}` }, template: request.risk === 'heavy' ? 'red' : 'orange' },
    body: { elements: [
      { tag: 'markdown', content: `**范围**  ${request.facts.scope_summary}\n**风险**  ${request.risk}\n**候选**  ${request.revision.slice(0, 12)} · Round ${request.round}` },
      { tag: 'markdown', content: `**Evidence 摘要**\n${request.facts.evidence_summary.map((item) => `- ${item}`).join('\n') || '- 无公开摘要'}` },
      { tag: 'markdown', content: `**失效条件**  ${request.facts.invalidation_summary}\n**有效期至**  ${request.expires_at}` },
      { tag: 'action', actions: actionElements },
    ] },
  };
  const serialized = JSON.stringify(card);
  if (/(?:merge|push|deploy|生产修改|权限扩大|authorization|bearer\s+|secret|token)/i.test(serialized)) throw new Error('confirmation card contains a forbidden action or sensitive field');
  return card;
}
