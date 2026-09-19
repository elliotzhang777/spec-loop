import test from 'node:test'
import assert from 'node:assert/strict'
import { runManagedProcess } from '../dist/managed-process.js'

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
