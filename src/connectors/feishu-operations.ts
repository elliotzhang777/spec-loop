import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ConfirmationControllerAdapter } from './feishu-callback.js';
import { feishuConnectorRoot, redactFeishuText } from './feishu.js';

const failureCategorySchema = z.enum(['rate_limited', 'server', 'network', 'permission', 'target', 'credentials', 'invalid_config', 'unknown']);
const operationalStateSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['disabled', 'starting', 'connected', 'retry_wait', 'blocked', 'stopped']),
  attempt: z.number().int().nonnegative(),
  last_transition_at: z.iso.datetime(),
  last_connected_at: z.iso.datetime().nullable(),
  next_retry_at: z.iso.datetime().nullable(),
  failure_category: failureCategorySchema.nullable(),
  error_summary: z.string().max(300).nullable(),
}).strict();

export type FeishuOperationalState = z.infer<typeof operationalStateSchema>;

export function classifyFeishuOperationalError(error: unknown): {
  category: z.infer<typeof failureCategorySchema>;
  retryable: boolean;
  retryAfterMs: number;
  summary: string;
} {
  const value = error as { status?: number; code?: string; retryAfterMs?: number; message?: string };
  const message = redactFeishuText(error instanceof Error ? error.message : String(error)).slice(0, 300);
  if (value.status === 429) return { category: 'rate_limited', retryable: true, retryAfterMs: Math.max(1_000, value.retryAfterMs ?? 5_000), summary: message };
  if (value.status && value.status >= 500) return { category: 'server', retryable: true, retryAfterMs: 2_000, summary: message };
  if (value.status === 401 || value.status === 403) return { category: 'permission', retryable: false, retryAfterMs: 0, summary: message };
  if (value.status === 404 || value.code === 'TARGET_UNAVAILABLE') return { category: 'target', retryable: false, retryAfterMs: 0, summary: message };
  if (/credential reference|app secret|app id/i.test(message)) return { category: 'credentials', retryable: false, retryAfterMs: 0, summary: message };
  if (/config|tenant|approver|target/i.test(message)) return { category: 'invalid_config', retryable: false, retryAfterMs: 0, summary: message };
  if (/ECONN|socket|network|timeout|timed out|preflight unavailable/i.test(message)) return { category: 'network', retryable: true, retryAfterMs: 1_000, summary: message };
  return { category: 'unknown', retryable: true, retryAfterMs: 1_000, summary: message || '飞书连接器发生未知错误' };
}

export async function readFeishuOperationalState(projectRoot: string): Promise<FeishuOperationalState | null> {
  const root = await feishuConnectorRoot(projectRoot), file = path.join(root, 'runtime-status.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('feishu runtime status is symbolic or not a regular file');
  return operationalStateSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function writeFeishuOperationalState(projectRoot: string, input: Omit<FeishuOperationalState, 'schema_version'>): Promise<FeishuOperationalState> {
  const root = await feishuConnectorRoot(projectRoot);
  const state = operationalStateSchema.parse({ schema_version: 1, ...input, error_summary: input.error_summary ? redactFeishuText(input.error_summary).slice(0, 300) : null });
  const file = path.join(root, 'runtime-status.json'), temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  return state;
}

export async function reconcileFeishuConnector(projectRoot: string, controller?: ConfirmationControllerAdapter, now = new Date()): Promise<{
  confirmations_expired: number;
  outbox_recovered: number;
  inbox_processed: number;
}> {
  const inboxProcessed = controller
    ? (await (await import('./feishu-callback.js')).reconcileFeishuActions(projectRoot, controller, now)).length
    : 0;
  const confirmations = await import('./feishu-confirmation.js');
  const pending = await confirmations.listConfirmationRequests(projectRoot);
  const confirmationsExpired = pending.some((item) => item.status === 'pending')
    ? await confirmations.expireConfirmationRequests(projectRoot, now)
    : 0;
  const { reconcileFeishuOutbox } = await import('./feishu-progress.js');
  const outboxRecovered = await reconcileFeishuOutbox(projectRoot);
  return { confirmations_expired: confirmationsExpired, outbox_recovered: outboxRecovered, inbox_processed: inboxProcessed };
}

export function retryDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, requestedDelayMs: number): number {
  const exponential = Math.max(baseDelayMs, requestedDelayMs) * 2 ** Math.min(8, Math.max(0, attempt - 1));
  return Math.min(maxDelayMs, exponential);
}
