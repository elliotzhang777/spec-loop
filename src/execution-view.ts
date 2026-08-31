import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertNoSecrets, exists, readMarkdown, sha256 } from './files.js';
import type { TaskState } from './model.js';
import { readExecutionEvents, type ExecutionEvent, type ExecutionStepType } from './execution-events.js';
import { readProject, scanTasks, selectActiveTask } from './project.js';
import { readState } from './task.js';

const precisionSchema = z.enum(['exact', 'derived', 'unknown']);
const stepStatusSchema = z.enum(['running', 'waiting', 'succeeded', 'failed', 'interrupted', 'noted', 'unknown']);
export const executionStepSnapshotSchema = z.object({
  id: z.string(), type: z.string(), round: z.number().int().nonnegative().nullable(), label: z.string(), summary: z.string(), status: stepStatusSchema,
  started_at: z.iso.datetime().nullable(), ended_at: z.iso.datetime().nullable(), duration_ms: z.number().int().nonnegative().nullable(),
  precision: precisionSchema, source: z.string(), outcome: z.string().nullable(), refs: z.array(z.string()), order: z.number(),
}).strict();
const durationBreakdownSchema = z.object({
  reproduce_ms: z.number().int().nonnegative(), analyze_ms: z.number().int().nonnegative(), change_ms: z.number().int().nonnegative(),
  test_ms: z.number().int().nonnegative(), wait_ms: z.number().int().nonnegative(), other_ms: z.number().int().nonnegative(),
  unattributed_ms: z.number().int().nonnegative(),
}).strict();
export const executionTaskSnapshotSchema = z.object({
  task_id: z.string(), title: z.string(), level: z.string(), status: z.string(), round: z.number().int().nonnegative(),
  depends_on: z.array(z.string()), blocked_by: z.array(z.string()), managed: z.boolean(),
  updated_at: z.iso.datetime(), current: z.boolean(), wall_clock_ms: z.number().int().nonnegative().nullable(),
  active_ms: z.number().int().nonnegative(), waiting_ms: z.number().int().nonnegative(), untracked_ms: z.number().int().nonnegative().nullable(),
  round_work_ms: z.number().int().nonnegative(), round_detail_ms: z.number().int().nonnegative(),
  round_waiting_ms: z.number().int().nonnegative(), round_unattributed_ms: z.number().int().nonnegative(),
  recording_coverage_pct: z.number().min(0).max(100).nullable(), detail_coverage_pct: z.number().min(0).max(100).nullable(),
  retry_count: z.number().int().nonnegative(), duration_breakdown: durationBreakdownSchema,
  timing_precision: precisionSchema, bottleneck_step_id: z.string().nullable(), steps: z.array(executionStepSnapshotSchema), diagnostics: z.array(z.string()),
}).strict();
export const executionWaveSnapshotSchema = z.object({
  wave_id: z.string().regex(/^[A-Z][A-Z0-9-]*$/), title: z.string(), status: z.string(), declared_status: z.string(), feature_id: z.string().nullable(),
  summary: z.string(), task_ids: z.array(z.string()), heavy_task_ids: z.array(z.string()),
  task_total: z.number().int().nonnegative(), completed_tasks: z.number().int().nonnegative(), unfinished_task_ids: z.array(z.string()),
  managed_tasks: z.number().int().nonnegative(), timed_tasks: z.number().int().nonnegative(),
  task_wall_clock_ms: z.number().int().nonnegative().nullable(), active_ms: z.number().int().nonnegative(), waiting_ms: z.number().int().nonnegative(),
}).strict();
export const executionSnapshotSchema = z.object({
  schema_version: z.literal(1), revision: z.string().length(64), generated_at: z.iso.datetime(),
  project: z.object({ project_id: z.string(), name: z.string() }).strict(),
  active_task: z.object({
    task_id: z.string(), title: z.string(), round: z.number().int().nonnegative(), lifecycle: z.string(),
    blocked_by: z.array(z.string()),
    step_id: z.string().nullable(), step_label: z.string().nullable(), step_summary: z.string().nullable(),
    step_status: stepStatusSchema.nullable(), step_started_at: z.iso.datetime().nullable(), current_elapsed_ms: z.number().int().nonnegative().nullable(),
    next_action: z.string(),
  }).strict().nullable(),
  waves: z.array(executionWaveSnapshotSchema), tasks: z.array(executionTaskSnapshotSchema), diagnostics: z.array(z.string()),
}).strict();

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export type ExecutionTaskSnapshot = z.infer<typeof executionTaskSnapshotSchema>;
export type ExecutionStepSnapshot = z.infer<typeof executionStepSnapshotSchema>;
export type ExecutionWaveSnapshot = z.infer<typeof executionWaveSnapshotSchema>;

type Interval = { start: number; end: number };

const labels: Record<string, string> = {
  plan: '规格与计划', round: '本轮实现', 'verify-pass': '验证通过', 'verify-fail': '验证失败', deliver: '交付关闭',
  init: '初始化 Task', 'pause-by-user-decision': '用户暂停', 'resume-paused-task-with-user-decision': '用户恢复',
  'resume-with-user-decision': '按用户输入恢复',
};

function union(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((item) => item.end >= item.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const item of sorted) {
    const tail = merged.at(-1);
    if (!tail || item.start > tail.end) merged.push({ ...item });
    else tail.end = Math.max(tail.end, item.end);
  }
  return merged;
}

function measure(intervals: Interval[]): number {
  return union(intervals).reduce((total, item) => total + item.end - item.start, 0);
}

function overlap(left: Interval[], right: Interval[]): number {
  const a = union(left), b = union(right); let i = 0, j = 0, total = 0;
  while (i < a.length && j < b.length) {
    total += Math.max(0, Math.min(a[i].end, b[j].end) - Math.max(a[i].start, b[j].start));
    if (a[i].end < b[j].end) i += 1; else j += 1;
  }
  return total;
}

function intersection(left: Interval[], right: Interval[]): Interval[] {
  const a = union(left), b = union(right), result: Interval[] = []; let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start), end = Math.min(a[i].end, b[j].end);
    if (end > start) result.push({ start, end });
    if (a[i].end < b[j].end) i += 1; else j += 1;
  }
  return result;
}

function eventStatus(start: ExecutionEvent, end: ExecutionEvent | undefined): ExecutionStepSnapshot['status'] {
  if (!end) {
    try { if (start.owner_pid) process.kill(start.owner_pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'interrupted'; }
    return start.kind === 'wait_started' ? 'waiting' : 'running';
  }
  if (end.kind === 'step_succeeded' || end.kind === 'wait_ended') return 'succeeded';
  if (end.kind === 'step_failed') return 'failed';
  return 'interrupted';
}

function eventSteps(events: ExecutionEvent[], now: number, currentRound: number): ExecutionStepSnapshot[] {
  const terminals = new Map(events.filter((item) =>
    ['step_succeeded', 'step_failed', 'step_interrupted', 'wait_ended'].includes(item.kind)).map((item) => [item.step_run_id, item]));
  const result: ExecutionStepSnapshot[] = [];
  for (const event of events) {
    if (event.kind === 'annotation') {
      if (!event.task_id) continue;
      result.push({
        id: `event-${event.sequence}`, type: 'annotation', round: event.round, label: event.label, summary: event.summary, status: 'noted',
        started_at: event.occurred_at, ended_at: event.occurred_at, duration_ms: 0, precision: 'exact',
        source: 'EXECUTION_EVENTS.jsonl', outcome: null, refs: event.refs, order: event.sequence,
      });
      continue;
    }
    if (event.kind !== 'step_started' && event.kind !== 'wait_started') continue;
    const end = terminals.get(event.step_run_id);
    const superseding = !end && event.round !== null && event.round < currentRound
      ? events.find((candidate) => candidate.sequence > event.sequence && candidate.round !== null && candidate.round > event.round!)
      : undefined;
    const status = superseding ? 'interrupted' : eventStatus(event, end), orphaned = !end && !superseding && status === 'interrupted';
    const startTime = Date.parse(event.occurred_at), endedAt = end?.occurred_at ?? superseding?.occurred_at ?? null;
    const endTime = endedAt ? Date.parse(endedAt) : now;
    result.push({
      id: event.step_run_id as string, type: event.step_type as string, round: event.round, label: event.label,
      summary: end?.summary ?? (superseding ? `${event.summary}；进入后续 Round 时自动截断`
        : orphaned ? `${event.summary}；执行进程已退出，等待 reconcile` : event.summary), status,
      started_at: event.occurred_at, ended_at: endedAt, duration_ms: orphaned ? null : Math.max(0, endTime - startTime),
      precision: superseding || orphaned || end?.kind === 'step_interrupted' ? 'derived' : 'exact', source: 'EXECUTION_EVENTS.jsonl',
      outcome: end?.outcome ?? (superseding || orphaned ? 'interrupted' : null),
      refs: [...new Set([...event.refs, ...(end?.refs ?? [])])], order: event.sequence,
    });
  }
  return result;
}

const legacyGateSchema = z.object({
  id: z.string(), kind: z.enum(['command', 'playwright']).default('command'), duration_ms: z.number().int().nonnegative(),
  created_at: z.iso.datetime(), exit_code: z.number().int(), timed_out: z.boolean(), artifact: z.string(), sha256: z.string().length(64),
}).passthrough();

function safeDisplayRef(value: string): boolean {
  return !path.isAbsolute(value) && !value.includes('\\') && !value.includes('\0')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

async function legacyGateSteps(projectRoot: string, taskId: string, round: number, existing: ExecutionStepSnapshot[]): Promise<ExecutionStepSnapshot[]> {
  const file = path.join(projectRoot, '.spec-loop', 'output', `${taskId}-gates.json`), info = await lstat(file).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${taskId}: Gate result path is invalid`);
  const gates = z.array(legacyGateSchema).parse(JSON.parse(await readFile(file, 'utf8'))), result: ExecutionStepSnapshot[] = [];
  for (let index = 0; index < gates.length; index += 1) {
    const gate = gates[index], label = `Gate ${gate.id}`;
    if (!safeDisplayRef(gate.artifact)) throw new Error(`${taskId}: Gate artifact reference is unsafe`);
    if (existing.some((item) => item.label === label && item.type.startsWith('gate.'))) continue;
    const started = Date.parse(gate.created_at), ended = started + gate.duration_ms;
    result.push({
      id: `legacy-gate-${gate.id}`, type: `gate.${gate.kind}`, round, label,
      summary: gate.timed_out ? 'Gate 超时' : gate.exit_code === 0 ? '确定性 Gate 通过' : `Gate 退出码 ${gate.exit_code}`,
      status: gate.timed_out ? 'interrupted' : gate.exit_code === 0 ? 'succeeded' : 'failed',
      started_at: new Date(started).toISOString(), ended_at: new Date(ended).toISOString(), duration_ms: gate.duration_ms,
      precision: 'exact', source: `${taskId}-gates.json`, outcome: gate.exit_code === 0 && !gate.timed_out ? 'success' : 'failure',
      refs: [gate.artifact], order: 100_000 + index,
    });
  }
  return result;
}

const legacyAttemptSchema = z.object({
  attempt: z.number().int().positive(), round: z.number().int().positive(), timestamp: z.iso.datetime(), action: z.string(),
  outcome: z.enum(['success', 'failure', 'no_progress']), error_fingerprint: z.string().nullable(),
}).passthrough();

async function legacyAttemptSteps(taskRoot: string, hasEvents: boolean): Promise<ExecutionStepSnapshot[]> {
  const file = path.join(taskRoot, 'LOOP_LEDGER.jsonl'); if (!(await exists(file))) return [];
  const raw = await readFile(file, 'utf8'), attempts = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => legacyAttemptSchema.parse(JSON.parse(line)));
  return attempts.map((attempt) => {
    assertNoSecrets(attempt.action, `legacy Attempt ${attempt.attempt}`);
    return ({
    id: `attempt-${attempt.attempt}`, type: 'task.attempt', round: attempt.round, label: `Attempt ${attempt.attempt}`,
    summary: attempt.action, status: attempt.outcome === 'success' ? 'succeeded' : attempt.outcome === 'failure' ? 'failed' : 'interrupted',
    started_at: attempt.timestamp, ended_at: null, duration_ms: null, precision: 'unknown' as const,
    source: 'LOOP_LEDGER.jsonl', outcome: attempt.outcome, refs: [], order: (hasEvents ? 200_000 : 10_000) + attempt.attempt,
    });
  });
}

async function legacyStateSteps(taskRoot: string, hasEvents: boolean): Promise<ExecutionStepSnapshot[]> {
  if (hasEvents) return [];
  const file = path.join(taskRoot, 'STATE_HISTORY.jsonl'), raw = await readFile(file, 'utf8');
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
    const value = z.object({ state_version: z.number(), status: z.string(), round: z.number(), command: z.string() }).passthrough().parse(JSON.parse(line));
    return {
      id: `state-${value.state_version}`, type: 'task.lifecycle', round: value.round, label: labels[value.command] ?? value.command,
      summary: `生命周期进入 ${value.status}，Round ${value.round}`, status: value.status === 'delivered' ? 'succeeded' as const : 'unknown' as const,
      started_at: null, ended_at: null, duration_ms: null, precision: 'unknown' as const,
      source: 'STATE_HISTORY.jsonl', outcome: null, refs: [], order: index,
    };
  });
}

function dependencyIds(content: string): string[] {
  const dependencyLine = content.match(/^- 依赖(?:工单|任务)?[：:]\s*(.+)$/m)?.[1];
  if (!dependencyLine || /^无(?:$|[，,。；;])/u.test(dependencyLine.trim())) return [];
  const expanded = dependencyLine.replace(/((?:WEB-)?TASK-)(\d+)[～~](\d+)/g, (_match, prefix, first, last) => {
    const start = Number(first), end = Number(last), width = first.length, values = [];
    for (let value = start; value <= end; value += 1) values.push(`${prefix}${String(value).padStart(width, '0')}`);
    return values.join('、');
  });
  return [...new Set(expanded.match(/(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*/g) ?? [])];
}

function allTaskIds(content: string): string[] {
  const expanded = content.replace(/((?:WEB-)?TASK-)(\d+)[～~](?:(?:WEB-)?TASK-)?(\d+)/g, (_match, prefix, first, last) => {
    const start = Number(first), end = Number(last), width = first.length, values = [];
    for (let value = start; value <= end; value += 1) values.push(`${prefix}${String(value).padStart(width, '0')}`);
    return values.join('、');
  });
  return [...new Set(expanded.match(/(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*/g) ?? [])];
}

async function taskDependencies(projectRoot: string, taskRoot: string): Promise<string[]> {
  const spec = await readMarkdown(path.join(taskRoot, 'SPEC.md'));
  const targetSpec = z.object({ target_spec: z.string().optional() }).passthrough().parse(spec.data).target_spec;
  if (!targetSpec) return [];
  const root = path.resolve(projectRoot), target = path.resolve(root, targetSpec);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('target spec path escapes the project');
  const info = await lstat(target).catch(() => null);
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('target spec path is invalid');
  return dependencyIds(await readFile(target, 'utf8'));
}

function targetStatus(content: string): string {
  const value = content.match(/^- 状态[：:]\s*(.+)$/m)?.[1]?.trim().split(/[，,；;]/u)[0]?.trim();
  return ({ 草稿: 'draft', 已批准: 'planned', 进行中: 'working', 待验证: 'verifying', 已完成: 'delivered', 已取消: 'cancelled' } as Record<string, string>)[value ?? ''] ?? 'draft';
}

async function targetSpecTasks(repositoryRoot: string, specRoot: string): Promise<ExecutionTaskSnapshot[]> {
  const repository = path.resolve(repositoryRoot), candidates = new Set([
    path.resolve(repository, specRoot, '04-task'), path.resolve(repository, specRoot, '05-task'),
    path.resolve(repository, 'backend/spec/05-task'), path.resolve(repository, 'frontend/spec/05-task'),
    path.resolve(repository, 'spec/04-task'), path.resolve(repository, 'spec/05-task'),
  ]), result: ExecutionTaskSnapshot[] = [];
  for (const directory of candidates) {
    if (directory !== repository && !directory.startsWith(`${repository}${path.sep}`)) continue;
    const directoryInfo = await lstat(directory).catch(() => null);
    if (!directoryInfo || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.md') || name.startsWith('_')) continue;
      const file = path.join(directory, name), info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) continue;
      const content = await readFile(file, 'utf8'), heading = content.match(/^# ((?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*)[：:]\s*(.+)$/m);
      if (!heading) continue;
      const updated = content.match(/^- 最后更新[：:]\s*(\d{4}-\d{2}-\d{2})$/m)?.[1];
      const levelValue = content.match(/^- 风险等级[：:]\s*(light|standard|heavy)$/mi)?.[1]?.toLowerCase();
      const level = levelValue ?? (/\bHeavy\b/i.test(heading[2]) ? 'heavy' : 'standard');
      result.push(executionTaskSnapshotSchema.parse({
        task_id: heading[1], title: heading[2].trim(), level, status: targetStatus(content), round: 0,
        depends_on: dependencyIds(content), blocked_by: [], managed: false, updated_at: updated ? `${updated}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z',
        current: false, wall_clock_ms: null, active_ms: 0, waiting_ms: 0, untracked_ms: null,
        round_work_ms: 0, round_detail_ms: 0, round_waiting_ms: 0, round_unattributed_ms: 0,
        recording_coverage_pct: null, detail_coverage_pct: null, retry_count: 0,
        duration_breakdown: { reproduce_ms: 0, analyze_ms: 0, change_ms: 0, test_ms: 0, wait_ms: 0, other_ms: 0, unattributed_ms: 0 },
        timing_precision: 'unknown', bottleneck_step_id: null, steps: [], diagnostics: [],
      }));
    }
  }
  return result;
}

async function projectWaves(repositoryRoot: string, specRoot: string, tasks: ExecutionTaskSnapshot[]): Promise<ExecutionWaveSnapshot[]> {
  const repository = path.resolve(repositoryRoot), backendSpec = path.resolve(repository, specRoot);
  if (backendSpec !== repository && !backendSpec.startsWith(`${repository}${path.sep}`)) throw new Error('spec root escapes the repository');
  const roadmapFile = path.join(backendSpec, 'roadmap.md'), waveFile = path.join(backendSpec, 'wave-task-status.md');
  const roadmap = await readFile(roadmapFile, 'utf8').catch(() => ''), waveStatus = await readFile(waveFile, 'utf8').catch(() => '');
  const roadmapRows = new Map<string, { title: string; status: string; summary: string; featureId: string | null }>();
  for (const line of roadmap.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const identity = cells[0]?.match(/^(H[1-9][0-9]*)\s+(.+)$/);
    if (!identity || cells.length < 5) continue;
    roadmapRows.set(identity[1], { title: identity[2], status: targetStatus(`- 状态：${cells[4]}`), summary: cells[2], featureId: cells[3].match(/FEAT-[0-9]{3}/)?.[0] ?? null });
  }
  const sections = new Map<string, string>();
  const headings = [...waveStatus.matchAll(/^## ([^\n]+)$/gm)];
  for (let index = 0; index < headings.length; index += 1) {
    const match = headings[index], waveHeading = match[1].match(/^(H[1-9][0-9]*)[：:](.+)$/);
    if (!waveHeading) continue;
    const start = (match.index ?? 0) + match[0].length, end = headings[index + 1]?.index ?? waveStatus.length;
    sections.set(waveHeading[1], `${waveHeading[2]}\n${waveStatus.slice(start, end)}`);
  }
  const byId = new Map(tasks.map((task) => [task.task_id, task])), waves: ExecutionWaveSnapshot[] = [];
  const declaredWaveNumbers = [...roadmapRows.keys(), ...sections.keys()]
    .map((waveId) => Number(waveId.slice(1)))
    .filter((number) => Number.isInteger(number) && number > 0);
  const lastWaveNumber = Math.max(15, ...declaredWaveNumbers);
  for (let number = 1; number <= lastWaveNumber; number += 1) {
    const waveId = `H${number}`, roadmapRow = roadmapRows.get(waveId), section = sections.get(waveId) ?? '';
    const tableRows = section.split(/\r?\n/).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
      .map((cells) => ({ taskId: cells[0]?.match(/(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*/)?.[0], type: cells[1] ?? '' }))
      .filter((row): row is { taskId: string; type: string } => Boolean(row.taskId));
    let taskIds = tableRows.map((row) => row.taskId);
    let featureId = section.match(/FEAT-[0-9]{3}/)?.[0] ?? roadmapRow?.featureId ?? null;
    if (!taskIds.length && featureId) {
      const featureDirectory = path.join(backendSpec, '02-feature'), names = await readdir(featureDirectory).catch(() => []);
      const featureName = names.find((name) => name.startsWith(`${featureId}-`) && name.endsWith('.md'));
      if (featureName) taskIds = allTaskIds(await readFile(path.join(featureDirectory, featureName), 'utf8'));
    }
    taskIds = [...new Set(taskIds)].filter((id) => byId.has(id));
    const declaredHeavy = new Set(tableRows.filter((row) => /Heavy/i.test(row.type)).map((row) => row.taskId));
    const heavyTaskIds = taskIds.filter((id) => (declaredHeavy.size ? declaredHeavy.has(id) : byId.get(id)?.level === 'heavy') && byId.get(id)?.status !== 'cancelled');
    const waveTasks = taskIds.map((id) => byId.get(id)).filter((task): task is ExecutionTaskSnapshot => Boolean(task));
    const timedTasks = waveTasks.filter((task) => task.wall_clock_ms !== null);
    const unfinishedTasks = waveTasks.filter((task) => !['delivered', 'cancelled'].includes(task.status));
    const declaredStatus = roadmapRow?.status ?? 'unknown';
    const effectiveStatus = waveTasks.length && !unfinishedTasks.length ? 'delivered'
      : unfinishedTasks.length && unfinishedTasks.every((task) => task.status === 'verifying') ? 'verifying'
      : unfinishedTasks.some((task) => ['working', 'verifying', 'iterating'].includes(task.status)) ? 'working'
      : unfinishedTasks.length ? 'planned' : declaredStatus;
    const sectionTitle = section.split('\n')[0]?.trim();
    waves.push(executionWaveSnapshotSchema.parse({
      wave_id: waveId, title: roadmapRow?.title ?? sectionTitle ?? waveId, status: effectiveStatus, declared_status: declaredStatus, feature_id: featureId,
      summary: roadmapRow?.summary ?? section.match(/阶段结论[：:]([^\n]+)/)?.[1]?.trim() ?? sectionTitle ?? '规格中未记录波次摘要',
      task_ids: taskIds, heavy_task_ids: heavyTaskIds, task_total: taskIds.length,
      completed_tasks: waveTasks.length - unfinishedTasks.length, unfinished_task_ids: unfinishedTasks.map((task) => task.task_id),
      managed_tasks: waveTasks.filter((task) => task.managed).length, timed_tasks: timedTasks.length,
      task_wall_clock_ms: timedTasks.length ? timedTasks.reduce((total, task) => total + (task.wall_clock_ms ?? 0), 0) : null,
      active_ms: waveTasks.reduce((total, task) => total + task.active_ms, 0),
      waiting_ms: waveTasks.reduce((total, task) => total + task.waiting_ms, 0),
    }));
  }
  const operationalWaveId = waveStatus.match(/^- Spec-Loop Wave ID[：:]\s*`?([A-Z][A-Z0-9-]+)`?\s*$/m)?.[1];
  if (operationalWaveId && !waves.some((wave) => wave.wave_id === operationalWaveId)) {
    const heading = waveStatus.match(/^#\s+([^\n]+)$/m)?.[1]?.trim() ?? operationalWaveId;
    const title = heading.replace(/^BATCH-[A-Z0-9-]+[：:]\s*/u, '').trim() || heading;
    const dependencyHeading = waveStatus.match(/^## 依赖图与执行波次\s*$/m);
    const dependencyStart = dependencyHeading ? (dependencyHeading.index ?? 0) + dependencyHeading[0].length : 0;
    const dependencyRemainder = waveStatus.slice(dependencyStart);
    const dependencyEnd = dependencyRemainder.search(/^## /m);
    const dependencySection = dependencyEnd >= 0 ? dependencyRemainder.slice(0, dependencyEnd) : dependencyRemainder;
    const taskIds = allTaskIds(dependencySection).filter((id) => byId.has(id));
    const uniqueTaskIds = [...new Set(taskIds)];
    const waveTasks = uniqueTaskIds.map((id) => byId.get(id)).filter((task): task is ExecutionTaskSnapshot => Boolean(task));
    const unfinishedTasks = waveTasks.filter((task) => !['delivered', 'cancelled'].includes(task.status));
    const timedTasks = waveTasks.filter((task) => task.wall_clock_ms !== null);
    const declaredStatus = targetStatus(waveStatus);
    const effectiveStatus = waveTasks.length && !unfinishedTasks.length ? 'delivered'
      : unfinishedTasks.some((task) => ['working', 'verifying', 'iterating'].includes(task.status)) ? 'working'
      : unfinishedTasks.length ? 'planned' : declaredStatus;
    const summary = waveStatus.match(/^## 批次目标\s*$\s*([^\n]+)/m)?.[1]?.trim() ?? '规格中未记录波次摘要';
    waves.push(executionWaveSnapshotSchema.parse({
      wave_id: operationalWaveId, title, status: effectiveStatus, declared_status: declaredStatus, feature_id: null, summary,
      task_ids: uniqueTaskIds, heavy_task_ids: waveTasks.filter((task) => task.level === 'heavy' && task.status !== 'cancelled').map((task) => task.task_id),
      task_total: waveTasks.length, completed_tasks: waveTasks.length - unfinishedTasks.length,
      unfinished_task_ids: unfinishedTasks.map((task) => task.task_id), managed_tasks: waveTasks.filter((task) => task.managed).length,
      timed_tasks: timedTasks.length, task_wall_clock_ms: timedTasks.length ? timedTasks.reduce((total, task) => total + (task.wall_clock_ms ?? 0), 0) : null,
      active_ms: waveTasks.reduce((total, task) => total + task.active_ms, 0), waiting_ms: waveTasks.reduce((total, task) => total + task.waiting_ms, 0),
    }));
  }
  return waves;
}

function stepIntervals(steps: ExecutionStepSnapshot[], now: number): { active: Interval[]; waiting: Interval[] } {
  const active: Interval[] = [], waiting: Interval[] = [];
  for (const step of steps) {
    if (!step.started_at || step.precision === 'unknown' || step.status === 'noted') continue;
    const interval = { start: Date.parse(step.started_at), end: step.ended_at ? Date.parse(step.ended_at) : now };
    // round.work is the lifetime envelope for a Round. It can remain open
    // across user idle time and must never be counted as continuous execution.
    if (step.type === 'wait.user' || step.status === 'waiting') waiting.push(interval);
    else if (step.type !== 'round.work') active.push(interval);
  }
  return { active, waiting };
}

type DurationBreakdown = z.infer<typeof durationBreakdownSchema>;

function breakdownCategory(step: ExecutionStepSnapshot): keyof DurationBreakdown | null {
  if (step.type === 'wait.user' || step.status === 'waiting') return 'wait_ms';
  if (step.type === 'work.reproduce') return 'reproduce_ms';
  if (step.type === 'work.analyze') return 'analyze_ms';
  if (step.type === 'work.change' || step.type === 'harness.execute') return 'change_ms';
  if (step.type.startsWith('gate.') || step.type === 'task.verify') return 'test_ms';
  if (['round.work', 'annotation', 'task.lifecycle', 'task.attempt'].includes(step.type)) return null;
  return 'other_ms';
}

function durationBreakdown(steps: ExecutionStepSnapshot[], wallStart: number | null, wallEnd: number | null, now: number): DurationBreakdown {
  const result: DurationBreakdown = {
    reproduce_ms: 0, analyze_ms: 0, change_ms: 0, test_ms: 0, wait_ms: 0, other_ms: 0, unattributed_ms: 0,
  };
  if (wallStart === null || wallEnd === null || wallEnd <= wallStart) return result;
  const classified = steps.flatMap((step) => {
    const category = breakdownCategory(step);
    if (!category || !step.started_at || step.precision === 'unknown' || step.status === 'noted') return [];
    const start = Math.max(wallStart, Date.parse(step.started_at));
    const end = Math.min(wallEnd, step.ended_at ? Date.parse(step.ended_at) : now);
    return end > start ? [{ start, end, category }] : [];
  });
  const boundaries = [...new Set([wallStart, wallEnd, ...classified.flatMap((item) => [item.start, item.end])])].sort((a, b) => a - b);
  const priority: Array<keyof DurationBreakdown> = ['wait_ms', 'test_ms', 'reproduce_ms', 'analyze_ms', 'change_ms', 'other_ms'];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index], end = boundaries[index + 1];
    const categories = new Set(classified.filter((item) => item.start < end && item.end > start).map((item) => item.category));
    const category = priority.find((candidate) => categories.has(candidate)) ?? 'unattributed_ms';
    result[category] += end - start;
  }
  return result;
}

function nextAction(state: TaskState, current?: ExecutionStepSnapshot): string {
  if (current?.type === 'harness.execute') return '收集 worktree 改动';
  if (current?.type === 'harness.collect') return '执行确定性 Gate';
  if (current?.type.startsWith('gate.')) return '生成 Harness Report';
  if (current?.type === 'wait.user') return '等待用户完成当前确认';
  return ({
    draft: '完善规格、计划和验收契约', planned: '开启 Round 并开始实现', working: '完成当前 Round 并验证',
    verifying: '映射 Evidence 并交付，或进入修复', iterating: '查看失败证据，决定修复或重构；不自动开启下一 Round', delivered: 'Task 已交付',
  } as Record<string, string>)[state.status] ?? '检查 Task 状态';
}

async function taskSnapshot(projectRoot: string, repositoryRoot: string, taskRoot: string, state: TaskState, taskEvents: ExecutionEvent[], current: boolean, now: number): Promise<ExecutionTaskSnapshot> {
  const fromEvents = eventSteps(taskEvents, now, state.current_round), diagnostics: string[] = [], dependsOn = await taskDependencies(repositoryRoot, taskRoot);
  const gates = await legacyGateSteps(projectRoot, state.task_id, state.current_round, fromEvents);
  const attempts = await legacyAttemptSteps(taskRoot, taskEvents.length > 0);
  const lifecycle = await legacyStateSteps(taskRoot, taskEvents.length > 0);
  const steps = [...fromEvents, ...gates, ...attempts, ...lifecycle].sort((left, right) => {
    const leftTime = left.started_at ? Date.parse(left.started_at) : Number.POSITIVE_INFINITY;
    const rightTime = right.started_at ? Date.parse(right.started_at) : Number.POSITIVE_INFINITY;
    return leftTime - rightTime || left.order - right.order;
  });
  if (!taskEvents.length) diagnostics.push('旧 Task 没有执行事件；仅已有 Gate 耗时为精确值，其余阶段可能未知。');
  const intervals = stepIntervals(steps, now), waitingMs = measure(intervals.waiting);
  const activeMs = Math.max(0, measure(intervals.active) - overlap(intervals.active, intervals.waiting));
  const roundIntervals = steps.filter((step) => step.type === 'round.work' && step.started_at && step.duration_ms !== null)
    .map((step) => ({ start: Date.parse(step.started_at as string), end: step.ended_at ? Date.parse(step.ended_at) : now }));
  const detailIntervals = steps.filter((step) => ['work.reproduce', 'work.analyze', 'work.change', 'harness.execute', 'harness.collect', 'harness.report', 'gate.command', 'gate.playwright'].includes(step.type)
    && step.started_at && step.duration_ms !== null)
    .map((step) => ({ start: Date.parse(step.started_at as string), end: step.ended_at ? Date.parse(step.ended_at) : now }));
  const roundWorkMs = measure(roundIntervals), roundDetailIntervals = intersection(roundIntervals, detailIntervals);
  const roundWaitingIntervals = intersection(roundIntervals, intervals.waiting), roundWaitingMs = measure(roundWaitingIntervals);
  const roundDetailMs = Math.max(0, measure(roundDetailIntervals) - overlap(roundDetailIntervals, roundWaitingIntervals));
  const roundUnattributedMs = Math.max(0, roundWorkMs - measure([...roundDetailIntervals, ...roundWaitingIntervals]));
  const taskEventTimes = taskEvents.filter((item) => item.task_id === state.task_id).map((item) => Date.parse(item.occurred_at));
  let wallClock: number | null = null, wallStart: number | null = null, wallEnd: number | null = null;
  let untracked: number | null = null, timing: 'exact' | 'derived' | 'unknown' = 'unknown';
  if (taskEventTimes.length) {
    const start = Math.min(...taskEventTimes), delivered = taskEvents.find((item) => item.label === '交付关闭' && item.kind === 'step_succeeded');
    const end = delivered ? Date.parse(delivered.occurred_at) : state.status === 'delivered' ? Date.parse(state.updated_at) : now;
    wallStart = start; wallEnd = Math.max(start, end); wallClock = wallEnd - wallStart;
    untracked = Math.max(0, wallClock - activeMs - waitingMs); timing = delivered || state.status !== 'delivered' ? 'exact' : 'derived';
  }
  const breakdown = durationBreakdown(steps, wallStart, wallEnd, now);
  const fineIntervals = steps.filter((step) => breakdownCategory(step) && breakdownCategory(step) !== 'wait_ms'
    && step.started_at && step.precision !== 'unknown' && step.status !== 'noted')
    .map((step) => ({ start: Date.parse(step.started_at as string), end: step.ended_at ? Date.parse(step.ended_at) : now }));
  const fineActiveMs = Math.max(0, measure(fineIntervals) - overlap(fineIntervals, intervals.waiting));
  const recordingCoverage = wallClock && untracked !== null ? Math.min(100, Math.max(0, (wallClock - untracked) / wallClock * 100)) : null;
  const detailCoverage = activeMs > 0 ? Math.min(100, Math.max(0, fineActiveMs / activeMs * 100)) : null;
  const retryCount = steps.filter((step) => ['failed', 'interrupted'].includes(step.status) && !['annotation', 'task.lifecycle'].includes(step.type)).length;
  const bottleneck = [...steps].filter((step) => step.duration_ms !== null && step.duration_ms > 0
    && step.type !== 'round.work' && step.type !== 'wait.user' && step.status !== 'noted')
    .sort((left, right) => (right.duration_ms as number) - (left.duration_ms as number))[0] ?? null;
  return executionTaskSnapshotSchema.parse({
    task_id: state.task_id, title: state.title, level: state.level, status: state.status, round: state.current_round, depends_on: dependsOn, blocked_by: [], managed: true,
    updated_at: state.updated_at, current, wall_clock_ms: wallClock, active_ms: activeMs, waiting_ms: waitingMs,
    untracked_ms: untracked, round_work_ms: roundWorkMs, round_detail_ms: roundDetailMs,
    round_waiting_ms: roundWaitingMs, round_unattributed_ms: roundUnattributedMs,
    recording_coverage_pct: recordingCoverage, detail_coverage_pct: detailCoverage, retry_count: retryCount, duration_breakdown: breakdown,
    timing_precision: timing, bottleneck_step_id: bottleneck?.id ?? null, steps, diagnostics,
  });
}

export async function buildExecutionSnapshot(projectRoot: string, now = new Date()): Promise<ExecutionSnapshot> {
  const project = await readProject(projectRoot), indexed = await scanTasks(projectRoot), events = await readExecutionEvents(projectRoot);
  const states = await Promise.all(indexed.map(async (task) => ({ task, state: await readState(task.path) })));
  const nowMs = now.getTime(), diagnostics: string[] = [];
  const managedTasks = await Promise.all(states.map(({ task, state }) => taskSnapshot(
    projectRoot, project.repository, task.path, state, events.filter((event) => event.task_id === state.task_id), false, nowMs,
  )));
  const managedIds = new Set(managedTasks.map((task) => task.task_id));
  const targetOnly = (await targetSpecTasks(project.repository, project.spec_root)).filter((task) => !managedIds.has(task.task_id));
  const rawTasks = [...managedTasks, ...targetOnly], taskStatus = new Map(rawTasks.map((task) => [task.task_id, task.status]));
  let tasks = rawTasks.map((task) => executionTaskSnapshotSchema.parse({
    ...task,
    blocked_by: task.depends_on.filter((dependency) => taskStatus.has(dependency) && !['delivered', 'cancelled'].includes(taskStatus.get(dependency) as string)),
  }));
  const blockedIds = new Set(tasks.filter((task) => task.blocked_by.length).map((task) => task.task_id));
  const active = selectActiveTask(states.filter(({ state }) => !blockedIds.has(state.task_id)));
  tasks = tasks.map((task) => executionTaskSnapshotSchema.parse({ ...task, current: active?.state.task_id === task.task_id }));
  const waves = await projectWaves(project.repository, project.spec_root, tasks);
  for (const wave of waves) {
    if (wave.declared_status === 'delivered' && wave.status !== 'delivered') diagnostics.push(`${wave.wave_id}: 路线图标记已完成，但 ${wave.unfinished_task_ids.join('、')} 尚未完成。`);
  }
  tasks.sort((left, right) => Number(right.current) - Number(left.current) || right.updated_at.localeCompare(left.updated_at));
  const activeSnapshot = active ? tasks.find((item) => item.task_id === active.state.task_id) ?? null : null;
  if (activeSnapshot && !waves.some((wave) => wave.task_ids.includes(activeSnapshot.task_id))) {
    diagnostics.unshift(`${activeSnapshot.task_id}: 当前活动 Task 未归属任何波次；请在 wave-task-status.md 或对应 Feature 规格中声明关联。`);
  }
  for (const task of tasks.filter((item) => item.blocked_by.length && ['working', 'verifying', 'iterating'].includes(item.status))) {
    diagnostics.unshift(`${task.task_id}: 控制状态为 ${task.status}，但前置 ${task.blocked_by.join('、')} 尚未完成；观察面按“等待依赖”显示。`);
  }
  const currentStep = activeSnapshot?.steps.filter((step) => (step.round ?? activeSnapshot.round) >= activeSnapshot.round
    && step.type !== 'round.work' && (step.status === 'running' || step.status === 'waiting'))
    .sort((left, right) => (right.started_at ?? '').localeCompare(left.started_at ?? ''))[0] ?? null;
  for (const task of tasks) diagnostics.push(...task.diagnostics.map((item) => `${task.task_id}: ${item}`));
  const revisionFacts = {
    projection_version: 2,
    project_id: project.project_id,
    states: states.map(({ state }) => ({ task_id: state.task_id, state_version: state.state_version, updated_at: state.updated_at })),
    event_tail: events.at(-1)?.event_hash ?? null,
    waves: waves.map((wave) => ({
      wave_id: wave.wave_id, title: wave.title, status: wave.status, declared_status: wave.declared_status,
      feature_id: wave.feature_id, summary: wave.summary, task_ids: wave.task_ids, heavy_task_ids: wave.heavy_task_ids,
      completed_tasks: wave.completed_tasks, unfinished_task_ids: wave.unfinished_task_ids,
    })),
    tasks: tasks.map((task) => ({ task_id: task.task_id, title: task.title, status: task.status, level: task.level, managed: task.managed,
      updated_at: task.updated_at, depends_on: task.depends_on, steps: task.steps.map((step) => ({ id: step.id, ended_at: step.ended_at, duration_ms: step.ended_at ? step.duration_ms : null, source: step.source })) })),
  };
  return executionSnapshotSchema.parse({
    schema_version: 1, revision: sha256(JSON.stringify(revisionFacts)), generated_at: now.toISOString(),
    project: { project_id: project.project_id, name: project.name },
    active_task: active && activeSnapshot ? {
      task_id: active.state.task_id, title: active.state.title, round: active.state.current_round, lifecycle: active.state.status,
      blocked_by: activeSnapshot.blocked_by,
      step_id: currentStep?.id ?? null, step_label: currentStep?.label ?? null, step_summary: currentStep?.summary ?? null,
      step_status: currentStep?.status ?? null, step_started_at: currentStep?.started_at ?? null,
      current_elapsed_ms: currentStep?.started_at ? Math.max(0, nowMs - Date.parse(currentStep.started_at)) : null,
      next_action: activeSnapshot.blocked_by.length
        ? `等待前置 ${activeSnapshot.blocked_by.join('、')} 完成；当前 Task 不应继续执行`
        : nextAction(active.state, currentStep ?? undefined),
    } : null,
    waves, tasks, diagnostics,
  });
}
