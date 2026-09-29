import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { initProject, scanTasks } from '../dist/project.js'
import { initTask, readState } from '../dist/task.js'
import { buildExecutionSnapshot } from '../dist/execution-view.js'
import { readExecutionEvents } from '../dist/execution-events.js'
import { startExecutionViewServer, closeExecutionViewServer } from '../dist/execution-view-server.js'

const taskCount = 200
const eventsPerTask = 200
const root = await mkdtemp(path.join(os.tmpdir(), 'spec-loop-view-benchmark-'))
const repository = path.join(root, 'repo')
let sequence = 0
let previousHash = null
let server = null

function event(facts) {
  const canonical = {
    schema_version: 1,
    sequence: ++sequence,
    event_id: randomUUID(),
    step_run_id: facts.step_run_id,
    project_id: facts.project_id,
    task_id: facts.task_id,
    round: facts.round,
    run_id: facts.run_id,
    owner_pid: facts.owner_pid,
    kind: facts.kind,
    step_type: facts.step_type,
    label: facts.label,
    summary: facts.summary,
    occurred_at: facts.occurred_at,
    outcome: facts.outcome,
    refs: facts.refs,
    previous_hash: previousHash,
  }
  const eventHash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  previousHash = eventHash
  return JSON.stringify({ ...canonical, event_hash: eventHash }) + '\n'
}

try {
  await mkdir(repository)
  await initProject(root, {
    id: 'PROJ-VIEW-BENCH', name: 'Execution View benchmark', repository,
    branch: 'main', risk: 'standard',
  })
  for (let index = 1; index <= taskCount; index += 1) {
    const id = `TASK-BENCH-${String(index).padStart(3, '0')}`
    await initTask(path.join(root, '.spec-loop', 'tasks', id.toLowerCase()), {
      id, title: `Benchmark task ${index}`, level: 'standard', repository,
    })
  }

  const lines = []
  for (let taskIndex = 1; taskIndex <= taskCount; taskIndex += 1) {
    const taskId = `TASK-BENCH-${String(taskIndex).padStart(3, '0')}`
    for (let stepIndex = 0; stepIndex < eventsPerTask / 2; stepIndex += 1) {
      const stepId = randomUUID()
      const base = Date.UTC(2026, 8, 1) + taskIndex * 1_000_000 + stepIndex * 2_000
      const common = {
        step_run_id: stepId, project_id: 'PROJ-VIEW-BENCH', task_id: taskId,
        round: 1, run_id: null, owner_pid: null, step_type: 'gate.command',
        label: 'Benchmark gate', summary: 'Fixed scale projection benchmark', refs: [],
      }
      lines.push(event({ ...common, kind: 'step_started', occurred_at: new Date(base).toISOString(), outcome: null }))
      lines.push(event({ ...common, kind: 'step_succeeded', occurred_at: new Date(base + 500).toISOString(), outcome: 'success' }))
    }
  }
  const eventFile = path.join(root, '.spec-loop', 'EXECUTION_EVENTS.jsonl')
  const archiveDir = path.join(root, '.spec-loop', 'execution-event-archive')
  const archiveSegments = []
  let segmentLines = [], segmentBytes = 0, firstSequence = 1
  for (let index = 0; index < lines.length; index += 1) {
    const lineBytes = Buffer.byteLength(lines[index])
    if (segmentLines.length && segmentBytes + lineBytes > 8 * 1024 * 1024) {
      archiveSegments.push({ first: firstSequence, last: index, content: segmentLines.join('') })
      firstSequence = index + 1
      segmentLines = []
      segmentBytes = 0
    }
    segmentLines.push(lines[index])
    segmentBytes += lineBytes
  }
  await mkdir(archiveDir)
  const archiveNames = []
  for (const segment of archiveSegments) {
    const digest = createHash('sha256').update(segment.content).digest('hex')
    const name = `${String(segment.first).padStart(12, '0')}-${String(segment.last).padStart(12, '0')}-${digest}.jsonl`
    archiveNames.push(name)
    await writeFile(path.join(archiveDir, name), segment.content)
  }
  if (archiveSegments.length) {
    const lastArchived = archiveSegments.at(-1).content.trimEnd().split('\n').at(-1)
    await writeFile(path.join(root, '.spec-loop', 'EXECUTION_EVENT_ARCHIVE.json'), JSON.stringify({
      schema_version: 1, segments: archiveNames, last_sequence: archiveSegments.at(-1).last,
      last_event_hash: JSON.parse(lastArchived).event_hash,
    }) + '\n')
  }
  await writeFile(eventFile, segmentLines.join(''))
  const coldStart = performance.now()
  const cold = await buildExecutionSnapshot(root)
  const coldMs = performance.now() - coldStart
  const readStart = performance.now()
  await readExecutionEvents(root)
  const readMs = performance.now() - readStart
  const scanStart = performance.now()
  const indexed = await scanTasks(root)
  const scanMs = performance.now() - scanStart
  const stateStart = performance.now()
  await Promise.all(indexed.map(task => readState(task.path)))
  const stateMs = performance.now() - stateStart
  const warmStart = performance.now()
  await buildExecutionSnapshot(root)
  const warmMs = performance.now() - warmStart

  const latestTask = `TASK-BENCH-${String(taskCount).padStart(3, '0')}`
  await appendFile(eventFile, event({
    step_run_id: null, project_id: 'PROJ-VIEW-BENCH', task_id: latestTask,
    round: 1, run_id: null, owner_pid: null, kind: 'annotation', step_type: null,
    label: 'Incremental update', summary: 'One new event after the cold projection',
    occurred_at: new Date().toISOString(), outcome: null, refs: [],
  }))
  const incrementalStart = performance.now()
  const incremental = await buildExecutionSnapshot(root)
  const incrementalMs = performance.now() - incrementalStart
  const view = await startExecutionViewServer(root)
  server = view.server
  await appendFile(eventFile, event({
    step_run_id: null, project_id: 'PROJ-VIEW-BENCH', task_id: latestTask,
    round: 1, run_id: null, owner_pid: null, kind: 'annotation', step_type: null,
    label: 'Browser-visible update', summary: 'One more event for the HTTP projection',
    occurred_at: new Date().toISOString(), outcome: null, refs: [],
  }))
  const visibleStart = performance.now()
  const response = await fetch(new URL('/api/snapshot', view.url))
  const visible = await response.json()
  const visibleMs = performance.now() - visibleStart
  if (!response.ok || !visible.tasks?.some(task => task.task_id === latestTask && task.steps.some(step => step.label === 'Browser-visible update')))
    throw new Error('new event was not visible in the HTTP snapshot')
  if (cold.tasks.length !== taskCount || incremental.tasks.length !== taskCount) throw new Error('benchmark lost Task rows')
  const result = {
    task_count: taskCount, events_per_task: eventsPerTask, archive_segments: archiveNames.length,
    cold_ms: Math.round(coldMs), warm_ms: Math.round(warmMs),
    cached_event_read_ms: Math.round(readMs), task_scan_ms: Math.round(scanMs), task_state_read_ms: Math.round(stateMs),
    incremental_ms: Math.round(incrementalMs), page_visible_ms: Math.round(visibleMs), cold_limit_ms: 2_000,
    incremental_limit_ms: 500,
    cold_pass: coldMs <= 2_000, incremental_pass: incrementalMs <= 500, page_visible_pass: visibleMs <= 500,
    snapshot_bytes: Buffer.byteLength(JSON.stringify(incremental)),
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.cold_pass || !result.incremental_pass || !result.page_visible_pass) process.exitCode = 1
} finally {
  if (server) await closeExecutionViewServer(server)
  await rm(root, { recursive: true, force: true })
}
