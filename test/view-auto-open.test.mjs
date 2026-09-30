import test from 'node:test'
import assert from 'node:assert/strict'

import { maybeAutoOpenExecutionView } from '../dist/view-auto-open.js'

test('automatic view respects CI, noninteractive sessions and --no-view', async () => {
  let starts = 0
  const services = { startView: async () => { starts += 1; return { url: 'http://127.0.0.1:1234/' } } }
  await maybeAutoOpenExecutionView('/project', {}, { ...services, interactive: false, ci: false })
  await maybeAutoOpenExecutionView('/project', {}, { ...services, interactive: true, ci: true })
  await maybeAutoOpenExecutionView('/project', { view: false }, { ...services, interactive: true, ci: false })
  await maybeAutoOpenExecutionView(null, {}, { ...services, interactive: true, ci: false })
  assert.equal(starts, 0)
})

test('automatic view reuses the managed start path and prints its URL', async () => {
  const calls = [], logs = []
  await maybeAutoOpenExecutionView('/project', {}, {
    interactive: true, ci: false,
    startView: async (root, timeout) => { calls.push([root, timeout]); return { url: 'http://127.0.0.1:1234/' } },
    openBrowser: url => calls.push(['browser', url]), log: message => logs.push(message),
  })
  assert.deepEqual(calls, [['/project', 4500], ['browser', 'http://127.0.0.1:1234/']])
  assert.deepEqual(logs, ['spec-loop execution view: http://127.0.0.1:1234/'])
})

test('view or browser startup failure does not fail the task command', async () => {
  const warnings = []
  await maybeAutoOpenExecutionView('/project', {}, {
    interactive: true, ci: false, startView: async () => { throw new Error('view unavailable') },
    warn: message => warnings.push(message),
  })
  await maybeAutoOpenExecutionView('/project', {}, {
    interactive: true, ci: false, startView: async () => ({ url: 'http://127.0.0.1:1234/' }),
    openBrowser: () => { throw new Error('browser unavailable') },
    log: () => {}, warn: message => warnings.push(message),
  })
  assert.match(warnings[0], /view unavailable/)
  assert.match(warnings[1], /browser unavailable/)
})
