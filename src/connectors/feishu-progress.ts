import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicWriteMany, readMarkdown, sha256 } from '../files.js';
import { feishuConnectorRoot, readFeishuConfig, type FeishuTarget, type FeishuTransport } from './feishu.js';
import { readProject, scanTasks } from '../project.js';
import { readState } from '../task.js';
import { verifySchema } from '../schemas.js';

const taskStatusSchema = z.enum(['draft', 'planned', 'working', 'verifying', 'iterating', 'delivered']);
const interventionSchema = z.enum(['none', 'approve_proposal', 'provide_input', 'review_visual', 'authorize_verification', 'accept_delivery']);
const resultSchema = z.enum(['none', 'pass', 'reject', 'failed']);
const nextActionSchema = z.enum(['continue_execution', 'fix_rejection', 'wait_for_verification_authorization', 'wait_for_heavy_acceptance', 'task_delivered', 'no_active_task']);

export const progressSnapshotSchema = z.object({
  schema_version: z.literal(1),
  project_id: z.string().regex(/^PROJ-[A-Z0-9-]+$/),
  wave_id: z.string().regex(/^[A-Z][A-Z0-9-]{1,63}$/),
  task_total: z.number().int().nonnegative(),
  task_counts: z.object({ draft: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), running: z.number().int().nonnegative(), verifying: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), completed: z.number().int().nonnegative() }).strict(),
  current: z.object({ task_id: z.string().regex(/^(?:WEB-)?TASK-[A-Z0-9-]+$/).nullable(), round: z.number().int().nonnegative(), harness_step: z.enum(['none', 'prepared', 'executed', 'collected', 'verified', 'reported']) }).strict(),
  recent: z.object({ gate: resultSchema, verifier: resultSchema }).strict(),
  next_user_intervention: interventionSchema,
  next_action: nextActionSchema,
  updated_at: z.iso.datetime(),
}).strict();

export type ProgressSnapshot = z.infer<typeof progressSnapshotSchema>;

export function buildProgressSnapshot(input: {
  projectId: string; waveId: string; tasks: Array<{ task_id: string; status: z.infer<typeof taskStatusSchema>; round: number }>;
  currentTaskId?: string | null; harnessStep?: ProgressSnapshot['current']['harness_step']; gate?: z.infer<typeof resultSchema>;
  verifier?: z.infer<typeof resultSchema>; nextUserIntervention?: z.infer<typeof interventionSchema>; nextAction: z.infer<typeof nextActionSchema>; updatedAt?: string;
}): ProgressSnapshot {
  const tasks = input.tasks.map((task) => ({ ...task, status: taskStatusSchema.parse(task.status) }));
  const current = tasks.find((task) => task.task_id === input.currentTaskId) ?? tasks.find((task) => ['working', 'verifying', 'iterating'].includes(task.status)) ?? null;
  const count = (status: z.infer<typeof taskStatusSchema>): number => tasks.filter((task) => task.status === status).length;
  return progressSnapshotSchema.parse({
    schema_version: 1, project_id: input.projectId, wave_id: input.waveId, task_total: tasks.length,
    task_counts: { draft: count('draft'), pending: count('planned'), running: count('working'), verifying: count('verifying'), blocked: count('iterating'), completed: count('delivered') },
    current: { task_id: current?.task_id ?? null, round: current?.round ?? 0, harness_step: input.harnessStep ?? 'none' },
    recent: { gate: input.gate ?? 'none', verifier: input.verifier ?? 'none' },
    next_user_intervention: input.nextUserIntervention ?? 'none', next_action: input.nextAction, updated_at: input.updatedAt ?? new Date().toISOString(),
  });
}

const interventionLabels: Record<z.infer<typeof interventionSchema>, string> = {
  none: '无需人工介入', approve_proposal: '批准规格/任务', provide_input: '补充结构化输入', review_visual: '确认页面效果',
  authorize_verification: '授权正式验证', accept_delivery: '执行最终 Heavy 验收',
};
const nextActionLabels: Record<z.infer<typeof nextActionSchema>, string> = {
  continue_execution: '继续按依赖执行当前任务',
  fix_rejection: '修复最近一次 Gate 或 Verifier 拒绝项',
  wait_for_verification_authorization: '等待当前候选的正式验证授权',
  wait_for_heavy_acceptance: '等待最终 Heavy 人工验收',
  task_delivered: '当前任务已交付，继续下一项',
  no_active_task: '当前没有活动任务',
};
const generatedSafeCards = new WeakSet<object>();

export function renderProgressCard(snapshotInput: ProgressSnapshot): Record<string, unknown> {
  const snapshot = progressSnapshotSchema.parse(snapshotInput);
  const counts = snapshot.task_counts;
  const card = {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `Spec-Loop · ${snapshot.wave_id}` }, template: snapshot.next_user_intervention === 'none' ? 'blue' : 'orange' },
    body: { elements: [
      { tag: 'markdown', content: `**总体进度**  ${counts.completed}/${snapshot.task_total}\n草稿 ${counts.draft} · 待执行 ${counts.pending} · 执行中 ${counts.running} · 待验证 ${counts.verifying} · 阻塞 ${counts.blocked}` },
      { tag: 'markdown', content: `**当前**  ${snapshot.current.task_id ?? '无'} · Round ${snapshot.current.round} · ${snapshot.current.harness_step}` },
      { tag: 'markdown', content: `**最近结论**  Gate ${snapshot.recent.gate} · Verifier ${snapshot.recent.verifier}` },
      { tag: 'markdown', content: `**下一步**  ${nextActionLabels[snapshot.next_action]}\n**人工介入**  ${interventionLabels[snapshot.next_user_intervention]}` },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `更新于 ${snapshot.updated_at}` }] },
    ] },
  };
  generatedSafeCards.add(card);
  return card;
}

const forbiddenPayload = /(?:authorization|bearer\s+|app[_-]?secret|(?:access|refresh)?[_-]?token|source\s*diff|完整日志|evidence\/|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/i;

export function assertSafeFeishuCard(card: object): void {
  if (!generatedSafeCards.has(card)) throw new Error('feishu card was not produced by an allowlisted summary renderer');
  const serialized = JSON.stringify(card);
  if (serialized.length > 48_000) throw new Error('feishu card exceeds safe summary size');
  if (forbiddenPayload.test(serialized)) throw new Error('feishu card contains forbidden sensitive content');
}

const outboxStatusSchema = z.enum(['pending', 'sending', 'sent', 'retry_wait', 'dead_letter']);
const outboxRecordSchema = z.object({
  id: z.string().uuid(), project_id: z.string(), wave_id: z.string(), kind: z.enum(['progress', 'critical']), target: z.object({ project_id: z.string(), receive_id_type: z.enum(['chat_id', 'open_id', 'user_id', 'union_id', 'email']), receive_id: z.string() }).strict(),
  idempotency_key: z.string().min(3).max(256), payload_hash: z.string().length(64), payload: z.record(z.string(), z.unknown()), priority: z.number().int().min(0).max(100),
  status: outboxStatusSchema, attempts: z.number().int().nonnegative(), next_attempt_at: z.iso.datetime().nullable(), message_id: z.string().nullable(), platform_request_id: z.string().nullable(),
  delivery_token: z.string().uuid().nullable(),
  last_error: z.enum(['rate_limited', 'server', 'network', 'permission', 'target', 'invalid_payload']).nullable(), created_at: z.iso.datetime(), updated_at: z.iso.datetime(),
}).strict();
const outboxSchema = z.object({ schema_version: z.literal(1), records: z.array(outboxRecordSchema) }).strict();
export type FeishuOutboxRecord = z.infer<typeof outboxRecordSchema>;

async function outboxRoot(projectRoot: string): Promise<string> {
  return feishuConnectorRoot(projectRoot);
}

async function withOutboxLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(root, 'outbox-mutation.lock'), token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ schema_version: 1, token, pid: process.pid, created_at: new Date().toISOString() })}\n`);
      await handle.close();
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readFile(lock, 'utf8').then((value) => JSON.parse(value) as { pid?: number; created_at?: string }).catch(() => null);
      const stale = !owner || typeof owner.pid !== 'number' || typeof owner.created_at !== 'string' || Date.now() - Date.parse(owner.created_at) > 30_000;
      let alive = false;
      if (owner?.pid && stale) {
        try { process.kill(owner.pid, 0); alive = true; } catch { alive = false; }
      }
      if (stale && !alive) {
        const quarantine = `${lock}.stale-${randomUUID()}`;
        try { await rename(lock, quarantine); await rm(quarantine, { force: true, recursive: true }); continue; } catch { /* another process won recovery */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('feishu outbox mutation is busy; explicit recovery is required');
  try { return await action(); } finally {
    const owner = await readFile(lock, 'utf8').then((value) => JSON.parse(value) as { token?: string }).catch(() => null);
    if (owner?.token === token) await rm(lock, { force: true });
  }
}

async function readOutboxAt(root: string): Promise<z.infer<typeof outboxSchema>> {
  const file = path.join(root, 'outbox.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return { schema_version: 1, records: [] };
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('feishu outbox is symbolic or not a regular file');
  const outbox = outboxSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  for (const record of outbox.records) if (sha256(JSON.stringify(record.payload)) !== record.payload_hash) throw new Error('feishu outbox payload hash mismatch');
  return outbox;
}

async function writeOutbox(projectRoot: string, root: string, value: z.infer<typeof outboxSchema>): Promise<void> {
  await atomicWriteMany(projectRoot, [{ file: path.join(root, 'outbox.json'), content: `${JSON.stringify(outboxSchema.parse(value), null, 2)}\n` }]);
}

function targetKey(target: FeishuTarget): string {
  return sha256(`${target.receive_id_type}\0${target.receive_id}`).slice(0, 20);
}

export async function enqueueProgressCard(projectRoot: string, snapshot: ProgressSnapshot, target: FeishuTarget, aggregateWindowMs = 5_000): Promise<FeishuOutboxRecord> {
  if (aggregateWindowMs < 0 || aggregateWindowMs > 10 * 60_000) throw new Error('invalid progress aggregation window');
  const card = renderProgressCard(snapshot); assertSafeFeishuCard(card);
  const root = await outboxRoot(projectRoot);
  return withOutboxLock(root, async () => {
    const outbox = await readOutboxAt(root), now = new Date(), key = `progress:${snapshot.project_id}:${snapshot.wave_id}:${targetKey(target)}`, hash = sha256(JSON.stringify(card));
    const existing = outbox.records.find((record) => record.idempotency_key === key && record.status !== 'dead_letter');
    if (existing) {
      if (existing.payload_hash === hash) return outboxRecordSchema.parse(existing);
      existing.payload = card;
      existing.payload_hash = hash;
      if (existing.status !== 'sending') existing.status = 'pending';
      existing.updated_at = now.toISOString();
      existing.next_attempt_at = new Date(now.getTime() + aggregateWindowMs).toISOString();
      await writeOutbox(projectRoot, root, outbox); return outboxRecordSchema.parse(existing);
    }
    const record = outboxRecordSchema.parse({ id: randomUUID(), project_id: snapshot.project_id, wave_id: snapshot.wave_id, kind: 'progress', target, idempotency_key: key, payload_hash: hash, payload: card, priority: 20, status: 'pending', attempts: 0, next_attempt_at: new Date(now.getTime() + aggregateWindowMs).toISOString(), message_id: null, platform_request_id: null, delivery_token: null, last_error: null, created_at: now.toISOString(), updated_at: now.toISOString() });
    outbox.records.push(record); await writeOutbox(projectRoot, root, outbox); return record;
  });
}

const criticalEventSchema = z.enum(['gate_failed', 'verifier_rejected', 'delivery_failed', 'connector_error']);
const criticalLabels: Record<z.infer<typeof criticalEventSchema>, { title: string; summary: string }> = {
  gate_failed: { title: 'Gate 未通过', summary: '定向 Gate 未通过，请在本地查看受控 Evidence 摘要。' },
  verifier_rejected: { title: 'Verifier 拒绝候选', summary: '独立 Verifier 拒绝当前候选，请回到本地修复。' },
  delivery_failed: { title: 'Delivery 未完成', summary: '交付闭环未完成，请在本地查看失败原因。' },
  connector_error: { title: '飞书连接器异常', summary: '连接器出现异常，本地 Task 状态未受影响。' },
};

export async function enqueueCriticalCard(projectRoot: string, input: { projectId: string; waveId: string; eventId: string; eventType: z.infer<typeof criticalEventSchema>; taskId?: string; target: FeishuTarget }): Promise<FeishuOutboxRecord> {
  const eventType = criticalEventSchema.parse(input.eventType), eventId = z.string().regex(/^[A-Za-z0-9:_-]{3,128}$/).parse(input.eventId), label = criticalLabels[eventType];
  const task = input.taskId ? z.string().regex(/^TASK-[A-Z0-9-]+$/).parse(input.taskId) : null;
  const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: label.title }, template: 'red' }, body: { elements: [{ tag: 'markdown', content: `${task ? `**${task}**  ` : ''}${label.summary}` }] } };
  generatedSafeCards.add(card);
  assertSafeFeishuCard(card); const root = await outboxRoot(projectRoot);
  return withOutboxLock(root, async () => {
    const outbox = await readOutboxAt(root), key = `critical:${input.projectId}:${eventId}:${targetKey(input.target)}`, existing = outbox.records.find((record) => record.idempotency_key === key);
    if (existing) return existing;
    const now = new Date().toISOString(), record = outboxRecordSchema.parse({ id: randomUUID(), project_id: input.projectId, wave_id: input.waveId, kind: 'critical', target: input.target, idempotency_key: key, payload_hash: sha256(JSON.stringify(card)), payload: card, priority: 100, status: 'pending', attempts: 0, next_attempt_at: now, message_id: null, platform_request_id: null, delivery_token: null, last_error: null, created_at: now, updated_at: now });
    outbox.records.push(record); await writeOutbox(projectRoot, root, outbox); return record;
  });
}

function classifyDeliveryError(error: unknown): { category: FeishuOutboxRecord['last_error']; retry: boolean; retryAfterMs: number } {
  const value = error as { status?: number; code?: string; retryAfterMs?: number; message?: string };
  if (value.status === 429) return { category: 'rate_limited', retry: true, retryAfterMs: Math.max(1_000, value.retryAfterMs ?? 5_000) };
  if (value.status && value.status >= 500) return { category: 'server', retry: true, retryAfterMs: 2_000 };
  if (value.status === 401 || value.status === 403) return { category: 'permission', retry: false, retryAfterMs: 0 };
  if (value.status === 404 || value.code === 'TARGET_UNAVAILABLE') return { category: 'target', retry: false, retryAfterMs: 0 };
  if (value.code === 'INVALID_PAYLOAD') return { category: 'invalid_payload', retry: false, retryAfterMs: 0 };
  return { category: 'network', retry: true, retryAfterMs: 1_000 };
}

export async function dispatchFeishuOutboxOnce(projectRoot: string, transport: FeishuTransport, now = new Date()): Promise<FeishuOutboxRecord | null> {
  const root = await outboxRoot(projectRoot);
  const retry = (await readFeishuConfig(projectRoot)).retry;
  const claimed = await withOutboxLock(root, async () => {
    const outbox = await readOutboxAt(root);
    const eligible = outbox.records.filter((record) => ['pending', 'retry_wait'].includes(record.status) && (!record.next_attempt_at || Date.parse(record.next_attempt_at) <= now.getTime())).sort((left, right) => right.priority - left.priority || left.created_at.localeCompare(right.created_at));
    const record = eligible[0]; if (!record) return null;
    record.status = 'sending'; record.attempts += 1; record.delivery_token = randomUUID(); record.platform_request_id ??= sha256(record.idempotency_key).slice(0, 32); record.updated_at = now.toISOString();
    await writeOutbox(projectRoot, root, outbox);
    return outboxRecordSchema.parse(record);
  });
  if (!claimed) return null;

  let sentMessageId: string | null = claimed.message_id;
  let failure: ReturnType<typeof classifyDeliveryError> | null = null;
  try {
    if (claimed.message_id) await transport.updateCard(claimed.message_id, claimed.payload);
    else sentMessageId = (await transport.sendCard(claimed.target, claimed.payload, claimed.platform_request_id ?? undefined)).messageId;
  } catch (error) {
    const value = error as { code?: string };
    failure = value.code === 'MESSAGE_NOT_FOUND'
      ? { category: 'target', retry: true, retryAfterMs: 1_000 }
      : classifyDeliveryError(error);
    if (value.code === 'MESSAGE_NOT_FOUND') sentMessageId = null;
  }

  return withOutboxLock(root, async () => {
    const outbox = await readOutboxAt(root);
    const record = outbox.records.find((candidate) => candidate.id === claimed.id);
    if (!record || record.status !== 'sending' || record.delivery_token !== claimed.delivery_token) {
      throw new Error('feishu outbox delivery lost its fencing token; reconcile before retrying');
    }
    const completedAt = new Date().toISOString();
    record.delivery_token = null;
    record.message_id = sentMessageId;
    if (failure?.category === 'target' && failure.retry && sentMessageId === null) {
      record.platform_request_id = sha256(`${record.idempotency_key}:${record.attempts}`).slice(0, 32);
    }
    if (!failure && record.payload_hash !== claimed.payload_hash) {
      record.status = 'pending'; record.next_attempt_at = completedAt; record.last_error = null;
    } else if (!failure) {
      record.status = 'sent'; record.next_attempt_at = null; record.last_error = null;
    } else {
      record.last_error = failure.category;
      const canRetry = failure.retry && record.attempts < retry.max_attempts;
      record.status = canRetry ? 'retry_wait' : 'dead_letter';
      const baseDelay = Math.max(retry.base_delay_ms, failure.retryAfterMs);
      const exponential = Math.min(retry.max_delay_ms, baseDelay * 2 ** Math.min(8, record.attempts - 1));
      record.next_attempt_at = canRetry ? new Date(Date.now() + exponential).toISOString() : null;
    }
    record.updated_at = completedAt;
    await writeOutbox(projectRoot, root, outbox);
    return outboxRecordSchema.parse(record);
  });
}

export async function reconcileFeishuOutbox(projectRoot: string): Promise<number> {
  const root = await outboxRoot(projectRoot);
  return withOutboxLock(root, async () => {
    const outbox = await readOutboxAt(root); let recovered = 0;
    for (const record of outbox.records) if (record.status === 'sending') {
      record.status = 'retry_wait';
      record.last_error = 'network';
      record.delivery_token = null;
      record.next_attempt_at = new Date().toISOString();
      record.updated_at = new Date().toISOString();
      recovered += 1;
    }
    if (recovered) await writeOutbox(projectRoot, root, outbox); return recovered;
  });
}

export async function readFeishuOutboxSummary(projectRoot: string): Promise<{ pending: number; retry_wait: number; dead_letter: number; last_sent_at: string | null }> {
  const root = await outboxRoot(projectRoot), outbox = await readOutboxAt(root);
  const sent = outbox.records.filter((record) => record.status === 'sent').sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { pending: outbox.records.filter((record) => record.status === 'pending' || record.status === 'sending').length, retry_wait: outbox.records.filter((record) => record.status === 'retry_wait').length, dead_letter: outbox.records.filter((record) => record.status === 'dead_letter').length, last_sent_at: sent[0]?.updated_at ?? null };
}

export async function readFeishuOutboxRecords(projectRoot: string): Promise<FeishuOutboxRecord[]> {
  const root = await outboxRoot(projectRoot);
  const outbox = await readOutboxAt(root);
  return outbox.records.map((record) => outboxRecordSchema.parse(record));
}

const harnessFactSchema = z.object({
  task_id: z.string(), stage: z.enum(['prepared', 'executed', 'collected', 'verified', 'reported']), updated_at: z.iso.datetime(),
}).passthrough();
const gateFactSchema = z.array(z.object({ exit_code: z.number().int(), timed_out: z.boolean(), created_at: z.iso.datetime() }).passthrough());

async function optionalJson(file: string): Promise<unknown | null> {
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`progress fact is symbolic or not a regular file: ${file}`);
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function projectProgressSnapshot(projectRoot: string): Promise<ProgressSnapshot> {
  const project = await readProject(projectRoot), indexed = await scanTasks(projectRoot);
  const states = await Promise.all(indexed.map(async (task) => ({ task, state: await readState(task.path) })));
  const active = states.filter(({ state }) => ['working', 'verifying', 'iterating'].includes(state.status))
    .sort((left, right) => right.state.updated_at.localeCompare(left.state.updated_at))[0]
    ?? states.filter(({ state }) => state.status === 'planned').sort((left, right) => right.state.updated_at.localeCompare(left.state.updated_at))[0]
    ?? states.sort((left, right) => right.state.updated_at.localeCompare(left.state.updated_at))[0]
    ?? null;
  const output = path.join(projectRoot, project.output_root);
  const taskId = active?.state.task_id ?? null;
  const harnessRaw = taskId ? await optionalJson(path.join(output, `${taskId}-harness-state.json`)) : null;
  const harness = harnessRaw ? harnessFactSchema.parse(harnessRaw) : null;
  const gatesRaw = taskId ? await optionalJson(path.join(output, `${taskId}-gates.json`)) : null;
  const gates = gatesRaw ? gateFactSchema.parse(gatesRaw) : [];
  let verifier: z.infer<typeof resultSchema> = 'none';
  if (active) {
    const verifyFile = path.join(active.task.path, 'VERIFY.md');
    const info = await lstat(verifyFile).catch(() => null);
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('task verifier projection is symbolic or not a regular file');
      const verify = verifySchema.parse((await readMarkdown(verifyFile)).data);
      verifier = verify.result === 'pass' ? 'pass' : verify.result === 'fail' ? 'reject' : 'none';
    }
  }
  const gate: z.infer<typeof resultSchema> = gates.length === 0 ? 'none' : gates.every((item) => item.exit_code === 0 && !item.timed_out) ? 'pass' : 'failed';
  const heavyAcceptance = active?.state.status === 'verifying' && active.state.level === 'heavy' && verifier === 'pass';
  const nextUserIntervention: z.infer<typeof interventionSchema> = heavyAcceptance ? 'accept_delivery' : 'none';
  const nextAction: z.infer<typeof nextActionSchema> = !active ? 'no_active_task'
    : active.state.status === 'iterating' ? 'fix_rejection'
      : heavyAcceptance ? 'wait_for_heavy_acceptance'
        : active.state.status === 'delivered' ? 'task_delivered' : 'continue_execution';
  const timestamps = [project.updated_at, ...states.map(({ state }) => state.updated_at), harness?.updated_at, ...gates.map((item) => item.created_at)].filter((value): value is string => Boolean(value));
  return buildProgressSnapshot({
    projectId: project.project_id,
    waveId: 'PROJECT',
    tasks: states.map(({ state }) => ({ task_id: state.task_id, status: state.status, round: state.current_round })),
    currentTaskId: taskId,
    harnessStep: harness?.task_id === taskId ? harness.stage : 'none',
    gate,
    verifier,
    nextUserIntervention,
    nextAction,
    updatedAt: timestamps.sort().at(-1) ?? new Date(0).toISOString(),
  });
}

export async function enqueueCurrentProjectProgress(projectRoot: string, targets: FeishuTarget[], aggregateWindowMs: number): Promise<number> {
  const snapshot = await projectProgressSnapshot(projectRoot);
  const routed = targets.filter((item) => item.project_id === snapshot.project_id);
  for (const target of routed) {
    await enqueueProgressCard(projectRoot, snapshot, target, aggregateWindowMs);
    const eventType = snapshot.recent.verifier === 'reject' ? 'verifier_rejected' : snapshot.recent.gate === 'failed' ? 'gate_failed' : null;
    if (eventType && snapshot.current.task_id) {
      const eventId = sha256(JSON.stringify({ task: snapshot.current.task_id, round: snapshot.current.round, eventType })).slice(0, 32);
      await enqueueCriticalCard(projectRoot, { projectId: snapshot.project_id, waveId: snapshot.wave_id, eventId, eventType, taskId: snapshot.current.task_id, target });
    }
  }
  return routed.length;
}
