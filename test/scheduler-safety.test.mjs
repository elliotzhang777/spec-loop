import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tempRoot } from './helpers.mjs'
import { processStartedAt, processMatches } from '../dist/process-control.js'
import { spawn } from 'node:child_process'
import { initSchedulerControl, inspectSchedulerLiveness, reconcileSchedulerControl, reconcileInterruptedWaves, acquireProjectLease, acquireTaskLease, releaseTaskLease, releaseProjectLease } from '../dist/scheduler-control.js'
import { completeVerifiedTaskStopIntent, runBoundedTaskStops } from '../dist/scheduler-stops.js'

test('invalid and future heartbeats cannot be healthy and damaged records do not hide healthy siblings', async (t) => {
  const root=await tempRoot('scheduler-health-input-');t.after(()=>rm(root,{recursive:true,force:true}))
  await initSchedulerControl(root)
  const dir=path.join(root,'.spec-loop','active-effects');await mkdir(dir)
  const identity=await processStartedAt(process.pid),now=new Date().toISOString(),base={task_id:'TASK-HEALTH',pid:process.pid,process_started_at:identity,idle_timeout_seconds:300}
  await writeFile(path.join(dir,'healthy.json'),JSON.stringify({...base,effect_id:'healthy',heartbeat_at:now,last_progress_at:now}))
  for (const [id,time] of [['invalid','not-a-date'],['future',new Date(Date.now()+3_600_000).toISOString()]])await writeFile(path.join(dir,`${id}.json`),JSON.stringify({...base,effect_id:id,heartbeat_at:time,last_progress_at:time}))
  await writeFile(path.join(dir,'damaged.json'),'{')
  const waves=path.join(root,'.spec-loop','scheduler','wave-runs')
  const wave={status:'running',driver:{pid:process.pid,process_started_at:identity},started_at:now,heartbeat_at:now,budget:{max_elapsed_seconds:300},planned_tasks:[]}
  await writeFile(path.join(waves,'healthy.json'),JSON.stringify({...wave,wave_id:'healthy-wave'}))
  await writeFile(path.join(waves,'invalid.json'),JSON.stringify({...wave,wave_id:'invalid-wave',heartbeat_at:'not-a-date'}))
  await writeFile(path.join(waves,'damaged.json'),'{')
  const health=await inspectSchedulerLiveness(root,3)
  assert.equal(health.effects.find(item=>item.effect_id==='healthy').status,'healthy')
  assert.equal(health.effects.find(item=>item.effect_id==='invalid').status,'invalid_timestamp')
  assert.equal(health.effects.find(item=>item.effect_id==='future').status,'invalid_timestamp')
  assert.equal(health.effects.find(item=>item.file==='damaged.json').status,'invalid_marker')
  assert.equal(health.waves.find(item=>item.wave_id==='healthy-wave').status,'healthy')
  assert.equal(health.waves.find(item=>item.wave_id==='invalid-wave').status,'invalid_timestamp')
  assert.equal(health.waves.find(item=>item.file==='damaged.json').status,'invalid_marker')
  assert.equal(health.ok,false)
})

test('a hanging stop batch returns within its total budget, continues independent stops, and never publishes late completion', async (t) => {
  const root=await tempRoot('scheduler-bounded-stops-');t.after(()=>rm(root,{recursive:true,force:true}))
  await initSchedulerControl(root)
  let release
  const hung=new Promise(resolve=>{release=resolve}),began=performance.now()
  const batch=await runBoundedTaskStops(root,['TASK-SLOW','TASK-FAST'], 'deadline fixture', {maxElapsedMs:800,taskTimeoutMs:600,maxParallel:2,executeStop:async id=>{
    for(const task of ['TASK-SLOW','TASK-FAST'])assert.equal(JSON.parse(await readFile(path.join(root,'.spec-loop','scheduler','stop-intents',`${task}.json`),'utf8')).status,'requested')
    return id==='TASK-SLOW'?hung:{task_id:id,status:'cancelled',stop_complete:true}
  }})
  assert.ok(performance.now()-began<1_600)
  assert.equal(batch.stopped_tasks.find(item=>item.task_id==='TASK-FAST').stop_complete,true)
  assert.equal(batch.stopped_tasks.find(item=>item.task_id==='TASK-SLOW').status,'stop_incomplete')
  const file=path.join(root,'.spec-loop','scheduler','stop-intents','TASK-SLOW.json')
  // Drain final persistence before checking the durable intent.
  for(let n=0;n<20;n++){if((await readFile(file,'utf8').then(JSON.parse)).status==='stop_incomplete')break;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal(JSON.parse(await readFile(file,'utf8')).status,'stop_incomplete')
  await assert.rejects(reconcileSchedulerControl(root),/stop remains incomplete/)
  const second=await runBoundedTaskStops(root,['TASK-SLOW'],'new request',{executeStop:async()=>({task_id:'TASK-SLOW',status:'cancelled',stop_complete:true})})
  release({task_id:'TASK-SLOW',status:'cancelled',stop_complete:true});await new Promise(resolve=>setTimeout(resolve,50))
  const current=JSON.parse(await readFile(file,'utf8'))
  assert.equal(current.request_id,second.request_id)
  assert.equal(current.status,'completed')
  assert.equal((await reconcileSchedulerControl(root)).reconcile_required,false)
})

test('an old watchdog observation cannot cancel a new healthy execution or a recovered effect', async (t) => {
  const root=await tempRoot('scheduler-watchdog-generation-');t.after(()=>rm(root,{recursive:true,force:true}))
  await initSchedulerControl(root)
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>child.kill('SIGKILL'))
  const identity=await processStartedAt(child.pid),dir=path.join(root,'.spec-loop','active-effects');await mkdir(dir)
  const now=new Date().toISOString(),marker=path.join(dir,'current.json')
  await writeFile(marker,JSON.stringify({task_id:'TASK-NEXT',effect_id:'new-effect',pid:child.pid,process_started_at:identity,heartbeat_at:now,last_progress_at:now,idle_timeout_seconds:300}))
  for(const id of ['old-effect','new-effect']){
    const batch=await runBoundedTaskStops(root,['TASK-NEXT'],'stale observation',{taskTimeoutMs:8_000,watchdogConditions:{'TASK-NEXT':[{source:'effect',id,pid:child.pid}]},watchdogStaleSeconds:3})
    assert.equal(batch.stop_complete,true,JSON.stringify(batch))
    assert.equal(batch.stopped_tasks[0].status,'superseded')
    assert.equal(await processMatches(child.pid,identity),true)
    assert.equal(JSON.parse(await readFile(marker,'utf8')).effect_id,'new-effect')
    assert.equal(JSON.parse(await readFile(path.join(root,'.spec-loop/scheduler/stop-intents/TASK-NEXT.json'),'utf8')).status,'completed')
  }
})


test('a verified direct stop settles its observed intent without overwriting a newer request',async t=>{
  const root=await tempRoot('scheduler-direct-stop-generation-');t.after(()=>rm(root,{recursive:true,force:true}))
  await initSchedulerControl(root)
  const file=path.join(root,'.spec-loop/scheduler/stop-intents/TASK-RETRY.json')
  await writeFile(file,JSON.stringify({task_id:'TASK-RETRY',request_id:'new-request',status:'stop_incomplete',last_error:'timeout'}))
  assert.equal(await completeVerifiedTaskStopIntent(root,'TASK-RETRY','old-request'),false)
  assert.equal(JSON.parse(await readFile(file,'utf8')).status,'stop_incomplete')
  assert.equal(await completeVerifiedTaskStopIntent(root,'TASK-RETRY','new-request'),true)
  const completed=JSON.parse(await readFile(file,'utf8'));assert.equal(completed.status,'completed');assert.equal(completed.last_error,null)
  assert.equal(await completeVerifiedTaskStopIntent(root,'TASK-MISSING','new-request'),false)
})


test('old wave recovery and watchdog observations cannot cancel a newer leased invocation',async t=>{
  const {waveFixture}=await import('./wave-review.helpers.mjs'),{prepareRoleInvocation,readRoleInvocation}=await import('../dist/role-orchestrator.js')
  const f=await waveFixture({failFirst:false});t.after(()=>rm(f.root,{recursive:true,force:true}));const id=f.taskIds[0]
  const project=await acquireProjectLease(f.root,{owner:'new-wave',idempotencyKey:'WAVE-NEW',ttlSeconds:300})
  const lease=await acquireTaskLease(f.root,{projectLeaseId:project.lease_id,projectFencingToken:project.fencing_token,taskId:id,owner:'new-wave',idempotencyKey:'new-task',ttlSeconds:300,resources:['branch:new'],action:'start_m'})
  const binding={wave_id:'WAVE-NEW',project_lease_id:project.lease_id,project_fencing_token:project.fencing_token,task_lease_id:lease.lease_id,task_fencing_token:lease.fencing_token}
  const invocation=await prepareRoleInvocation(f.root,id,'M',{executionBinding:binding})
  const directory=path.join(f.root,'.spec-loop/scheduler/wave-runs')
  await writeFile(path.join(directory,'WAVE-A-DAMAGED.json'),'{')
  await writeFile(path.join(directory,'WAVE-OLD.json'),JSON.stringify({wave_id:'WAVE-OLD',status:'running',driver:{pid:99999999,process_started_at:'never'},heartbeat_at:new Date(0).toISOString(),planned_tasks:[id]}))
  const health=await inspectSchedulerLiveness(f.root,3);assert.deepEqual(health.waves.find(item=>item.wave_id==='WAVE-OLD').task_ids,[])
  const recovery=await reconcileInterruptedWaves(f.root,true);assert.equal(recovery.waves.find(item=>item.file==='WAVE-A-DAMAGED.json').status,'recovery_failed');assert.equal(recovery.waves.find(item=>item.wave_id==='WAVE-OLD').status,'interrupted_requeued');assert.equal((await readRoleInvocation(f.root,id,invocation.invocation_id)).status,'prepared')
  // Recovery still cancels its own exact generation, including after lease expiry/release.
  await releaseTaskLease(f.root,lease.lease_id,lease.fencing_token);await releaseProjectLease(f.root,project.lease_id,project.fencing_token)
  await writeFile(path.join(directory,'WAVE-NEW.json'),JSON.stringify({wave_id:'WAVE-NEW',status:'running',project_lease:{lease_id:project.lease_id},driver:{pid:99999999,process_started_at:'never'},heartbeat_at:new Date(0).toISOString(),planned_tasks:[id]}))
  await reconcileInterruptedWaves(f.root,true);assert.equal((await readRoleInvocation(f.root,id,invocation.invocation_id)).status,'cancelled')
})


test('failed Project lease admission leaves no running wave for later recovery',async t=>{
 const {waveFixture}=await import('./wave-review.helpers.mjs'),{runReadyWave}=await import('../dist/scheduler-control.js'),{stopManagedSchedulerSupervisor}=await import('../dist/scheduler-supervisor.js')
 const f=await waveFixture({failFirst:false});t.after(async()=>{await stopManagedSchedulerSupervisor(f.root).catch(()=>{});await rm(f.root,{recursive:true,force:true})})
 await acquireProjectLease(f.root,{owner:'existing-owner',idempotencyKey:'WAVE-EXISTING',ttlSeconds:300})
 await assert.rejects(runReadyWave(f.root,{owner:'rejected-owner',testSessionId:'admission-guard',testMaxRuntimeSeconds:60}),/already has an active/)
 assert.deepEqual((await (await import('node:fs/promises')).readdir(path.join(f.root,'.spec-loop/scheduler/wave-runs'))).filter(name=>name.endsWith('.json')),[])
})
