import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { acquireOwnedDirectoryLock, inspectOwnedDirectoryLock, withOwnedDirectoryLock } from '../dist/owned-lock.js'
import { createLatestValueWriter, withOperationTimeout } from '../dist/latest-writer.js'
import { processStartedAt } from '../dist/process-control.js'
import { tempRoot } from './helpers.mjs'

test('owned directory lock detects PID reuse and only releases its own nonce', async () => {
  const root=await tempRoot('owned-lock-'),directory=path.join(root,'control.lock'),started=await processStartedAt(process.pid)
  assert.ok(started)
  await mkdir(directory)
  await writeFile(path.join(directory,'owner.json'),`${JSON.stringify({schema_version:1,name:'fixture',pid:process.pid,process_started_at:`${started}-reused`,nonce:randomUUID(),created_at:new Date().toISOString()})}\n`)
  const lock=await acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:100})
  assert.equal(lock.reclaimed_reason,'pid_reused')
  const stolen={...lock.owner,nonce:randomUUID()}
  await writeFile(path.join(directory,'owner.json'),`${JSON.stringify(stolen)}\n`)
  assert.equal(await lock.release(),false)
  assert.equal((await inspectOwnedDirectoryLock(directory)).exists,true)
  await rm(directory,{recursive:true,force:true})
})

test('owned directory lock protects a missing owner briefly and then reclaims it', async () => {
  const root=await tempRoot('owned-lock-missing-'),directory=path.join(root,'control.lock')
  await mkdir(directory)
  await assert.rejects(acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:20,missingOwnerProtectionMs:5_000}),/missing_owner/)
  const old=new Date(Date.now()-10_000);await utimes(directory,old,old)
  const lock=await acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:100,missingOwnerProtectionMs:5_000})
  assert.equal(lock.reclaimed_reason,'missing_owner')
  assert.equal(await lock.release(),true)
})

test('owned directory lock protects a partially written owner and serializes concurrent recovery', async () => {
  const root=await tempRoot('owned-lock-partial-'),directory=path.join(root,'control.lock')
  await mkdir(directory)
  await writeFile(path.join(directory,'owner.json'),'{"schema_version":1')
  await assert.rejects(acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:25,missingOwnerProtectionMs:5_000}),/invalid_owner/)
  assert.equal((await inspectOwnedDirectoryLock(directory)).reason,'invalid_owner')
  const old=new Date(Date.now()-10_000);await utimes(directory,old,old)
  const attempts=await Promise.allSettled(Array.from({length:50},()=>acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:500,pollMs:5,missingOwnerProtectionMs:20})))
  const acquired=attempts.filter(result=>result.status==='fulfilled').map(result=>result.value)
  assert.equal(acquired.length,1)
  for(const rejected of attempts.filter(result=>result.status==='rejected'))assert.match(String(rejected.reason),/lock wait exceeded/)
  assert.equal(await acquired[0].release(),true)
  assert.equal((await inspectOwnedDirectoryLock(directory)).exists,false)
})

test('owned directory lock release failure does not mask the operation error', async () => {
  const root=await tempRoot('owned-lock-primary-error-'),directory=path.join(root,'control.lock')
  await assert.rejects(withOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:100},async()=>{
    const owner=JSON.parse(await readFile(path.join(directory,'owner.json'),'utf8'))
    await writeFile(path.join(directory,'owner.json'),`${JSON.stringify({...owner,nonce:randomUUID()})}\n`)
    throw new Error('primary operation failed')
  }),/primary operation failed/)
  await rm(directory,{recursive:true,force:true})
})

test('owned directory lock maxWaitMs zero never waits for a live recovery owner', async () => {
  const root=await tempRoot('owned-lock-recovery-deadline-'),directory=path.join(root,'control.lock'),started=await processStartedAt(process.pid)
  assert.ok(started)
  await mkdir(directory)
  await writeFile(path.join(directory,'owner.json'),'{"schema_version":1')
  const old=new Date(Date.now()-10_000);await utimes(directory,old,old)
  await writeFile(`${directory}.recovery`,`${JSON.stringify({schema_version:1,name:'live recovery fixture',pid:process.pid,process_started_at:started,nonce:randomUUID(),created_at:new Date().toISOString()})}\n`)
  const began=Date.now()
  await assert.rejects(acquireOwnedDirectoryLock(directory,{name:'fixture',maxWaitMs:0,missingOwnerProtectionMs:20}),/lock wait exceeded 0ms/)
  assert.ok(Date.now()-began<1_000,`zero-wait acquisition took ${Date.now()-began}ms`)
  await rm(directory,{recursive:true,force:true});await rm(`${directory}.recovery`,{force:true})
})

test('latest-value writer coalesces queued heartbeats and flushes the terminal snapshot', async () => {
  const writes=[];let unblock
  const blocked=new Promise(resolve=>{unblock=resolve})
  const writer=createLatestValueWriter(async value=>{writes.push(value);if(writes.length===1)await blocked})
  const pending=[]
  pending.push(writer.enqueue({sequence:0,status:'running'}))
  for(let sequence=1;sequence<=100;sequence++)pending.push(writer.enqueue({sequence,status:'running'}))
  const closed=writer.close({sequence:101,status:'completed'})
  unblock();await Promise.all([...pending,closed])
  assert.equal(writes.length,2)
  assert.deepEqual(writes.at(-1),{sequence:101,status:'completed'})
  assert.ok(writer.stats().coalesced_updates>=99)
})

test('control-plane operation timeout fails closed with a bounded diagnostic', async () => {
  await assert.rejects(withOperationTimeout(new Promise(()=>{}),20,'fixture write'),/fixture write exceeded 20ms/)
})
