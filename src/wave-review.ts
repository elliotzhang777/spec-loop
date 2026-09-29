import path from 'node:path';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startManagedProcess } from './managed-process.js';
import { inspectProcess, processStartedAt, requireProcessIdentity } from './process-control.js';
import { z } from 'zod';
import { acceptanceReviewFacts, returnAcceptanceToMaker } from './acceptance-loop.js';
import { atomicWriteMany, assertNoSecrets, sha256 } from './files.js';
import { readGateConfig } from './execution.js';
import { readProject } from './project.js';
import { decideVisualReview, validateRequiredHumanReviews, validImage } from './review.js';
import { readState } from './task.js';
import { withOwnedDirectoryLock } from './owned-lock.js';

const taskId = z.string().regex(/^(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*$/);
const waveId = z.string().regex(/^WAVE-[A-Za-z0-9-]{1,120}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const taskHoldSchema = z.discriminatedUnion('status', [
  z.object({schema_version:z.literal(1),task_id:taskId,wave_id:waveId,bundle_hash:digest,facts_hash:digest,status:z.literal('awaiting_wave_review')}).strict(),
  z.object({schema_version:z.literal(1),task_id:taskId,wave_id:waveId,bundle_hash:digest,status:z.enum(['accepted','released']),decision_id:z.uuid()}).strict(),
]);
const choiceSchema = z.object({task_id:taskId,action:z.enum(['accept','return_to_m','continue','defer']),reauthorize_budget:z.boolean().default(false),heavy_accepted:z.boolean().default(false),visual:z.array(z.object({review_id:z.string().min(1),request_hash:digest,result:z.enum(['approved','rejected'])}).strict()).default([])}).strict();
export const waveDecisionSchema = z.object({bundle_hash:digest,request_id:z.uuid(),actor:z.string().trim().min(2).max(100),note:z.string().trim().min(3).max(1000),choices:z.array(choiceSchema).min(1).max(200),authorize_next:z.boolean().default(false),next_plan_hash:digest.optional()}).strict();
type Facts = Awaited<ReturnType<typeof acceptanceReviewFacts>>;
type BundleTask = {task_id:string;facts:Facts|null;facts_hash:string;diagnostics:string[];outcome:string;usage:{tokens:number;cost_usd:number|null;recorded:boolean};elapsed_ms:number|null;failures:string[]};
export type WaveReviewBundle = {schema_version:1;wave_id:string;source_wave_id?:string;project_id:string;created_at:string;expires_at:string;execution_status:string;execution_mode?:string;phase?:string|null;verification_round?:number|null;max_verification_rounds?:number|null;block_reason?:string|null;tasks:BundleTask[];next_plan:{task_ids:string[];contract_hashes:Record<string,string>;gate_hash:string;gate_plan?:Awaited<ReturnType<typeof readGateConfig>>;budget:unknown;plan_hash:string};bundle_hash:string};
type ReviewRecord = {schema_version:1;bundle:WaveReviewBundle;status:'awaiting_wave_review'|'applying'|'reviewed';decision: (z.infer<typeof waveDecisionSchema>&{decided_at:string;authorization_id:string|null;applied:string[];request_hash:string})|null};
const directory = (root:string)=>path.join(root,'.spec-loop','scheduler','wave-reviews');
const reviewFile = (root:string,id:string)=>path.join(directory(root),`${waveId.parse(id)}.json`);
const holdFile = (root:string,id:string)=>path.join(directory(root),'tasks',`${taskId.parse(id)}.json`);
const authFile = (root:string,id:string)=>path.join(directory(root),'authorizations',`${z.uuid().parse(id)}.json`);
const json = (value:unknown)=>`${JSON.stringify(value,null,2)}\n`;
async function readJson(file:string) {
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1_048_576)throw new Error('invalid wave review record');
  return JSON.parse(await readFile(file,'utf8'));
}
async function reviewLock<T>(root:string,work:()=>Promise<T>) { return withOwnedDirectoryLock(path.join(directory(root),'mutex'),{name:'wave review',maxWaitMs:5_000},work); }
function bundleHash(bundle:Omit<WaveReviewBundle,'bundle_hash'>|WaveReviewBundle) { const {bundle_hash:_,...input}=bundle as WaveReviewBundle;return sha256(JSON.stringify(input)); }
async function readRecord(root:string,id:string):Promise<ReviewRecord> {
  const record=await readJson(reviewFile(root,id)) as ReviewRecord;
  if(record.schema_version!==1||record.bundle.wave_id!==id||bundleHash(record.bundle)!==record.bundle.bundle_hash||record.bundle.project_id!==(await readProject(root)).project_id)throw new Error('wave review integrity failure');
  return record;
}
async function readTaskWaveReviewMarker(root:string,id:string) {
  let raw:unknown;
  try { raw=await readJson(holdFile(root,id)); }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  const parsed=taskHoldSchema.safeParse(raw);
  if(!parsed.success||parsed.data.task_id!==id)throw new Error('invalid wave review hold');
  const hold=parsed.data;
  const review=await readRecord(root,hold.wave_id).catch(()=>{throw new Error('wave review hold binding is invalid')});
  const item=Array.isArray(review.bundle.tasks)?review.bundle.tasks.find(item=>item.task_id===id):null;
  if(review.bundle.bundle_hash!==hold.bundle_hash||!item)throw new Error('wave review hold binding is invalid');
  if(hold.status==='awaiting_wave_review'){
    if(item.facts_hash!==hold.facts_hash)throw new Error('wave review hold binding is invalid');
    return hold;
  }
  const decision=review.decision,choices=decision?.choices;
  const matching=Array.isArray(choices)?choices.filter(choice=>choice.task_id===id):[];
  const choice=matching.length===1?matching[0]:null;
  const validAction=hold.status==='accepted'?choice?.action==='accept':choice?.action==='return_to_m'||choice?.action==='continue';
  if(review.status!=='reviewed'||decision?.request_id!==hold.decision_id||decision.bundle_hash!==hold.bundle_hash||!Array.isArray(decision.applied)||!decision.applied.includes(id)||!validAction)throw new Error('wave review hold binding is invalid');
  return hold;
}
export async function taskWaveReviewHold(root:string,id:string) {
  const hold=await readTaskWaveReviewMarker(root,id);
  return hold?.status==='awaiting_wave_review'?hold:null;
}

export async function createWaveReview(root:string,wave:Record<string,any>,options:{expectedHoldWaveId?:string;projectLease?:{lease_id:string;fencing_token:number};deadlineAt?:number}={}) {
  const id=waveId.parse(wave.wave_id),ids=[...new Set<string>(wave.authorized_tasks??wave.planned_tasks??[])];
  if(ids.length>200)throw new Error('wave review supports at most 200 approved Tasks');
  return reviewLock(root,async()=>{
    const current=async()=>{if(options.deadlineAt&&Date.now()>=options.deadlineAt)throw new Error('wave review creation deadline reached');if(options.projectLease)await (await import('./scheduler-control.js')).requireProjectLease(root,options.projectLease.lease_id,options.projectLease.fencing_token);};await current();
    try { return (await readRecord(root,id)).bundle; } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    // Publish under the same mutex as decisions. A delayed refresh or old
    // wave must never replace a hold that already belongs to a newer review.
    for(const task of ids){
      const hold=await readTaskWaveReviewMarker(root,task);
      const mayReplace=options.expectedHoldWaveId
        ?hold?.wave_id===options.expectedHoldWaveId&&['awaiting_wave_review','released'].includes(hold.status)
        :!hold||hold.status==='released';
      if(!mayReplace)throw new Error(`${task}: another review owns this Task`);
    }
    const tasks:BundleTask[]=[];
    for(const id of ids.sort()){
      await current();
      let facts:Facts|null=null;const diagnostics:string[]=[];
      try{facts=await acceptanceReviewFacts(root,id);diagnostics.push(...facts.diagnostics);}catch(error){diagnostics.push((error as Error).message.slice(0,500));}
      const results=(wave.results??[]).filter((item:any)=>item.task_id===id),usage=results.map((item:any)=>item.usage),slo=wave.slo?.[id];
      tasks.push({task_id:id,facts,facts_hash:sha256(JSON.stringify(facts)),diagnostics,outcome:diagnostics.length?'invalid':facts?.stage==='candidate'?'candidate':facts?.stage==='waiting_human_review'?'needs_user':'unfinished',usage:{tokens:usage.reduce((sum:number,item:any)=>sum+(item?.total_tokens??0),0),cost_usd:usage.every((item:any)=>typeof item?.cost_usd==='number')?usage.reduce((sum:number,item:any)=>sum+item.cost_usd,0):null,recorded:usage.length>0&&usage.every((item:any)=>item?.recorded&&item.cost_usd!==null)},elapsed_ms:typeof slo?.elapsed_ms==='number'?slo.elapsed_ms:null,failures:results.filter((item:any)=>item.status!=='succeeded'||item.result_status==='invalid'||item.acceptance_verdict==='fail').map((item:any)=>String(item.result_error??item.error??item.acceptance_message??`${item.role}: ${item.status}`)).slice(-20)});
    }
    const gatePlan=await readGateConfig(root),next={task_ids:ids.sort(),contract_hashes:Object.fromEntries(tasks.filter(item=>item.facts).map(item=>[item.task_id,item.facts!.contract_hash])),gate_hash:sha256(JSON.stringify(gatePlan)),gate_plan:gatePlan,budget:wave.budget};
    const base={schema_version:1 as const,wave_id:id,source_wave_id:wave.source_wave_id??id,project_id:(await readProject(root)).project_id,created_at:new Date().toISOString(),expires_at:new Date(Date.now()+24*3_600_000).toISOString(),execution_status:String(wave.execution_status??wave.status),...(wave.execution_mode==='batch_two_rounds'?{execution_mode:wave.execution_mode,phase:wave.phase??null,verification_round:wave.verification_round??null,max_verification_rounds:2,block_reason:wave.block_reason??null}:{}),tasks,next_plan:{...next,plan_hash:sha256(JSON.stringify(next))}};
    const bundle:WaveReviewBundle={...base,bundle_hash:bundleHash(base)},record:ReviewRecord={schema_version:1,bundle,status:'awaiting_wave_review',decision:null};
    assertNoSecrets(JSON.stringify(bundle),'wave review');
    if(Buffer.byteLength(json(record))>1_048_576)throw new Error('wave review exceeds bounded record size');
    await current();
    await atomicWriteMany(root,[{file:reviewFile(root,id),content:json(record)},...tasks.map(item=>({file:holdFile(root,item.task_id),content:json({schema_version:1,task_id:item.task_id,wave_id:id,bundle_hash:bundle.bundle_hash,facts_hash:item.facts_hash,status:'awaiting_wave_review'})}))]);
    return bundle;
  });
}

export async function readWaveReview(root:string,id:string) {return readRecord(root,id);}

export async function finalizeWaveReview(root:string,id:string) {
  const file=path.join(root,'.spec-loop','scheduler','wave-runs',`${waveId.parse(id)}.json`),wave=await readJson(file);
  if(wave.status!=='finalizing'||!Number.isFinite(Date.parse(wave.finalization_deadline_at))||Date.parse(wave.finalization_deadline_at)<=Date.now())throw new Error('wave finalization is stale or expired');
  const scheduler=await import('./scheduler-control.js'),previous=wave.finalization_project_lease;let lease;
  try{lease=await scheduler.renewProjectLease(root,{leaseId:previous.lease_id,fencingToken:previous.fencing_token,ownerNonce:previous.owner_nonce,ttlSeconds:30,notAfter:new Date(Date.now()+30_000).toISOString()});}
  catch(error){if(!/stale or foreign/.test((error as Error).message))throw error;lease=await scheduler.acquireProjectLease(root,{owner:wave.owner,idempotencyKey:`${id}:finalization`,ttlSeconds:30,purpose:'review_finalization'});}
  try{
  const bundle=await createWaveReview(root,wave,{projectLease:lease,deadlineAt:Date.parse(wave.finalization_deadline_at)}),updated={...wave,status:['budget_stopped','usage_unknown'].includes(wave.execution_status)?wave.execution_status:'awaiting_wave_review',review_state:'awaiting_wave_review',review_bundle_hash:bundle.bundle_hash,finalized_at:new Date().toISOString()};
  if(Date.parse(wave.finalization_deadline_at)<=Date.now())throw new Error('wave finalization deadline reached');
  const current=await readJson(file);if(current.status!=='finalizing'||current.finalization_deadline_at!==wave.finalization_deadline_at)throw new Error('wave finalization generation changed');
  await atomicWriteMany(root,[{file,content:json(updated)}]);return {wave_id:id,bundle_hash:bundle.bundle_hash};
  }finally{await scheduler.releaseProjectLease(root,lease.lease_id,lease.fencing_token);}
}

export async function rebuildWaveReview(root:string,id:string) {
  const file=path.join(root,'.spec-loop','scheduler','wave-runs',`${waveId.parse(id)}.json`);
  await reviewLock(root,async()=>{
    const wave=await readJson(file),control=await (await import('./scheduler-control.js')).schedulerControlStatus(root);
    if(wave.status!=='finalization_incomplete'||wave.finalizer_stop_verified!==true)throw new Error('only a verified stopped finalizer may be rebuilt');
    if(!control.control.paused||control.control.killed||control.project_leases.some(item=>item.status==='active'&&Date.parse(item.expires_at)>Date.now()))throw new Error('pause and reconcile active execution before rebuilding the review');
    await atomicWriteMany(root,[{file,content:json({...wave,status:'finalizing',finalization_deadline_at:new Date(Date.now()+15_000).toISOString()})}]);
  });
  const child=startManagedProcess({bin:process.execPath,args:[fileURLToPath(new URL('./cli.js',import.meta.url)),'_wave-review-finalize',root,'--wave',id],cwd:root,timeoutMs:15_000,terminationTimeoutMs:1000,terminationGraceMs:100,maxCaptureBytes:64_000}),result=await child.completion;
  if(result.code===0)return readRecord(root,id);
  const stopped=await child.terminate({timeoutMs:1000,graceMs:100}),current=await readJson(file);await atomicWriteMany(root,[{file,content:json({...current,status:'finalization_incomplete',finalizer_stop_verified:stopped,finalization_error:result.stderr.slice(-1000)||'review rebuild failed'})}]);throw new Error('wave review rebuild remains incomplete');
}
export async function listWaveReviews(root:string) {
  const names=(await readdir(directory(root)).catch(error=>{if(error.code==='ENOENT')return[];throw error;})).filter(name=>/^WAVE-[A-Za-z0-9-]+\.json$/.test(name));
  type Item={wave_id:string;status:ReviewRecord['status'];execution_status:string;bundle_hash:string;created_at:string;expires_at:string;task_total:number;candidates:number;pending:number};
  const pending:Item[]=[],history:Item[]=[],invalid:Array<{wave_id:string;status:'invalid';error:string;created_at:null;task_total:number}>=[];
  for(const name of names){
    try{const record=await readRecord(root,name.slice(0,-5)),item={wave_id:record.bundle.wave_id,status:record.status,execution_status:record.bundle.execution_status,bundle_hash:record.bundle.bundle_hash,created_at:record.bundle.created_at,expires_at:record.bundle.expires_at,task_total:record.bundle.tasks.length,candidates:record.bundle.tasks.filter(item=>item.outcome==='candidate').length,pending:record.bundle.tasks.filter(item=>item.outcome!=='candidate').length};
      (record.status==='reviewed'?history:pending).push(item);
    }catch(error){invalid.push({wave_id:name.slice(0,-5),status:'invalid' as const,error:(error as Error).message.slice(0,500),created_at:null,task_total:0});}
  }
  const newest=(a:{created_at:string},b:{created_at:string})=>b.created_at.localeCompare(a.created_at);
  return [...pending.sort(newest),...history.sort(newest).slice(0,20),...invalid];
}

export async function refreshWaveReview(root:string,id:string) {
  // Never edit an old hash or reuse its decision. Refresh is a new immutable
  // review generation, including new HEADs, evidence and expiry.
  const current=await readRecord(root,id);if(current.decision?.authorization_id)await reconcileWaveAuthorization(root,current.decision.authorization_id);if(current.status==='applying')throw new Error('finish the in-flight decision before refreshing');
  const wave=await readJson(path.join(root,'.spec-loop','scheduler','wave-runs',`${waveId.parse(current.bundle.source_wave_id??id)}.json`));
  const pending=[] as string[];for(const item of current.bundle.tasks){const hold=await taskWaveReviewHold(root,item.task_id);if(hold?.wave_id===id)pending.push(item.task_id);}
  // A launch that failed, or an unused grant invalidated by changed controls,
  // must remain recoverable from the same review screen. Revoke that grant
  // before creating a new plan; never include Tasks owned by a newer wave.
  if(current.decision?.authorization_id)await reviewLock(root,async()=>{
    const file=authFile(root,current.decision!.authorization_id!),auth=await readJson(file);
    if(!['authorized','failed'].includes(auth.status))return;
    for(const task of auth.task_ids){const hold=await readTaskWaveReviewMarker(root,task);if(!hold)throw new Error('wave review hold missing');if(hold.wave_id===id&&hold.status==='released'&&!pending.includes(task))pending.push(task);}
    if(pending.length){auth.status='revoked';await atomicWriteMany(root,[{file,content:json(auth)}]);}
  });
  if(!pending.length)throw new Error('no pending Tasks remain in this review, or a newer review owns them');
  return createWaveReview(root,{...wave,budget:await (await import('./scheduler-control.js')).readWaveBudget(root),source_wave_id:current.bundle.source_wave_id??id,wave_id:`WAVE-${Date.now()}-${randomUUID()}`,authorized_tasks:pending},{expectedHoldWaveId:id});
}

export async function decideWaveReview(root:string,id:string,inputValue:unknown) {
  const input=waveDecisionSchema.parse(inputValue),requestHash=sha256(JSON.stringify(input));assertNoSecrets(`${input.actor}\n${input.note}`,'wave review decision');
  return reviewLock(root,async()=>{
    const record=await readRecord(root,id);
    if(record.decision){if(record.decision.request_id!==input.request_id||record.decision.request_hash!==requestHash)throw new Error('wave review was already consumed by a different decision');if(record.status==='reviewed')return record;}
    if(record.bundle.bundle_hash!==input.bundle_hash)throw new Error('stale wave review hash');
    if(!record.decision&&Date.parse(record.bundle.expires_at)<=Date.now())throw new Error('wave review expired; refresh before deciding');
    if(new Set(input.choices.map(item=>item.task_id)).size!==input.choices.length)throw new Error('duplicate Task decision');
    if(input.authorize_next&&!input.choices.some(choice=>['return_to_m','continue'].includes(choice.action)))throw new Error('next wave authorization requires at least one returned Task');
    if(input.authorize_next&&(!record.decision)&&(record.bundle.next_plan.gate_hash!==sha256(JSON.stringify(await readGateConfig(root)))||JSON.stringify(record.bundle.next_plan.budget)!==JSON.stringify(await (await import('./scheduler-control.js')).readWaveBudget(root))))throw new Error('Gate plan or budget changed; refresh the next wave plan');
    if(input.authorize_next&&input.next_plan_hash!==record.bundle.next_plan.plan_hash)throw new Error('next wave plan hash mismatch');
    for(const choice of input.choices){
      const item=record.bundle.tasks.find(item=>item.task_id===choice.task_id);if(!item)throw new Error('Task is not present in the bound review');if(!item.facts){if(choice.action!=='defer'||choice.visual.length||choice.reauthorize_budget)throw new Error('an unavailable Task may only be deferred');continue;}
      if(record.decision?.applied.includes(choice.task_id))continue;
      const current=await acceptanceReviewFacts(root,choice.task_id);
      if(['return_to_m','continue'].includes(choice.action)&&current.invocations.some(item=>item.status==='running'))throw new Error('a running Provider must stop before rework or continuation');
      const comparable=structuredClone(current);
      if(record.decision)for(const visual of choice.visual){const request=current.visual.find(item=>item.review_id===visual.review_id);const effect=await readJson(path.join(root,item.facts.task_root,'controller-effects',`${input.request_id}-${choice.task_id}-${visual.review_id}.json`)).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(effect?.decision_hash===request?.decision_hash&&effect?.result===visual.result)comparable.visual=comparable.visual.map(item=>item.review_id===visual.review_id?record.bundle.tasks.find(item=>item.task_id===choice.task_id)!.facts!.visual.find(item=>item.review_id===visual.review_id)!:item);}

      if(choice.action==='continue'&&!['m_working','m_submitted','plan_compiled','v_passed'].includes(current.stage))throw new Error('only an existing execution stage may continue');
      const resumedAction=choice.action==='return_to_m'&&current.stage==='m_working'&&(await import('./acceptance-loop.js')).readAcceptanceRun;
      const roleReceipt=choice.action==='continue'&&(await Promise.all(['M','V','R'].map(role=>(async()=>{const latest=await (await import('./role-orchestrator.js')).latestRoleInvocation(root,choice.task_id,role as 'M'|'V'|'R');return latest?.last_error===`wave-review:${input.request_id}-${choice.task_id}: continue`;})()))).some(Boolean);
      const actionAlreadyApplied=roleReceipt||resumedAction&&(await resumedAction(root,choice.task_id)).history.some(entry=>entry.artifact===`wave-review:${input.request_id}-${choice.task_id}`);
      if(!actionAlreadyApplied&&sha256(JSON.stringify(comparable))!==item.facts_hash)throw new Error(`${choice.task_id}: review facts changed; refresh before deciding`);
      const hold=await taskWaveReviewHold(root,choice.task_id);if(!hold||hold.bundle_hash!==input.bundle_hash)throw new Error(`${choice.task_id}: another review owns this Task`);
      if(choice.action==='accept'&&(item.outcome!=='candidate'||current.diagnostics.length||!current.clean))throw new Error(`${choice.task_id}: only a fresh, verified Candidate may be accepted`);
      if(choice.action==='accept'&&current.risk==='heavy'&&!choice.heavy_accepted)throw new Error(`${choice.task_id}: explicit Heavy acceptance is required`);
      if(choice.reauthorize_budget&&choice.action!=='return_to_m')throw new Error('budget reauthorization is only valid for return_to_m');
      if(choice.action==='return_to_m'&&!choice.reauthorize_budget&&current.semantic_reworks_used>=current.budgets.max_semantic_reworks)throw new Error(`${choice.task_id}: explicit rework budget reauthorization is required`);
      if(choice.action==='accept')await validateRequiredHumanReviews(path.resolve(root,current.task_root),await readState(path.resolve(root,current.task_root)),current.head!,new Map(choice.visual.filter(item=>item.result==='approved').map(item=>[item.review_id,item.request_hash])));
      for(const visual of choice.visual){const request=current.visual.find(item=>item.review_id===visual.review_id);if(!request||request.request_hash!==visual.request_hash||request.code_revision!==current.head)throw new Error('visual review request is stale');if(choice.action==='accept'&&visual.result!=='approved')throw new Error('a rejected visual review cannot accept a Candidate');}
    }
    if(!record.decision){record.decision={...input,decided_at:new Date().toISOString(),authorization_id:input.authorize_next?randomUUID():null,applied:[],request_hash:requestHash};record.status='applying';await atomicWriteMany(root,[{file:reviewFile(root,id),content:json(record)}]);}
    for(const choice of input.choices){
      if(record.decision.applied.includes(choice.task_id))continue;
      const item=record.bundle.tasks.find(item=>item.task_id===choice.task_id)!;if(!item.facts){record.decision.applied.push(choice.task_id);await atomicWriteMany(root,[{file:reviewFile(root,id),content:json(record)}]);continue;}const taskRoot=path.resolve(root,item.facts.task_root);
      for(const visual of choice.visual)await decideVisualReview(taskRoot,visual.review_id,visual.result,input.actor,input.note,`${input.request_id}-${choice.task_id}-${visual.review_id}`);
      if(choice.action==='accept')await validateRequiredHumanReviews(taskRoot,await readState(taskRoot),item.facts!.head!);
      if(choice.action==='continue'){await (await import('./role-orchestrator.js')).resumeRoleFromWaveReview(root,choice.task_id,`${input.request_id}-${choice.task_id}`);const scheduler=await import('./scheduler-control.js'),status=await scheduler.schedulerControlStatus(root);if(status.task_dispatch.some(item=>item.task_id===choice.task_id&&item.status==='dead_letter'))await scheduler.retryDeadLetter(root,choice.task_id);}
      if(choice.action==='return_to_m'){
        await returnAcceptanceToMaker(root,choice.task_id,input.actor,input.note,`${input.request_id}-${choice.task_id}`,choice.reauthorize_budget);
        await (await import('./role-orchestrator.js')).rejectUnacceptedRolesForRework(root,choice.task_id,`${input.request_id}-${choice.task_id}`);
        const scheduler=await import('./scheduler-control.js'),status=await scheduler.schedulerControlStatus(root);if(status.task_dispatch.some(item=>item.task_id===choice.task_id&&item.status==='dead_letter'))await scheduler.retryDeadLetter(root,choice.task_id);
      }
      record.decision.applied.push(choice.task_id);
      await atomicWriteMany(root,[{file:reviewFile(root,id),content:json(record)}]);
    }
    for(const choice of input.choices.filter(item=>item.action==='accept')){const original=record.bundle.tasks.find(item=>item.task_id===choice.task_id)!.facts!,current=await acceptanceReviewFacts(root,choice.task_id);const normalized={...current,visual:original.visual};if(sha256(JSON.stringify(normalized))!==sha256(JSON.stringify(original)))throw new Error('Candidate changed while applying the review');await validateRequiredHumanReviews(path.resolve(root,current.task_root),await readState(path.resolve(root,current.task_root)),current.head!);}
    const writes=input.choices.filter(choice=>choice.action!=='defer').map(choice=>({file:holdFile(root,choice.task_id),content:json({schema_version:1,task_id:choice.task_id,wave_id:id,bundle_hash:input.bundle_hash,status:choice.action==='accept'?'accepted':'released',decision_id:input.request_id})}));
    if(input.authorize_next){const ids=input.choices.filter(choice=>['return_to_m','continue'].includes(choice.action)).map(choice=>choice.task_id);if(!ids.length)throw new Error('next wave authorization requires at least one returned Task');writes.push({file:authFile(root,record.decision.authorization_id!),content:json({schema_version:1,authorization_id:record.decision.authorization_id,project_id:record.bundle.project_id,task_ids:ids,contract_hashes:record.bundle.next_plan.contract_hashes,gate_hash:record.bundle.next_plan.gate_hash,budget:record.bundle.next_plan.budget,control_hash:sha256(JSON.stringify((await (await import('./scheduler-control.js')).schedulerControlStatus(root)).control)),bundle_hash:input.bundle_hash,actor:input.actor,expires_at:record.bundle.expires_at,status:'authorized',wave_id:null})});}
    record.status='reviewed';writes.push({file:reviewFile(root,id),content:json(record)});await atomicWriteMany(root,writes);return record;
  });
}

export async function reconcileWaveAuthorization(root:string,id:string) {
  return reviewLock(root,async()=>{
    const file=authFile(root,id),auth=await readJson(file);if(!['launching','running'].includes(auth.status))return auth;
    const owner=auth.worker??auth.launcher;
    if(!owner?.pid||!owner?.process_started_at)return {...auth,recovery_status:'identity_unknown'};
    const probe=await inspectProcess(owner.pid,owner.process_started_at);if(probe.status==='alive'||probe.status==='unknown')return {...auth,recovery_status:probe.status};
    const linked=auth.wave_id?await readJson(path.join(root,'.spec-loop','scheduler','wave-runs',`${waveId.parse(auth.wave_id)}.json`)).catch(error=>{if(error.code==='ENOENT')return null;throw error;}):null;
    if(linked?.authorization_id===id&&linked.review_state==='awaiting_wave_review'&&linked.review_bundle_hash){const review=await readRecord(root,linked.wave_id);if(review.bundle.bundle_hash!==linked.review_bundle_hash)throw new Error('completed wave review binding mismatch');auth.status='completed';}
    else{auth.status='failed';auth.error='authorized Worker exited before confirmed wave finalization; reconcile execution facts before retry';}
    auth.recovered_at=new Date().toISOString();auth.recovery_reason=probe.status;await atomicWriteMany(root,[{file,content:json(auth)}]);return auth;
  });
}

export async function reconcileWaveAuthorizations(root:string,deadlineAt=Date.now()+5000) {
  const dir=path.join(directory(root),'authorizations'),names=(await readdir(dir).catch(error=>{if(error.code==='ENOENT')return[];throw error;})).filter(name=>/^[a-f0-9-]{36}\.json$/.test(name)).sort();
  if(!names.length)return [];
  const file=path.join(directory(root),'authorization-recovery-cursor.json'),cursor=await readJson(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),start=Number.isSafeInteger(cursor?.offset)&&cursor.offset>=0?cursor.offset%names.length:0,results=[];
  let count=0;
  for(;count<Math.min(20,names.length)&&Date.now()<deadlineAt;count++){const id=names[(start+count)%names.length].slice(0,-5);try{const value=await reconcileWaveAuthorization(root,id);results.push({authorization_id:id,status:value.status,recovery_status:value.recovery_status??null});}catch(error){results.push({authorization_id:id,status:'recovery_failed',error:(error as Error).message});}}
  await atomicWriteMany(root,[{file,content:json({offset:(start+count)%names.length})}]);return results;
}

export async function runAuthorizedWave(root:string,id:string,options:{testSessionId?:string;testMaxRuntimeSeconds?:number;launchToken?:string}={}) {
  const worker={pid:process.pid,process_started_at:requireProcessIdentity(await processStartedAt(process.pid),'authorized wave Worker')};
  const authorization=await reviewLock(root,async()=>{
    const auth=await readJson(authFile(root,id)),scheduler=await import('./scheduler-control.js');
    if(auth.status!=='authorized'&&!(auth.status==='launching'&&typeof auth.launch_token==='string'&&auth.launch_token===options.launchToken))throw new Error('next wave authorization was already consumed');
    if(auth.project_id!==(await readProject(root)).project_id||Date.parse(auth.expires_at)<=Date.now())throw new Error('next wave authorization is expired or belongs to another Project');
    if(auth.gate_hash!==sha256(JSON.stringify(await readGateConfig(root)))||JSON.stringify(auth.budget)!==JSON.stringify(await scheduler.readWaveBudget(root)))throw new Error('Gate plan or wave budget changed after authorization');
    const control=(await scheduler.schedulerControlStatus(root)).control;if(auth.control_hash!==sha256(JSON.stringify(control)))throw new Error('Scheduler control changed after authorization');
    for(const id of auth.task_ids){const facts=await acceptanceReviewFacts(root,taskId.parse(id));if(facts.contract_hash!==auth.contract_hashes[id])throw new Error('Acceptance Contract changed after authorization');}
    if(control.killed||control.reconcile_required)await scheduler.reconcileSchedulerControl(root);if(control.paused)await scheduler.resumeSchedulerControl(root);
    auth.status='running';auth.worker=worker;auth.started_at=new Date().toISOString();await atomicWriteMany(root,[{file:authFile(root,id),content:json(auth)}]);return auth;
  });
  try{const wave=await (await import('./scheduler-control.js')).runReadyWave(root,{owner:authorization.actor,taskIds:authorization.task_ids,...options,authorizationId:id,onWaveCreated:async waveId=>{authorization.wave_id=waveId;await atomicWriteMany(root,[{file:authFile(root,id),content:json(authorization)}]);}});authorization.status=wave.review_state==='awaiting_wave_review'?'completed':'failed';authorization.wave_id=wave.wave_id;await atomicWriteMany(root,[{file:authFile(root,id),content:json(authorization)}]);return wave;}
  catch(error){authorization.status='failed';authorization.error=(error as Error).message;await atomicWriteMany(root,[{file:authFile(root,id),content:json(authorization)}]);throw error;}
}

export async function launchAuthorizedWave(root:string,id:string) {
  await reconcileWaveAuthorization(root,id);
  return reviewLock(root,async()=>{
    const file=authFile(root,id),auth=await readJson(file);
    if(['launching','running','completed'].includes(auth.status))return{authorization_id:id,status:auth.status,wave_id:auth.wave_id};
    if(auth.status!=='authorized')throw new Error('next wave authorization was already consumed');
    auth.status='launching';auth.launch_token=randomUUID();auth.launcher={pid:process.pid,process_started_at:requireProcessIdentity(await processStartedAt(process.pid),'wave launcher')};auth.launch_started_at=new Date().toISOString();
    await atomicWriteMany(root,[{file,content:json(auth)}]);
    const child=startManagedProcess({bin:process.execPath,args:[fileURLToPath(new URL('./cli.js',import.meta.url)),'scheduler','control','run-approved',root,'--authorization',id,'--launch-token',auth.launch_token,'--json'],cwd:root,timeoutMs:Number((auth.budget as {max_elapsed_seconds:number}).max_elapsed_seconds)*1000+120_000,maxCaptureBytes:256*1024});
    const identity=await child.processStartedAt;
    if(!identity){await child.terminate();const current=await readJson(file);if(current.status==='launching'&&current.launch_token===auth.launch_token){current.status='failed';current.error='cannot establish next wave Worker identity';await atomicWriteMany(root,[{file,content:json(current)}]);}throw new Error('cannot establish next wave Worker identity');}
    const current=await readJson(file);if(current.status==='launching'&&current.launch_token===auth.launch_token){current.worker={pid:child.child.pid,process_started_at:identity};await atomicWriteMany(root,[{file,content:json(current)}]);}
    // The child owns authorization consumption and terminal state. Do not
    // overwrite that state with the parent's earlier launching snapshot.
    void child.completion.then(()=>reconcileWaveAuthorization(root,id)).catch(()=>{});
    return{authorization_id:id,pid:child.child.pid,process_started_at:identity,status:'started'};
  });
}

export async function waveReviewArtifact(root:string,id:string,task:string,hash:string) {
  digest.parse(hash);const record=await readRecord(root,id),item=record.bundle.tasks.find(item=>item.task_id===taskId.parse(task));
  if(!item?.facts)throw new Error('review artifact Task not found');
  const artifact=item.facts.visual.flatMap(item=>item.artifacts).find(item=>item.sha256===hash);if(!artifact)throw new Error('review artifact not found');
  const taskRoot=path.resolve(root,item.facts.task_root);if(!taskRoot.startsWith(path.resolve(root)+path.sep))throw new Error('review Task root escapes Project');const file=path.resolve(taskRoot,artifact.file),info=await lstat(file),actual=await realpath(file);
  if(!file.startsWith(taskRoot+path.sep)||!actual.startsWith(await realpath(taskRoot)+path.sep)||!info.isFile()||info.isSymbolicLink()||info.size>10*1024*1024)throw new Error('invalid review artifact');
  const content=await readFile(file);if(sha256(content)!==hash||!validImage(content,artifact.media_type))throw new Error('review artifact changed');return{content,media_type:artifact.media_type};
}
