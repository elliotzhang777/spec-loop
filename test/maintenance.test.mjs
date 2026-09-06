import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

import { cli, fillContracts, tempRoot } from './helpers.mjs'
import { archiveAcceptanceEvidence, inspectArtifacts, planWorktreeRetirement, retentionPolicy, retireWorktree } from '../dist/maintenance.js'
import { cancelTask } from '../dist/task.js'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

test('artifact inspection is bounded, does not follow symlinks, and only proposes terminal worktrees', async () => {
  const root = await tempRoot('maintenance-inspect-'), repository = path.join(root, 'repo')
  await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-MAINT', '--name', 'Maintenance fixture', '--repository', repository]).code, 0)
  const taskRoot = path.join(root, '.spec-loop', 'tasks', 'task-maint')
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', 'TASK-MAINT', '--title', 'Inspect artifacts', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: 'TASK-MAINT', title: 'Inspect artifacts', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  await cancelTask(taskRoot)
  const modules = path.join(root, '.spec-loop', 'worktrees', 'task-maint', 'node_modules', 'pkg')
  await mkdir(modules, { recursive: true })
  await writeFile(path.join(modules, 'large.bin'), Buffer.alloc(4096))
  const outside = path.join(root, 'outside.bin')
  await writeFile(outside, Buffer.alloc(8192))
  await symlink(outside, path.join(root, '.spec-loop', 'worktrees', 'task-maint', 'outside-link'))
  const before = await readFile(outside)
  const report = await inspectArtifacts(root)
  assert.equal(report.policy.destructive_action_performed, false)
  assert.equal(report.duplicated_dependency_indicators.node_modules_bytes, 4096)
  assert.equal(report.symlinks, 1)
  assert.equal(report.retirement_candidates[0].directory, '.spec-loop/worktrees/task-maint')
  assert.deepEqual(await readFile(outside), before)
})

test('explicit retirement refuses HEAD drift and preserves the committed recovery branch', async () => {
  const root = await tempRoot('maintenance-retire-'), repository = path.join(root, 'repo')
  await mkdir(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.email', 'test@example.com'])
  git(repository, ['config', 'user.name', 'Test'])
  await writeFile(path.join(repository, 'README.md'), 'fixture\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'initial'])
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-RETIRE', '--name', 'Retirement fixture', '--repository', repository]).code, 0)
  const taskId = 'TASK-MAINT-RETIRE', taskRoot = path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase())
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', taskId, '--title', 'Retire artifacts', '--repository', repository]).code, 0)
  await fillContracts(taskRoot, { id: taskId, title: 'Retire artifacts', level: 'standard' })
  assert.equal(cli(['plan', taskRoot]).code, 0)
  assert.equal(cli(['round', taskRoot]).code, 0)
  await cancelTask(taskRoot)
  const worktree = path.join(root, '.spec-loop', 'worktrees', taskId.toLowerCase()), branch = `spec-loop/${taskId.toLowerCase()}`
  await mkdir(path.dirname(worktree), { recursive: true })
  git(repository, ['worktree', 'add', '-b', branch, worktree, 'HEAD'])
  const head = git(worktree, ['rev-parse', 'HEAD'])
  const repositoryReal = await import('node:fs/promises').then(fs => fs.realpath(repository))
  await writeFile(path.join(root, '.spec-loop', 'output', `${taskId}-workspace.json`), `${JSON.stringify({ schema_version: 1, task_id: taskId, repository: repositoryReal, worktree, branch, base_commit: head, head, created_at: new Date().toISOString() }, null, 2)}\n`)
  assert.equal((await planWorktreeRetirement(root, taskId)).safe_to_retire, true)
  await assert.rejects(retireWorktree(root, taskId, '0'.repeat(40)), /Expected HEAD/)
  const retired = await retireWorktree(root, taskId, head)
  assert.equal(retired.destructive_action_performed, true)
  assert.equal(await import('node:fs/promises').then(fs => fs.lstat(worktree).catch(() => null)), null)
  assert.equal(git(repository, ['rev-parse', `refs/heads/${branch}`]), head)
  assert.equal((await retireWorktree(root, taskId, head)).actual_head, head)
})

test('retention policy uses shared dependency caches and archives bounded authoritative Evidence idempotently', async () => {
  const root = await tempRoot('maintenance-archive-'), repository = path.join(root, 'repo'); await mkdir(repository)
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-ARCHIVE', '--name', 'Archive fixture', '--repository', repository]).code, 0)
  const taskId = 'TASK-ARCHIVE-1', taskRoot = path.join(root, '.spec-loop', 'tasks', taskId.toLowerCase())
  assert.equal(cli(['init', taskRoot, '--level', 'standard', '--id', taskId, '--title', 'Archive evidence', '--repository', repository]).code, 0)
  await writeFile(path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'), 'contract evidence\n')
  await writeFile(path.join(taskRoot, 'ACCEPTANCE_RUN.json'), `${JSON.stringify({ run_id: 'RUN-TASK-ARCHIVE-1-1' })}\n`)
  const output = path.join(root, '.spec-loop', 'output', `${taskId}-acceptance-v2`); await mkdir(path.join(output, 'invocations', 'INV-1', 'candidate'), { recursive: true }); await mkdir(path.join(output, 'V'), { recursive: true })
  await writeFile(path.join(output, 'V', 'result.json'), '{"verdict":"pass"}\n')
  await writeFile(path.join(output, 'invocations', 'INV-1', 'candidate', 'large.bin'), Buffer.alloc(1024))
  const policy = await retentionPolicy(root)
  assert.match(policy.shared_cache_root, /\.spec-loop\/shared-cache$/)
  assert.equal(policy.snapshot_max_bytes, 262_144)
  const archived = await archiveAcceptanceEvidence(root, taskId)
  assert.equal(archived.files.some(item => item.relative.includes('candidate')), false)
  assert.equal(archived.files.some(item => item.relative.endsWith('V/result.json')), true)
  assert.deepEqual(await archiveAcceptanceEvidence(root, taskId), archived)
})
