import { createHash } from 'node:crypto'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { buildExecutionSnapshot } from '../dist/execution-view.js'
import { scanTasks } from '../dist/project.js'

const roots = process.argv.slice(2).map(value => path.resolve(value))
if (!roots.length) throw new Error('pass at least one Project root')

const reports = []
for (const root of roots) {
  const now = new Date()
  const started = performance.now()
  const snapshot = await buildExecutionSnapshot(root, now, { audit: true })
  const coldMs = performance.now() - started
  const expected = await scanTasks(root)
  const second = await buildExecutionSnapshot(root, now, { audit: true })
  const managed = snapshot.tasks.filter(task => task.managed)
  const counts = { exact: 0, derived: 0, unknown: 0 }
  const steps = { exact: 0, derived: 0, unknown: 0 }
  for (const task of managed) {
    counts[task.timing_precision] += 1
    for (const step of task.steps) steps[step.precision] += 1
  }
  reports.push({
    project_root: root,
    project_id: snapshot.project.project_id,
    snapshot_revision: snapshot.revision,
    snapshot_sha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    cold_rebuild_ms: Math.round(coldMs),
    managed_tasks_expected: expected.length,
    managed_tasks_reconstructed: managed.length,
    rebuild_ratio: expected.length ? managed.length / expected.length : 1,
    task_timing_precision: counts,
    exact_task_timing_coverage: managed.length ? counts.exact / managed.length : 1,
    visible_step_precision: steps,
    unknown_timing_tasks: managed.filter(task => task.timing_precision === 'unknown')
      .map(task => ({ task_id: task.task_id, unknown_steps: task.steps.filter(step => step.precision === 'unknown').length })),
    unattributed_intervals: managed.filter(task => task.untracked_ms !== null && task.untracked_ms > 0)
      .map(task => ({ task_id: task.task_id, untracked_ms: task.untracked_ms })),
    diagnostics: snapshot.diagnostics,
    deterministic_rebuild_at_fixed_time: JSON.stringify(snapshot) === JSON.stringify(second),
  })
}

console.log(JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), projects: reports }, null, 2))
