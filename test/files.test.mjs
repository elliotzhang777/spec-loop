import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

import { tempRoot } from './helpers.mjs'
import { atomicWriteMany, recoverTransactions } from '../dist/files.js'

test('concurrent atomic transactions cannot recover or remove another writer journal', async () => {
  const root = await tempRoot('atomic-concurrency-')
  await Promise.all(Array.from({ length: 40 }, (_, index) => atomicWriteMany(root, [{ file: path.join(root, 'facts', `${index}.json`), content: `${JSON.stringify({ index })}\n` }])))
  await recoverTransactions(root)
  for (let index = 0; index < 40; index++) assert.deepEqual(JSON.parse(await readFile(path.join(root, 'facts', `${index}.json`), 'utf8')), { index })
})
