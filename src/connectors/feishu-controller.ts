import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteMany, readMarkdown, sha256 } from '../files.js';
import { findConfirmationDecision, recordConfirmationDecision } from '../confirmation-decisions.js';
import { readWorkspace } from '../execution.js';
import { approveProposal, readProject, scanTasks } from '../project.js';
import { decideVisualReview, readVisualReviews, canonicalGitRevision } from '../review.js';
import { applyNeedsUserDecision, readState } from '../task.js';
import type { ConfirmationControllerAdapter, ConfirmationControllerCommand } from './feishu-callback.js';
import { feishuConnectorRoot } from './feishu.js';

const commandResultSchema = z.object({
  status: z.enum(['applied', 'duplicate']),
  audit_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/),
}).strict();

const storedCommandSchema = z.object({
  schema_version: z.literal(1),
  command_id: z.string().uuid(),
  command_hash: z.string().length(64),
  request_id: z.string().uuid(),
  request_type: z.enum(['proposal', 'needs_user', 'visual_review', 'verification', 'heavy_acceptance']),
  action: z.string(),
  actor: z.string(),
  status: z.enum(['processing', 'succeeded']),
  audit_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/),
  started_at: z.iso.datetime(),
  completed_at: z.iso.datetime().nullable(),
}).strict();
type StoredCommand = z.infer<typeof storedCommandSchema>;

const storeSchema = z.object({
  schema_version: z.literal(1),
  projection_hash: z.string().length(64),
  commands: z.array(storedCommandSchema),
}).strict();

function commandHash(command: ConfirmationControllerCommand): string {
  return sha256(JSON.stringify(command));
}

async function controllerRoot(projectRoot: string): Promise<string> {
  const root = path.join(await feishuConnectorRoot(projectRoot), 'controller');
  const info = await lstat(root).catch(() => null);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('feishu Controller path is symbolic or not a directory');
  if (!info) await mkdir(root, { mode: 0o700 });
  return root;
}

async function withControllerLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, 'mutation.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('feishu Controller is busy; explicit recovery is required');
  try { return await operation(); } finally { await rmdir(lock); }
}

async function readCommands(root: string): Promise<StoredCommand[]> {
  const file = path.join(root, 'commands.json');
  const info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('feishu Controller command store is invalid');
  const value = storeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (value.projection_hash !== sha256(JSON.stringify(value.commands))) throw new Error('feishu Controller command projection integrity failure');
  return value.commands;
}

async function writeCommands(projectRoot: string, root: string, commands: StoredCommand[]): Promise<void> {
  const value = storeSchema.parse({ schema_version: 1, projection_hash: sha256(JSON.stringify(commands)), commands });
  await atomicWriteMany(projectRoot, [{ file: path.join(root, 'commands.json'), content: `${JSON.stringify(value, null, 2)}\n` }]);
}

function reference(command: ConfirmationControllerCommand, expression: RegExp, label: string): string {
  const value = command.facts.reference_ids.find((item) => expression.test(item));
  if (!value) throw new Error(`${label} reference is unavailable`);
  return value;
}

async function assertCurrentAuthority(projectRoot: string, command: ConfirmationControllerCommand): Promise<{ taskPath: string }> {
  const project = await readProject(projectRoot);
  if (project.project_id !== command.project_id) throw new Error('Controller project authority changed');
  const task = (await scanTasks(projectRoot)).find((item) => item.task_id === command.task_id);
  if (!task) throw new Error('Controller task authority is unavailable');
  const state = await readState(task.path);
  if (state.current_round !== command.round || state.level !== command.risk) throw new Error('Controller Round or risk authority changed');
  const allowedStatuses: Record<ConfirmationControllerCommand['request_type'], string[]> = {
    proposal: ['working', 'iterating'], needs_user: ['working', 'iterating'], visual_review: ['working', 'iterating'],
    verification: ['working'], heavy_acceptance: ['working', 'verifying'],
  };
  if (!allowedStatuses[command.request_type].includes(state.status)) throw new Error('Controller state transition is not allowed');
  const workspaceFile = path.join(projectRoot, '.spec-loop', 'output', `${command.task_id}-workspace.json`);
  const workspace = await lstat(workspaceFile).catch(() => null);
  const candidateRepository = workspace ? (await readWorkspace(projectRoot, command.task_id)).worktree : state.repository;
  const currentRevision = await canonicalGitRevision(candidateRepository, 'HEAD');
  const requestedRevision = await canonicalGitRevision(state.repository, command.revision);
  if (currentRevision !== requestedRevision) throw new Error('Controller candidate revision changed');
  const acceptance = (await readMarkdown(path.join(task.path, 'ACCEPTANCE.md'))).data;
  if (sha256(JSON.stringify(acceptance)) !== command.facts.acceptance_hash) throw new Error('Controller Acceptance authority changed');
  const gatePlan = (await readMarkdown(path.join(projectRoot, '.spec-loop', 'GATES.md'))).data;
  if (sha256(JSON.stringify(gatePlan)) !== command.facts.gate_plan_hash) throw new Error('Controller Gate Plan authority changed');
  const screenshotHashes = (await readVisualReviews(task.path)).flatMap((review) => review.artifacts.map((item) => item.sha256)).sort();
  if (JSON.stringify(screenshotHashes) !== JSON.stringify([...command.facts.screenshot_hashes].sort())) throw new Error('Controller screenshot authority changed');
  if (command.request_type === 'visual_review') {
    const reviewId = reference(command, /^REVIEW-[1-9]\d*$/, 'visual review');
    const review = (await readVisualReviews(task.path)).find((item) => item.review_id === reviewId);
    if (!review || review.status !== 'pending' || review.round !== command.round || review.code_revision !== requestedRevision) {
      throw new Error('Controller visual review authority changed');
    }
  }
  return { taskPath: task.path };
}

async function applyCommand(projectRoot: string, command: ConfirmationControllerCommand, taskPath: string): Promise<void> {
  const allowed: Record<ConfirmationControllerCommand['request_type'], ConfirmationControllerCommand['action'][]> = {
    proposal: ['approve_proposal', 'reject_proposal'], needs_user: ['choose_option', 'pause_task'],
    visual_review: ['approve_visual', 'reject_visual'], verification: ['authorize_verification', 'defer_verification'],
    heavy_acceptance: ['accept_heavy', 'reject_heavy'],
  };
  if (!allowed[command.request_type].includes(command.action)) throw new Error('Controller action does not match the request type');
  switch (command.request_type) {
    case 'proposal':
      if (command.action === 'approve_proposal') {
        await approveProposal(projectRoot, reference(command, /^PROP-[1-9]\d*$/, 'proposal'), command.actor, 24, command.command_id);
      }
      return;
    case 'visual_review':
      await decideVisualReview(
        taskPath,
        reference(command, /^REVIEW-[1-9]\d*$/, 'visual review'),
        command.action === 'approve_visual' ? 'approved' : 'rejected',
        command.actor,
        `结构化确认请求 ${command.request_id}`,
        command.command_id,
      );
      return;
    case 'needs_user':
      await applyNeedsUserDecision(taskPath, {
        commandId: command.command_id, requestId: command.request_id, actor: command.actor,
        action: command.action as 'choose_option' | 'pause_task', optionId: command.option_id,
      });
      return;
    case 'verification':
    case 'heavy_acceptance':
      return;
  }
}

async function completedDomainEffect(projectRoot: string, command: ConfirmationControllerCommand): Promise<boolean> {
  let file: string | null = null;
  if (command.action === 'approve_proposal') file = path.join(projectRoot, '.spec-loop', 'controller-effects', `${command.command_id}.json`);
  if (command.request_type === 'visual_review') {
    const task = (await scanTasks(projectRoot)).find((item) => item.task_id === command.task_id);
    if (task) file = path.join(task.path, 'controller-effects', `${command.command_id}.json`);
  }
  if (command.request_type === 'needs_user') {
    const task = (await scanTasks(projectRoot)).find((item) => item.task_id === command.task_id);
    if (task) file = path.join(task.path, 'user-decisions', `${command.command_id}.json`);
  }
  if (!file) return false;
  const info = await lstat(file).catch(() => null);
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Controller domain effect marker is invalid');
  const value = JSON.parse(await readFile(file, 'utf8')) as {
    command_id?: string; proposal_id?: string; approval_id?: string; review_id?: string; result?: string; decision_hash?: string;
  };
  if (value.command_id !== command.command_id) throw new Error('Controller domain effect marker differs from the command');
  if (command.action === 'approve_proposal') {
    const proposalId = reference(command, /^PROP-[1-9]\d*$/, 'proposal');
    if (value.proposal_id !== proposalId || !value.approval_id) throw new Error('Controller proposal effect marker is incomplete');
    const approvalFile = path.join(projectRoot, '.spec-loop', 'approvals', `${value.approval_id}.json`);
    const approvalInfo = await lstat(approvalFile).catch(() => null);
    if (!approvalInfo?.isFile() || approvalInfo.isSymbolicLink()) throw new Error('Controller proposal approval effect is missing');
    const approval = JSON.parse(await readFile(approvalFile, 'utf8')) as { proposal_id?: string; approved_by?: string };
    if (approval.proposal_id !== proposalId || approval.approved_by !== command.actor) throw new Error('Controller proposal approval effect differs from the command');
  }
  if (command.request_type === 'visual_review') {
    const task = (await scanTasks(projectRoot)).find((item) => item.task_id === command.task_id);
    const reviewId = reference(command, /^REVIEW-[1-9]\d*$/, 'visual review');
    const expected = command.action === 'approve_visual' ? 'approved' : 'rejected';
    const review = task ? (await readVisualReviews(task.path)).find((item) => item.review_id === reviewId) : null;
    if (!review || value.review_id !== reviewId || value.result !== expected || value.decision_hash !== review.decision_hash || review.status !== expected) {
      throw new Error('Controller visual review effect differs from the command');
    }
  }
  if (command.request_type === 'needs_user') {
    if (value.command_id !== command.command_id) throw new Error('Controller needs_user effect differs from the command');
  }
  return true;
}

export class LocalSpecLoopConfirmationController implements ConfirmationControllerAdapter {
  constructor(private readonly projectRoot: string) {}

  async lookup(commandId: string): Promise<{ status: 'applied' | 'duplicate'; audit_id: string; committed_at: string } | null> {
    const root = await controllerRoot(this.projectRoot);
    return withControllerLock(root, async () => {
      const existing = (await readCommands(root)).find((item) => item.command_id === commandId && item.status === 'succeeded');
      return existing ? { ...commandResultSchema.parse({ status: 'duplicate', audit_id: existing.audit_id }), committed_at: existing.completed_at as string } : null;
    });
  }

  async execute(command: ConfirmationControllerCommand): Promise<{ status: 'applied' | 'duplicate'; audit_id: string; committed_at?: string }> {
    const root = await controllerRoot(this.projectRoot);
    return withControllerLock(root, async () => {
      const commands = await readCommands(root);
      const hash = commandHash(command);
      let current = commands.find((item) => item.command_id === command.command_id);
      if (current && current.command_hash !== hash) throw new Error('Controller idempotency key was reused with different authority facts');
      if (current?.status === 'succeeded') return { ...commandResultSchema.parse({ status: 'duplicate', audit_id: current.audit_id }), committed_at: current.completed_at as string };
      if (current && await findConfirmationDecision(this.projectRoot, command.command_id)) {
        current.status = 'succeeded'; current.completed_at = new Date().toISOString();
        await writeCommands(this.projectRoot, root, commands);
        return { ...commandResultSchema.parse({ status: 'duplicate', audit_id: current.audit_id }), committed_at: current.completed_at as string };
      }
      if (current && await completedDomainEffect(this.projectRoot, command)) {
        await recordConfirmationDecision(this.projectRoot, command);
        current.status = 'succeeded'; current.completed_at = new Date().toISOString();
        await writeCommands(this.projectRoot, root, commands);
        return { ...commandResultSchema.parse({ status: 'duplicate', audit_id: current.audit_id }), committed_at: current.completed_at as string };
      }
      const authority = await assertCurrentAuthority(this.projectRoot, command);
      if (!current) {
        current = storedCommandSchema.parse({
          schema_version: 1, command_id: command.command_id, command_hash: hash, request_id: command.request_id,
          request_type: command.request_type, action: command.action, actor: command.actor, status: 'processing',
          audit_id: `audit_${randomUUID().replaceAll('-', '')}`, started_at: new Date().toISOString(), completed_at: null,
        });
        commands.push(current);
        await writeCommands(this.projectRoot, root, commands);
      }
      await applyCommand(this.projectRoot, command, authority.taskPath);
      await recordConfirmationDecision(this.projectRoot, command);
      current.status = 'succeeded'; current.completed_at = new Date().toISOString();
      await writeCommands(this.projectRoot, root, commands);
      return { ...commandResultSchema.parse({ status: 'applied', audit_id: current.audit_id }), committed_at: current.completed_at as string };
    });
  }
}

export function createLocalSpecLoopConfirmationController(projectRoot: string): LocalSpecLoopConfirmationController {
  return new LocalSpecLoopConfirmationController(projectRoot);
}
