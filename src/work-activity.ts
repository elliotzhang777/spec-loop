import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { assertNoSecrets } from './files.js';
import {
  finishExecutionStep, managedProjectRootForTask, readExecutionEvents, startExecutionStep,
  type ExecutionEvent, type ExecutionOutcome, type ExecutionStepType,
} from './execution-events.js';
import { readState } from './task.js';

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
  kind: 'command' | 'playwright'; label: string; summary: string; executable: string; args: string[]; refs?: string[];
}): Promise<{ step: ExecutionEvent; exitCode: number; signal: NodeJS.Signals | null; error: string | null }> {
  const current = await context(taskRoot), stepType = activityTypes[input.kind];
  assertNoSecrets(`${input.label}\n${input.summary}\n${(input.refs ?? []).join('\n')}`, 'work command');
  const started = await startExecutionStep(current.projectRoot, {
    taskId: current.taskId, round: current.round, stepType, label: input.label,
    summary: input.summary, refs: input.refs,
  });
  const result = spawnSync(input.executable, input.args, { cwd: current.repository, stdio: 'inherit', env: process.env });
  const exitCode = result.status ?? 1, signal = result.signal, error = result.error?.message ?? null;
  const outcome: ExecutionOutcome = exitCode === 0 && !signal && !error ? 'success' : signal ? 'interrupted' : 'failure';
  const detail = error ? `启动失败：${error}` : signal ? `被信号 ${signal} 中断` : `退出码 ${exitCode}`;
  const step = await finishExecutionStep(current.projectRoot, started, {
    outcome, summary: `${input.summary}；${detail}`, refs: input.refs,
  });
  return { step, exitCode, signal, error };
}
