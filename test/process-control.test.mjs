import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { processMatches, processStartedAt, inspectProcess, requireProcessIdentity, terminateProcessTree } from '../dist/process-control.js'

test('required process identity rejects a missing start time',()=>{
  assert.throws(()=>requireProcessIdentity(null,'wave Driver'),/cannot establish process start identity/)
  assert.equal(requireProcessIdentity('known-start','wave Driver'),'known-start')
})

test('process inspection distinguishes an unknown identity from death and PID reuse', async () => {
  const started = await processStartedAt(process.pid)
  assert.equal((await inspectProcess(process.pid, started, { identifyProcess: async () => null })).status, 'unknown')
  assert.equal((await inspectProcess(process.pid, started, { identifyProcess: async () => { throw new Error('ps unavailable') } })).status, 'unknown')
  assert.equal((await inspectProcess(process.pid, `${started}-old`)).status, 'identity_mismatch')
  assert.equal((await inspectProcess(99999999, 'old', { identifyProcess: async () => null })).status, 'dead')
  assert.equal((await inspectProcess(null)).status, 'unknown')
})

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

test('a failed identity query does not certify a live process as stopped', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const identity = await processStartedAt(child.pid)
  const result = await terminateProcessTree(child.pid, identity, 100, { identifyProcess: async () => null })
  assert.deepEqual(result, { stopped: false, escalated: false, reason: 'identity_unavailable' })
  assert.equal(await processMatches(child.pid, identity), true)
  const missingExpected = await terminateProcessTree(child.pid, null, 100)
  assert.equal(missingExpected.reason, 'identity_unavailable')
  assert.equal(await processMatches(child.pid, identity), true)
})

test('termination shares one absolute deadline across slow identity probes', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch {} })
  const identity = await processStartedAt(child.pid), budgets = []
  const started = performance.now()
  const result = await terminateProcessTree(child.pid, identity, 100, {
    timeoutMs: 120,
    identifyProcess: async (_pid, remaining) => {
      budgets.push(remaining)
      if (budgets.length === 1) { await new Promise(resolve => setTimeout(resolve, 50)); return identity }
      return new Promise(() => {})
    },
  })
  assert.deepEqual(result, { stopped: false, escalated: false, reason: 'deadline_exceeded' })
  assert.ok(performance.now() - started < 500)
  assert.equal(budgets.length, 2)
  assert.ok(budgets[1] < budgets[0] - 30)
})
