import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'

import { cli, tempRoot } from './helpers.mjs'
import { runReportScheduler } from '../dist/report-scheduler.js'

async function taskFingerprint(root) {
  const files = []
  async function walk(dir) { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else files.push([path.relative(root, file), await readFile(file, 'utf8')]) } }
  await walk(root); return JSON.stringify(files.sort(([left], [right]) => left.localeCompare(right)))
}

async function fixture() {
  const root = await tempRoot('scheduler-report-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-REPORT', '--name', 'Report only', '--repository', repository]).code, 0)
  const proposal = cli(['triage', 'propose', root, '--source', 'approved project review', '--goal', 'Report task readiness', '--reason', 'Need scheduler facts', '--ac', 'report is deterministic'])
  assert.equal(proposal.code, 0, proposal.stderr); assert.equal(cli(['triage', 'approve', root, proposal.stdout.trim(), '--by', 'owner']).code, 0)
  assert.equal(cli(['triage', 'create-task', root, proposal.stdout.trim(), '--id', 'TASK-REPORT-1', '--title', 'Report readiness']).code, 0)
  return { root, taskRoot: path.join(root, '.spec-loop', 'tasks', 'task-report-1') }
}

test('report-only scheduler is canonical, measurable, read-only to Tasks, and fail closed', async () => {
  const f = await fixture(), before = await taskFingerprint(f.taskRoot)
  const first = await runReportScheduler(f.root), second = await runReportScheduler(f.root)
  assert.equal(first.suggestions.length, 1)
  assert.equal(first.suggestions[0].source, 'project-task:TASK-REPORT-1')
  assert.equal(first.suggestions[0].risk, 'standard')
  assert.equal(first.suggestions[0].estimated_cost, 3)
  assert.equal(second.canonical_report_hash, first.canonical_report_hash)
  assert.equal(second.equivalent_to_previous, true)
  assert.equal(await taskFingerprint(f.taskRoot), before)

  await writeFile(path.join(f.root, '.spec-loop', 'SCHEDULER_FEEDBACK.json'), `${JSON.stringify({ schema_version: 1, items: [{ dedupe_key: first.suggestions[0].dedupe_key, disposition: 'adopted' }] }, null, 2)}\n`)
  const measured = await runReportScheduler(f.root)
  assert.equal(measured.metrics.adopted, 1)
  assert.equal(measured.metrics.adoption_rate, 1)

  assert.equal(cli(['scheduler', 'pause', f.root]).code, 0)
  await assert.rejects(runReportScheduler(f.root), /paused/)
  assert.equal(cli(['scheduler', 'resume', f.root]).code, 0)

  const lock = path.join(f.root, '.spec-loop', 'scheduler-report.lock'); await mkdir(lock)
  await assert.rejects(runReportScheduler(f.root), /already running/)
  await rm(lock, { recursive: true })

  await writeFile(path.join(f.root, '.spec-loop', 'output', 'scheduler-cursor.json'), '{"schema_version":1,"corrupt":true}\n')
  await assert.rejects(runReportScheduler(f.root), /cursor is invalid/)
  assert.equal(await taskFingerprint(f.taskRoot), before)
})
