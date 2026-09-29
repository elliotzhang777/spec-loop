import { taskWaveReviewHold, reconcileWaveAuthorizations } from './wave-review.js';
import { completeVerifiedTaskStopIntent, runBoundedTaskStops, type WatchdogStopCondition } from './scheduler-stops.js';
import { batchWaveStep, type BatchWavePhase } from './wave-phases.js';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startManagedProcess } from './managed-process.js';
import { z } from 'zod';
import { atomicWriteMany, atomicWriteTelemetry, removeTelemetryFile, exists, sha256 } from './files.js';
import { buildAcceptanceSchedule, cancelAcceptanceRun, readAcceptanceRun, reconcileCandidateBaseline } from './acceptance-loop.js';
import { cancelRoleInvocation, ingestSucceededRoleResult, latestRoleInvocation, prepareRoleInvocation, readRoleInvocation, reconcileRoleInvocation, runRoleInvocation, type RoleInvocation } from './role-orchestrator.js';
import { readProject, scanTasks } from './project.js';
import { readWorkspace } from './execution.js';
import { cancelTask, readState } from './task.js';
import { cancelTaskExecution } from './execution-events.js';
import { inspectProcess, processStartedAt, requireProcessIdentity, terminateProcessTree } from './process-control.js';
import { acquireOwnedDirectoryLock, inspectOwnedDirectoryLock, withOwnedDirectoryLock } from './owned-lock.js';
import { createLatestValueWriter, withOperationTimeout, withAbortableOperationTimeout } from './latest-writer.js';

const controlStateSchema=z.object({schema_version:z.literal(1),paused:z.boolean(),killed:z.boolean(),reconcile_required:z.boolean(),updated_at:z.iso.datetime()}).strict();
const leaseStatusSchema=z.enum(['active','released','expired','killed']);
const projectLeaseSchema=z.object({schema_version:z.literal(1),kind:z.literal('project'),purpose:z.enum(['execution','review_finalization']).default('execution'),lease_id:z.string(),project_id:z.string(),owner:z.string().min(2),owner_nonce:z.string().uuid(),idempotency_key:z.string().min(3),fencing_token:z.number().int().positive(),status:leaseStatusSchema,issued_at:z.iso.datetime(),expires_at:z.iso.datetime(),updated_at:z.iso.datetime()}).strict();
const taskLeaseSchema=z.object({schema_version:z.literal(1),kind:z.literal('task'),lease_id:z.string(),project_lease_id:z.string(),project_fencing_token:z.number().int().positive(),task_id:z.string(),owner:z.string().min(2),owner_nonce:z.string().uuid(),idempotency_key:z.string().min(3),fencing_token:z.number().int().positive(),resources:z.array(z.string()).min(1),action:z.enum(['start_m','start_v','start_r','run_gate']),status:leaseStatusSchema,issued_at:z.iso.datetime(),expires_at:z.iso.datetime(),updated_at:z.iso.datetime()}).strict();
const counterSchema=z.object({schema_version:z.literal(1),next_fencing_token:z.number().int().positive()}).strict();
const waveBudgetSchema=z.object({schema_version:z.literal(1),max_parallel:z.number().int().min(1).max(16),max_elapsed_seconds:z.number().int().min(1).max(3600),max_tokens:z.number().int().positive(),max_cost_usd:z.number().positive(),updated_at:z.iso.datetime()}).strict();
const dispatchStateSchema=z.object({schema_version:z.literal(1),task_id:z.string(),action:z.enum(['start_m','start_v','start_r','run_gate']),status:z.enum(['running','retry_wait','dead_letter','succeeded']),attempt:z.number().int().nonnegative(),max_attempts:z.number().int().positive(),retry_class:z.enum(['infrastructure','deterministic_tool','workflow']).nullable(),failure_fingerprint:z.string().length(64).nullable(),same_fingerprint_count:z.number().int().nonnegative(),next_retry_at:z.iso.datetime().nullable(),last_error:z.string().max(1000).nullable(),last_evidence:z.array(z.string()).max(20),worktree_head:z.string().nullable(),recommended_action:z.string().max(500).nullable(),updated_at:z.iso.datetime()}).strict();
export type ProjectLease=z.infer<typeof projectLeaseSchema>;export type TaskLease=z.infer<typeof taskLeaseSchema>;

const rootDir=(root:string)=>path.join(root,'.spec-loop','scheduler'),stateFile=(root:string)=>path.join(rootDir(root),'CONTROL.json'),counterFile=(root:string)=>path.join(rootDir(root),'COUNTER.json'),budgetFile=(root:string)=>path.join(rootDir(root),'BUDGET.json'),waveDir=(root:string)=>path.join(rootDir(root),'wave-runs');
const projectDir=(root:string)=>path.join(rootDir(root),'project-leases'),taskDir=(root:string)=>path.join(rootDir(root),'task-leases'),dispatchDir=(root:string)=>path.join(rootDir(root),'task-dispatch');
const stopIntentDir=(root:string)=>path.join(rootDir(root),'stop-intents');
const denied=new Set(['merge','push','deploy','credential','credential_write','production_data','external_side_effect','delete','release','publish']);
const exec=promisify(execFile);
const controlWrite=(root:string,values:Array<{file:string;content:string|Buffer}>,label:string)=>withOperationTimeout(atomicWriteMany(root,values),5_000,`${label} control-plane write`);

export async function initSchedulerControl(root:string){await mkdir(projectDir(root),{recursive:true});await mkdir(taskDir(root),{recursive:true});await mkdir(waveDir(root),{recursive:true});await mkdir(dispatchDir(root),{recursive:true});await mkdir(stopIntentDir(root),{recursive:true});if(!(await exists(stateFile(root))))await controlWrite(root,[{file:stateFile(root),content:`${JSON.stringify({schema_version:1,paused:false,killed:false,reconcile_required:false,updated_at:new Date().toISOString()},null,2)}\n`}],'scheduler initialization');if(!(await exists(counterFile(root))))await controlWrite(root,[{file:counterFile(root),content:`${JSON.stringify({schema_version:1,next_fencing_token:1},null,2)}\n`}],'scheduler counter initialization');if(!(await exists(budgetFile(root))))await controlWrite(root,[{file:budgetFile(root),content:`${JSON.stringify({schema_version:1,max_parallel:2,max_elapsed_seconds:1200,max_tokens:250_000,max_cost_usd:10,updated_at:new Date().toISOString()},null,2)}\n`}],'scheduler budget initialization');return controlStateSchema.parse(JSON.parse(await readFile(stateFile(root),'utf8')))}
export async function readWaveBudget(root:string){await initSchedulerControl(root);return waveBudgetSchema.parse(JSON.parse(await readFile(budgetFile(root),'utf8')))}
export async function configureWaveBudget(root:string,input:{maxParallel:number;maxElapsedSeconds:number;maxTokens:number;maxCostUsd:number}){await initSchedulerControl(root);const value=waveBudgetSchema.parse({schema_version:1,max_parallel:input.maxParallel,max_elapsed_seconds:input.maxElapsedSeconds,max_tokens:input.maxTokens,max_cost_usd:input.maxCostUsd,updated_at:new Date().toISOString()});await controlWrite(root,[{file:budgetFile(root),content:`${JSON.stringify(value,null,2)}\n`}],'wave budget');return value}
async function lock<T>(root:string,operation:()=>Promise<T>):Promise<T>{
  await mkdir(rootDir(root),{recursive:true});
  return withOwnedDirectoryLock(path.join(rootDir(root),'mutex'),{
    name:'scheduler control',maxWaitMs:10_000,pollMs:10,missingOwnerProtectionMs:5_000,
    telemetryFile:path.join(rootDir(root),'control-health','scheduler-control-lock.json'),
  },operation);
}
async function state(root:string){await initSchedulerControl(root);return controlStateSchema.parse(JSON.parse(await readFile(stateFile(root),'utf8')))}
async function writeState(root:string,value:z.infer<typeof controlStateSchema>){await controlWrite(root,[{file:stateFile(root),content:`${JSON.stringify(controlStateSchema.parse(value),null,2)}\n`}],'scheduler state')}
async function nextToken(root:string){const value=counterSchema.parse(JSON.parse(await readFile(counterFile(root),'utf8'))),token=value.next_fencing_token;await controlWrite(root,[{file:counterFile(root),content:`${JSON.stringify({schema_version:1,next_fencing_token:token+1},null,2)}\n`}],'fencing counter');return token}
async function listLeases<T>(dir:string,schema:z.ZodType<T>):Promise<T[]>{if(!(await exists(dir)))return[];const result=[] as T[];for(const name of (await readdir(dir)).filter(name=>name.endsWith('.json')).sort())result.push(schema.parse(JSON.parse(await readFile(path.join(dir,name),'utf8'))));return result}
function active<T extends {status:z.infer<typeof leaseStatusSchema>;expires_at:string}>(lease:T){return lease.status==='active'&&Date.parse(lease.expires_at)>Date.now()}
async function writeProjectLease(root:string,value:ProjectLease){await controlWrite(root,[{file:path.join(projectDir(root),`${value.lease_id}.json`),content:`${JSON.stringify(projectLeaseSchema.parse(value),null,2)}\n`}],'Project Lease')}
async function writeTaskLease(root:string,value:TaskLease){await controlWrite(root,[{file:path.join(taskDir(root),`${value.lease_id}.json`),content:`${JSON.stringify(taskLeaseSchema.parse(value),null,2)}\n`}],'Task Lease')}
function ttl(value:number){if(!Number.isInteger(value)||value<1||value>3600)throw new Error('lease ttl must be 1–3600 seconds');return value}
type ResourceClaim={raw:string;kind:'repo'|'branch'|'module'|'tool';resourcePath:string;mode:'read'|'write'|'capacity';units:number;capacity:number};
function parseResourceClaim(raw:string):ResourceClaim{
  const match=raw.trim().match(/^(repo|branch|module|tool):([A-Za-z0-9_./-]+?)(?:#(read|write|([1-9][0-9]*)\/([1-9][0-9]*)))?$/);if(!match||match[2].split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('resource claims must use safe repo:/branch:/module:/tool: identifiers with optional #read, #write, or #units/capacity');
  const kind=match[1] as ResourceClaim['kind'],mode=match[3]==='read'?'read':match[3]&&match[4]?'capacity':'write',units=match[4]?Number(match[4]):1,capacity=match[5]?Number(match[5]):1;
  if(mode==='capacity'&&kind!=='tool')throw new Error('capacity resource claims are supported only for tool: resources');if(units>capacity)throw new Error('resource capacity units cannot exceed capacity');
  return{raw:raw.trim(),kind,resourcePath:match[2],mode,units,capacity};
}
function normalizeResources(values:string[]){const result=[...new Set(values.map(value=>value.trim()))].sort();if(!result.length)throw new Error('at least one resource claim is required');for(const value of result)parseResourceClaim(value);return result}
function pathOverlaps(left:string,right:string){return left===right||left.startsWith(`${right}/`)||right.startsWith(`${left}/`)}
function claimsOverlap(left:ResourceClaim,right:ResourceClaim){if(left.kind===right.kind)return pathOverlaps(left.resourcePath,right.resourcePath);if(left.kind==='repo'&&right.kind==='branch')return right.resourcePath===left.resourcePath||right.resourcePath.startsWith(`${left.resourcePath}/`);if(right.kind==='repo'&&left.kind==='branch')return left.resourcePath===right.resourcePath||left.resourcePath.startsWith(`${right.resourcePath}/`);return false}
export function resourceClaimsConflict(leftValues:string[],rightValues:string[]):boolean{
  const left=leftValues.map(parseResourceClaim),right=rightValues.map(parseResourceClaim);
  for(const a of left)for(const b of right){if(!claimsOverlap(a,b))continue;if(a.mode==='read'&&b.mode==='read')continue;if(a.mode==='capacity'&&b.mode==='capacity'&&a.kind==='tool'&&b.kind==='tool'&&a.resourcePath===b.resourcePath&&a.units+b.units<=Math.min(a.capacity,b.capacity))continue;return true}return false;
}

export async function acquireProjectLease(root:string,input:{owner:string;idempotencyKey:string;ttlSeconds:number;purpose?:'execution'|'review_finalization'}):Promise<ProjectLease>{await initSchedulerControl(root);return lock(root,async()=>{const currentState=await state(root);if(currentState.killed||((currentState.paused||currentState.reconcile_required)&&input.purpose!=='review_finalization'))throw new Error('scheduler is paused, killed, or requires reconcile');const leases=await listLeases(projectDir(root),projectLeaseSchema),same=leases.find(item=>active(item)&&item.idempotency_key===input.idempotencyKey&&item.owner===input.owner);if(same){if(same.purpose!==(input.purpose??'execution'))throw new Error('Project lease purpose changed');return same;}if(leases.some(active))throw new Error('Project already has an active scheduler lease');const now=new Date(),token=await nextToken(root),value=projectLeaseSchema.parse({schema_version:1,kind:'project',purpose:input.purpose??'execution',lease_id:`PL-${randomUUID()}`,project_id:(await readProject(root)).project_id,owner:input.owner,owner_nonce:randomUUID(),idempotency_key:input.idempotencyKey,fencing_token:token,status:'active',issued_at:now.toISOString(),expires_at:new Date(now.getTime()+ttl(input.ttlSeconds)*1000).toISOString(),updated_at:now.toISOString()});await writeProjectLease(root,value);return value})}

export async function requireProjectLease(root:string,id:string,token:number){const lease=projectLeaseSchema.parse(JSON.parse(await readFile(path.join(projectDir(root),`${id}.json`),'utf8')));if(!active(lease)||lease.fencing_token!==token)throw new Error('stale or inactive Project lease fencing token');return lease}
export async function acquireTaskLease(root:string,input:{projectLeaseId:string;projectFencingToken:number;taskId:string;owner:string;idempotencyKey:string;ttlSeconds:number;resources:string[];action:'start_m'|'start_v'|'start_r'|'run_gate'}):Promise<TaskLease>{await initSchedulerControl(root);return taskStopLock(root,input.taskId,()=>lock(root,async()=>{const currentState=await state(root);if(await taskWaveReviewHold(root,input.taskId))throw new Error('Task awaits wave review');if(currentState.paused||currentState.killed||currentState.reconcile_required)throw new Error('scheduler is paused, killed, or requires reconcile');if((await requireProjectLease(root,input.projectLeaseId,input.projectFencingToken)).purpose!=='execution')throw new Error('review finalization lease cannot dispatch Task work');const run=await readAcceptanceRun(root,input.taskId),allowed={start_m:'m_working',start_v:'plan_compiled',start_r:'v_passed',run_gate:'plan_compiled'}[input.action];if(run.stage!==allowed)throw new Error(`${input.action} is not ready from ${run.stage}`);const schedule=await buildAcceptanceSchedule(root),scheduled=schedule.tasks.find(item=>item.task_id===input.taskId);if(scheduled?.blocked_by.length)throw new Error(`${input.taskId} is blocked by ${scheduled.blocked_by.join(', ')}`);const resources=normalizeResources(input.resources),leases=await listLeases(taskDir(root),taskLeaseSchema),same=leases.find(item=>active(item)&&item.idempotency_key===input.idempotencyKey);if(same){if(same.task_id!==input.taskId||same.action!==input.action||JSON.stringify(same.resources)!==JSON.stringify(resources))throw new Error('task lease idempotency key was reused with different facts');return same}const activeLeases=leases.filter(active);if(activeLeases.some(item=>item.task_id===input.taskId))throw new Error('Task already has an active lease');const conflict=findResourceConflict(activeLeases,resources);if(conflict)throw new Error(`resources conflict with ${conflict.task_id}: ${conflict.resources.join(', ')} <> ${resources.join(', ')}`);const now=new Date(),token=await nextToken(root),value=taskLeaseSchema.parse({schema_version:1,kind:'task',lease_id:`TL-${randomUUID()}`,project_lease_id:input.projectLeaseId,project_fencing_token:input.projectFencingToken,task_id:input.taskId,owner:input.owner,owner_nonce:randomUUID(),idempotency_key:input.idempotencyKey,fencing_token:token,resources,action:input.action,status:'active',issued_at:now.toISOString(),expires_at:new Date(now.getTime()+ttl(input.ttlSeconds)*1000).toISOString(),updated_at:now.toISOString()});await writeTaskLease(root,value);return value}))}
function resourcesConflict(left:string[],right:string[]){return resourceClaimsConflict(left,right)}
function findResourceConflict<T extends {resources:string[]}>(leases:T[],requested:string[]):T|null{const direct=leases.find(item=>resourcesConflict(item.resources,requested));if(direct)return direct;for(const claim of requested.map(parseResourceClaim).filter(item=>item.mode==='capacity')){const matches=leases.flatMap(lease=>lease.resources.map(parseResourceClaim).filter(item=>item.mode==='capacity'&&item.kind===claim.kind&&item.resourcePath===claim.resourcePath).map(item=>({lease,item})));if(!matches.length)continue;const capacity=Math.min(claim.capacity,...matches.map(match=>match.item.capacity)),used=matches.reduce((sum,match)=>sum+match.item.units,0);if(used+claim.units>capacity)return matches[0].lease}return null}
export function resourceClaimGroupsConflict(existing:string[][],requested:string[]){return findResourceConflict(existing.map(resources=>({resources})),requested)!==null}

const dispatchFile=(root:string,taskId:string)=>path.join(dispatchDir(root),`${taskId}.json`);
async function readDispatchState(root:string,taskId:string){return readFile(dispatchFile(root,taskId),'utf8').then(raw=>dispatchStateSchema.parse(JSON.parse(raw))).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error})}
async function taskHead(root:string,taskId:string){try{const workspace=await readWorkspace(root,taskId);return(await exec('git',['rev-parse','HEAD'],{cwd:workspace.worktree,maxBuffer:1_000_000,timeout:30_000,killSignal:'SIGKILL'})).stdout.trim()}catch{return null}}
export function classifySchedulerFailure(error:unknown){const message=(error as Error).message||String(error),normalized=message.toLowerCase().replace(/[a-f0-9]{32,}/g,'<digest>').replace(/\b\d{4,}\b/g,'<number>').replace(/\/[^\s:]+/g,'<path>');let retryClass:'infrastructure'|'deterministic_tool'|'workflow'='workflow';if(/timeout|timed out|network|econn|eai_again|enospc|emfile|temporar|unavailable|lock wait|heartbeat|lease renewal|spawn/.test(normalized))retryClass='infrastructure';if(/unknown option|invalid option|command not found|enoent|exit(?:ed)? (?:with )?(?:code )?2\b|not executable/.test(normalized))retryClass='deterministic_tool';return{message:message.slice(0,1000),retryClass,fingerprint:sha256(`${retryClass}\n${normalized}`)}}
export function shouldRetrySchedulerFailure(retryClass:'infrastructure'|'deterministic_tool'|'workflow',attempt:number,sameFingerprintCount:number,maxAttempts=3){return retryClass==='infrastructure'&&attempt<maxAttempts&&sameFingerprintCount<2}
async function markDispatchRunning(root:string,taskId:string,action:'start_m'|'start_v'|'start_r'|'run_gate'){return lock(root,async()=>{const previous=await readDispatchState(root,taskId),now=new Date().toISOString(),value=dispatchStateSchema.parse({schema_version:1,task_id:taskId,action,status:'running',attempt:previous?.action===action?previous.attempt+1:1,max_attempts:3,retry_class:null,failure_fingerprint:null,same_fingerprint_count:0,next_retry_at:null,last_error:null,last_evidence:[],worktree_head:await taskHead(root,taskId),recommended_action:null,updated_at:now});await controlWrite(root,[{file:dispatchFile(root,taskId),content:`${JSON.stringify(value,null,2)}\n`}],'task dispatch');return value})}
async function recordDispatchFailure(root:string,taskId:string,action:'start_m'|'start_v'|'start_r'|'run_gate',error:unknown,evidence:string[]=[]){const classified=classifySchedulerFailure(error);return lock(root,async()=>{const previous=await readDispatchState(root,taskId),attempt=previous?.action===action?Math.max(1,previous.attempt):1,same=previous?.action===action&&previous.failure_fingerprint===classified.fingerprint?previous.same_fingerprint_count+1:1,auto=shouldRetrySchedulerFailure(classified.retryClass,attempt,same),next=auto?new Date(Date.now()+Math.min(60_000,5_000*2**Math.max(0,attempt-1))).toISOString():null,status=auto?'retry_wait':'dead_letter',value=dispatchStateSchema.parse({schema_version:1,task_id:taskId,action,status,attempt,max_attempts:3,retry_class:classified.retryClass,failure_fingerprint:classified.fingerprint,same_fingerprint_count:same,next_retry_at:next,last_error:classified.message,last_evidence:evidence.slice(-20),worktree_head:await taskHead(root,taskId),recommended_action:auto?'wait for the bounded infrastructure retry':classified.retryClass==='deterministic_tool'?'fix the tool or Adapter configuration, then explicitly retry':'inspect the invocation Evidence and choose an explicit recovery',updated_at:new Date().toISOString()});await controlWrite(root,[{file:dispatchFile(root,taskId),content:`${JSON.stringify(value,null,2)}\n`}],'task dispatch failure');return value})}
async function recordDispatchSuccess(root:string,taskId:string,action:'start_m'|'start_v'|'start_r'|'run_gate',evidence:string[]=[]){return lock(root,async()=>{const previous=await readDispatchState(root,taskId),value=dispatchStateSchema.parse({schema_version:1,task_id:taskId,action,status:'succeeded',attempt:previous?.action===action?previous.attempt:1,max_attempts:previous?.max_attempts??3,retry_class:null,failure_fingerprint:null,same_fingerprint_count:0,next_retry_at:null,last_error:null,last_evidence:evidence.slice(-20),worktree_head:await taskHead(root,taskId),recommended_action:null,updated_at:new Date().toISOString()});await controlWrite(root,[{file:dispatchFile(root,taskId),content:`${JSON.stringify(value,null,2)}\n`}],'task dispatch success');return value})}
export async function retryDeadLetter(root:string,taskId:string){await initSchedulerControl(root);return lock(root,async()=>{const previous=await readDispatchState(root,taskId);if(!previous||previous.status!=='dead_letter')throw new Error(`${taskId} has no scheduler DeadLetter`);const value=dispatchStateSchema.parse({...previous,status:'retry_wait',attempt:0,same_fingerprint_count:0,next_retry_at:new Date().toISOString(),recommended_action:'explicit operator retry requested',updated_at:new Date().toISOString()});await controlWrite(root,[{file:dispatchFile(root,taskId),content:`${JSON.stringify(value,null,2)}\n`}],'DeadLetter retry');return value})}

export async function assertTaskLeaseResult(root:string,leaseId:string,fencingToken:number,invocationId?:string){const lease=taskLeaseSchema.parse(JSON.parse(await readFile(path.join(taskDir(root),`${leaseId}.json`),'utf8'))),currentState=await state(root);if(currentState.killed||currentState.reconcile_required||!active(lease)||lease.fencing_token!==fencingToken)throw new Error('stale, killed, or inactive Task lease fencing token');await requireProjectLease(root,lease.project_lease_id,lease.project_fencing_token);if(invocationId){const invocation=await readRoleInvocation(root,lease.task_id,invocationId);const expected={start_m:'M',start_v:'V',start_r:'R',run_gate:'V'}[lease.action];if(invocation.execution_binding&&(invocation.execution_binding.task_lease_id!==lease.lease_id||invocation.execution_binding.task_fencing_token!==lease.fencing_token||invocation.execution_binding.project_lease_id!==lease.project_lease_id||invocation.execution_binding.project_fencing_token!==lease.project_fencing_token))throw new Error('lease result belongs to another execution generation');if(invocation.role!==expected||invocation.status!=='succeeded')throw new Error('lease result is not bound to the expected succeeded role invocation')}return{accepted:true,lease_id:leaseId,fencing_token:fencingToken,fact_hash:sha256(JSON.stringify(lease))}}
function renewedExpiry(ttlSeconds:number,notAfter:string){const deadline=Date.parse(notAfter);if(!Number.isFinite(deadline))throw new Error('lease renewal deadline is invalid');const expires=Math.min(Date.now()+ttl(ttlSeconds)*1000,deadline);if(expires<=Date.now())throw new Error('lease renewal cannot exceed the wave deadline');return new Date(expires).toISOString()}
export async function renewProjectLease(root:string,input:{leaseId:string;fencingToken:number;ownerNonce:string;ttlSeconds:number;notAfter:string}){return lock(root,async()=>{const lease=projectLeaseSchema.parse(JSON.parse(await readFile(path.join(projectDir(root),`${input.leaseId}.json`),'utf8')));if(!active(lease)||lease.fencing_token!==input.fencingToken||lease.owner_nonce!==input.ownerNonce)throw new Error('stale or foreign Project lease renewal');const currentState=await state(root);if(currentState.killed||currentState.reconcile_required)throw new Error('Project lease cannot renew while scheduler requires reconcile');const updated=projectLeaseSchema.parse({...lease,expires_at:renewedExpiry(input.ttlSeconds,input.notAfter),updated_at:new Date().toISOString()});await writeProjectLease(root,updated);return updated})}
export async function renewTaskLease(root:string,input:{leaseId:string;fencingToken:number;ownerNonce:string;ttlSeconds:number;notAfter:string}){return lock(root,async()=>{const lease=taskLeaseSchema.parse(JSON.parse(await readFile(path.join(taskDir(root),`${input.leaseId}.json`),'utf8')));if(!active(lease)||lease.fencing_token!==input.fencingToken||lease.owner_nonce!==input.ownerNonce)throw new Error('stale or foreign Task lease renewal');const project=await requireProjectLease(root,lease.project_lease_id,lease.project_fencing_token);if(project.owner_nonce.length<1)throw new Error('Task lease parent Project lease is invalid');const currentState=await state(root);if(currentState.killed||currentState.reconcile_required)throw new Error('Task lease cannot renew while scheduler requires reconcile');const updated=taskLeaseSchema.parse({...lease,expires_at:renewedExpiry(input.ttlSeconds,input.notAfter),updated_at:new Date().toISOString()});await writeTaskLease(root,updated);return updated})}
export async function releaseTaskLease(root:string,leaseId:string,fencingToken:number){return lock(root,async()=>{const lease=taskLeaseSchema.parse(JSON.parse(await readFile(path.join(taskDir(root),`${leaseId}.json`),'utf8')));if(!active(lease)||lease.fencing_token!==fencingToken)throw new Error('stale or inactive Task lease fencing token');const updated=taskLeaseSchema.parse({...lease,status:'released',updated_at:new Date().toISOString()});await writeTaskLease(root,updated);return updated})}
export async function releaseProjectLease(root:string,leaseId:string,fencingToken:number){return lock(root,async()=>{const lease=projectLeaseSchema.parse(JSON.parse(await readFile(path.join(projectDir(root),`${leaseId}.json`),'utf8')));if(!active(lease)||lease.fencing_token!==fencingToken)throw new Error('stale or inactive Project lease fencing token');const activeTasks=(await listLeases(taskDir(root),taskLeaseSchema)).filter(item=>active(item)&&item.project_lease_id===leaseId);if(activeTasks.length)throw new Error(`Project lease still owns active Task leases: ${activeTasks.map(item=>item.lease_id).join(', ')}`);const updated=projectLeaseSchema.parse({...lease,status:'released',updated_at:new Date().toISOString()});await writeProjectLease(root,updated);return updated})}

export function assertSchedulerAction(action:string){if(denied.has(action.toLowerCase()))throw new Error(`scheduler action is denied: ${action}`);if(!['start_m','start_v','start_r','run_gate'].includes(action))throw new Error(`scheduler action is not allowlisted: ${action}`);return{allowed:true,action}}
export async function pauseSchedulerControl(root:string){await initSchedulerControl(root);return lock(root,async()=>{const current=await state(root),updated=controlStateSchema.parse({...current,paused:true,updated_at:new Date().toISOString()});await writeState(root,updated);return updated})}
export async function resumeSchedulerControl(root:string){await initSchedulerControl(root);return lock(root,async()=>{const current=await state(root);if(current.killed||current.reconcile_required)throw new Error('scheduler must reconcile after Kill before resume');const updated=controlStateSchema.parse({...current,paused:false,updated_at:new Date().toISOString()});await writeState(root,updated);return updated})}

async function roleInvocations(root:string){const output=path.join(root,'.spec-loop','output'),items=[] as Array<{taskId:string;id:string}>;if(!(await exists(output)))return items;for(const entry of await readdir(output,{withFileTypes:true})){const match=entry.isDirectory()&&entry.name.match(/^((?:WEB-)?TASK-[A-Z0-9-]+)-acceptance-v2$/);if(!match)continue;const dir=path.join(output,entry.name,'invocations');if(!(await exists(dir)))continue;for(const invocation of await readdir(dir,{withFileTypes:true}))if(invocation.isDirectory())items.push({taskId:match[1],id:invocation.name})}return items}

async function cancelActiveEffects(root:string,taskId:string):Promise<{cancelled:string[];incomplete:string[]}>{
  const dir=path.join(root,'.spec-loop','active-effects');if(!(await exists(dir)))return{cancelled:[],incomplete:[]};const cancelled:string[]=[],incomplete:string[]=[];
  for(const name of (await readdir(dir)).filter(value=>value.endsWith('.json'))){const file=path.join(dir,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('active Effect marker is invalid');const value=JSON.parse(await readFile(file,'utf8')) as {effect_id?:string;task_id?:string;pid?:number;process_started_at?:string|null};if(value.task_id!==taskId)continue;if(!value.effect_id||!value.pid)throw new Error('active Effect marker has no auditable identity');if(!value.process_started_at){const probe=await inspectProcess(value.pid);if(probe.status!=='dead'){incomplete.push(`${value.effect_id}:legacy marker has no process identity`);continue}cancelled.push(value.effect_id);continue}const termination=await terminateProcessTree(value.pid,value.process_started_at);if(termination.stopped){cancelled.push(value.effect_id)}else incomplete.push(`${value.effect_id}:${termination.reason}`)}return{cancelled:cancelled.sort(),incomplete:incomplete.sort()};
}

// Preserve verified-dead markers until the stop proof is durable, so an
// interrupted stop worker leaves facts that the next retry can recover.
async function removeStoppedEffectMarkers(root:string,taskId:string,ids:string[]) {
  const dir=path.join(root,'.spec-loop','active-effects');
  for(const name of (await readdir(dir).catch(error=>{if(error.code==='ENOENT')return [];throw error})).filter(value=>value.endsWith('.json'))){
    const file=path.join(dir,name);
    await removeTelemetryFile(root,file,async()=>{
      const value=await readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error});
      if(value?.task_id!==taskId||!ids.includes(value.effect_id)||!value.pid)return false;
      const identity=await inspectProcess(value.pid,value.process_started_at??undefined);
      return identity.status==='dead'||identity.status==='identity_mismatch';
    });
  }
}

async function stopOrReclaimDriverLock(root:string,taskId:string,reason:string,at:Date):Promise<{reclaimed:boolean;stop_requested:boolean;stop_verified:boolean;stop_error:string|null}>{
  const lockDir=path.join(root,'.spec-loop','locks',`workflow-driver-${taskId}.lock`),info=await lstat(lockDir).catch(()=>null);if(!info)return{reclaimed:false,stop_requested:false,stop_verified:true,stop_error:null};
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('workflow Driver lock is invalid');
  const owner=await readFile(path.join(lockDir,'owner.json'),'utf8').then(raw=>JSON.parse(raw) as {pid?:number;process_started_at?:string|null}).catch(()=>null);
  if(!owner?.pid)throw new Error('workflow Driver lock has no auditable owner; manual reconcile is required');
  const probe=await inspectProcess(owner.pid,owner.process_started_at);
  if(probe.status==='unknown')return{reclaimed:false,stop_requested:false,stop_verified:false,stop_error:'Driver identity is unknown'};
  const reclaim=async()=>{const recovered=await acquireOwnedDirectoryLock(lockDir,{name:'workflow Driver stop recovery',maxWaitMs:0});return recovered.release()};
  if(probe.status==='alive'){const request=path.join(lockDir,'STOP_REQUEST.json'),existing=await lstat(request).catch(()=>null);if(!existing)await atomicWriteMany(root,[{file:request,content:`${JSON.stringify({schema_version:1,task_id:taskId,pid:owner.pid,process_started_at:owner.process_started_at??null,requested_at:at.toISOString(),reason},null,2)}\n`}]);else if(!existing.isFile()||existing.isSymbolicLink())throw new Error('workflow Driver stop request marker is invalid');if(!owner.process_started_at)return{reclaimed:false,stop_requested:true,stop_verified:false,stop_error:'legacy Driver lock has no process identity'};const termination=await terminateProcessTree(owner.pid,owner.process_started_at);if(termination.stopped){await reclaim();return{reclaimed:true,stop_requested:true,stop_verified:true,stop_error:null}}return{reclaimed:false,stop_requested:true,stop_verified:false,stop_error:termination.reason}}
  await reclaim();return{reclaimed:true,stop_requested:false,stop_verified:true,stop_error:null};
}

async function taskStopLock<T>(root:string,taskId:string,work:()=>Promise<T>){return withOwnedDirectoryLock(path.join(root,'.spec-loop','locks',`task-stop-${taskId}.lock`),{name:'Task stop / lease admission',maxWaitMs:3_000},work);}
export async function stopTaskExecution(root:string,taskId:string,reason='stopped by user',stopRequestId?:string){
  if(!/^(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*$/.test(taskId))throw new Error('invalid stop Task id');
  return taskStopLock(root,taskId,async()=>{
    const observedIntent=!stopRequestId?await readFile(path.join(stopIntentDir(root),`${taskId}.json`),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error}):null;
    if(stopRequestId){
      z.uuid().parse(stopRequestId);const intent=JSON.parse(await readFile(path.join(stopIntentDir(root),`${taskId}.json`),'utf8'));
      if(intent.request_id!==stopRequestId)throw new Error('stop request generation was superseded');
      if(intent.watchdog_conditions){
        const health=await inspectSchedulerLiveness(root,intent.stale_seconds??15,taskId),rows=watchdogReferences(health,taskId);
        const matches=rows.filter(row=>intent.watchdog_conditions.some((expected:WatchdogStopCondition)=>expected.source===row.reference.source&&expected.id===row.reference.id&&(expected.pid===undefined||expected.pid===row.reference.pid)&&(expected.process_started_at===undefined||expected.process_started_at===row.reference.process_started_at)));
        if(matches.some(row=>row.status==='identity_unknown'))return{task_id:taskId,status:'stop_incomplete',stop_complete:false,error:'watchdog source identity is unknown'};
        if(!matches.some(row=>row.status!=='healthy'))return{task_id:taskId,status:'superseded',stop_complete:true,reason:'observed unhealthy execution ended or recovered'};
      }
    }
    const result=await stopTaskExecutionInternal(root,taskId,reason);
    if(result.stop_complete===true&&typeof observedIntent?.request_id==='string')await completeVerifiedTaskStopIntent(root,taskId,observedIntent.request_id);
    return result;
  });
}
async function stopTaskExecutionInternal(root:string,taskId:string,reason:string){
  const stopBegan=Date.now();
  const marker=path.join(root,'.spec-loop','output',`${taskId}-stop.json`);
  if(await exists(marker)){
    const previous=JSON.parse(await readFile(marker,'utf8')) as Record<string,unknown>,driver=await stopOrReclaimDriverLock(root,taskId,String(previous.reason??reason),new Date()),effects=await cancelActiveEffects(root,taskId);
    const roleIncomplete:string[]=[],cancelledInvocations:string[]=[];
    for(const item of (await roleInvocations(root)).filter(item=>item.taskId===taskId)){
      const invocation=await readRoleInvocation(root,taskId,item.id).catch(()=>null);
      if(invocation&&['prepared','running','interrupted'].includes(invocation.status))try{await cancelRoleInvocation(root,taskId,item.id);cancelledInvocations.push(item.id)}catch(error){roleIncomplete.push(`${item.id}:${(error as Error).message}`)}
    }
    const incomplete=[...roleIncomplete,...effects.incomplete,...(driver.stop_verified?[]:[`driver:${driver.stop_error??'not verified'}`])];
    let updated={...previous,cancelled_invocations:[...new Set([...(Array.isArray(previous.cancelled_invocations)?previous.cancelled_invocations:[]),...cancelledInvocations])].sort(),cancelled_effects:[...new Set([...(Array.isArray(previous.cancelled_effects)?previous.cancelled_effects:[]),...effects.cancelled])].sort(),incomplete_stops:incomplete,stop_complete:incomplete.length===0,driver_lock_reclaimed:Boolean(previous.driver_lock_reclaimed)||driver.reclaimed,driver_stop_requested:driver.stop_requested,driver_stop_verified:driver.stop_verified,driver_stop_error:driver.stop_error} as Record<string,unknown>;
    if(!incomplete.length){
      const task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');
      const taskState=await readState(task.path);let head=typeof previous.actual_head==='string'?previous.actual_head:null;
      try{const workspace=await readWorkspace(root,taskId);head=(await exec('git',['rev-parse','HEAD'],{cwd:workspace.worktree,timeout:30_000,killSignal:'SIGKILL',maxBuffer:1_000_000})).stdout.trim()}catch{}
      let acceptanceStage=previous.acceptance_stage;
      try{acceptanceStage=(await cancelAcceptanceRun(root,taskId,reason,head)).stage}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!/ENOENT|completed Candidate/.test((error as Error).message))throw error}
      const final=['cancelled','delivered','draft'].includes(taskState.status)?taskState:await cancelTask(task.path);
      updated={...updated,status:final.status,acceptance_stage:acceptanceStage,actual_head:head};
    }
    if(JSON.stringify(updated)!==JSON.stringify(previous))await atomicWriteMany(root,[{file:marker,content:`${JSON.stringify(updated,null,2)}\n`}]);
    await removeStoppedEffectMarkers(root,taskId,effects.cancelled);
    return updated;
  }
  const task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error('task not found');
  const state=await (await import('./task.js')).readState(task.path),at=new Date();
  const cancellation=await cancelTaskExecution(root,{taskId,round:state.current_round,summary:reason,refs:[`.spec-loop/output/${taskId}-stop.json`],occurredAt:at});
  const cancelledInvocations=[] as string[],incompleteStops=[] as string[];
  for(const item of (await roleInvocations(root)).filter(item=>item.taskId===taskId)){const invocation=await readRoleInvocation(root,item.taskId,item.id).catch(()=>null);if(invocation&&['prepared','running','interrupted','cancelled'].includes(invocation.status))try{await cancelRoleInvocation(root,item.taskId,item.id);cancelledInvocations.push(item.id)}catch(error){incompleteStops.push(`${item.id}:${(error as Error).message}`)}}
  const cancelledEffects=await cancelActiveEffects(root,taskId);incompleteStops.push(...cancelledEffects.incomplete);
  let actualHead:string|null=null;try{const workspace=await readWorkspace(root,taskId);actualHead=(await exec('git',['rev-parse','HEAD'],{cwd:workspace.worktree,maxBuffer:1_000_000,timeout:30_000,killSignal:'SIGKILL'})).stdout.trim()}catch{}
  const driver=await stopOrReclaimDriverLock(root,taskId,reason,at);
  if(!driver.stop_verified)incompleteStops.push(`driver:${driver.stop_error??'not verified'}`);
  let acceptanceStage:string|null=null;try{acceptanceStage=incompleteStops.length?(await readAcceptanceRun(root,taskId)).stage:(await cancelAcceptanceRun(root,taskId,reason,actualHead)).stage}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!/ENOENT|completed Candidate/.test((error as Error).message))throw error}
  const finalState=incompleteStops.length||state.status==='cancelled'||state.status==='delivered'||state.status==='draft'?state:await cancelTask(task.path,at);
  await lock(root,async()=>{for(const lease of await listLeases(taskDir(root),taskLeaseSchema))if(active(lease)&&lease.task_id===taskId)await writeTaskLease(root,taskLeaseSchema.parse({...lease,status:'killed',updated_at:at.toISOString()}))});
  const result={schema_version:2,task_id:taskId,status:finalState.status,acceptance_stage:acceptanceStage,actual_head:actualHead,cancelled_invocations:cancelledInvocations.sort(),cancelled_effects:cancelledEffects.cancelled,incomplete_stops:incompleteStops.sort(),stop_complete:incompleteStops.length===0,closed_steps:cancellation.closed.length,cancellation_event_id:cancellation.cancellation.event_id,driver_lock_reclaimed:driver.reclaimed,driver_stop_requested:driver.stop_requested,driver_stop_verified:driver.stop_verified,driver_stop_error:driver.stop_error,stop_duration_ms:Date.now()-stopBegan,stopped_at:at.toISOString(),reason};
  await atomicWriteMany(root,[{file:marker,content:`${JSON.stringify(result,null,2)}\n`}]);await removeStoppedEffectMarkers(root,taskId,cancelledEffects.cancelled);return result;
}
export async function killSchedulerControl(root:string){await initSchedulerControl(root);const now=new Date().toISOString(),updated=await lock(root,async()=>{const current=await state(root),next=controlStateSchema.parse({...current,paused:true,killed:true,reconcile_required:true,updated_at:now});await writeState(root,next);return next});const taskIds=new Set<string>((await roleInvocations(root)).map(item=>item.taskId));for(const lease of await listLeases(taskDir(root),taskLeaseSchema))if(active(lease))taskIds.add(lease.task_id);for(const name of (await readdir(stopIntentDir(root))).filter(value=>value.endsWith('.json'))){const intent=JSON.parse(await readFile(path.join(stopIntentDir(root),name),'utf8'));if(intent.status!=='completed'&&typeof intent.task_id==='string')taskIds.add(intent.task_id);} const batch=await runBoundedTaskStops(root,[...taskIds],'scheduler Kill requested');await lock(root,async()=>{for(const lease of await listLeases(taskDir(root),taskLeaseSchema))if(active(lease))await writeTaskLease(root,taskLeaseSchema.parse({...lease,status:'killed',updated_at:now}));for(const lease of await listLeases(projectDir(root),projectLeaseSchema))if(active(lease))await writeProjectLease(root,projectLeaseSchema.parse({...lease,status:'killed',updated_at:now}))});return{...updated,stop_complete:batch.stop_complete,stopped_tasks:batch.stopped_tasks}}
export async function reconcileSchedulerControl(root:string){for(const name of (await readdir(stopIntentDir(root)).catch(()=>[])).filter(value=>value.endsWith('.json'))){const value=JSON.parse(await readFile(path.join(stopIntentDir(root),name),'utf8'));if(value.status!=='completed')throw new Error(`Task stop remains incomplete: ${value.task_id??name}`)}for(const item of await roleInvocations(root))await reconcileRoleInvocation(root,item.taskId,item.id).catch(()=>{});const running=[];for(const item of await roleInvocations(root)){
const invocation=await readRoleInvocation(root,item.taskId,item.id).catch(()=>null);if(invocation?.status==='running')running.push(invocation.invocation_id)}if(running.length)throw new Error(`role invocations are still running: ${running.join(', ')}`);return lock(root,async()=>{const current=await state(root),updated=controlStateSchema.parse({...current,killed:false,reconcile_required:false,updated_at:new Date().toISOString()});await writeState(root,updated);return updated})}
const stageRole={m_working:'M',plan_compiled:'V',v_passed:'R'} as const;
export async function planReadyWave(root:string,options:{includeCandidateRecovery?:boolean;taskIds?:ReadonlySet<string>}={}){
  const controlState=await state(root),budget=await readWaveBudget(root),schedule=await buildAcceptanceSchedule(root),taskIndex=await scanTasks(root),ready=[] as Array<{task_id:string;stage:string;role:'M'|'V'|'R';action:'start_m'|'start_v'|'start_r';resource:string;scheduling_score:number;ready_wait_ms:number;downstream_blocked:number}>,held=[] as Array<{task_id:string;reason:string}>,candidateRecovery=[] as Array<Record<string,unknown>>;
  if(options.taskIds&&[...options.taskIds].some(id=>!schedule.tasks.some(item=>item.task_id===id)))throw new Error('wave scope contains an unapproved Task');
  if(options.includeCandidateRecovery!==false){
    const candidates=schedule.tasks.filter(item=>item.stage==='candidate'&&(!options.taskIds||options.taskIds.has(item.task_id)));
    // Baseline checks are read-only and independent. Limit concurrency so a
    // long Candidate history does not serialize Git probes or flood the disk.
    for(let index=0;index<candidates.length;index+=4){
      candidateRecovery.push(...await Promise.all(candidates.slice(index,index+4).map(async task=>{
        try{return await reconcileCandidateBaseline(root,task.task_id,false)}
        catch(error){return{task_id:task.task_id,status:'unavailable',error:(error as Error).message}}
      })));
    }
  }
  if(options.taskIds)for(const task of schedule.tasks.filter(item=>options.taskIds!.has(item.task_id)&&!item.ready))held.push({task_id:task.task_id,reason:task.blocked_by.length?`prerequisites are not Candidates: ${task.blocked_by.join(',')}`:task.action===null?`stage ${task.stage} has no automatic action`:`stage ${task.stage} is not ready`});
  for(const task of schedule.tasks.filter(item=>item.ready&&item.action&&(!options.taskIds||options.taskIds.has(item.task_id)))){
    const role=stageRole[task.stage as keyof typeof stageRole];if(!role)continue;
    const action=task.action as 'start_m'|'start_v'|'start_r',dispatch=await readDispatchState(root,task.task_id);
    if(dispatch?.action===action&&dispatch.status==='dead_letter'){held.push({task_id:task.task_id,reason:`scheduler DeadLetter (${dispatch.retry_class}): ${dispatch.recommended_action}`});continue}
    if(dispatch?.action===action&&dispatch.status==='retry_wait'&&dispatch.next_retry_at&&Date.parse(dispatch.next_retry_at)>Date.now()){held.push({task_id:task.task_id,reason:`scheduler RetryWait until ${dispatch.next_retry_at}`});continue}
    const reviewHold=await taskWaveReviewHold(root,task.task_id);if(reviewHold){held.push({task_id:task.task_id,reason:'awaiting_wave_review'});continue}
    const latest=await latestRoleInvocation(root,task.task_id,role),nonterminal=latest&&(['prepared','running','interrupted'].includes(latest.status)||(latest.status==='succeeded'&&latest.result_status!=='ingested'));
    if(nonterminal){held.push({task_id:task.task_id,reason:latest.status==='succeeded'?`${role} invocation succeeded and awaits result ingestion`:`${role} invocation is ${latest.status}`});continue}
    const indexed=taskIndex.find(item=>item.task_id===task.task_id),taskState=indexed?await readState(indexed.path):null,readyWaitMs=taskState?Math.max(0,Date.now()-Date.parse(taskState.updated_at)):0,downstreamBlocked=schedule.tasks.filter(item=>item.blocked_by.includes(task.task_id)).length,riskPenalty=indexed?.level==='heavy'?20:indexed?.level==='standard'?5:0,retryPenalty=(dispatch?.attempt??0)*5,schedulingScore=Math.round(Math.min(168,readyWaitMs/3_600_000)*10)+downstreamBlocked*100-riskPenalty-retryPenalty;
    ready.push({task_id:task.task_id,stage:task.stage,role,action,resource:`branch:spec-loop/${task.task_id.toLowerCase()}`,scheduling_score:schedulingScore,ready_wait_ms:readyWaitMs,downstream_blocked:downstreamBlocked});
  }
  ready.sort((left,right)=>right.scheduling_score-left.scheduling_score||left.task_id.localeCompare(right.task_id));
  return{schema_version:1,mode:'wave_execution',executable:!controlState.paused&&!controlState.killed&&!controlState.reconcile_required,control:controlState,budget,ready,held,candidate_recovery:candidateRecovery,planned_at:new Date().toISOString(),destructive_action_performed:false};
}

export async function runReadyWave(root:string,input:{owner:string;taskIds?:string[];singleStage?:boolean;testSessionId?:string;testMaxRuntimeSeconds?:number;authorizationId?:string;onWaveCreated?:(waveId:string)=>Promise<void>}){
  if(input.owner.trim().length<2)throw new Error('wave owner must contain at least two characters');
  const driverStart=requireProcessIdentity(await processStartedAt(process.pid),'wave Driver');
  const supervisor=await (await import('./scheduler-supervisor.js')).startManagedSchedulerSupervisor(root,input.testSessionId?{testMode:true,testSessionId:input.testSessionId,maxRuntimeSeconds:input.testMaxRuntimeSeconds??120}:{});
  if(!supervisor.running||!supervisor.healthy)throw new Error(`wave execution requires a healthy independent Supervisor (${supervisor.reason})`);
  await reconcileInterruptedWaves(root,true);
  let schedule=await buildAcceptanceSchedule(root);
  const authorizedTasks=new Set(input.taskIds??schedule.tasks.filter(item=>!['candidate','cancelled'].includes(item.stage)).map(item=>item.task_id));
  for(const id of [...authorizedTasks])if(await taskWaveReviewHold(root,id)){if(input.taskIds)throw new Error(`${id} awaits wave review`);authorizedTasks.delete(id);}
  if(input.taskIds&&[...authorizedTasks].some(id=>!schedule.tasks.some(item=>item.task_id===id)))throw new Error('wave scope contains an unapproved Task');
  if(input.taskIds&&authorizedTasks.size>200)throw new Error('wave scope must contain at most 200 approved Tasks');
  let plan=await planReadyWave(root,{taskIds:authorizedTasks});if(!plan.executable)throw new Error('scheduler control does not permit execution');
  for(const recovery of plan.candidate_recovery)if(recovery.status==='baseline_drift'&&typeof recovery.task_id==='string')await reconcileCandidateBaseline(root,recovery.task_id,true);
  if(plan.candidate_recovery.some(item=>item.status==='baseline_drift')){plan=await planReadyWave(root,{includeCandidateRecovery:false,taskIds:authorizedTasks});schedule=await buildAcceptanceSchedule(root)}
  if(!input.taskIds){authorizedTasks.clear();for(const item of plan.ready)authorizedTasks.add(item.task_id)}
  if(authorizedTasks.size>200)throw new Error('wave scope must contain at most 200 approved Tasks');
  plan={...plan,ready:plan.ready.filter(item=>authorizedTasks.has(item.task_id))};
  if(!plan.ready.length)throw new Error('wave has no Ready Tasks; no execution was started');
  const parked=new Set<string>(),authorizedContracts=new Map<string,string>(),initialRuns=new Map<string,Awaited<ReturnType<typeof readAcceptanceRun>>>();
  for(const id of authorizedTasks){const run=await readAcceptanceRun(root,id);authorizedContracts.set(id,run.contract_hash);initialRuns.set(id,run)}
  // Existing V/R work stays on the legacy path; a fresh wave uses barriers.
  const executionMode=input.singleStage||!authorizedTasks.size||[...initialRuns.values()].some(run=>run.stage!=='m_working'||run.semantic_reworks_used>0)?'task_continuous':'batch_two_rounds';
  if(executionMode==='batch_two_rounds'){
    const blocked=schedule.tasks.filter(task=>authorizedTasks.has(task.task_id)&&task.blocked_by.length);
    if(blocked.length)throw new Error(`batch wave requires prerequisites to be Candidates before admission: ${blocked.map(task=>`${task.task_id} <- ${task.blocked_by.join(',')}`).join('; ')}`);
    if(plan.ready.filter(item=>authorizedTasks.has(item.task_id)&&item.role==='M').length!==authorizedTasks.size)throw new Error('batch wave requires every approved Task to be ready for implementation');
  }
  const approvedGateHash=sha256(JSON.stringify(await (await import('./execution.js')).readGateConfig(root)));
  const waveId=`WAVE-${Date.now()}-${randomUUID()}`,startedAt=new Date().toISOString(),waveDeadlineAt=new Date(Date.parse(startedAt)+plan.budget.max_elapsed_seconds*1000).toISOString(),leaseTtlSeconds=Math.max(1,Math.min(60,plan.budget.max_elapsed_seconds)),recordFile=path.join(waveDir(root),`${waveId}.json`),queue=[...plan.ready],results=[] as Array<Record<string,unknown>>,activeTasks=new Set<string>(),activeTaskLeases=new Map<string,TaskLease>(),reservations=new Map<string,{tokens:number;cost:number}>(),liveUsage=new Map<string,{tokens:number;cost:number}>(),ledger=[] as Array<Record<string,unknown>>,slo=new Map<string,Record<string,unknown>>(),attempted=new Set<string>();let phase:BatchWavePhase='implementation',verificationRound:0|1|2=0,waveBlockReason:string|null=null;
  const waveAbort=new AbortController();let signalStopping!:()=>void;const stoppingSignal=new Promise<void>(resolve=>{signalStopping=resolve});let sealed=false,stopResults=[] as Array<Record<string,unknown>>;
  let executionFinished=false;let next=0,fuse:string|null=null,totalTokens=0,totalCost=0,reservedTokens=0,reservedCost=0,unknownUsage=false,projectLease:ProjectLease|null=null,stopPromise:Promise<unknown>|null=null,leaseTimer:NodeJS.Timeout|undefined,leaseRenewalWork:Promise<void>=Promise.resolve(),leaseRenewalStopped=false;
  const observed=()=>({tokens:totalTokens+[...liveUsage.values()].reduce((sum,item)=>sum+item.tokens,0),cost:totalCost+[...liveUsage.values()].reduce((sum,item)=>sum+item.cost,0)});
  const writer=createLatestValueWriter<Record<string,unknown>>(snapshot=>withAbortableOperationTimeout(signal=>atomicWriteTelemetry(root,{file:recordFile,content:`${JSON.stringify(snapshot,null,2)}\n`},signal),5_000,'wave heartbeat write'))
  const snapshot=(status:string,finishedAt:string|null)=>{const usage=observed();return{schema_version:2,wave_id:waveId,authorization_id:input.authorizationId??null,status,execution_mode:executionMode,phase:executionMode==='batch_two_rounds'?phase:null,verification_round:executionMode==='batch_two_rounds'?verificationRound:null,max_verification_rounds:executionMode==='batch_two_rounds'?2:null,block_reason:waveBlockReason,owner:input.owner,driver:{pid:process.pid,process_started_at:driverStart},supervisor:{pid:supervisor.marker?.pid??null,process_started_at:supervisor.marker?.process_started_at??null},started_at:startedAt,heartbeat_at:new Date().toISOString(),finished_at:finishedAt,budget:plan.budget,authorized_tasks:[...authorizedTasks].sort(),planned_tasks:[...authorizedTasks].sort(),pending_tasks:queue.slice(next).map(item=>item.task_id),active_tasks:[...activeTasks].sort(),results,usage:{total_tokens:usage.tokens,cost_usd:usage.cost,recorded:!unknownUsage},project_lease:projectLease?{lease_id:projectLease.lease_id,fencing_token:projectLease.fencing_token}:null,reserved:{tokens:reservedTokens,cost_usd:reservedCost},reservations:Object.fromEntries([...reservations].sort()),budget_ledger:ledger.slice(-1000),slo:Object.fromEntries([...slo].sort()),fuse_reason:fuse,stop_results:stopResults,pending_stops:stopResults.filter(item=>item.stop_complete!==true).map(item=>item.task_id),control_io:writer.stats()}};
  const persist=async(status:string,finishedAt:string|null)=>writer.enqueue(snapshot(status,finishedAt));
  const trip=(reason:string)=>{if(fuse)return;fuse=reason;ledger.push({event:'fuse',reason,at:new Date().toISOString()});waveAbort.abort(new Error(reason));signalStopping();stopPromise=runBoundedTaskStops(root,[...activeTasks],`wave ${waveId} stopped: ${reason}`).then(batch=>{stopResults=batch.stopped_tasks}).catch(error=>{stopResults=[...activeTasks].map(task_id=>({task_id,status:'stop_incomplete',stop_complete:false,error:(error as Error).message}))});void persist('stopping',null).catch(()=>{})};
  projectLease=await acquireProjectLease(root,{owner:input.owner,idempotencyKey:waveId,ttlSeconds:leaseTtlSeconds});
  try{await persist('running',null);await input.onWaveCreated?.(waveId);}catch(error){await writer.close(snapshot('admission_failed',new Date().toISOString())).catch(()=>{});await releaseProjectLease(root,projectLease.lease_id,projectLease.fencing_token).catch(()=>{});throw error;}
  const pulse=setInterval(()=>{void persist(fuse?'stopping':'running',null).catch(error=>trip(`wave heartbeat persistence failed: ${(error as Error).message}`))},2_000);
  try{
    const scheduleLeaseRenewal=()=>{const delayMs=Math.max(1_000,Math.min(20_000,Math.floor(leaseTtlSeconds*1000/3)));leaseTimer=setTimeout(()=>{leaseRenewalWork=(async()=>{if(leaseRenewalStopped||!projectLease||fuse)return;projectLease=await renewProjectLease(root,{leaseId:projectLease.lease_id,fencingToken:projectLease.fencing_token,ownerNonce:projectLease.owner_nonce,ttlSeconds:leaseTtlSeconds,notAfter:waveDeadlineAt});for(const [taskId,current] of [...activeTaskLeases])activeTaskLeases.set(taskId,await renewTaskLease(root,{leaseId:current.lease_id,fencingToken:current.fencing_token,ownerNonce:current.owner_nonce,ttlSeconds:leaseTtlSeconds,notAfter:waveDeadlineAt}));ledger.push({event:'leases_renewed',task_ids:[...activeTaskLeases.keys()].sort(),at:new Date().toISOString()})})().catch(error=>{if(!leaseRenewalStopped)trip(`lease renewal failed: ${(error as Error).message}`)}).finally(()=>{if(!leaseRenewalStopped&&!fuse)scheduleLeaseRenewal()})},delayMs);leaseTimer.unref()};scheduleLeaseRenewal();
    const timer=setTimeout(()=>trip(`elapsed budget reached (${plan.budget.max_elapsed_seconds}s)`),plan.budget.max_elapsed_seconds*1000);
    try{
      const worker=async()=>{for(;;){if(fuse)return;const index=next++;if(index>=queue.length)return;const item=queue[index];if(executionMode==='batch_two_rounds')attempted.add(`${phase}:${item.task_id}`);let lease:TaskLease|null=null,invocationId:string|null=null;const dispatchAt=Date.now();slo.set(item.task_id,{...slo.get(item.task_id),ready_to_dispatch_ms:item.ready_wait_ms,dispatch_at:new Date(dispatchAt).toISOString(),lease_acquire_ms:null,provider_start_ms:null});activeTasks.add(item.task_id);try{
        await markDispatchRunning(root,item.task_id,item.action);
        const leaseStarted=Date.now();lease=await acquireTaskLease(root,{projectLeaseId:projectLease!.lease_id,projectFencingToken:projectLease!.fencing_token,taskId:item.task_id,owner:input.owner,idempotencyKey:`${waveId}:${item.task_id}:${item.action}:${results.length}:${index}`,ttlSeconds:leaseTtlSeconds,resources:[item.resource],action:item.action});activeTaskLeases.set(item.task_id,lease);slo.set(item.task_id,{...slo.get(item.task_id),lease_acquire_ms:Date.now()-leaseStarted});
        const slots=Math.max(1,plan.budget.max_parallel-reservations.size),availableTokens=plan.budget.max_tokens-totalTokens-reservedTokens,availableCost=plan.budget.max_cost_usd-totalCost-reservedCost;if(availableTokens<1||availableCost<=0){trip('wave budget has no reservable capacity');return}const tokenReservation=Math.max(1,Math.floor(availableTokens/slots)),costReservation=availableCost/slots;reservations.set(item.task_id,{tokens:tokenReservation,cost:costReservation});reservedTokens+=tokenReservation;reservedCost+=costReservation;ledger.push({event:'reserve',task_id:item.task_id,tokens:tokenReservation,cost_usd:costReservation,at:new Date().toISOString()});await persist('running',null);if(fuse)return;
        let probeTokens=0,probeCost=0;const providerRequestedAt=Date.now(),invocation=await prepareRoleInvocation(root,item.task_id,item.role,{executionBinding:{wave_id:waveId,project_lease_id:projectLease!.lease_id,project_fencing_token:projectLease!.fencing_token,task_lease_id:lease.lease_id,task_fencing_token:lease.fencing_token},signal:waveAbort.signal,deadlineAt:Date.parse(waveDeadlineAt),maxTokens:tokenReservation,maxCostUsd:costReservation,onUsage:usage=>{if(sealed)return 'wave finalized';liveUsage.set(item.task_id,{tokens:usage.total_tokens??0,cost:usage.cost_usd??0});const current=observed();return current.tokens>=plan.budget.max_tokens||current.cost>=plan.budget.max_cost_usd?'wave startup probe reached shared budget':null},onProbeUsage:usage=>{if(sealed)return;liveUsage.delete(item.task_id);probeTokens+=usage.total_tokens??0;probeCost+=usage.cost_usd??0;totalTokens+=usage.total_tokens??0;totalCost+=usage.cost_usd??0;results.push({task_id:item.task_id,role:'probe_usage',status:'succeeded',result_status:'ingested',usage,next_action:'Provider startup probe usage accounted'});ledger.push({event:'probe_usage',task_id:item.task_id,usage,at:new Date().toISOString()});if(!usage.recorded||usage.cost_usd===null){unknownUsage=true;trip('Provider startup probe usage or cost is unrecorded')}else if(probeTokens>=tokenReservation||probeCost>=costReservation)trip('Provider startup probe exhausted its reservation')}});invocationId=invocation.invocation_id;if(fuse){await cancelRoleInvocation(root,item.task_id,invocation.invocation_id);return}const completed=await runRoleInvocation(root,item.task_id,invocation.invocation_id,{signal:waveAbort.signal,maxTokens:Math.max(1,tokenReservation-probeTokens),maxCostUsd:Math.max(Number.EPSILON,costReservation-probeCost),onUsage:(usage)=>{if(sealed)return 'wave already finalized';liveUsage.set(item.task_id,{tokens:usage.total_tokens??0,cost:usage.cost_usd??0});const current=observed();if(sealed)return 'wave already finalized';if(current.tokens>=plan.budget.max_tokens)return`wave live token budget reached (${current.tokens}/${plan.budget.max_tokens})`;if(current.cost>=plan.budget.max_cost_usd)return`wave live cost budget reached (${current.cost}/${plan.budget.max_cost_usd})`;return null}});if(sealed)return;slo.set(item.task_id,{...slo.get(item.task_id),provider_start_ms:completed.started_at?Math.max(0,Date.parse(completed.started_at)-providerRequestedAt):null});
        if(sealed)return;
        if(completed.status==='succeeded')await assertTaskLeaseResult(root,lease.lease_id,lease.fencing_token,completed.invocation_id);
        const ingested=completed.status==='succeeded'?await ingestSucceededRoleResult(root,item.task_id,completed.invocation_id,{controlledVerification:true}):completed;if(sealed)return;const usage=ingested.usage;liveUsage.delete(item.task_id);totalTokens+=usage.total_tokens??0;totalCost+=usage.cost_usd??0;if(!usage.recorded||usage.cost_usd===null)unknownUsage=true;
        const acceptance=await readAcceptanceRun(root,item.task_id),acceptanceFailed=ingested.result_status==='ingested'&&((item.role==='V'&&acceptance.stage!=='v_passed')||(item.role==='R'&&acceptance.stage!=='candidate'));
        if(ingested.status!=='succeeded'||ingested.result_status!=='ingested')parked.add(item.task_id);
        if(ingested.status!=='succeeded')await recordDispatchFailure(root,item.task_id,item.action,new Error(ingested.last_error??`Provider ${ingested.status}`),[ingested.invocation_id]).catch(()=>{});
        slo.set(item.task_id,{...slo.get(item.task_id),elapsed_ms:Number(slo.get(item.task_id)?.elapsed_ms??0)+Date.now()-dispatchAt});
        results.push({task_id:item.task_id,role:item.role,acceptance_stage:acceptance.stage,acceptance_verdict:acceptanceFailed?'fail':'pass',acceptance_message:acceptance.history.at(-1)?.action,invocation_id:ingested.invocation_id,status:ingested.status,result_status:ingested.result_status,result_error:ingested.result_error,usage,reservation:{tokens:tokenReservation,cost_usd:costReservation},next_action:ingested.status==='succeeded'?(ingested.result_status==='ingested'?`${item.role} result ingested and workflow advanced`:`${item.role} result awaits valid Evidence/RESULT.json`):'inspect invocation failure'});if(ingested.status==='succeeded')await recordDispatchSuccess(root,item.task_id,item.action,[ingested.invocation_id]);activeTasks.delete(item.task_id);ledger.push({event:'settle',task_id:item.task_id,total_tokens:usage.total_tokens,cost_usd:usage.cost_usd,at:new Date().toISOString()});await persist('running',null);
        if(unknownUsage)trip('Provider usage or cost is unrecorded; wave budget cannot be proven');
        else if(totalTokens>=plan.budget.max_tokens)trip(`token budget reached (${totalTokens}/${plan.budget.max_tokens})`);
        else if(totalCost>=plan.budget.max_cost_usd)trip(`cost budget reached (${totalCost}/${plan.budget.max_cost_usd})`);
      }catch(error){if(sealed)return;parked.add(item.task_id);const retry=await recordDispatchFailure(root,item.task_id,item.action,error,invocationId?[invocationId]:[]).catch(()=>null);results.push({task_id:item.task_id,role:item.role,status:'failed_to_dispatch',error:(error as Error).message,retry});ledger.push({event:'dispatch_failed',task_id:item.task_id,error:(error as Error).message.slice(0,500),retry_status:retry?.status??null,failure_fingerprint:retry?.failure_fingerprint??null,at:new Date().toISOString()});}finally{if(sealed)return;liveUsage.delete(item.task_id);activeTaskLeases.delete(item.task_id);const reservation=reservations.get(item.task_id);if(reservation){reservedTokens-=reservation.tokens;reservedCost-=reservation.cost;reservations.delete(item.task_id)}activeTasks.delete(item.task_id);if(lease)await releaseTaskLease(root,lease.lease_id,lease.fencing_token).catch(()=>{});await persist(fuse?'stopping':'running',null)}}};
      for(;;){
        const workers=Promise.all(Array.from({length:Math.min(plan.budget.max_parallel,queue.length)},()=>worker()));
        await Promise.race([workers,stoppingSignal.then(async()=>{await stopPromise})]);
        if(fuse||input.singleStage)break;
        const nextPlan=await Promise.race([planReadyWave(root,{includeCandidateRecovery:false,taskIds:authorizedTasks}),stoppingSignal.then(()=>null)]);if(!nextPlan)break;if(!nextPlan.executable){trip('scheduler paused, killed, or requires reconciliation');break;}
        if(sha256(JSON.stringify(await (await import('./execution.js')).readGateConfig(root)))!==approvedGateHash){trip('approved Gate plan changed during the wave');break;}
        if(executionMode==='batch_two_rounds'){
          for(const id of authorizedTasks)if((await readAcceptanceRun(root,id)).contract_hash!==authorizedContracts.get(id)){parked.add(id);waveBlockReason=`approved contract changed during batch wave: ${id}`;ledger.push({event:'scope_changed',task_id:id,at:new Date().toISOString()})}
          if(waveBlockReason)break;
          // A Task with an invalid or failed invocation is parked for wave
          // review; it must not hold the V/R barrier for independent Tasks.
          const stages=(await buildAcceptanceSchedule(root)).tasks.filter(task=>authorizedTasks.has(task.task_id)&&!parked.has(task.task_id));
          if(!stages.length){waveBlockReason='all approved Tasks are parked for wave review';break}
          const step=batchWaveStep(phase,stages,attempted);phase=step.phase;verificationRound=step.verification_round;
          await persist('running',null);
          if(step.status==='complete')break;
          if(step.status==='blocked'){waveBlockReason=step.reason;break}
          const scope=new Set(step.task_ids),ready=nextPlan.ready.filter(item=>scope.has(item.task_id)&&item.role===step.role&&!parked.has(item.task_id));
          queue.splice(0,queue.length,...ready);next=0;
          if(!queue.length){waveBlockReason=`${phase} has no dispatchable Tasks after scheduler holds`;break}
        }else{
          const ready=nextPlan.ready.filter(item=>authorizedTasks.has(item.task_id)&&!parked.has(item.task_id));
          for(const item of [...ready])if((await readAcceptanceRun(root,item.task_id)).contract_hash!==authorizedContracts.get(item.task_id)){parked.add(item.task_id);ledger.push({event:'scope_changed',task_id:item.task_id,at:new Date().toISOString()});}
          queue.splice(0,queue.length,...ready.filter(item=>!parked.has(item.task_id)));next=0;
          if(!queue.length)break;
        }
      }
    }finally{clearTimeout(timer);if(stopPromise)await stopPromise;if(fuse){sealed=true;if(activeTasks.size)unknownUsage=true}}
    executionFinished=true;
  }finally{leaseRenewalStopped=true;clearInterval(pulse);if(leaseTimer)clearTimeout(leaseTimer);await withOperationTimeout(leaseRenewalWork,1_000,'wave lease renewal drain').catch(()=>{});if(projectLease&&!executionFinished)await withOperationTimeout(releaseProjectLease(root,projectLease.lease_id,projectLease.fencing_token),1_000,'wave project lease release').catch(()=>{})}
  try{
  const incompleteStops=stopResults.some(item=>item.stop_complete!==true);if(incompleteStops)await withOperationTimeout(lock(root,async()=>{const current=await state(root);await writeState(root,{...current,paused:true,reconcile_required:true,updated_at:new Date().toISOString()})}),1_000,'wave incomplete stop pause').catch(()=>{});
  const finalRuns=executionMode==='batch_two_rounds'?await Promise.all([...authorizedTasks].map(id=>readAcceptanceRun(root,id))):[];
  const batchSuccess=executionMode==='batch_two_rounds'&&!waveBlockReason&&['initial_r','recheck_r'].includes(phase)&&finalRuns.every(run=>run.stage==='candidate');
  if(executionMode==='batch_two_rounds'&&!batchSuccess&&verificationRound===2&&!waveBlockReason&&!fuse&&!incompleteStops)waveBlockReason=`second verification round ended with unresolved Tasks: ${finalRuns.filter(run=>run.stage!=='candidate').map(run=>`${run.task_id}:${run.stage}`).join('; ')}`;
  const failed=executionMode==='batch_two_rounds'?!batchSuccess:results.some(item=>item.status!=='succeeded'||item.result_status!=='ingested'||item.acceptance_verdict==='fail');
  const status=incompleteStops?'stop_incomplete':fuse?(unknownUsage?'usage_unknown':'budget_stopped'):failed?'completed_with_failures':'completed';await writer.close(snapshot(status,new Date().toISOString()));
  const finished=JSON.parse(await readFile(recordFile,'utf8'));if(!incompleteStops&&authorizedTasks.size){
    const finalizing={...finished,execution_status:status,status:'finalizing',finalization_project_lease:projectLease,finalization_deadline_at:new Date(Date.now()+15_000).toISOString()};
    await withAbortableOperationTimeout(signal=>atomicWriteTelemetry(root,{file:recordFile,content:JSON.stringify(finalizing)+'\n'},signal),5_000,'wave finalization admission');
    const child=startManagedProcess({bin:process.execPath,args:[fileURLToPath(new URL('./cli.js',import.meta.url)),'_wave-review-finalize',root,'--wave',waveId],cwd:root,timeoutMs:15_000,terminationTimeoutMs:1_000,terminationGraceMs:100,maxCaptureBytes:64_000});
    const result=await child.completion;
    if(result.code===0&&!result.identity_error){const updated=JSON.parse(await readFile(recordFile,'utf8'));if(updated.review_state!=='awaiting_wave_review'||!updated.review_bundle_hash)throw new Error('finalizer exited without a bound review');return updated;}
    const stopped=await child.terminate({timeoutMs:1_000,graceMs:100}),failed={...finalizing,status:'finalization_incomplete',finalization_error:result.stderr.slice(-1000)||`finalizer exited ${result.code}`,finalizer_stop_verified:stopped};
    await withAbortableOperationTimeout(signal=>atomicWriteTelemetry(root,{file:recordFile,content:JSON.stringify(failed)+'\n'},signal),5_000,'wave finalization failure').catch(()=>{});
    await withOperationTimeout(lock(root,async()=>{const current=await state(root);await writeState(root,{...current,paused:true,reconcile_required:true,updated_at:new Date().toISOString()})}),1_000,'wave finalization pause').catch(()=>{});
    return failed;
  }return finished;
  }finally{if(projectLease)await withOperationTimeout(releaseProjectLease(root,projectLease.lease_id,projectLease.fencing_token),1_000,'wave project lease release').catch(()=>{})}
}

type WaveOwnershipSnapshot={tasks:TaskLease[];projects:ProjectLease[];references:Awaited<ReturnType<typeof roleInvocations>>;roles:Map<string,RoleInvocation[]>};
async function waveTaskOwnership(root:string,wave:Record<string,any>,taskId:string,snapshot?:WaveOwnershipSnapshot){
  const tasks=(snapshot?.tasks??await listLeases(taskDir(root),taskLeaseSchema)).filter(item=>item.task_id===taskId),projects=snapshot?.projects??await listLeases(projectDir(root),projectLeaseSchema);
  if(tasks.some(item=>active(item)&&projects.find(project=>project.lease_id===item.project_lease_id)?.idempotency_key!==wave.wave_id))return 'foreign';
  let roles=snapshot?.roles.get(taskId);if(!roles){roles=[];for(const item of (snapshot?.references??await roleInvocations(root)).filter(item=>item.taskId===taskId)){const invocation=await readRoleInvocation(root,taskId,item.id).catch(()=>null);if(invocation)roles.push(invocation);}snapshot?.roles.set(taskId,roles);}
  const unfinished=(item:RoleInvocation)=>['prepared','running','interrupted'].includes(item.status)||(item.status==='succeeded'&&item.result_status!=='ingested');
  if(roles.some(item=>unfinished(item)&&item.execution_binding&&item.execution_binding.wave_id!==wave.wave_id))return 'foreign';
  if(roles.some(item=>unfinished(item)&&!item.execution_binding))return 'unknown';
  if(tasks.some(item=>active(item)&&projects.find(project=>project.lease_id===item.project_lease_id)?.idempotency_key===wave.wave_id)||roles.some(item=>unfinished(item)&&item.execution_binding?.wave_id===wave.wave_id))return 'owned';
  return 'unknown';
}
export async function reconcileInterruptedWaves(root:string,apply=false){
  await initSchedulerControl(root);const items=[] as Array<Record<string,unknown>>;
  for(const name of (await readdir(waveDir(root))).filter(value=>value.endsWith('.json')).sort()){
    try{
      const file=path.join(waveDir(root),name),value=await healthRecord(file,1024*1024);if(!['running','stopping','finalizing'].includes(String(value.status)))continue;
      const heartbeatAge=healthAge(value.heartbeat_at),driver=value.driver as {pid?:number;process_started_at?:string|null}|undefined,probe=await inspectProcess(driver?.pid,driver?.process_started_at),driverAlive=probe.status==='alive',stale=value.status==='finalizing'?!(Date.parse(String(value.finalization_deadline_at))>Date.now()):heartbeatAge===null||heartbeatAge>10_000;
      if(probe.status==='unknown'||(driverAlive&&!driver?.process_started_at)){items.push({wave_id:value.wave_id,status:'identity_unknown',action:'inspection_only'});continue}
      if(driverAlive&&!stale){items.push({wave_id:value.wave_id,status:'active',heartbeat_age_ms:heartbeatAge,action:'none'});continue}
      if(!apply){items.push({wave_id:value.wave_id,status:driverAlive?'stale_heartbeat':'dead_driver',heartbeat_age_ms:heartbeatAge,action:'inspection_only'});continue}
      if(driverAlive&&driver?.pid===process.pid){items.push({wave_id:value.wave_id,status:'stale_heartbeat',action:'inspection_only',reason:'cannot terminate the current reconciliation process'});continue}
      if(driverAlive){const stopped=await terminateProcessTree(driver?.pid,driver?.process_started_at);if(!stopped.stopped){items.push({wave_id:value.wave_id,status:'stop_incomplete',action:'inspection_only',reason:stopped.reason});continue}}
      const planned=Array.isArray(value.planned_tasks)?value.planned_tasks.filter((id:unknown):id is string=>typeof id==='string'):[],reconciled:string[]=[],protectedInvocations:string[]=[];
      for(const taskId of planned)await taskStopLock(root,taskId,async()=>{
        const ownership=await waveTaskOwnership(root,value,taskId);
        for(const item of (await roleInvocations(root)).filter(item=>item.taskId===taskId)){
          let invocation=await readRoleInvocation(root,taskId,item.id);
          const binding=invocation.execution_binding;
          const boundLease=binding?taskLeaseSchema.parse(JSON.parse(await readFile(path.join(taskDir(root),`${binding.task_lease_id}.json`),'utf8'))):null;
          const boundProject=boundLease?projectLeaseSchema.parse(JSON.parse(await readFile(path.join(projectDir(root),`${boundLease.project_lease_id}.json`),'utf8'))):null;
          if(ownership!=='owned'||binding?.wave_id!==value.wave_id||boundLease?.task_id!==taskId||boundLease?.fencing_token!==binding?.task_fencing_token||boundProject?.idempotency_key!==value.wave_id||boundProject?.lease_id!==binding?.project_lease_id||boundProject?.fencing_token!==binding?.project_fencing_token||(value.project_lease&&binding?.project_lease_id!==(value.project_lease as any).lease_id)){if(['prepared','running','interrupted'].includes(invocation.status))protectedInvocations.push(item.id);continue}
          if(invocation.status==='running')invocation=await reconcileRoleInvocation(root,taskId,item.id);
          if(['running','prepared','interrupted'].includes(invocation.status))invocation=await cancelRoleInvocation(root,taskId,item.id);
          if(invocation.status==='succeeded'&&invocation.result_status!=='ingested')await ingestSucceededRoleResult(root,taskId,item.id);
          reconciled.push(item.id);
        }
      });
      const plan=await planReadyWave(root),requeued=plan.ready.filter(item=>planned.includes(item.task_id)).map(item=>item.task_id),updated={...value,schema_version:2,status:'interrupted_requeued',finished_at:new Date().toISOString(),heartbeat_at:new Date().toISOString(),recovery:{reason:driverAlive?'stale_wave_heartbeat':'dead_wave_driver',reconciled_invocations:reconciled.sort(),protected_invocations:protectedInvocations.sort(),requeued_tasks:requeued,recovered_at:new Date().toISOString()}};
      await atomicWriteMany(root,[{file,content:JSON.stringify(updated)+'\n'}]);items.push({wave_id:value.wave_id,status:'interrupted_requeued',action:'reconciled',requeued_tasks:requeued,protected_invocations:protectedInvocations});
    }catch(error){items.push({file:name,status:'recovery_failed',action:'inspection_only',error:(error as Error).message.slice(0,500)});}
  }
  return{schema_version:1,apply,reconciled_at:new Date().toISOString(),waves:items};
}

async function healthRecord(file: string,maxBytes=256*1024): Promise<Record<string, any>> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('invalid runtime marker');
  const value: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime marker must be an object');
  return value as Record<string, any>;
}
function healthAge(value: unknown): number | null {
  if (typeof value !== 'string' || !z.iso.datetime().safeParse(value).success) return null;
  const timestamp = Date.parse(value), now = Date.now();
  return Number.isFinite(timestamp) && timestamp <= now + 30_000 ? Math.max(0, now - timestamp) : null;
}
function processHealthStatus(probe: Awaited<ReturnType<typeof inspectProcess>>, expected: unknown): string | null {
  if (probe.status === 'unknown' || (probe.status === 'alive' && !expected)) return 'identity_unknown';
  return probe.status === 'alive' ? null : 'dead_or_pid_reused';
}
export async function inspectSchedulerLiveness(root:string,staleSeconds=15,onlyTask?:string){
  if(!Number.isInteger(staleSeconds)||staleSeconds<3||staleSeconds>3600)throw new Error('stale heartbeat threshold must be 3–3600 seconds');
  await initSchedulerControl(root);
  const now=Date.now(),invocations=[] as Array<Record<string,unknown>>,awaitingIngestion=[] as Array<Record<string,unknown>>,effects=[] as Array<Record<string,unknown>>,drivers=[] as Array<Record<string,unknown>>,waves=[] as Array<Record<string,unknown>>,controlLocks=[] as Array<Record<string,unknown>>;
  const [tasks,projects,references]=await Promise.all([listLeases(taskDir(root),taskLeaseSchema),listLeases(projectDir(root),projectLeaseSchema),roleInvocations(root)]);
  const ownership:WaveOwnershipSnapshot={tasks,projects,references,roles:new Map()};
  for(const item of references){
    if(onlyTask&&item.taskId!==onlyTask)continue;
    const invocation=await readRoleInvocation(root,item.taskId,item.id).catch(()=>null);
    if(!ownership.roles.has(item.taskId))ownership.roles.set(item.taskId,[]);if(invocation)ownership.roles.get(item.taskId)!.push(invocation);
    if(invocation?.status==='succeeded'&&invocation.result_status!=='ingested'){
      awaitingIngestion.push({task_id:item.taskId,invocation_id:item.id,role:invocation.role,finished_at:invocation.finished_at,wait_age_ms:healthAge(invocation.finished_at)});continue;
    }
    if(invocation?.status!=='running')continue;
    let heartbeat: Record<string, any> | null = null, malformed=false;
    try { heartbeat=await healthRecord(path.join(root,'.spec-loop','output',`${item.taskId}-acceptance-v2`,'invocations',item.id,'HEARTBEAT.json')); }
    catch(error){malformed=(error as NodeJS.ErrnoException).code!=='ENOENT';}
    const heartbeatAt=heartbeat?.heartbeat_at??invocation.heartbeat_at??invocation.started_at,lastProgressAt=heartbeat?.last_progress_at??invocation.last_progress_at??invocation.started_at;
    const age=healthAge(heartbeatAt),progressAge=healthAge(lastProgressAt),idleSeconds=heartbeat?.idle_timeout_seconds??300,idleMs=idleSeconds*1000;
    const identity=heartbeat?.process_started_at??invocation.process_started_at,probe=await inspectProcess(invocation.pid,identity);
    const status=processHealthStatus(probe,identity)??(malformed||!Number.isFinite(idleSeconds)||idleSeconds<=0||idleSeconds>3600?'invalid_marker':age===null||progressAge===null?'invalid_timestamp':age>staleSeconds*1000?'controller_stalled':progressAge>idleMs?'no_progress':'healthy');
    invocations.push({task_id:item.taskId,invocation_id:item.id,pid:invocation.pid,process_started_at:identity??null,heartbeat_at:heartbeatAt,heartbeat_age_ms:age,last_progress_at:lastProgressAt,progress_age_ms:progressAge,no_progress_remaining_ms:progressAge===null?null:Math.max(0,idleMs-progressAge),idle_timeout_ms:idleMs,progress_sequence:heartbeat?.progress_sequence??invocation.progress_sequence,output_bytes:heartbeat?.output_bytes??null,status});
  }
  const effectRoot=path.join(root,'.spec-loop','active-effects');
  for(const name of (await readdir(effectRoot).catch(()=>[])).filter(value=>value.endsWith('.json'))){
    try{
      const value=await healthRecord(path.join(effectRoot,name));if(onlyTask&&value.task_id!==onlyTask)continue;const at=value.heartbeat_at??value.started_at??null,progressAt=value.last_progress_at??value.started_at??null;
      const age=healthAge(at),progressAge=healthAge(progressAt),idleSeconds=value.idle_timeout_seconds??300,idleMs=idleSeconds*1000,probe=await inspectProcess(value.pid,value.process_started_at);
      const status=processHealthStatus(probe,value.process_started_at)??(!Number.isFinite(idleSeconds)||idleSeconds<=0||idleSeconds>3600?'invalid_marker':age===null||progressAge===null?'invalid_timestamp':age>staleSeconds*1000?'controller_stalled':progressAge>idleMs?'no_progress':'healthy');
      effects.push({task_id:value.task_id,effect_id:value.effect_id,pid:value.pid,process_started_at:value.process_started_at??null,heartbeat_at:at,heartbeat_age_ms:age,last_progress_at:progressAt,progress_age_ms:progressAge,idle_timeout_ms:idleMs,progress_sequence:value.progress_sequence??null,output_bytes:value.output_bytes??null,status});
    }catch(error){effects.push({file:name,status:'invalid_marker',error:(error as Error).message.slice(0,500)});}
  }
  const locks=path.join(root,'.spec-loop','locks');
  for(const name of await readdir(locks).catch(()=>[])){
    const match=name.match(/^workflow-driver-(.+)\.lock$/);if(!match||(onlyTask&&match[1]!==onlyTask))continue;
    const owner=await healthRecord(path.join(locks,name,'owner.json')).catch(()=>null),probe=await inspectProcess(owner?.pid,owner?.process_started_at);
    drivers.push({task_id:match[1],pid:owner?.pid??null,process_started_at:owner?.process_started_at??null,owner_at:owner?.at??owner?.created_at??null,status:processHealthStatus(probe,owner?.process_started_at)??'healthy'});
  }
  for(const [name,directory] of [['scheduler_control',path.join(rootDir(root),'mutex')],['scheduler_supervisor',path.join(root,'.spec-loop','locks','scheduler-supervisor.lock')],['report_scheduler',path.join(root,'.spec-loop','scheduler-report.lock')]] as const){
    const inspection=await inspectOwnedDirectoryLock(directory),telemetry=await readFile(path.join(rootDir(root),'control-health',`${name==='scheduler_control'?'scheduler-control-lock':name==='scheduler_supervisor'?'supervisor-lock':'report-scheduler-lock'}.json`),'utf8').then(raw=>JSON.parse(raw) as Record<string,unknown>).catch(()=>null);
    controlLocks.push({name,directory,active:inspection.exists,status:!inspection.exists?'idle':inspection.reason==='owned'||inspection.reason==='legacy_owner'?'healthy':inspection.reason,owner:inspection.owner,owner_age_ms:inspection.owner_age_ms,wait_duration_ms:telemetry?.wait_duration_ms??null,last_reclaim_reason:telemetry?.last_reclaim_reason??null,reclaim_count:telemetry?.reclaim_count??0,consecutive_acquire_failures:telemetry?.consecutive_acquire_failures??0,updated_at:telemetry?.updated_at??null});
  }
  let waveTotal=0,waveCompleted=0;
  for(const name of (await readdir(waveDir(root))).filter(value=>value.endsWith('.json'))){
    try{
      const value=await healthRecord(path.join(waveDir(root),name),1024*1024);waveTotal+=1;if(value.status==='completed'||value.execution_status==='completed')waveCompleted+=1;if(!['running','stopping','stop_incomplete','finalizing'].includes(value.status))continue;
      const age=healthAge(value.started_at),heartbeatAge=healthAge(value.heartbeat_at),seconds=value.budget?.max_elapsed_seconds,limit=seconds*1000,probe=await inspectProcess(value.driver?.pid,value.driver?.process_started_at);
      const identityStatus=processHealthStatus(probe,value.driver?.process_started_at),waveStatus=value.status==='stop_incomplete'?'stop_incomplete':identityStatus==='dead_or_pid_reused'?'dead_driver':identityStatus??(value.status==='finalizing'?(Date.parse(value.finalization_deadline_at)>Date.now()?'healthy':'finalization_overdue'):age===null||heartbeatAge===null?'invalid_timestamp':!Number.isFinite(seconds)||seconds<=0?'invalid':heartbeatAge>Math.max(10_000,staleSeconds*1000)?'stalled':age>limit+staleSeconds*1000?'overdue':'healthy');
      const recoverableTasks=[] as string[];for(const id of (value.pending_stops??value.planned_tasks??[]))if(typeof id==='string'&&await waveTaskOwnership(root,value,id,ownership)==='owned')recoverableTasks.push(id);
      waves.push({wave_id:value.wave_id,execution_mode:value.execution_mode??'task_continuous',phase:value.phase??null,verification_round:value.verification_round??null,max_verification_rounds:value.max_verification_rounds??null,block_reason:value.block_reason??null,started_at:value.started_at??null,heartbeat_at:value.heartbeat_at??null,heartbeat_age_ms:heartbeatAge,age_ms:age,max_elapsed_ms:Number.isFinite(limit)?limit:null,elapsed_ratio:limit&&age!==null?Math.min(1,age/limit):null,token_ratio:value.budget?.max_tokens&&typeof value.usage?.total_tokens==='number'?Math.min(1,value.usage.total_tokens/value.budget.max_tokens):null,cost_ratio:value.budget?.max_cost_usd&&typeof value.usage?.cost_usd==='number'?Math.min(1,value.usage.cost_usd/value.budget.max_cost_usd):null,control_io:value.control_io??null,task_ids:value.status==='finalizing'?[]:recoverableTasks,driver_pid:value.driver?.pid??null,process_started_at:value.driver?.process_started_at??null,status:waveStatus});
    }catch(error){waves.push({file:name,status:'invalid_marker',error:(error as Error).message.slice(0,500)});}
  }
  const supervisor=await readFile(path.join(root,'.spec-loop','scheduler','SUPERVISOR.json'),'utf8').then(raw=>JSON.parse(raw) as Record<string,unknown>).catch(()=>null),leaseHealth=[...projects.map(item=>({kind:'project',lease_id:item.lease_id,status:item.status,owner:item.owner,remaining_ms:active(item)?Math.max(0,Date.parse(item.expires_at)-now):0})),...tasks.map(item=>({kind:'task',lease_id:item.lease_id,task_id:item.task_id,status:item.status,owner:item.owner,remaining_ms:active(item)?Math.max(0,Date.parse(item.expires_at)-now):0}))],dispatchStates=await listLeases(dispatchDir(root),dispatchStateSchema);
  const unhealthy=[...invocations,...effects,...drivers,...waves,...controlLocks.filter(item=>item.active)].filter(item=>item.status!=='healthy'),lockReclaims=controlLocks.reduce((sum,item)=>sum+(typeof item.reclaim_count==='number'?item.reclaim_count:0),0);return{schema_version:1,checked_at:new Date(now).toISOString(),stale_seconds:staleSeconds,ok:unhealthy.length===0,slo:{wave_total:waveTotal,wave_completed:waveCompleted,wave_completion_rate:waveTotal?waveCompleted/waveTotal:null,watchdog_timeout_count:typeof supervisor?.last_error==='string'&&supervisor.last_error.includes('watchdog cycle exceeded')?1:0,dead_lock_recovery_count:lockReclaims},supervisor:supervisor?{state:supervisor.state,successful_watchdogs:supervisor.successful_watchdogs??0,consecutive_failures:supervisor.consecutive_failures??0,last_recovery_action:supervisor.last_recovery_action??null,control_io:supervisor.control_io??null,test_mode:supervisor.test_mode??false}:null,leases:leaseHealth,retry_wait:dispatchStates.filter(item=>item.status==='retry_wait'),dead_letters:dispatchStates.filter(item=>item.status==='dead_letter'),awaiting_ingestion:awaitingIngestion,invocations,effects,drivers,waves,control_locks:controlLocks,unhealthy};
}
function watchdogReferences(health:Awaited<ReturnType<typeof inspectSchedulerLiveness>>,taskId:string){
  return [
    ...health.invocations.filter(row=>row.task_id===taskId).map(row=>({status:row.status,reference:{source:'invocation' as const,id:String(row.invocation_id),pid:row.pid as number|null,process_started_at:row.process_started_at as string|null}})),
    ...health.effects.filter(row=>row.task_id===taskId).map(row=>({status:row.status,reference:{source:'effect' as const,id:String(row.effect_id),pid:row.pid as number|null,process_started_at:row.process_started_at as string|null}})),
    ...health.drivers.filter(row=>row.task_id===taskId).map(row=>({status:row.status,reference:{source:'driver' as const,id:taskId,pid:row.pid as number|null,process_started_at:row.process_started_at as string|null}})),
    ...health.waves.filter(row=>Array.isArray(row.task_ids)&&row.task_ids.includes(taskId)).map(row=>({status:row.status,reference:{source:'wave' as const,id:String(row.wave_id),pid:row.driver_pid as number|null,process_started_at:row.process_started_at as string|null}})),
  ];
}
export async function runSchedulerWatchdog(root:string,staleSeconds=15,apply=false){
  const health=await inspectSchedulerLiveness(root,staleSeconds);if(!apply)return{...health,action:'inspection_only',stopped_tasks:[],wave_recovery:null};
  const pendingIntents=[] as Array<{task_id?:string;status?:string;watchdog_conditions?:WatchdogStopCondition[]}>;for(const name of (await readdir(stopIntentDir(root)).catch(()=>[])).filter(value=>value.endsWith('.json')))pendingIntents.push(await readFile(path.join(stopIntentDir(root),name),'utf8').then(raw=>JSON.parse(raw)).catch(()=>({})));
  const taskIds=[...new Set([...health.unhealthy.flatMap(item=>item.status==='identity_unknown'?[]:typeof item.task_id==='string'?[item.task_id]:'task_ids' in item&&Array.isArray(item.task_ids)?item.task_ids.filter((id:unknown):id is string=>typeof id==='string'):[]),...pendingIntents.flatMap(item=>item.status!=='completed'&&typeof item.task_id==='string'?[item.task_id]:[])])].sort();
  const reason=`watchdog detected stale, dead, or no-progress execution after ${staleSeconds}s`,watchdogDeadline=performance.now()+10_000;
  const conditions:Record<string,WatchdogStopCondition[]>={};for(const id of taskIds){const pending=pendingIntents.find(item=>item.task_id===id&&item.status!=='completed');if(pending&&!pending.watchdog_conditions)continue;conditions[id]=[...watchdogReferences(health,id).filter(row=>!['healthy','identity_unknown'].includes(String(row.status))).map(row=>row.reference),...(pending?.watchdog_conditions??[])];}
  const batch=await runBoundedTaskStops(root,taskIds,reason,{watchdogConditions:conditions,watchdogStaleSeconds:staleSeconds}),stopped=batch.stopped_tasks;

  const waveRecovery=performance.now()<watchdogDeadline-1_000?await withOperationTimeout(reconcileInterruptedWaves(root,true),Math.max(500,watchdogDeadline-performance.now()-500),'watchdog wave reconciliation').catch(error=>({apply:true,reconciled_at:new Date().toISOString(),waves:[],error:(error as Error).message})):null;
  const authorizationRecovery=performance.now()<watchdogDeadline-500?await withOperationTimeout(reconcileWaveAuthorizations(root,Date.now()+Math.max(1,watchdogDeadline-performance.now()-500)),Math.max(1,watchdogDeadline-performance.now()-500),'watchdog authorization reconciliation').catch(error=>({error:(error as Error).message})):null;
  return{...health,action:'stopped_unhealthy_tasks',stopped_tasks:stopped,wave_recovery:waveRecovery,authorization_recovery:authorizationRecovery};
}

export async function schedulerControlStatus(root:string){return{control:await state(root),budget:await readWaveBudget(root),project_leases:await listLeases(projectDir(root),projectLeaseSchema),task_leases:await listLeases(taskDir(root),taskLeaseSchema),task_dispatch:await listLeases(dispatchDir(root),dispatchStateSchema)}}
