import test from 'node:test'
import assert from 'node:assert/strict'
import { runManagedProcess, startManagedProcess } from '../dist/managed-process.js'
import { processStartedAt } from '../dist/process-control.js'

test('managed process settles after the root exits even when a detached grandchild holds its pipes', {skip:process.platform==='win32'}, async (t) => {
  let grandchildPid=null
  t.after(()=>{if(grandchildPid)try{process.kill(grandchildPid,'SIGKILL')}catch{}})
  const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});console.log(child.pid);child.unref()`
  const started=Date.now(),result=await runManagedProcess({bin:process.execPath,args:['-e',script],timeoutMs:5_000,pipeDrainTimeoutMs:100})
  grandchildPid=Number(result.stdout.trim().split(/\s+/)[0])||null
  assert.equal(result.code,0)
  assert.equal(result.termination_verified,true)
  assert.equal(result.pipe_drain_timed_out,true)
  assert.ok(Date.now()-started<2_000)
})

test('managed process hard timeout is independent from pipe drain timeout', {skip:process.platform==='win32'}, async (t) => {
  let grandchildPid=null
  t.after(()=>{if(grandchildPid)try{process.kill(grandchildPid,'SIGKILL')}catch{}})
  const script=`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});console.log(child.pid);child.unref();setInterval(()=>{},1000)`
  const started=Date.now(),result=await runManagedProcess({bin:process.execPath,args:['-e',script],timeoutMs:1000,pipeDrainTimeoutMs:100})
  grandchildPid=Number(result.stdout.trim().split(/\s+/)[0])||null
  assert.equal(result.code,124)
  assert.equal(result.timedOut,true)
  assert.equal(result.termination_verified,true)
  assert.equal(result.pipe_drain_timed_out,true)
  assert.ok(Date.now()-started<3_000)
})

test('an unidentifiable live managed child is killed and cannot report success', async (t) => {
  const managed = startManagedProcess({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 5_000, identifyProcess: async () => null })
  t.after(() => { try { managed.child.kill('SIGKILL') } catch {} })
  const result = await managed.completion
  assert.equal(result.code, 125)
  assert.match(result.identity_error, /cannot establish.*identity/)
  assert.equal(result.termination_verified, true)
  assert.equal(await processStartedAt(managed.child.pid), null)
})

test('a child that exits before its identity probe completes remains a valid fast result', async () => {
  const result = await runManagedProcess({ bin: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5_000, identifyProcess: async () => {
    await new Promise(resolve => setTimeout(resolve, 300)); return null
  } })
  assert.equal(result.code, 0)
  assert.equal(result.identity_error, null)
})

test('repeated and concurrent termination cannot turn unverified pipe completion into stopped', async (t) => {
  const managed = startManagedProcess({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 100, pipeDrainTimeoutMs: 30, identifyProcess: async () => 'mismatching-test-identity' })
  const ended = new Promise(resolve => managed.child.once('close', resolve))
  t.after(async () => { managed.child.kill('SIGKILL'); await ended })
  const result = await managed.completion
  assert.equal(result.termination_verified, false)
  assert.ok(await processStartedAt(managed.child.pid))
  assert.deepEqual(await Promise.all([managed.terminate(), managed.terminate(), managed.terminate()]), [false, false, false])
  assert.ok(await processStartedAt(managed.child.pid))
  managed.child.kill('SIGKILL'); await ended
  assert.equal(await managed.terminate(), true)
})
