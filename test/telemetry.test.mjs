import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir, rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { atomicWriteMany, atomicWriteTelemetry, removeTelemetryFile, recoverTransactions } from '../dist/files.js'
import { acquireOwnedDirectoryLock } from '../dist/owned-lock.js'
import { withAbortableOperationTimeout } from '../dist/latest-writer.js'
import { serveSchedulerSupervisor } from '../dist/scheduler-supervisor.js'
import { inspectOwnedDirectoryLock } from '../dist/owned-lock.js'
import { cli } from './helpers.mjs'

for (const terminal of ['completed', 'removed']) {
  test(`timed-out queued heartbeats cannot replace a ${terminal} terminal state or replay from a journal`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'telemetry-timeout-')), file = path.join(root, 'HEARTBEAT.json')
    t.after(() => rm(root, { recursive: true, force: true }))
    await atomicWriteMany(root, [{ file, content: 'initial' }])
    const lock = await acquireOwnedDirectoryLock(path.join(root, '.spec-loop-tx-lock'), { name: 'delayed telemetry fixture', maxWaitMs: 0 })
    t.after(() => lock.release())
    let abandoned
    await assert.rejects(withAbortableOperationTimeout(signal => {
      abandoned = atomicWriteTelemetry(root, { file, content: 'late running heartbeat' }, signal)
      return abandoned
    }, 25, 'heartbeat fixture'), /exceeded 25ms/)
    // Queue terminal work while the abandoned write still waits for its lock.
    const final = terminal === 'removed' ? removeTelemetryFile(root, file) : atomicWriteMany(root, [{ file, content: 'completed' }])
    await lock.release()
    await assert.rejects(abandoned, /exceeded 25ms/)
    await final
    await recoverTransactions(root)
    if (terminal === 'removed') await assert.rejects(readFile(file), { code: 'ENOENT' })
    else assert.equal(await readFile(file, 'utf8'), 'completed')
    assert.deepEqual(await readdir(path.join(root, '.spec-loop-tx')), [])
  })
}

test('aborted telemetry never creates a file even without a following terminal write', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'telemetry-abort-')), file = path.join(root, 'HEARTBEAT.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const controller = new AbortController(); controller.abort(new Error('obsolete epoch'))
  await assert.rejects(atomicWriteTelemetry(root, { file, content: 'obsolete' }, controller.signal), /obsolete epoch/)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
})

test('conditional telemetry removal leaves a replacement owner intact', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'telemetry-owner-')), file = path.join(root, 'SUPERVISOR.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  await atomicWriteMany(root, [{ file, content: 'new owner' }])
  await removeTelemetryFile(root, file, async () => (await readFile(file, 'utf8')) === 'old owner')
  assert.equal(await readFile(file, 'utf8'), 'new owner')
})

test('Supervisor startup heartbeat timeout releases its lock and signal listeners', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'telemetry-supervisor-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(cli(['project', 'init', root, '--id', 'PROJ-TELEMETRY', '--name', 'Telemetry fixture', '--repository', root]).code, 0)
  const lock = await acquireOwnedDirectoryLock(path.join(root, '.spec-loop-tx-lock'), { name: 'startup heartbeat delay', maxWaitMs: 0 })
  t.after(() => lock.release())
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]
  const release = setTimeout(() => { void lock.release() }, 300)
  t.after(() => clearTimeout(release))
  await assert.rejects(serveSchedulerSupervisor(root, { slowWriteMs: 100 }), /Supervisor heartbeat write exceeded 100ms/)
  assert.equal((await inspectOwnedDirectoryLock(path.join(root, '.spec-loop', 'locks', 'scheduler-supervisor.lock'))).exists, false)
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], listeners)
  await assert.rejects(readFile(path.join(root, '.spec-loop', 'scheduler', 'SUPERVISOR.json')), { code: 'ENOENT' })
})
