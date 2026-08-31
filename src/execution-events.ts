import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertNoSecrets, atomicWriteMany, readMarkdown, sha256 } from './files.js';

export const executionStepTypeSchema = z.enum([
  'task.plan', 'task.attempt', 'round.work',
  'work.reproduce', 'work.analyze', 'work.change',
  'harness.prepare', 'harness.execute', 'harness.collect', 'harness.report',
  'gate.command', 'gate.playwright', 'review.visual', 'task.verify', 'task.deliver', 'wait.user',
]);
export const executionEventKindSchema = z.enum([
  'step_started', 'step_succeeded', 'step_failed', 'step_interrupted',
  'wait_started', 'wait_ended', 'annotation',
]);
export const executionOutcomeSchema = z.enum(['success', 'failure', 'interrupted', 'cancelled']).nullable();

const safeRefSchema = z.string().trim().min(1).max(500).refine((value) => {
  if (path.isAbsolute(value) || value.includes('\\') || value.startsWith('-') || value.includes('\0')) return false;
  const parts = value.split('/');
  return !parts.includes('..') && !parts.includes('.') && parts.every(Boolean);
}, { message: 'must be a safe project-relative reference or identifier' });

export const executionEventSchema = z.object({
  schema_version: z.literal(1), sequence: z.number().int().positive(), event_id: z.string().uuid(),
  step_run_id: z.string().uuid().nullable(), project_id: z.string().regex(/^PROJ-[A-Z0-9-]+$/),
  task_id: z.string().min(1).nullable(), round: z.number().int().nonnegative().nullable(), run_id: z.string().uuid().nullable(),
  owner_pid: z.number().int().positive().nullable().optional(),
  kind: executionEventKindSchema, step_type: executionStepTypeSchema.nullable(),
  label: z.string().trim().min(3).max(120), summary: z.string().trim().min(3).max(500),
  occurred_at: z.iso.datetime(), outcome: executionOutcomeSchema, refs: z.array(safeRefSchema).max(50),
  previous_hash: z.string().length(64).nullable(), event_hash: z.string().length(64),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'annotation') {
    if (value.step_run_id !== null) ctx.addIssue({ code: 'custom', path: ['step_run_id'], message: 'annotation must not have a step run id' });
    if (value.owner_pid != null) ctx.addIssue({ code: 'custom', path: ['owner_pid'], message: 'annotation must not have an owner pid' });
  } else if (!value.step_run_id || !value.task_id || value.round === null || !value.step_type) {
    ctx.addIssue({ code: 'custom', message: 'step events require step run, task, round and step type' });
  }
  const starts = ['step_started', 'wait_started'];
  const terminals = ['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended'];
  if (starts.includes(value.kind) && value.outcome !== null) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'start event outcome must be null' });
  if (terminals.includes(value.kind) && value.outcome === null) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'terminal event requires an outcome' });
  if (value.kind === 'annotation' && value.outcome !== null) ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'annotation outcome must be null' });
  if (value.kind.startsWith('wait_') && value.step_type !== 'wait.user') ctx.addIssue({ code: 'custom', path: ['step_type'], message: 'wait events require wait.user step type' });
  if (!value.kind.startsWith('wait_') && value.step_type === 'wait.user') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'wait.user requires wait events' });
});

export type ExecutionStepType = z.infer<typeof executionStepTypeSchema>;
export type ExecutionEvent = z.infer<typeof executionEventSchema>;
export type ExecutionOutcome = Exclude<z.infer<typeof executionOutcomeSchema>, null>;

type EventInput = {
  taskId: string; round: number; runId?: string | null; stepType: ExecutionStepType;
  label: string; summary: string; refs?: string[]; occurredAt?: Date; detached?: boolean;
};
type AnnotationInput = Omit<EventInput, 'runId' | 'stepType'>;

const eventFile = (projectRoot: string) => path.join(projectRoot, '.spec-loop', 'EXECUTION_EVENTS.jsonl');

function parseLine(raw: string, line: number): unknown {
  const keys = new Set<string>();
  const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(raw)) !== null) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (keys.has(key)) throw new Error(`EXECUTION_EVENTS.jsonl:${line}: duplicate field ${key}`);
    keys.add(key);
  }
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`EXECUTION_EVENTS.jsonl:${line}: malformed JSON: ${(error as Error).message}`); }
}

function eventHash(event: Omit<ExecutionEvent, 'event_hash'>): string {
  return sha256(JSON.stringify(event));
}

function validateEventSequence(events: ExecutionEvent[]): void {
  const open = new Map<string, ExecutionEvent>();
  const terminal = new Set(['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended']);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) throw new Error(`execution event sequence must be continuous: expected ${index + 1}, got ${event.sequence}`);
    const previous = index ? events[index - 1].event_hash : null;
    if (event.previous_hash !== previous) throw new Error(`execution event ${event.sequence}: previous hash mismatch`);
    const { event_hash: actual, ...facts } = event;
    if (actual !== eventHash(facts)) throw new Error(`execution event ${event.sequence}: event hash mismatch`);
    assertNoSecrets(`${event.label}\n${event.summary}\n${event.refs.join('\n')}`, `execution event ${event.sequence}`);
    if (event.kind === 'step_started' || event.kind === 'wait_started') {
      if (open.has(event.step_run_id as string)) throw new Error(`execution event ${event.sequence}: duplicate open step run`);
      open.set(event.step_run_id as string, event);
    } else if (terminal.has(event.kind)) {
      const start = open.get(event.step_run_id as string);
      if (!start) throw new Error(`execution event ${event.sequence}: terminal event has no open step`);
      if (start.project_id !== event.project_id || start.task_id !== event.task_id || start.round !== event.round
        || start.run_id !== event.run_id || start.step_type !== event.step_type) throw new Error(`execution event ${event.sequence}: terminal event identity mismatch`);
      if ((start.kind === 'wait_started') !== (event.kind === 'wait_ended')) throw new Error(`execution event ${event.sequence}: wait event pairing mismatch`);
      if (Date.parse(event.occurred_at) < Date.parse(start.occurred_at)) throw new Error(`execution event ${event.sequence}: terminal time precedes start`);
      open.delete(event.step_run_id as string);
    }
  }
}

async function projectId(projectRoot: string): Promise<string> {
  const data = (await readMarkdown(path.join(projectRoot, '.spec-loop', 'PROJECT.md'))).data as { project_id?: unknown };
  return z.string().regex(/^PROJ-[A-Z0-9-]+$/).parse(data.project_id);
}

async function withEventLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const control = path.join(projectRoot, '.spec-loop');
  const info = await lstat(control).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('execution event control root is missing or invalid');
  const lock = path.join(control, 'execution-events.lock'), owner = path.join(lock, 'owner.json');
  let acquired = false;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(owner, `${JSON.stringify({ schema_version: 1, pid: process.pid, created_at: new Date().toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
      acquired = true; break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockInfo = await lstat(lock).catch(() => null);
      if (!lockInfo) continue;
      if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink()) throw new Error('execution event lock is invalid');
      const current = await readFile(owner, 'utf8').then((value) => JSON.parse(value) as { pid?: number }).catch(() => null);
      let dead = false;
      if (current?.pid) {
        try { process.kill(current.pid, 0); }
        catch (pidError) { dead = (pidError as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      if (dead || (!current && Date.now() - lockInfo.mtimeMs > 5_000)) { await rm(lock, { recursive: true, force: true }); continue; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error('execution event store is busy');
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function readExecutionEvents(projectRoot: string): Promise<ExecutionEvent[]> {
  const file = eventFile(projectRoot), info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('execution event store is symbolic or not a regular file');
  const raw = await readFile(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const events = lines.map((line, index) => executionEventSchema.parse(parseLine(line, index + 1)));
  validateEventSequence(events);
  return events;
}

function createEvent(input: Omit<ExecutionEvent, 'schema_version' | 'sequence' | 'event_id' | 'previous_hash' | 'event_hash'>,
  sequence: number, previousHash: string | null): ExecutionEvent {
  const facts = {
    schema_version: 1 as const, sequence, event_id: randomUUID(), ...input, previous_hash: previousHash,
  };
  const parsed = executionEventSchema.parse({ ...facts, event_hash: '0'.repeat(64) });
  const { event_hash: _placeholder, ...canonical } = parsed;
  return executionEventSchema.parse({ ...canonical, event_hash: eventHash(canonical) });
}

async function append(projectRoot: string, input: Omit<ExecutionEvent, 'schema_version' | 'sequence' | 'event_id' | 'project_id' | 'previous_hash' | 'event_hash'>): Promise<ExecutionEvent> {
  return withEventLock(projectRoot, async () => {
    const id = await projectId(projectRoot), existing = await readExecutionEvents(projectRoot), additions: ExecutionEvent[] = [];
    let previous = existing.at(-1)?.event_hash ?? null, sequence = existing.length + 1;
    if (!existing.length) {
      const baseline = createEvent({
        step_run_id: null, project_id: id, task_id: null, round: null, run_id: null, owner_pid: null, kind: 'annotation', step_type: null,
        label: 'Observability baseline', summary: 'Execution timing starts at this project event baseline; earlier facts retain their original precision.',
        occurred_at: input.occurred_at, outcome: null, refs: [],
      }, sequence, previous);
      additions.push(baseline); previous = baseline.event_hash; sequence += 1;
    }
    const event = createEvent({ ...input, project_id: id }, sequence, previous);
    const events = [...existing, ...additions, event]; validateEventSequence(events);
    await atomicWriteMany(projectRoot, [{ file: eventFile(projectRoot), content: `${events.map((item) => JSON.stringify(item)).join('\n')}\n` }]);
    return event;
  });
}

export async function startExecutionStep(projectRoot: string, input: EventInput & { wait?: boolean }): Promise<ExecutionEvent> {
  assertNoSecrets(`${input.label}\n${input.summary}\n${(input.refs ?? []).join('\n')}`, 'execution step');
  const wait = Boolean(input.wait), stepRunId = randomUUID();
  const ownerPid = wait || input.detached || input.stepType === 'round.work' ? null : process.pid;
  return append(projectRoot, {
    step_run_id: stepRunId, task_id: input.taskId, round: input.round, run_id: input.runId ?? null, owner_pid: ownerPid,
    kind: wait ? 'wait_started' : 'step_started', step_type: wait ? 'wait.user' : input.stepType,
    label: input.label, summary: input.summary, occurred_at: (input.occurredAt ?? new Date()).toISOString(), outcome: null, refs: input.refs ?? [],
  });
}

export async function finishExecutionStep(projectRoot: string, start: ExecutionEvent, input: {
  outcome: ExecutionOutcome; summary?: string; refs?: string[]; occurredAt?: Date;
}): Promise<ExecutionEvent> {
  if (!start.step_run_id || !start.task_id || start.round === null || !start.step_type) throw new Error('cannot finish an annotation event');
  const kind = start.kind === 'wait_started' ? 'wait_ended'
    : input.outcome === 'success' ? 'step_succeeded'
      : input.outcome === 'failure' ? 'step_failed' : 'step_interrupted';
  return append(projectRoot, {
    step_run_id: start.step_run_id, task_id: start.task_id, round: start.round, run_id: start.run_id, owner_pid: start.owner_pid ?? null,
    kind, step_type: start.step_type, label: start.label, summary: input.summary ?? start.summary,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(), outcome: input.outcome, refs: input.refs ?? start.refs,
  });
}

export async function annotateExecution(projectRoot: string, input: AnnotationInput): Promise<ExecutionEvent> {
  return append(projectRoot, {
    step_run_id: null, task_id: input.taskId, round: input.round, run_id: null, owner_pid: null, kind: 'annotation', step_type: null,
    label: input.label, summary: input.summary, occurred_at: (input.occurredAt ?? new Date()).toISOString(), outcome: null, refs: input.refs ?? [],
  });
}

export function managedProjectRootForTask(taskRoot: string): string | null {
  const tasks = path.dirname(path.resolve(taskRoot)), control = path.dirname(tasks);
  return path.basename(tasks) === 'tasks' && path.basename(control) === '.spec-loop' ? path.dirname(control) : null;
}

export async function startManagedTaskStep(taskRoot: string, input: EventInput & { wait?: boolean }): Promise<ExecutionEvent | null> {
  const root = managedProjectRootForTask(taskRoot); return root ? startExecutionStep(root, input) : null;
}

export async function annotateManagedTask(taskRoot: string, input: AnnotationInput): Promise<ExecutionEvent | null> {
  const root = managedProjectRootForTask(taskRoot); return root ? annotateExecution(root, input) : null;
}

export async function latestOpenExecutionStep(projectRoot: string, input: {
  taskId: string; round: number; stepType: ExecutionStepType;
}): Promise<ExecutionEvent | null> {
  const events = await readExecutionEvents(projectRoot), closed = new Set(events.filter((item) =>
    ['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended'].includes(item.kind)).map((item) => item.step_run_id));
  return [...events].reverse().find((item) => (item.kind === 'step_started' || item.kind === 'wait_started')
    && item.task_id === input.taskId && item.round === input.round && item.step_type === input.stepType && !closed.has(item.step_run_id)) ?? null;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export async function reconcileInterruptedExecutionSteps(projectRoot: string, input: {
  taskId: string; stepTypes: ExecutionStepType[]; summary: string;
}): Promise<ExecutionEvent[]> {
  const events = await readExecutionEvents(projectRoot), closed = new Set(events.filter((item) =>
    ['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended'].includes(item.kind)).map((item) => item.step_run_id));
  const orphaned = events.filter((item) => (item.kind === 'step_started' || item.kind === 'wait_started')
    && item.task_id === input.taskId && item.step_type && input.stepTypes.includes(item.step_type)
    && !closed.has(item.step_run_id) && typeof item.owner_pid === 'number' && !processAlive(item.owner_pid));
  const reconciled: ExecutionEvent[] = [];
  for (const start of orphaned) reconciled.push(await finishExecutionStep(projectRoot, start, { outcome: 'interrupted', summary: input.summary }));
  return reconciled;
}

export async function finishLatestManagedTaskStep(taskRoot: string, input: {
  taskId: string; round: number; stepType: ExecutionStepType; outcome: ExecutionOutcome; summary?: string; refs?: string[];
}): Promise<ExecutionEvent | null> {
  const root = managedProjectRootForTask(taskRoot); if (!root) return null;
  const start = await latestOpenExecutionStep(root, input); return start ? finishExecutionStep(root, start, input) : null;
}
