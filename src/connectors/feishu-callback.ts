import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteMany, sha256 } from '../files.js';
import {
  executeConfirmationRequest,
  listConfirmationRequests,
  type ConfirmationAction,
  type ConfirmationRequest,
} from './feishu-confirmation.js';
import {
  feishuConnectorRoot,
  readFeishuConfig,
  redactFeishuText,
  type FeishuCardAction,
  type FeishuCardActionHandler,
} from './feishu.js';

const actionSchema = z.enum([
  'approve_proposal', 'reject_proposal',
  'choose_option', 'pause_task',
  'approve_visual', 'reject_visual',
  'authorize_verification', 'defer_verification',
  'accept_heavy', 'reject_heavy',
]);
const sourceSchema = z.enum(['feishu', 'local']);
const inboxStatusSchema = z.enum(['pending', 'processing', 'succeeded', 'rejected', 'failed']);
const safeId = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);

const actionEnvelopeSchema = z.object({
  source: sourceSchema,
  event_id: safeId,
  tenant_key: z.string().trim().min(3).max(256).nullable(),
  project_id: z.string().regex(/^PROJ-[A-Z0-9][A-Z0-9-]*$/),
  operator_open_id: z.string().regex(/^ou_[A-Za-z0-9_-]{8,128}$/).nullable(),
  local_actor: z.string().trim().min(3).max(128).nullable(),
  request_id: z.string().uuid(),
  action_id: actionSchema,
  option_id: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/).nullable(),
  message_id: z.string().trim().min(3).max(256).nullable(),
  received_at: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.source === 'feishu' && (!value.tenant_key || !value.operator_open_id || !value.message_id || value.local_actor !== null)) {
    ctx.addIssue({ code: 'custom', message: 'feishu action requires tenant, open_id and message while forbidding caller supplied local actor' });
  }
  if (value.source === 'local' && (value.tenant_key !== null || value.operator_open_id !== null || !value.local_actor || value.message_id !== null)) {
    ctx.addIssue({ code: 'custom', message: 'local action requires local actor and forbids platform identity fields' });
  }
  if (value.action_id === 'choose_option' && !value.option_id) ctx.addIssue({ code: 'custom', path: ['option_id'], message: 'choose_option requires an option id' });
  if (value.action_id !== 'choose_option' && value.option_id !== null) ctx.addIssue({ code: 'custom', path: ['option_id'], message: 'only choose_option may carry an option id' });
});

export type FeishuActionEnvelope = z.infer<typeof actionEnvelopeSchema>;

const controllerResultSchema = z.object({
  status: z.enum(['applied', 'duplicate']),
  audit_id: safeId,
}).strict();

export interface ConfirmationControllerCommand {
  command_id: string;
  idempotency_key: string;
  project_id: string;
  task_id: string;
  request_id: string;
  request_type: ConfirmationRequest['type'];
  round: number;
  revision: string;
  content_hash: string;
  risk: ConfirmationRequest['risk'];
  facts: ConfirmationRequest['facts'];
  action: ConfirmationAction;
  option_id: string | null;
  actor: string;
  source: 'feishu' | 'local';
}

export interface ConfirmationControllerAdapter {
  execute(command: ConfirmationControllerCommand): Promise<{ status: 'applied' | 'duplicate'; audit_id: string }>;
  lookup?(commandId: string): Promise<{ status: 'applied' | 'duplicate'; audit_id: string } | null>;
}

const inboxRecordSchema = z.object({
  schema_version: z.literal(1),
  inbox_id: z.string().uuid(),
  event_ids: z.array(safeId).min(1).max(100),
  envelope: actionEnvelopeSchema,
  request_action_key: z.string().length(64),
  controller_command_id: z.string().uuid(),
  status: inboxStatusSchema,
  attempts: z.number().int().nonnegative(),
  claim_token: z.string().uuid().nullable(),
  claimed_at: z.iso.datetime().nullable(),
  completed_at: z.iso.datetime().nullable(),
  resolved_actor: z.string().min(3).max(128).nullable(),
  confirmation_status: z.enum(['consumed', 'rejected', 'expired', 'invalidated']).nullable(),
  controller_result: controllerResultSchema.nullable(),
  reason: z.string().trim().min(1).max(300).nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'processing' && (!value.claim_token || !value.claimed_at)) ctx.addIssue({ code: 'custom', message: 'processing inbox record requires claim facts' });
  if (value.status !== 'processing' && (value.claim_token !== null || value.claimed_at !== null)) ctx.addIssue({ code: 'custom', message: 'non-processing inbox record may not retain claim facts' });
  if (['succeeded', 'rejected'].includes(value.status) && !value.completed_at) ctx.addIssue({ code: 'custom', message: 'terminal inbox record requires completion time' });
  if (value.status === 'succeeded' && (!value.confirmation_status || !value.controller_result)) ctx.addIssue({ code: 'custom', message: 'successful inbox record requires confirmation and controller results' });
  if (value.status === 'rejected' && !value.reason) ctx.addIssue({ code: 'custom', message: 'rejected inbox record requires a reason' });
});

export type FeishuActionInboxRecord = z.infer<typeof inboxRecordSchema>;

const inboxProjectionSchema = z.object({
  schema_version: z.literal(1),
  projection_hash: z.string().length(64),
  records: z.array(inboxRecordSchema),
}).strict();

function projection(records: FeishuActionInboxRecord[]): z.infer<typeof inboxProjectionSchema> {
  return inboxProjectionSchema.parse({ schema_version: 1, projection_hash: sha256(JSON.stringify(records)), records });
}

async function actionRoot(projectRoot: string): Promise<string> {
  const root = path.join(await feishuConnectorRoot(projectRoot), 'actions');
  const info = await lstat(root).catch(() => null);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('feishu action inbox path is symbolic or not a directory');
  if (!info) await mkdir(root, { mode: 0o700 });
  return root;
}

async function withInboxLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, 'mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('feishu action inbox is busy; explicit recovery is required');
  try { return await action(); } finally { await rmdir(lock); }
}

async function readInbox(root: string): Promise<FeishuActionInboxRecord[]> {
  const file = path.join(root, 'inbox.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('feishu action inbox is symbolic or not a regular file');
  const value = inboxProjectionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (value.projection_hash !== sha256(JSON.stringify(value.records))) throw new Error('feishu action inbox projection integrity failure');
  return value.records;
}

async function writeInbox(projectRoot: string, root: string, records: FeishuActionInboxRecord[]): Promise<void> {
  await atomicWriteMany(projectRoot, [{ file: path.join(root, 'inbox.json'), content: `${JSON.stringify(projection(records), null, 2)}\n` }]);
}

function actionKey(envelope: Pick<FeishuActionEnvelope, 'source' | 'request_id' | 'action_id' | 'option_id' | 'tenant_key' | 'operator_open_id' | 'local_actor'>): string {
  return sha256(JSON.stringify({
    source: envelope.source, request_id: envelope.request_id, action_id: envelope.action_id, option_id: envelope.option_id,
    tenant_key: envelope.tenant_key, operator_open_id: envelope.operator_open_id, local_actor: envelope.local_actor,
  }));
}

export async function acceptFeishuAction(projectRoot: string, input: Omit<FeishuActionEnvelope, 'source' | 'local_actor' | 'received_at'> & { receivedAt?: Date }): Promise<{ record: FeishuActionInboxRecord; duplicate: boolean }> {
  const { receivedAt, ...envelope } = input;
  const parsed = actionEnvelopeSchema.parse({ ...envelope, source: 'feishu', local_actor: null, received_at: (receivedAt ?? new Date()).toISOString() });
  return acceptAction(projectRoot, parsed, await preauthorizeAction(projectRoot, parsed));
}

export async function acceptLocalConfirmationAction(projectRoot: string, input: {
  eventId?: string;
  projectId: string;
  actor: string;
  requestId: string;
  action: ConfirmationAction;
  optionId?: string;
  receivedAt?: Date;
}): Promise<{ record: FeishuActionInboxRecord; duplicate: boolean }> {
  const envelope = actionEnvelopeSchema.parse({
    source: 'local', event_id: input.eventId ?? `local_${randomUUID().replaceAll('-', '')}`,
    tenant_key: null, project_id: input.projectId, operator_open_id: null, local_actor: input.actor,
    request_id: input.requestId, action_id: input.action, option_id: input.optionId ?? null,
    message_id: null, received_at: (input.receivedAt ?? new Date()).toISOString(),
  });
  return acceptAction(projectRoot, envelope, await preauthorizeAction(projectRoot, envelope));
}

async function preauthorizeAction(projectRoot: string, envelope: FeishuActionEnvelope): Promise<string | null> {
  try {
    const request = (await listConfirmationRequests(projectRoot)).find((item) => item.request_id === envelope.request_id);
    if (!request) throw permanent('confirmation request does not exist');
    await resolveActor(projectRoot, envelope, request);
    if (!request.allowed_actions.includes(envelope.action_id)) throw permanent('action is not allowed for this confirmation request');
    assertOption(request, envelope);
    return null;
  } catch (error) {
    const value = error as Error & { permanent?: boolean };
    if (value.permanent !== true) throw error;
    return redactFeishuText(value.message).slice(0, 300) || 'action identity preauthorization failed';
  }
}

async function acceptAction(projectRoot: string, envelope: FeishuActionEnvelope, preRejection: string | null): Promise<{ record: FeishuActionInboxRecord; duplicate: boolean }> {
  const root = await actionRoot(projectRoot);
  return withInboxLock(root, async () => {
    const records = await readInbox(root);
    const byEvent = records.find((item) => item.event_ids.includes(envelope.event_id));
    if (byEvent) return { record: byEvent, duplicate: true };
    const key = actionKey(envelope);
    const byAction = records.find((item) => item.request_action_key === key);
    if (byAction) {
      byAction.event_ids = [...byAction.event_ids, envelope.event_id].slice(-100);
      byAction.updated_at = envelope.received_at;
      await writeInbox(projectRoot, root, records);
      return { record: inboxRecordSchema.parse(byAction), duplicate: true };
    }
    const requestClaim = records.find((item) => item.envelope.request_id === envelope.request_id && item.status !== 'rejected');
    const rejection = preRejection ?? (requestClaim ? 'confirmation request is already claimed by another action' : null);
    const rejected = rejection !== null;
    const record = inboxRecordSchema.parse({
      schema_version: 1, inbox_id: randomUUID(), event_ids: [envelope.event_id], envelope,
      request_action_key: key, controller_command_id: randomUUID(), status: rejected ? 'rejected' : 'pending', attempts: 0,
      claim_token: null, claimed_at: null, completed_at: rejected ? envelope.received_at : null,
      resolved_actor: null, confirmation_status: null, controller_result: null,
      reason: rejection,
      created_at: envelope.received_at, updated_at: envelope.received_at,
    });
    records.push(record);
    await writeInbox(projectRoot, root, records);
    return { record, duplicate: false };
  });
}

function permanent(message: string): Error {
  return Object.assign(new Error(message), { permanent: true });
}

async function resolveActor(projectRoot: string, envelope: FeishuActionEnvelope, request: ConfirmationRequest): Promise<string> {
  if (envelope.project_id !== request.project_id) throw permanent('action project does not match confirmation request');
  if (envelope.source === 'local') {
    if (!envelope.local_actor || !request.allowed_actor_ids.includes(envelope.local_actor)) throw permanent('local actor is not allowed for this confirmation request');
    return envelope.local_actor;
  }
  const config = await readFeishuConfig(projectRoot);
  if (!config.enabled) throw permanent('feishu connector is disabled; use the local confirmation entry');
  if (envelope.tenant_key !== config.tenant_key) throw permanent('feishu tenant is not allowed');
  const approver = config.approvers.find((item) => item.project_id === request.project_id && item.open_id === envelope.operator_open_id);
  if (!approver || !approver.request_types.includes(request.type)) throw permanent('feishu operator is not allowed for this project and request type');
  if (!request.allowed_actor_ids.includes(approver.local_actor)) throw permanent('mapped local actor is not allowed for this confirmation request');
  return approver.local_actor;
}

function assertOption(request: ConfirmationRequest, envelope: FeishuActionEnvelope): void {
  if (envelope.action_id !== 'choose_option') return;
  if (!request.facts.options.some((item) => item.id === envelope.option_id)) throw permanent('selected option is not allowed for this confirmation request');
}

export async function processFeishuAction(projectRoot: string, inboxId: string, controller: ConfirmationControllerAdapter, now = new Date()): Promise<FeishuActionInboxRecord> {
  const root = await actionRoot(projectRoot);
  const claimed = await withInboxLock(root, async () => {
    const records = await readInbox(root);
    const record = records.find((item) => item.inbox_id === inboxId);
    if (!record) throw new Error('feishu action inbox record does not exist');
    if (record.status !== 'pending') return { record, claimed: false };
    record.status = 'processing'; record.attempts += 1; record.claim_token = randomUUID();
    record.claimed_at = now.toISOString(); record.updated_at = now.toISOString();
    await writeInbox(projectRoot, root, records);
    return { record: inboxRecordSchema.parse(record), claimed: true };
  });
  if (!claimed.claimed) {
    if (claimed.record.status !== 'processing') return claimed.record;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await withInboxLock(root, async () => (await readInbox(root)).find((item) => item.inbox_id === inboxId));
      if (!current) throw new Error('feishu action inbox record disappeared');
      if (current.status !== 'processing') return current;
    }
    throw new Error('feishu action is still processing; reconcile is required');
  }

  let finalStatus: FeishuActionInboxRecord['status'] = 'failed';
  let confirmationStatus: FeishuActionInboxRecord['confirmation_status'] = null;
  let controllerResult: FeishuActionInboxRecord['controller_result'] = null;
  let resolvedActor: string | null = null;
  let reason: string | null = null;
  try {
    const request = (await listConfirmationRequests(projectRoot)).find((item) => item.request_id === claimed.record.envelope.request_id);
    if (!request) throw permanent('confirmation request does not exist');
    resolvedActor = await resolveActor(projectRoot, claimed.record.envelope, request);
    assertOption(request, claimed.record.envelope);
    let executedResult: z.infer<typeof controllerResultSchema> | null = null;
    const confirmation = await executeConfirmationRequest(
      projectRoot, request.request_id, claimed.record.envelope.action_id, resolvedActor,
      async (current) => {
        const result = await controller.execute({
          command_id: claimed.record.controller_command_id,
          idempotency_key: claimed.record.controller_command_id,
          project_id: current.project_id, task_id: current.task_id, request_id: current.request_id,
          request_type: current.type, round: current.round, revision: current.revision,
          content_hash: current.content_hash, risk: current.risk, facts: current.facts,
          action: claimed.record.envelope.action_id, option_id: claimed.record.envelope.option_id,
          actor: resolvedActor as string, source: claimed.record.envelope.source,
        });
        executedResult = controllerResultSchema.parse(result);
      },
      now,
    );
    confirmationStatus = confirmation.status as FeishuActionInboxRecord['confirmation_status'];
    if (!executedResult) {
      finalStatus = 'rejected';
      reason = confirmation.invalidation_reason ?? `confirmation request is ${confirmation.status}`;
    } else {
      finalStatus = 'succeeded';
      controllerResult = executedResult;
    }
  } catch (error) {
    const value = error as Error & { permanent?: boolean };
    finalStatus = value.permanent === true || /already (?:consumed|rejected|expired|invalidated)|not allowed|does not exist|disabled/i.test(value.message) ? 'rejected' : 'failed';
    reason = redactFeishuText(value.message).slice(0, 300) || 'action processing failed';
  }

  return withInboxLock(root, async () => {
    const records = await readInbox(root);
    const record = records.find((item) => item.inbox_id === inboxId);
    if (!record) throw new Error('feishu action inbox record disappeared');
    if (record.status !== 'processing' || record.claim_token !== claimed.record.claim_token) throw new Error('feishu action inbox claim was lost; reconcile is required');
    record.status = finalStatus; record.claim_token = null; record.claimed_at = null;
    record.completed_at = finalStatus === 'failed' ? null : now.toISOString(); record.updated_at = now.toISOString();
    record.resolved_actor = resolvedActor; record.confirmation_status = confirmationStatus;
    record.controller_result = controllerResult; record.reason = reason;
    await writeInbox(projectRoot, root, records);
    return inboxRecordSchema.parse(record);
  });
}

export async function reconcileFeishuActions(
  projectRoot: string,
  controller: ConfirmationControllerAdapter,
  now = new Date(),
  staleProcessingMs = 30_000,
): Promise<FeishuActionInboxRecord[]> {
  if (!Number.isInteger(staleProcessingMs) || staleProcessingMs < 0) throw new Error('invalid Feishu action reconcile threshold');
  const root = await actionRoot(projectRoot);
  const pendingIds = await withInboxLock(root, async () => {
    const records = await readInbox(root);
    let changed = false;
    for (const record of records) {
      if (record.status !== 'processing') continue;
      const known = await controller.lookup?.(record.controller_command_id) ?? null;
      const stale = record.claimed_at !== null && now.getTime() - Date.parse(record.claimed_at) >= staleProcessingMs;
      if (!known && !stale) continue;
      record.status = 'pending'; record.claim_token = null; record.claimed_at = null;
      record.updated_at = now.toISOString(); record.reason = null; changed = true;
    }
    if (changed) await writeInbox(projectRoot, root, records);
    return records.filter((item) => item.status === 'pending').map((item) => item.inbox_id);
  });
  const results: FeishuActionInboxRecord[] = [];
  for (const inboxId of pendingIds) results.push(await processFeishuAction(projectRoot, inboxId, controller, now));
  return results;
}

export async function listFeishuActionInbox(projectRoot: string): Promise<FeishuActionInboxRecord[]> {
  const root = await actionRoot(projectRoot);
  return withInboxLock(root, () => readInbox(root));
}

export function createFeishuCardActionHandler(projectRoot: string, input: {
  projectId: string;
  controller: ConfirmationControllerAdapter;
  onResult?: (record: FeishuActionInboxRecord) => Promise<void> | void;
  now?: () => Date;
}): FeishuCardActionHandler {
  return async (action) => {
    const value = z.object({ request_id: z.string().uuid(), action_id: actionSchema, option_id: z.string().optional() }).passthrough().parse(action.action.value);
    const accepted = await acceptFeishuAction(projectRoot, {
      event_id: action.eventId, tenant_key: action.tenantKey, project_id: input.projectId,
      operator_open_id: action.operatorOpenId, request_id: value.request_id, action_id: value.action_id,
      option_id: action.action.option ?? value.option_id ?? null, message_id: action.messageId,
      receivedAt: input.now?.() ?? new Date(),
    });
    queueMicrotask(() => {
      void processFeishuAction(projectRoot, accepted.record.inbox_id, input.controller, input.now?.() ?? new Date())
        .then((record) => input.onResult?.(record))
        .catch(() => undefined);
    });
  };
}
