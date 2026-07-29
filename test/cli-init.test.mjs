import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'

import { cli, readMd, tempRoot } from './helpers.mjs'

test('task init defaults repository to the caller working directory', async () => {
  const parent = await tempRoot('cli-init-repository-')
  const repository = path.join(parent, 'repo')
  const task = path.join(parent, 'task')
  await mkdir(repository)

  const result = cli(
    ['init', task, '--level', 'standard', '--id', 'TASK-DEFAULT-REPO', '--title', 'Default repository'],
    { cwd: repository },
  )
  assert.equal(result.code, 0, result.stderr)

  const state = await readMd(path.join(task, 'TASK_STATE.md'))
  assert.equal(state.data.repository, await realpath(repository))
})
