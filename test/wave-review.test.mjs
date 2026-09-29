import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { waveFixture, git } from './wave-review.helpers.mjs'
import { runReadyWave, planReadyWave, schedulerControlStatus, pauseSchedulerControl, configureWaveBudget } from '../dist/scheduler-control.js'
import { readAcceptanceRun } from '../dist/acceptance-loop.js'
import { createWaveReview, listWaveReviews, rebuildWaveReview, readWaveReview, decideWaveReview, refreshWaveReview, runAuthorizedWave, taskWaveReviewHold, waveReviewArtifact, reconcileWaveAuthorization, reconcileWaveAuthorizations, launchAuthorizedWave } from '../dist/wave-review.js'
import { startManagedProcess } from '../dist/managed-process.js'
import { acquireOwnedDirectoryLock } from '../dist/owned-lock.js'
import { cli, tempRoot, writeMd } from './helpers.mjs'
import { stopManagedSchedulerSupervisor } from '../dist/scheduler-supervisor.js'
import { requestVisualReview } from '../dist/review.js'
import { startExecutionViewServer, closeExecutionViewServer } from '../dist/execution-view-server.js'

test('a new wave leaves unrelated drifted Candidates outside its scope', {timeout:120_000}, async t=>{
  const f=await waveFixture({failFirst:false})
  t.after(async()=>{await stopManagedSchedulerSupervisor(f.root).catch(()=>{})})
  const candidateFile=path.join(f.taskRoot(f.taskIds[0]),'ACCEPTANCE_RUN.json')
  const candidate=JSON.parse(await readFile(candidateFile,'utf8'))
  const candidateHead=git(f.repository,['rev-parse','HEAD'])
  await writeFile(candidateFile,JSON.stringify({...candidate,stage:'candidate',candidate_id:'CANDIDATE-OLDER',current_head:candidateHead}))
  await writeFile(path.join(f.repository,'later-baseline.txt'),'new default branch baseline\n')
  git(f.repository,['add','.']);git(f.repository,['commit','-m','advance baseline'])
  const reported=await planReadyWave(f.root)
  assert.equal(reported.candidate_recovery.find(item=>item.task_id===f.taskIds[0])?.status,'baseline_drift')
  const scoped=await planReadyWave(f.root,{taskIds:new Set([f.taskIds[1]])})
  assert.equal(scoped.candidate_recovery.length,0)
  assert.deepEqual(scoped.ready.map(item=>item.task_id),reported.ready.map(item=>item.task_id))
  const preview=cli(['scheduler','control','run-ready',f.root,'--owner','preview-test','--task',f.taskIds[1],'--json'])
  assert.equal(preview.code,0,preview.stderr)
  assert.deepEqual(JSON.parse(preview.stdout).ready.map(item=>item.task_id),[f.taskIds[1]])
  assert.equal(JSON.parse(preview.stdout).candidate_recovery.length,0)
  const wave=await runReadyWave(f.root,{owner:'scoped-candidate-test',taskIds:[f.taskIds[1]],singleStage:true,testSessionId:'scoped-candidate-test',testMaxRuntimeSeconds:120})
  assert.deepEqual(wave.authorized_tasks,[f.taskIds[1]])
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'candidate')
  await assert.rejects(runReadyWave(f.root,{owner:'scoped-candidate-test',testSessionId:'scoped-candidate-test',testMaxRuntimeSeconds:120}),/no Ready Tasks/)
})

test('a crashed authorization Worker becomes failed while living or unknown owners remain protected',async t=>{
  const root=await tempRoot('authorization-recovery-'),id=randomUUID(),directory=path.join(root,'.spec-loop','scheduler','wave-reviews','authorizations');await mkdir(directory,{recursive:true})
  const file=path.join(directory,`${id}.json`),child=startManagedProcess({bin:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:30_000})
  t.after(()=>child.terminate())
  const identity=await child.processStartedAt
  await writeFile(file,JSON.stringify({status:'running',worker:{pid:child.child.pid,process_started_at:identity},wave_id:null}))
  assert.equal((await reconcileWaveAuthorization(root,id)).status,'running')
  await child.terminate();await child.completion
  assert.equal((await reconcileWaveAuthorization(root,id)).status,'failed')
  assert.equal(JSON.parse(await readFile(file,'utf8')).status,'failed')
  await assert.rejects(launchAuthorizedWave(root,id),/already consumed/)
  await writeFile(file,JSON.stringify({status:'running',wave_id:null}))
  const unknown=await reconcileWaveAuthorization(root,id);assert.equal(unknown.status,'running');assert.equal(unknown.recovery_status,'identity_unknown')
  await writeFile(file,JSON.stringify({status:'running',worker:{pid:child.child.pid,process_started_at:identity},wave_id:null}))
  assert.equal((await reconcileWaveAuthorizations(root))[0].status,'failed','Supervisor recovery uses the same ownership proof')
  const broken=randomUUID();await writeFile(path.join(directory,`${broken}.json`),'{')
  await writeFile(path.join(root,'.spec-loop/scheduler/wave-reviews/authorization-recovery-cursor.json'),JSON.stringify({offset:-2}))
  const recovered=await reconcileWaveAuthorizations(root)
  assert.equal(recovered.find(item=>item.authorization_id===id).status,'failed')
  assert.equal(recovered.find(item=>item.authorization_id===broken).status,'recovery_failed')

})

test('failed wave finalization is bounded, retains its Candidate and pauses further dispatch',{timeout:120_000},async t=>{
  const f=await waveFixture({failFirst:false}),held=await acquireOwnedDirectoryLock(path.join(f.root,'.spec-loop','scheduler','wave-reviews','mutex'),{name:'blocked review fixture',maxWaitMs:0})
  t.after(async()=>{await held.release();await stopManagedSchedulerSupervisor(f.root).catch(()=>{})})
  const started=Date.now(),wave=await runReadyWave(f.root,{owner:'wave-owner',taskIds:[f.taskIds[0]],testSessionId:'finalization-failure-test',testMaxRuntimeSeconds:120})
  assert.equal(wave.status,'finalization_incomplete',JSON.stringify(wave))
  assert.equal(wave.finalizer_stop_verified,true);assert.ok(Date.now()-started<90_000)
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'candidate')
  const status=await schedulerControlStatus(f.root);assert.equal(status.control.paused,true);assert.equal(status.control.reconcile_required,true)
  assert.equal(status.project_leases.some(item=>item.status==='active'),false)
  await held.release()
  const rebuilt=await rebuildWaveReview(f.root,wave.wave_id)
  assert.equal(rebuilt.status,'awaiting_wave_review');assert.equal(rebuilt.bundle.tasks[0].outcome,'candidate')
  assert.equal((await schedulerControlStatus(f.root)).control.paused,true,'review recovery must not resume business execution')
})

test('concurrent review refreshes cannot overwrite a newer Task hold', async()=>{
  const root=await tempRoot('wave-review-generation-'),repository=path.join(root,'repo');await mkdir(repository)
  assert.equal(cli(['project','init',root,'--id','PROJ-REVIEW-GENERATION','--name','验收代际测试','--repository',repository]).code,0)
  await writeMd(path.join(root,'.spec-loop','GATES.md'),{schema_version:1,scope_kind:'task',wave_id:'WGENERATION',coverage:'targeted',database:{lifecycle:'persistent',reset:'fixtures'},gates:[{id:'check',ac:['AC-1'],command:[process.execPath,'--version'],timeout_seconds:10}]},'# Approved fixture Gate')
  const wave={wave_id:`WAVE-${randomUUID()}`,status:'completed',authorized_tasks:['TASK-GENERATION-1'],results:[],budget:{max_parallel:1,max_elapsed_seconds:60,max_tokens:100,max_cost_usd:1}}
  const runDir=path.join(root,'.spec-loop','scheduler','wave-runs');await mkdir(runDir,{recursive:true})
  await writeFile(path.join(runDir,`${wave.wave_id}.json`),JSON.stringify(wave))
  await createWaveReview(root,wave)
  await assert.rejects(createWaveReview(root,{...wave,wave_id:`WAVE-${randomUUID()}`}),/another review owns this Task/)
  const refreshes=await Promise.allSettled([refreshWaveReview(root,wave.wave_id),refreshWaveReview(root,wave.wave_id)])
  assert.equal(refreshes.filter(item=>item.status==='fulfilled').length,1)
  const winner=refreshes.find(item=>item.status==='fulfilled').value
  assert.equal((await taskWaveReviewHold(root,wave.authorized_tasks[0])).wave_id,winner.wave_id)
  assert.equal(refreshes.find(item=>item.status==='rejected').reason.message.match(/another review owns this Task|no pending Tasks remain/)!==null,true)
  await assert.rejects(refreshWaveReview(root,wave.wave_id),/no pending Tasks remain/)
  await assert.rejects(createWaveReview(root,{...wave,wave_id:`WAVE-${randomUUID()}`},{expectedHoldWaveId:wave.wave_id}),/another review owns this Task/)
  assert.equal((await taskWaveReviewHold(root,wave.authorized_tasks[0])).wave_id,winner.wave_id)
})

test('a wave repairs V failures without renewed HEAD authorization, then atomically reviews a subset and authorizes bounded continuation', {timeout:180_000}, async t=>{
  const f=await waveFixture({visual:true});t.after(()=>stopManagedSchedulerSupervisor(f.root).catch(()=>{}))
  const baseline=git(f.repository,['rev-parse','HEAD'])
  const wave=await runReadyWave(f.root,{owner:'wave-owner',testSessionId:'review-test',testMaxRuntimeSeconds:180})
  assert.equal(wave.status,'awaiting_wave_review',JSON.stringify(wave.results))
  assert.equal(wave.execution_mode,'batch_two_rounds')
  assert.equal(wave.verification_round,2)
  assert.equal(wave.execution_status,'completed')
  const roles=wave.results.map(item=>item.role)
  assert.ok(roles.slice(0,2).every(role=>role==='M'),'all implementation finishes before V starts')
  assert.ok(roles.indexOf('R')>roles.lastIndexOf('V'),'R starts after the whole wave passes V')
  assert.equal(wave.results.length,8,JSON.stringify(wave.results))
  assert.equal(wave.results.filter(item=>item.task_id===f.taskIds[0]&&item.role==='V').length,2)
  assert.ok(wave.results.some(item=>item.role==='V'&&item.acceptance_verdict==='fail'))
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).semantic_reworks_used,1)
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[1])).stage,'candidate')
  assert.equal((await schedulerControlStatus(f.root)).task_leases.filter(item=>item.status==='active').length,0)
  let record=await readWaveReview(f.root,wave.wave_id)
  assert.equal(record.bundle.tasks.filter(item=>item.outcome==='candidate').length,2,JSON.stringify(record.bundle.tasks))
  const makeInput=(choices,extra={})=>({bundle_hash:record.bundle.bundle_hash,request_id:randomUUID(),actor:'owner',note:'统一核对当前候选',choices,...extra})
  const accept=[{task_id:f.taskIds[0],action:'accept'},{task_id:f.taskIds[1],action:'accept'}]
  await assert.rejects(decideWaveReview(f.root,wave.wave_id,makeInput(accept)),/visual review has not been requested/)
  assert.equal((await readWaveReview(f.root,wave.wave_id)).decision,null)
  const evidence=path.join(f.root,record.bundle.tasks[1].facts.records[0].evidence.at(-1).file),original=await readFile(evidence)
  await writeFile(evidence,'tampered report')
  await assert.rejects(decideWaveReview(f.root,wave.wave_id,makeInput([{task_id:f.taskIds[1],action:'accept'}])),/facts changed/)
  await writeFile(evidence,original)
  await assert.rejects(decideWaveReview(f.root,wave.wave_id,makeInput([{task_id:'TASK-NOT-IN-WAVE',action:'accept'}])),/not present/)
  await assert.rejects(decideWaveReview(f.root,wave.wave_id,makeInput([{task_id:f.taskIds[0],action:'return_to_m'}],{authorize_next:true,next_plan_hash:'0'.repeat(64)})),/plan hash mismatch/)
  const input=makeInput([{task_id:f.taskIds[0],action:'return_to_m'},{task_id:f.taskIds[1],action:'accept'}],{authorize_next:true,next_plan_hash:record.bundle.next_plan.plan_hash})
  const decided=await decideWaveReview(f.root,wave.wave_id,input)
  assert.equal(decided.status,'reviewed');assert.deepEqual(await decideWaveReview(f.root,wave.wave_id,input),decided)
  await assert.rejects(decideWaveReview(f.root,wave.wave_id,{...input,request_id:randomUUID()}),/already consumed/)
  assert.equal(await taskWaveReviewHold(f.root,f.taskIds[0]),null)
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'m_working')
  assert.equal((await planReadyWave(f.root)).ready[0].task_id,f.taskIds[0])
  assert.equal(git(f.repository,['rev-parse','HEAD']),baseline,'final acceptance must not merge')
  const next=await runAuthorizedWave(f.root,decided.decision.authorization_id,{testSessionId:'review-test',testMaxRuntimeSeconds:180})
  assert.equal(next.status,'awaiting_wave_review',JSON.stringify(next))
  assert.deepEqual(next.authorized_tasks,[f.taskIds[0]])
  await assert.rejects(runAuthorizedWave(f.root,decided.decision.authorization_id),/already consumed/)
  assert.notEqual((await readAcceptanceRun(f.root,f.taskIds[0])).current_head,record.bundle.tasks[0].facts.head)
  const shot=path.join(f.root,'visual.png');await writeFile(shot,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'))
  const visual=await requestVisualReview(f.taskRoot(f.taskIds[0]),'REVIEW-1',(await readAcceptanceRun(f.root,f.taskIds[0])).current_head,[shot])
  const refreshed=await refreshWaveReview(f.root,next.wave_id);record=await readWaveReview(f.root,refreshed.wave_id)
  assert.equal((await waveReviewArtifact(f.root,refreshed.wave_id,f.taskIds[0],visual.artifacts[0].sha256)).media_type,'image/png')
  await assert.rejects(decideWaveReview(f.root,next.wave_id,{bundle_hash:next.review_bundle_hash,request_id:randomUUID(),actor:'owner',note:'旧清单无效',choices:[{task_id:f.taskIds[0],action:'accept'}]}),/facts changed|another review/)
  const oldNow=Date.now;Date.now=()=>oldNow()+25*3_600_000
  try{await assert.rejects(decideWaveReview(f.root,refreshed.wave_id,makeInput([{task_id:f.taskIds[0],action:'accept'}])),/expired/)}finally{Date.now=oldNow}
  const freshAgain=await refreshWaveReview(f.root,refreshed.wave_id);record=await readWaveReview(f.root,freshAgain.wave_id)
  const server=await startExecutionViewServer(f.root);t.after(()=>closeExecutionViewServer(server.server))
  const html=await(await fetch(server.url)).text(),token=html.match(/name="review-token" content="([a-f0-9]+)"/)[1]
  const payload={wave_id:record.bundle.wave_id,decision:makeInput([{task_id:f.taskIds[0],action:'accept',visual:[{review_id:'REVIEW-1',request_hash:visual.request_hash,result:'approved'}]}])}
  const endpoint=new URL('/api/wave-review/decision',server.url)
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403)
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Spec-Loop-Review-Token':token,Origin:'https://untrusted.example'},body:JSON.stringify(payload)})).status,403)
  assert.equal((await fetch(new URL('/api/snapshot',server.url),{method:'POST'})).status,405)
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Spec-Loop-Review-Token':token,Origin:server.url.slice(0,-1)},body:JSON.stringify(payload)})
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).review.status,'reviewed')
  assert.equal(git(f.repository,['rev-parse','HEAD']),baseline)
})

test('a fresh wave stops after its second V failure without scheduling a third M', {timeout:180_000}, async t=>{
  const f=await waveFixture({failFirst:'always'});t.after(()=>stopManagedSchedulerSupervisor(f.root).catch(()=>{}))
  const wave=await runReadyWave(f.root,{owner:'wave-owner',testSessionId:'review-limit-test',testMaxRuntimeSeconds:180})
  assert.equal(wave.execution_mode,'batch_two_rounds')
  assert.equal(wave.verification_round,2)
  assert.equal(wave.execution_status,'completed_with_failures')
  assert.match(wave.block_reason,/second verification round.*TASK-REVIEW-1:waiting_human_review/)
  assert.deepEqual(wave.results.filter(item=>item.task_id===f.taskIds[0]&&item.role==='M').length,2)
  assert.deepEqual(wave.results.filter(item=>item.task_id===f.taskIds[0]&&item.role==='V').length,2)
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'waiting_human_review')
  assert.equal(wave.results.some(item=>item.role==='R'&&item.task_id===f.taskIds[1]),true,'independent Task completes its review')
})

test('ordinary needs_user lets independent Tasks reach R and keeps unreviewed Tasks parked', {timeout:120_000}, async t=>{
  const f=await waveFixture({blockFirst:true,failFirst:false});t.after(()=>stopManagedSchedulerSupervisor(f.root).catch(()=>{}))
  const wave=await runReadyWave(f.root,{owner:'wave-owner',testSessionId:'review-suspension-test',testMaxRuntimeSeconds:120})
  assert.equal(wave.status,'awaiting_wave_review')
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'waiting_human_review')
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[1])).stage,'candidate')
  assert.ok(wave.results.some(item=>item.task_id===f.taskIds[1]&&item.role==='R'))
  assert.equal((await schedulerControlStatus(f.root)).project_leases.filter(item=>item.status==='active').length,0)
  const record=await readWaveReview(f.root,wave.wave_id)
  await decideWaveReview(f.root,wave.wave_id,{bundle_hash:record.bundle.bundle_hash,request_id:randomUUID(),actor:'owner',note:'仅接受独立任务，其他项暂缓',choices:[{task_id:f.taskIds[1],action:'accept'},{task_id:f.taskIds[0],action:'defer'}]})
  assert.ok(await taskWaveReviewHold(f.root,f.taskIds[0]))
  assert.equal((await planReadyWave(f.root)).ready.length,0)
  const refreshed=await refreshWaveReview(f.root,wave.wave_id)
  assert.equal(refreshed.tasks.find(item=>item.task_id===f.taskIds[0]).outcome,'needs_user')
  const released=await decideWaveReview(f.root,refreshed.wave_id,{bundle_hash:refreshed.bundle_hash,request_id:randomUUID(),actor:'owner',note:'按原范围修复并批准下一波',choices:[{task_id:f.taskIds[0],action:'return_to_m'}],authorize_next:true,next_plan_hash:refreshed.next_plan.plan_hash})
  await pauseSchedulerControl(f.root)
  await assert.rejects(runAuthorizedWave(f.root,released.decision.authorization_id),/control changed/)
  const revisedBudget=await configureWaveBudget(f.root,{maxParallel:2,maxElapsedSeconds:150,maxTokens:1500,maxCostUsd:2})
  const recovery=await refreshWaveReview(f.root,refreshed.wave_id)
  assert.deepEqual(recovery.next_plan.budget,revisedBudget)
  assert.deepEqual(recovery.tasks.map(item=>item.task_id),[f.taskIds[0]])
  await assert.rejects(runAuthorizedWave(f.root,released.decision.authorization_id),/already consumed/)
  const resumed=await decideWaveReview(f.root,recovery.wave_id,{bundle_hash:recovery.bundle_hash,request_id:randomUUID(),actor:'owner',note:'明确批准恢复原范围的调度',choices:[{task_id:f.taskIds[0],action:'continue'}],authorize_next:true,next_plan_hash:recovery.next_plan.plan_hash})
  const next=await runAuthorizedWave(f.root,resumed.decision.authorization_id,{testSessionId:'review-suspension-test',testMaxRuntimeSeconds:120})
  assert.equal(next.status,'awaiting_wave_review',JSON.stringify(next))
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'candidate')
  assert.equal((await schedulerControlStatus(f.root)).control.paused,false)
})

test('missing RESULT fields are rejected and explicit rework releases old invalid results for a fresh V/R', {timeout:150_000}, async t=>{
  const f=await waveFixture({malformedFirst:true,failFirst:false});t.after(()=>stopManagedSchedulerSupervisor(f.root).catch(()=>{}))
  const wave=await runReadyWave(f.root,{owner:'wave-owner',testSessionId:'malformed-review-test',testMaxRuntimeSeconds:150})
  const invalid=wave.results.find(item=>item.task_id===f.taskIds[0]&&item.role==='V')
  assert.equal(invalid.result_status,'invalid')
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'plan_compiled')
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[1])).stage,'candidate')
  const record=await readWaveReview(f.root,wave.wave_id)
  const decision=await decideWaveReview(f.root,wave.wave_id,{bundle_hash:record.bundle.bundle_hash,request_id:randomUUID(),actor:'owner',note:'修复不完整报告并复验原范围',choices:[{task_id:f.taskIds[0],action:'return_to_m'},{task_id:f.taskIds[1],action:'accept'}],authorize_next:true,next_plan_hash:record.bundle.next_plan.plan_hash})
  const next=await runAuthorizedWave(f.root,decision.decision.authorization_id,{testSessionId:'malformed-review-test',testMaxRuntimeSeconds:150})
  assert.equal(next.status,'awaiting_wave_review',JSON.stringify(next))
  assert.deepEqual(next.results.map(item=>item.role),['M','V','R'])
  assert.equal((await readAcceptanceRun(f.root,f.taskIds[0])).stage,'candidate')
})


test('older pending reviews remain listed and damaged records do not hide valid reviews',async t=>{
  const f=await waveFixture({failFirst:false});t.after(()=>rm(f.root,{recursive:true,force:true}));const dir=path.join(f.root,'.spec-loop/scheduler/wave-reviews')
  await createWaveReview(f.root,{wave_id:'WAVE-1700000000000-pending',planned_tasks:f.taskIds,budget:{}})
  for(let n=1;n<=21;n++){const bundle=await createWaveReview(f.root,{wave_id:`WAVE-${1700000000000+n}-history`,planned_tasks:[],budget:{}}),file=path.join(dir,bundle.wave_id+'.json'),record=JSON.parse(await readFile(file,'utf8'));record.status='reviewed';await writeFile(file,JSON.stringify(record))}
  await writeFile(path.join(dir,'WAVE-9999999999999-damaged.json'),'{')
  const reviews=await listWaveReviews(f.root);assert.equal(reviews[0].wave_id,'WAVE-1700000000000-pending');assert.equal(reviews.filter(item=>item.status==='reviewed').length,20);assert.equal(reviews.find(item=>item.status==='invalid').wave_id,'WAVE-9999999999999-damaged')
})
