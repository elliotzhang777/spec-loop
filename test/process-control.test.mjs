import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { processMatches, processStartedAt, terminateProcessTree } from '../dist/process-control.js'

const exited = (child) => new Promise((resolve) => child.once('close', resolve))

test('verified termination falls back to a direct PID for a non-process-group child', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const identity = await processStartedAt(child.pid)
  assert.ok(identity)
  assert.equal(await processMatches(child.pid, identity), true)
  const stopping = exited(child)
  const result = await terminateProcessTree(child.pid, identity, 250)
  assert.equal(result.stopped, true)
  await stopping
  assert.equal(await processMatches(child.pid, identity), false)
})

test('PID identity mismatch fails closed and does not signal an unrelated process', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const identity = await processStartedAt(child.pid)
  assert.ok(identity)
  const result = await terminateProcessTree(child.pid, `${identity}-different`, 100)
  assert.deepEqual(result, { stopped: false, escalated: false, reason: 'identity_mismatch' })
  assert.equal(await processMatches(child.pid, identity), true)
  const stopping = exited(child); child.kill('SIGKILL'); await stopping
})
