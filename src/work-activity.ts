import { z } from 'zod';
import { assertNoSecrets } from './files.js';
import {
  finishExecutionStep, managedProjectRootForTask, readExecutionEvents, startExecutionStep,
  type ExecutionEvent, type ExecutionOutcome, type ExecutionStepType,
} from './execution-events.js';
import { readState } from './task.js';
import { runManagedProcess } from './managed-process.js';

export const workActivityKindSchema = z.enum(['reproduce', 'analyze', 'change', 'command', 'playwright']);
export type WorkActivityKind = z.infer<typeof workActivityKindSchema>;

const activityTypes: Record<WorkActivityKind, ExecutionStepType> = {
  reproduce: 'work.reproduce', analyze: 'work.analyze', change: 'work.change',
  command: 'gate.command', playwright: 'gate.playwright',
};

async function context(taskRoot: string): Promise<{ projectRoot: string; taskId: string; round: number; repository: string }> {
  const state = await readState(taskRoot), projectRoot = managedProjectRootForTask(taskRoot);
  if (!projectRoot) throw new Error('work activity requires a managed Project Task');
  if (state.status !== 'working') throw new Error(`work activity requires a working Task, got ${state.status}`);
  return { projectRoot, taskId: state.task_id, round: state.current_round, repository: state.repository };
}

export async function startWorkActivity(taskRoot: string, input: {
  kind: WorkActivityKind; label: string; summary: string; refs?: string[];
}): Promise<ExecutionEvent> {
  const current = await context(taskRoot), stepType = activityTypes[input.kind];
  assertNoSecrets(`${input.label}\n${input.summary}\n${(input.refs ?? []).join('\n')}`, 'work activity');
  return startExecutionStep(current.projectRoot, {
    taskId: current.taskId, round: current.round, stepType, label: input.label,
    summary: input.summary, refs: input.refs, detached: true,
  });
}

export async function finishWorkActivity(taskRoot: string, stepRunId: string, input: {
  outcome: ExecutionOutcome; summary?: string; refs?: string[];
}): Promise<ExecutionEvent> {
  const current = await context(taskRoot), events = await readExecutionEvents(current.projectRoot);
  const start = events.find((event) => event.step_run_id === stepRunId && event.task_id === current.taskId
    && event.round === current.round && (event.kind === 'step_started' || event.kind === 'wait_started'));
  if (!start) throw new Error('work activity start event was not found in the current Task/Round');
  if (!start.step_type || !['work.reproduce', 'work.analyze', 'work.change'].includes(start.step_type)) throw new Error('step is not a manually managed work activity');
  if (events.some((event) => event.step_run_id === stepRunId
    && ['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended'].includes(event.kind))) throw new Error('work activity is already closed');
  return finishExecutionStep(current.projectRoot, start, input);
}

export async function runWorkCommand(taskRoot: string, input: {
  kind: 'command' | 'playwright'; label: string; summary: string; executable: string; args: string[]; refs?: string[];timeoutMs?:number;
}): Promise<{ step: ExecutionEvent; exitCode: number; signal: NodeJS.Signals | null; error: string | null;timedOut:boolean;terminationVerified:boolean;pipeDrainTimedOut:boolean }> {
  const current = await context(taskRoot), stepType = activityTypes[input.kind];
  const timeoutMs=input.timeoutMs??300_000;if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>3_600_000)throw new Error('work command timeout must be 1–3600000ms');
  assertNoSecrets(`${input.label}\n${input.summary}\n${(input.refs ?? []).join('\n')}`, 'work command');
  const started = await startExecutionStep(current.projectRoot, {
    taskId: current.taskId, round: current.round, stepType, label: input.label,
    summary: input.summary, refs: input.refs,
  });
  const result = await runManagedProcess({bin:input.executable,args:input.args,cwd:current.repository,env:process.env,timeoutMs,pipeDrainTimeoutMs:1_000,onStdout:chunk=>process.stdout.write(chunk),onStderr:chunk=>process.stderr.write(chunk)});
  const exitCode = result.code, signal = result.signal, error = result.code===127?(result.stderr.trim()||'命令无法启动'):result.termination_verified?null:'进程终止无法确认';
  const outcome: ExecutionOutcome = exitCode === 0 && !signal && !error ? 'success' : result.timedOut?'failure':signal ? 'interrupted' : 'failure';
  const detail = result.timedOut?`超时（${timeoutMs}ms，终止确认=${result.termination_verified}，管道排空超时=${result.pipe_drain_timed_out}）`:error ? `启动失败：${error}` : signal ? `被信号 ${signal} 中断` : `退出码 ${exitCode}`;
  const step = await finishExecutionStep(current.projectRoot, started, {
    outcome, summary: `${input.summary}；${detail}`, refs: input.refs,
  });
  return { step, exitCode, signal, error,timedOut:result.timedOut,terminationVerified:result.termination_verified,pipeDrainTimedOut:result.pipe_drain_timed_out };
}
