import { lstat, mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteMany, sha256 } from './files.js';
import type { ConfirmationControllerCommand } from './connectors/feishu-callback.js';
import { confirmationContentHash, confirmationFactsSchema } from './connectors/feishu-confirmation.js';

const actionSchema = z.enum([
  'approve_proposal', 'reject_proposal', 'choose_option', 'pause_task', 'approve_visual', 'reject_visual',
  'authorize_verification', 'defer_verification', 'accept_heavy', 'reject_heavy',
]);

const decisionSchema = z.object({
  schema_version: z.literal(1),
  command_id: z.string().uuid(), request_id: z.string().uuid(),
  project_id: z.string(), task_id: z.string(), request_type: z.enum(['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance']),
  round: z.number().int().positive(), revision: z.string(), content_hash: z.string().length(64),
  risk: z.enum(['light', 'standard', 'heavy']), facts: confirmationFactsSchema,
  action: actionSchema, option_id: z.string().nullable(), actor: z.string(), source: z.enum(['feishu', 'local']),
  reference_ids: z.array(z.string()), status: z.enum(['active', 'consumed']),
  created_at: z.iso.datetime(), consumed_at: z.iso.datetime().nullable(), consumed_by: z.string().nullable(),
}).strict();
export type ConfirmationDecision = z.infer<typeof decisionSchema>;

const storeSchema = z.object({
  schema_version: z.literal(1), projection_hash: z.string().length(64), decisions: z.array(decisionSchema),
}).strict();

async function decisionRoot(projectRoot: string): Promise<string> {
  const root = path.join(projectRoot, '.spec-loop', 'decisions');
  const info = await lstat(root).catch(() => null);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('confirmation decision path is invalid');
  if (!info) await mkdir(root, { mode: 0o700 });
  return root;
}

async function withDecisionLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, 'mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('confirmation decision store is busy');
  try { return await operation(); } finally { await rmdir(lock); }
}

async function readDecisions(root: string): Promise<ConfirmationDecision[]> {
  const file = path.join(root, 'decisions.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('confirmation decision store is invalid');
  const value = storeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (value.projection_hash !== sha256(JSON.stringify(value.decisions))) throw new Error('confirmation decision projection integrity failure');
  return value.decisions;
}

async function writeDecisions(projectRoot: string, root: string, decisions: ConfirmationDecision[]): Promise<void> {
  const value = storeSchema.parse({ schema_version: 1, projection_hash: sha256(JSON.stringify(decisions)), decisions });
  await atomicWriteMany(projectRoot, [{ file: path.join(root, 'decisions.json'), content: `${JSON.stringify(value, null, 2)}\n` }]);
}

export async function recordConfirmationDecision(projectRoot: string, command: ConfirmationControllerCommand): Promise<ConfirmationDecision> {
  const root = await decisionRoot(projectRoot);
  return withDecisionLock(root, async () => {
    const decisions = await readDecisions(root);
    const existing = decisions.find((item) => item.command_id === command.command_id);
    if (existing) {
      const expected = sha256(JSON.stringify({ request_id: command.request_id, action: command.action, actor: command.actor, content_hash: command.content_hash }));
      const actual = sha256(JSON.stringify({ request_id: existing.request_id, action: existing.action, actor: existing.actor, content_hash: existing.content_hash }));
      if (actual !== expected) throw new Error('confirmation decision command was reused with different facts');
      return existing;
    }
    const decision = decisionSchema.parse({
      schema_version: 1, command_id: command.command_id, request_id: command.request_id,
      project_id: command.project_id, task_id: command.task_id, request_type: command.request_type,
      round: command.round, revision: command.revision, content_hash: command.content_hash, risk: command.risk, facts: command.facts,
      action: command.action, option_id: command.option_id, actor: command.actor, source: command.source,
      reference_ids: command.facts.reference_ids, status: 'active', created_at: new Date().toISOString(),
      consumed_at: null, consumed_by: null,
    });
    decisions.push(decision); await writeDecisions(projectRoot, root, decisions); return decision;
  });
}

export async function listConfirmationDecisions(projectRoot: string): Promise<ConfirmationDecision[]> {
  const root = await decisionRoot(projectRoot);
  return withDecisionLock(root, () => readDecisions(root));
}

export async function findConfirmationDecision(projectRoot: string, commandId: string): Promise<ConfirmationDecision | null> {
  return (await listConfirmationDecisions(projectRoot)).find((item) => item.command_id === commandId) ?? null;
}

export async function latestActiveConfirmationDecision(projectRoot: string, input: {
  taskId: string; requestType: ConfirmationDecision['request_type']; round: number;
}): Promise<ConfirmationDecision | null> {
  return [...await listConfirmationDecisions(projectRoot)].reverse().find((item) => item.status === 'active'
    && item.task_id === input.taskId && item.request_type === input.requestType && item.round === input.round) ?? null;
}

export async function consumeConfirmationDecision(projectRoot: string, input: {
  commandId: string; contentHash: string; consumer: string;
}): Promise<ConfirmationDecision | null> {
  const root = await decisionRoot(projectRoot);
  return withDecisionLock(root, async () => {
    const decisions = await readDecisions(root);
    const decision = decisions.find((item) => item.status === 'active' && item.command_id === input.commandId);
    if (!decision) return null;
    if (decision.content_hash !== input.contentHash) throw new Error('confirmation decision authority changed before consumption');
    decision.status = 'consumed'; decision.consumed_at = new Date().toISOString(); decision.consumed_by = input.consumer;
    await writeDecisions(projectRoot, root, decisions); return decision;
  });
}

export function confirmationDecisionHasValidContent(decision: ConfirmationDecision): boolean {
  return decision.content_hash === confirmationContentHash({
    type: decision.request_type, projectId: decision.project_id, taskId: decision.task_id,
    round: decision.round, revision: decision.revision, risk: decision.risk, facts: decision.facts,
  });
}

export async function hasProposalRejection(projectRoot: string, proposalId: string): Promise<boolean> {
  return (await listConfirmationDecisions(projectRoot)).some((item) => item.status === 'active' && item.request_type === 'proposal'
    && item.action === 'reject_proposal' && item.reference_ids.includes(proposalId));
}

export function managedProjectRoot(taskRoot: string): string | null {
  const tasks = path.dirname(taskRoot), control = path.dirname(tasks);
  return path.basename(tasks) === 'tasks' && path.basename(control) === '.spec-loop' ? path.dirname(control) : null;
}
