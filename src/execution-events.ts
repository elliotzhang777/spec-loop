import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertNoSecrets, atomicWriteMany, exists, recoverTransactions, readMarkdown, sha256 } from './files.js';
import { withOwnedDirectoryLock } from './owned-lock.js';

export const executionStepTypeSchema = z.enum([
  'task.plan', 'task.attempt', 'round.work',
  'work.reproduce', 'work.analyze', 'work.change',
  'harness.prepare', 'harness.execute', 'harness.collect', 'harness.report',
  'role.m', 'role.v', 'role.r', 'acceptance.plan', 'acceptance.route', 'acceptance.candidate',
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
  task_id: z.string().min(1).nullable(), round: z.number().int().nonnegative().nullable(), run_id: z.string().min(1).max(160).nullable(),
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

function validateEventSequence(events: ExecutionEvent[],offset=0,previousOpen=new Map<string,ExecutionEvent>(),previousSeen=new Set<string>()): {open:Map<string,ExecutionEvent>;seen:Set<string>} {
  const open = new Map(previousOpen);
  const seen = new Set(previousSeen);
  const terminal = new Set(['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended']);
  for (let index = offset; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) throw new Error(`execution event sequence must be continuous: expected ${index + 1}, got ${event.sequence}`);
    const previous = index ? events[index - 1].event_hash : null;
    if (event.previous_hash !== previous) throw new Error(`execution event ${event.sequence}: previous hash mismatch`);
    const { event_hash: actual, ...facts } = event;
    if (actual !== eventHash(facts)) throw new Error(`execution event ${event.sequence}: event hash mismatch`);
    assertNoSecrets(`${event.task_id??''}\n${event.run_id??''}\n${event.label}\n${event.summary}\n${event.refs.join('\n')}`, `execution event ${event.sequence}`);
    if (event.kind === 'step_started' || event.kind === 'wait_started') {
      if (seen.has(event.step_run_id as string)) throw new Error(`execution event ${event.sequence}: duplicate step run id`);
      seen.add(event.step_run_id as string);
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
  return {open,seen};
}

async function projectId(projectRoot: string): Promise<string> {
  const data = (await readMarkdown(path.join(projectRoot, '.spec-loop', 'PROJECT.md'))).data as { project_id?: unknown };
  return z.string().regex(/^PROJ-[A-Z0-9-]+$/).parse(data.project_id);
}

async function withEventLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const control = path.join(projectRoot, '.spec-loop');
  const info = await lstat(control).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('execution event control root is missing or invalid');
  return withOwnedDirectoryLock(path.join(control, 'execution-events.lock'), {
    name: 'execution event store', maxWaitMs: 5_000, pollMs: 10, missingOwnerProtectionMs: 5_000,
  }, operation);
}

const SEGMENT_BYTES=8*1024*1024;
const archiveIndex=(root:string)=>path.join(root,'.spec-loop','EXECUTION_EVENT_ARCHIVE.json');
const archiveDir=(root:string)=>path.join(root,'.spec-loop','execution-event-archive');
const segmentPattern=/^(\d{12})-(\d{12})-([a-f0-9]{64})\.jsonl$/;
type EventCache={key:string;events:ExecutionEvent[]};
const eventCache=new Map<string,EventCache>();
async function eventFiles(root:string){
  const dir=archiveDir(root),directory=await lstat(dir).catch(error=>{if(error.code==='ENOENT')return null;throw error});
  if(directory&&(!directory.isDirectory()||directory.isSymbolicLink()))throw new Error('invalid execution event archive directory');
  const names=directory?(await readdir(dir)).filter(name=>name.endsWith('.jsonl')).sort():[];
  if(names.some(name=>!segmentPattern.test(name)))throw new Error('invalid execution event segment name');
  const indexInfo=await lstat(archiveIndex(root),{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error});
  let indexKey='';
  if(indexInfo){
    if(!indexInfo.isFile()||indexInfo.isSymbolicLink()||indexInfo.size>1048576n)throw new Error('invalid execution event archive index');
    const index=JSON.parse(await readFile(archiveIndex(root),'utf8'));
    if(index.schema_version!==1||JSON.stringify(index.segments)!==JSON.stringify(names)||!names.length||index.last_sequence!==Number(names.at(-1)!.match(segmentPattern)![2])||!/^[a-f0-9]{64}$/.test(index.last_event_hash))throw new Error('execution event archive index integrity failure');
    indexKey=`${indexInfo.dev}:${indexInfo.ino}:${indexInfo.size}:${indexInfo.mtimeNs}:${indexInfo.ctimeNs}`;
  }else if(names.length)throw new Error('execution event archive index is missing');
  const files=[];
  for(const file of [...names.map(name=>path.join(dir,name)),eventFile(root)]){
    const info=await lstat(file,{bigint:true}).catch(error=>{if(error.code==='ENOENT'&&file===eventFile(root))return null;throw error});
    if(!info)continue;
    if(!info.isFile()||info.isSymbolicLink())throw new Error('execution event store is symbolic or not a regular file');
    files.push({file,size:Number(info.size),key:`${indexKey}:${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`});
  }
  return files;
}
async function readExecutionEventsUnlocked(root:string):Promise<ExecutionEvent[]>{
  const files=await eventFiles(root),key=files.map(item=>item.key).join('|'),cached=eventCache.get(root);
  if(cached?.key===key)return structuredClone(cached.events);
  const events:ExecutionEvent[]=[];let open=new Map<string,ExecutionEvent>(),seen=new Set<string>();
  for(const {file} of files){
    const offset=events.length,decoder=new StringDecoder('utf8'),hash=createHash('sha256');let pending='',lineNumber=0;
    const parse=(line:string)=>{if(Buffer.byteLength(line)>65_536)throw new Error('execution event line exceeds bounded reader');if(line.trim())events.push(executionEventSchema.parse(parseLine(line,++lineNumber)));};
    for await(const chunk of createReadStream(file,{highWaterMark:65_536})){
      hash.update(chunk);pending+=decoder.write(chunk as Buffer);let end;
      while((end=pending.indexOf('\n'))!==-1){parse(pending.slice(0,end));pending=pending.slice(end+1);}
      if(Buffer.byteLength(pending)>65_536)throw new Error('execution event line exceeds bounded reader');
    }
    pending+=decoder.end();if(pending)parse(pending);
    const match=path.basename(file).match(segmentPattern);
    if(match&&(Number(match[1])!==offset+1||Number(match[2])!==events.length||match[3]!==hash.digest('hex')))throw new Error('execution event archive integrity failure');
    ({open,seen}=validateEventSequence(events,offset,open,seen));
  }
  if(files.some(item=>item.file!==eventFile(root))){const index=JSON.parse(await readFile(archiveIndex(root),'utf8'));if(events[index.last_sequence-1]?.event_hash!==index.last_event_hash)throw new Error('execution event archive chain integrity failure');}
  eventCache.delete(root);
  if(files.reduce((sum,item)=>sum+item.size,0)<=SEGMENT_BYTES&&(await eventFiles(root)).map(item=>item.key).join('|')===key){eventCache.set(root,{key,events});while(eventCache.size>4)eventCache.delete(eventCache.keys().next().value!);}
  return structuredClone(events);
}
export async function readExecutionEvents(root:string):Promise<ExecutionEvent[]>{return withEventLock(root,()=>readExecutionEventsUnlocked(root));}
async function writeEventHistory(root:string,events:ExecutionEvent[],forceArchive=false){
  const files=await eventFiles(root),lastArchive=files.filter(item=>item.file!==eventFile(root)).at(-1),lastSequence=lastArchive?Number(path.basename(lastArchive.file).match(segmentPattern)![2]):0;
  const pending=events.filter(event=>event.sequence>lastSequence),writes:Array<{file:string;content:string}>=[];
  let content='',bytes=0,first=0,last=0;
  const archive=()=>{if(!content)return;const name=`${String(first).padStart(12,'0')}-${String(last).padStart(12,'0')}-${sha256(content)}.jsonl`;writes.push({file:path.join(archiveDir(root),name),content});content='';bytes=0;first=0;};
  for(const event of pending){const line=JSON.stringify(event)+'\n';if(content&&bytes+Buffer.byteLength(line)>SEGMENT_BYTES)archive();if(!first)first=event.sequence;last=event.sequence;content+=line;bytes+=Buffer.byteLength(line);}
  if(forceArchive)archive();
  const newSegments=writes.map(item=>path.basename(item.file));
  if(newSegments.length){const segments=[...files.filter(item=>item.file!==eventFile(root)).map(item=>path.basename(item.file)),...newSegments],end=Number(segments.at(-1)!.match(segmentPattern)![2]);writes.push({file:archiveIndex(root),content:JSON.stringify({schema_version:1,segments,last_sequence:end,last_event_hash:events[end-1].event_hash})+'\n'});}
  writes.push({file:eventFile(root),content});await atomicWriteMany(root,writes);eventCache.delete(root);
}
export async function archiveExecutionEvents(root:string){return withEventLock(root,async()=>{await recoverTransactions(root);const events=await readExecutionEventsUnlocked(root);await writeEventHistory(root,events,true);return{schema_version:1,event_count:events.length,last_event_hash:events.at(-1)?.event_hash??null,segments:(await eventFiles(root)).filter(item=>item.file!==eventFile(root)).length,history_preserved:true};});}

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
    await recoverTransactions(projectRoot);
    const id = await projectId(projectRoot), existing = await readExecutionEventsUnlocked(projectRoot), additions: ExecutionEvent[] = [];
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
    await writeEventHistory(projectRoot,events);
    return event;
  });
}

export async function startExecutionStep(projectRoot: string, input: EventInput & { wait?: boolean }): Promise<ExecutionEvent> {
  assertNoSecrets(`${input.taskId}\n${input.runId??''}\n${input.label}\n${input.summary}\n${(input.refs ?? []).join('\n')}`, 'execution step');
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
  const existing=(await readExecutionEvents(projectRoot)).find((event)=>event.step_run_id===start.step_run_id&&['step_succeeded','step_failed','step_interrupted','wait_ended'].includes(event.kind));
  if(existing){if(existing.outcome==='cancelled')return existing;throw new Error('execution step already has a terminal event')}
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

export async function cancelTaskExecution(projectRoot: string, input: {
  taskId: string; round: number; runId?: string | null; summary?: string; refs?: string[]; occurredAt?: Date;
}): Promise<{ cancellation: ExecutionEvent; closed: ExecutionEvent[]; alreadyCancelled: boolean }> {
  assertNoSecrets(`${input.summary ?? ''}\n${(input.refs ?? []).join('\n')}`, 'execution cancellation');
  return withEventLock(projectRoot, async () => {
    await recoverTransactions(projectRoot);
    const id = await projectId(projectRoot), existing = await readExecutionEventsUnlocked(projectRoot);
    const prior = existing.find((event) => event.kind === 'annotation' && event.task_id === input.taskId && event.label === 'Task 已取消');
    if (prior) return { cancellation: prior, closed: [], alreadyCancelled: true };
    const additions:ExecutionEvent[] = [];
    let previous = existing.at(-1)?.event_hash ?? null, sequence = existing.length + 1;
    if (!existing.length) {
      const baseline = createEvent({
        step_run_id: null, project_id: id, task_id: null, round: null, run_id: null, owner_pid: null, kind: 'annotation', step_type: null,
        label: 'Observability baseline', summary: 'Execution timing starts at this project event baseline; earlier facts retain their original precision.',
        occurred_at: (input.occurredAt ?? new Date()).toISOString(), outcome: null, refs: [],
      }, sequence++, previous);
      additions.push(baseline); previous = baseline.event_hash;
    }
    const occurredAt = (input.occurredAt ?? new Date()).toISOString();
    const cancellation = createEvent({
      step_run_id: null, project_id: id, task_id: input.taskId, round: input.round, run_id: null, owner_pid: null,
      kind: 'annotation', step_type: null, label: 'Task 已取消', summary: input.summary ?? 'Controller 已请求停止 Task，并冻结运行时间。',
      occurred_at: occurredAt, outcome: null, refs: input.refs ?? [],
    }, sequence++, previous);
    additions.push(cancellation); previous = cancellation.event_hash;
    const terminals = new Set(existing.filter((event) => ['step_succeeded','step_failed','step_interrupted','wait_ended'].includes(event.kind)).map((event) => event.step_run_id));
    const starts = existing.filter((event) => (event.kind === 'step_started' || event.kind === 'wait_started') && event.task_id === input.taskId && !terminals.has(event.step_run_id));
    const closed:ExecutionEvent[] = [];
    for (const start of starts) {
      const terminal = createEvent({
        step_run_id:start.step_run_id,project_id:id,task_id:start.task_id,round:start.round,run_id:start.run_id,owner_pid:start.owner_pid??null,
        kind:start.kind==='wait_started'?'wait_ended':'step_interrupted',step_type:start.step_type,label:start.label,
        summary:'Task 已取消；该步骤由停止闭环终止。',occurred_at:occurredAt,outcome:'cancelled',refs:start.refs,
      }, sequence++, previous);
      additions.push(terminal); closed.push(terminal); previous = terminal.event_hash;
    }
    const events=[...existing,...additions];validateEventSequence(events);
    await writeEventHistory(projectRoot,events);
    return { cancellation, closed, alreadyCancelled:false };
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

export type ConfirmationWaitKind='proposal'|'needs_user'|'verification'|'heavy_acceptance';
const waitLabels:Record<ConfirmationWaitKind,string>={proposal:'等待用户确认任务规格',needs_user:'等待用户提供结构化输入',verification:'等待正式验证授权',heavy_acceptance:'等待 Heavy 验收'};
async function hasEventProject(root:string){return exists(path.join(root,'.spec-loop','PROJECT.md'))}

export async function startConfirmationWait(root:string,input:{taskId:string;round:number;requestId:string;kind:ConfirmationWaitKind;occurredAt:Date}):Promise<ExecutionEvent|null>{
  if(!await hasEventProject(root))return null;
  const prior=(await readExecutionEvents(root)).find(event=>event.kind==='wait_started'&&event.run_id===input.requestId);
  if(prior)return prior;
  return startExecutionStep(root,{taskId:input.taskId,round:input.round,runId:input.requestId,stepType:'wait.user',wait:true,detached:true,label:waitLabels[input.kind],summary:`${waitLabels[input.kind]}；请求 ${input.requestId}`,refs:[input.requestId],occurredAt:input.occurredAt});
}

export async function finishConfirmationWait(root:string,input:{requestId:string;outcome:ExecutionOutcome;occurredAt:Date}):Promise<ExecutionEvent|null>{
  if(!await hasEventProject(root))return null;
  const events=await readExecutionEvents(root),start=events.find(event=>event.kind==='wait_started'&&event.run_id===input.requestId);
  if(!start)return null;
  const terminal=events.find(event=>event.step_run_id===start.step_run_id&&event.kind==='wait_ended');
  if(terminal)return terminal;
  return finishExecutionStep(root,start,{outcome:input.outcome,summary:`${start.label}：${input.outcome}`,occurredAt:input.occurredAt});
}
