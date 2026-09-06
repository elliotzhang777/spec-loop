import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteMany, exists, readMarkdown, sha256 } from './files.js';
import { readProviderConfig, scanTasks } from './project.js';
import { readWorkspace } from './execution.js';
import { finishExecutionStep, reconcileInterruptedExecutionSteps, startExecutionStep } from './execution-events.js';
import { readState, runtimeInit } from './task.js';
import { readBudget } from './runtime.js';

const roleSchema=z.enum(['M','V','R']);
const statusSchema=z.enum(['prepared','running','succeeded','failed','timed_out','cancelled','interrupted']);
const resultStatusSchema=z.enum(['none','awaiting_ingestion','ingested','invalid']);
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const usageSchema=z.object({input_tokens:z.number().int().nonnegative().nullable(),cached_input_tokens:z.number().int().nonnegative().nullable(),output_tokens:z.number().int().nonnegative().nullable(),reasoning_tokens:z.number().int().nonnegative().nullable(),total_tokens:z.number().int().nonnegative().nullable(),cost_usd:z.number().nonnegative().nullable(),recorded:z.boolean()}).strict();
const emptyUsage={input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null,cost_usd:null,recorded:false};
const MAX_PROVIDER_OUTPUT_BYTES=1_048_576;
const invocationSchema=z.object({
  schema_version:z.literal(2),invocation_id:z.string().regex(/^INV-(?:WEB-)?TASK-[A-Z0-9-]+-[MVR]-[a-f0-9-]+$/),
  task_id:z.string().regex(/^(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*$/),run_id:z.string(),role:roleSchema,status:statusSchema,
  provider:z.string(),provider_identity:z.object({executable:z.string(),resolved:z.string(),args_sha256:hashSchema,version:z.string().nullable()}).strict().nullable().default(null),candidate:z.object({path:z.string(),access:z.enum(['read_write','read_only_snapshot']),head:z.string().min(7),fingerprint:hashSchema}).strict(),
  evidence_root:z.string(),context:z.array(z.object({file:z.string(),sha256:hashSchema}).strict()).min(2),
  forbidden_actions:z.array(z.enum(['merge','push','deploy','credential_write','production_data','external_side_effect'])).length(6),
  prompt_hash:hashSchema,pid:z.number().int().positive().nullable(),exit_code:z.number().int().nullable(),timed_out:z.boolean(),
  output_sha256:hashSchema.nullable(),output_truncated:z.boolean().default(false),usage:usageSchema.default(emptyUsage),failure_fingerprint:hashSchema.nullable().default(null),created_at:z.iso.datetime(),started_at:z.iso.datetime().nullable(),finished_at:z.iso.datetime().nullable(),last_error:z.string().nullable(),
  heartbeat_at:z.iso.datetime().nullable().default(null),
  runtime_probe_hash:hashSchema.nullable().default(null),token_limit:z.number().int().positive().nullable().default(null),cost_limit_usd:z.number().positive().nullable().default(null),
  result_status:resultStatusSchema.default('none'),result_error:z.string().max(1000).nullable().default(null),
}).strict();

export type RoleInvocation=z.infer<typeof invocationSchema>;
export type AcceptanceRole=z.infer<typeof roleSchema>;

const control=(root:string)=>path.join(root,'.spec-loop');
const acceptanceOutput=(root:string,taskId:string)=>path.join(control(root),'output',`${taskId}-acceptance-v2`);
const invocationRoot=(root:string,taskId:string,id:string)=>path.join(acceptanceOutput(root,taskId),'invocations',id);
const invocationFile=(root:string,taskId:string,id:string)=>path.join(invocationRoot(root,taskId,id),'INVOCATION.json');
const heartbeatFile=(root:string,taskId:string,id:string)=>path.join(invocationRoot(root,taskId,id),'HEARTBEAT.json');

async function git(cwd:string,args:string[]):Promise<string>{return new Promise((resolve,reject)=>{const child=spawn('git',args,{cwd,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='',settled=false;const kill=()=>{try{if(process.platform==='win32')child.kill('SIGKILL');else process.kill(-(child.pid as number),'SIGKILL')}catch{child.kill('SIGKILL')}};const timer=setTimeout(()=>{if(settled)return;settled=true;kill();reject(new Error(`git ${args[0]??'command'} timed out after 60s`))},60_000);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)});child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);code===0?resolve(stdout.trim()):reject(new Error(stderr.trim()||`git exited ${code}`))})})}

async function treeFingerprint(root:string):Promise<string>{
  const entries:Array<{file:string;kind:string;sha256:string|null}>=[];
  async function walk(dir:string):Promise<void>{for(const entry of await readdir(dir,{withFileTypes:true})){const target=path.join(dir,entry.name),relative=path.relative(root,target).split(path.sep).join('/');if(entry.isDirectory())await walk(target);else if(entry.isSymbolicLink())entries.push({file:relative,kind:'symlink',sha256:sha256(await readlink(target))});else if(entry.isFile())entries.push({file:relative,kind:'file',sha256:sha256(await readFile(target))});else throw new Error(`unsupported candidate entry: ${relative}`)}}
  await walk(root);entries.sort((left,right)=>left.file.localeCompare(right.file));return sha256(JSON.stringify(entries));
}

async function extractSnapshot(worktree:string,head:string,destination:string):Promise<void>{
  await mkdir(destination,{recursive:true});
  await new Promise<void>((resolve,reject)=>{
    const archive=spawn('git',['archive','--format=tar',head],{cwd:worktree,stdio:['ignore','pipe','pipe']}),extract=spawn('tar',['-xf','-','-C',destination],{stdio:['pipe','ignore','pipe']});
    let archiveError='',extractError='',archiveCode:number|null=null,extractCode:number|null=null,settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;archive.kill('SIGKILL');extract.kill('SIGKILL');reject(new Error('role snapshot extraction timed out after 60s'))},60_000);
    const finish=()=>{if(settled||archiveCode===null||extractCode===null)return;settled=true;clearTimeout(timer);archiveCode===0&&extractCode===0?resolve():reject(new Error(archiveError||extractError||'cannot create role snapshot'))};
    archive.stdout.pipe(extract.stdin);archive.stderr.on('data',chunk=>archiveError+=chunk);extract.stderr.on('data',chunk=>extractError+=chunk);
    archive.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)});extract.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)});archive.on('close',code=>{archiveCode=code??1;finish()});extract.on('close',code=>{extractCode=code??1;finish()});
  });
}

async function makeReadOnly(root:string):Promise<void>{
  const directories=[root];
  async function walk(dir:string):Promise<void>{for(const entry of await readdir(dir,{withFileTypes:true})){const target=path.join(dir,entry.name);if(entry.isDirectory()){directories.push(target);await walk(target)}else if(!entry.isSymbolicLink())await chmod(target,0o444)}}
  await walk(root);for(const directory of directories.reverse())await chmod(directory,0o555);
}

async function contextRecord(root:string,file:string){const relative=path.relative(root,file);if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('role context escapes Project root');return{file:relative,sha256:sha256(await readFile(file))}}

function rolePrompt(value:{taskId:string;role:AcceptanceRole;head:string;contextRoot:string;context:Array<{file:string;sha256:string}>;evidenceRoot:string}):string{
  const responsibility=value.role==='M'?'Implement only the approved contract and write self-test evidence. Do not change acceptance criteria.':value.role==='V'?'Independently review every approved assertion against the frozen plan and relevant source. The Controller runs deterministic Gates after this review; do not run the full suite or expect generated dist/node_modules in the immutable snapshot. Do not modify the candidate.': 'Review the current V record and Evidence against every acceptance criterion. Do not rerun V or modify the candidate.';
  return [`Role ${value.role} for ${value.taskId}.`,responsibility,`Candidate HEAD: ${value.head}.`,`Evidence output (writable): ${value.evidenceRoot}.`,`Control context root (read-only): ${value.contextRoot}.`,'Keep inspection bounded to the approved AC and relevant implementation/test files; do not recursively ingest the repository. Write a concise evidence summary before finishing.','Forbidden: merge, push, deploy, credential changes, production data, and unapproved external side effects.','Context:',...value.context.map(item=>`- ${path.join(value.contextRoot,item.file)} sha256=${item.sha256}`)].join('\n');
}

async function writeInvocation(root:string,value:RoleInvocation):Promise<void>{await atomicWriteMany(root,[{file:invocationFile(root,value.task_id,value.invocation_id),content:`${JSON.stringify(invocationSchema.parse(value),null,2)}\n`}])}

export async function readRoleInvocation(root:string,taskId:string,id:string):Promise<RoleInvocation>{return invocationSchema.parse(JSON.parse(await readFile(invocationFile(root,taskId,id),'utf8')))}

async function invocationRecords(root:string,taskId:string):Promise<RoleInvocation[]>{const dir=path.join(acceptanceOutput(root,taskId),'invocations');if(!(await exists(dir)))return[];const values=[] as RoleInvocation[];for(const entry of await readdir(dir,{withFileTypes:true}))if(entry.isDirectory()){const value=await readRoleInvocation(root,taskId,entry.name).catch(()=>null);if(value)values.push(value)}return values.sort((left,right)=>left.created_at.localeCompare(right.created_at))}
export async function latestRoleInvocation(root:string,taskId:string,role:AcceptanceRole):Promise<RoleInvocation|null>{const values=(await invocationRecords(root,taskId)).filter(item=>item.role===role);return values.at(-1)??null}
function providerFailureFingerprint(role:AcceptanceRole,code:number,timedOut:boolean,stderr:string){const normalized=stderr.trim().toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').slice(0,2_000);return sha256(JSON.stringify({role,code,timed_out:timedOut,message:normalized}))}
function findUsage(value:unknown,found:Array<Record<string,unknown>>):void{if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)findUsage(item,found);return}const record=value as Record<string,unknown>;if(record.usage&&typeof record.usage==='object'&&!Array.isArray(record.usage))found.push(record.usage as Record<string,unknown>);for(const nested of Object.values(record))findUsage(nested,found)}
function providerUsage(stdout:string){const found:Array<Record<string,unknown>>=[];for(const line of stdout.split(/\r?\n/)){try{findUsage(JSON.parse(line),found)}catch{}}const value=found.at(-1);if(!value)return usageSchema.parse(emptyUsage);const number=(...keys:string[])=>{for(const key of keys)if(typeof value[key]==='number'&&Number.isFinite(value[key]))return Math.max(0,Math.trunc(value[key] as number));return null};const decimal=(...keys:string[])=>{for(const key of keys)if(typeof value[key]==='number'&&Number.isFinite(value[key]))return Math.max(0,value[key] as number);return null};const input=number('input_tokens','inputTokens'),cached=number('cached_input_tokens','cachedInputTokens'),output=number('output_tokens','outputTokens'),reasoning=number('reasoning_tokens','reasoningTokens'),declaredTotal=number('total_tokens','totalTokens'),total=declaredTotal??(input!==null||output!==null?(input??0)+(output??0):null),cost=decimal('cost_usd','costUsd','cost');return usageSchema.parse({input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_tokens:reasoning,total_tokens:total,cost_usd:cost,recorded:total!==null})}

function providerEnvironment(root:string,extra:Record<string,string>={}):NodeJS.ProcessEnv{
  const locale=[process.env.LC_ALL,process.env.LANG].find(value=>value&&/utf-?8/i.test(value))??'en_US.UTF-8';
  const shared=path.join(root,'.spec-loop','shared-cache');
  return{PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:path.join(shared,'tmp'),LANG:locale,LC_ALL:locale,
    npm_config_cache:path.join(shared,'npm'),MAVEN_OPTS:[process.env.MAVEN_OPTS,`-Dmaven.repo.local=${path.join(shared,'maven')}`].filter(Boolean).join(' '),SPEC_LOOP_SHARED_CACHE_ROOT:shared,...extra};
}

function signalProcessTree(pid:number|null|undefined,signal:NodeJS.Signals):void{if(!pid)return;try{if(process.platform==='win32')process.kill(pid,signal);else process.kill(-pid,signal)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')try{process.kill(pid,signal)}catch{/* already stopped */}}}
async function processAlive(pid:number):Promise<boolean>{try{process.kill(pid,0);return true}catch{return false}}
async function terminateProcessTree(pid:number|null|undefined):Promise<void>{if(!pid)return;signalProcessTree(pid,'SIGTERM');for(let attempt=0;attempt<20&&await processAlive(pid);attempt++)await new Promise(resolve=>setTimeout(resolve,50));if(await processAlive(pid))signalProcessTree(pid,'SIGKILL')}

async function ensureCodexRuntimeProbe(root:string,role:AcceptanceRole,resolved:string,version:string|null,args:string[]):Promise<string|null>{
  if(path.basename(resolved)!=='codex')return null;
  const env=providerEnvironment(root),identity={resolved,version,args,role,platform:process.platform,arch:process.arch,node:process.version,LANG:env.LANG,LC_ALL:env.LC_ALL},hash=sha256(JSON.stringify(identity));
  const probeRoot=path.join(control(root),'provider-probes'),recordFile=path.join(probeRoot,`${hash}.json`),cached=await readFile(recordFile,'utf8').then(raw=>JSON.parse(raw) as {ok?:boolean;expires_at?:string;error?:string}).catch(()=>null);
  if(cached&&Date.parse(cached.expires_at??'')>Date.now()){if(cached.ok)return hash;throw new Error(`cached Codex runtime probe failed: ${cached.error??'unknown failure'}`)}
  const workspace=path.join(probeRoot,'workspace'),evidence=path.join(probeRoot,`evidence-${hash}`);await mkdir(workspace,{recursive:true});await mkdir(evidence,{recursive:true});for(const directory of [path.join(control(root),'shared-cache','tmp'),path.join(control(root),'shared-cache','npm'),path.join(control(root),'shared-cache','maven')])await mkdir(directory,{recursive:true});
  if(!(await exists(path.join(workspace,'.git'))))await git(workspace,['init']);
  const prompt=`Spec-Loop runtime probe for role ${role}. Do not inspect the Project or modify the candidate. Write exactly SPEC_LOOP_PROBE_OK to ${path.join(evidence,'probe-ok.txt')} and then print SPEC_LOOP_PROBE_OK.`;
  const probeArgs=buildProviderArgs('codex',args,role,workspace,prompt,evidence);let stdout='',stderr='',settled=false,timedOut=false;
  const result=await new Promise<{code:number}>((resolve)=>{const child=spawn(resolved,probeArgs,{cwd:workspace,detached:process.platform!=='win32',env:providerEnvironment(root,{SPEC_LOOP_ROLE:role,SPEC_LOOP_INVOCATION_ID:`PROBE-${hash}`,SPEC_LOOP_EVIDENCE_ROOT:evidence}),stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{timedOut=true;signalProcessTree(child.pid,'SIGTERM');setTimeout(()=>signalProcessTree(child.pid,'SIGKILL'),1000).unref()},20_000);child.stdout.on('data',chunk=>{if(stdout.length<64_000)stdout+=chunk});child.stderr.on('data',chunk=>{if(stderr.length<64_000)stderr+=chunk});child.on('error',error=>{stderr+=error.message});child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code:timedOut?124:(code??1)})})});
  const evidenceOk=await readFile(path.join(evidence,'probe-ok.txt'),'utf8').then(value=>value.trim()==='SPEC_LOOP_PROBE_OK').catch(()=>false),ok=result.code===0&&evidenceOk&&stdout.includes('SPEC_LOOP_PROBE_OK'),error=ok?null:(timedOut?'probe timed out after 20s':(stderr.trim()||`probe exited ${result.code} or did not write its Evidence sentinel`).slice(0,1000));
  const now=Date.now(),record={schema_version:1,identity_hash:hash,ok,error,checked_at:new Date(now).toISOString(),expires_at:new Date(now+(ok?24*60*60*1000:10*60*1000)).toISOString()};await atomicWriteMany(root,[{file:recordFile,content:`${JSON.stringify(record,null,2)}\n`}]);if(!ok)throw new Error(`Codex runtime probe failed: ${error}`);return hash;
}

export async function summarizeRoleUsage(root:string,taskId?:string){
  const tasks=taskId?[taskId]:(await readdir(path.join(root,'.spec-loop','output'),{withFileTypes:true}).catch(()=>[])).flatMap(entry=>{const match=entry.isDirectory()?entry.name.match(/^((?:WEB-)?TASK-[A-Z0-9-]+)-acceptance-v2$/):null;return match?[match[1]]:[]});
  const byTask=[] as Array<{task_id:string;invocations:number;recorded_runs:number;unrecorded_runs:number;input_tokens:number;cached_input_tokens:number;output_tokens:number;reasoning_tokens:number;total_tokens:number;cost_usd:number;cost_recorded_runs:number}>;
  for(const current of [...new Set(tasks)].sort()){
    const values=await invocationRecords(root,current),recorded=values.filter(item=>item.usage.recorded),costed=values.filter(item=>item.usage.cost_usd!==null),sum=(key:'input_tokens'|'cached_input_tokens'|'output_tokens'|'reasoning_tokens'|'total_tokens')=>values.reduce((total,item)=>total+(item.usage[key]??0),0);
    byTask.push({task_id:current,invocations:values.length,recorded_runs:recorded.length,unrecorded_runs:values.length-recorded.length,input_tokens:sum('input_tokens'),cached_input_tokens:sum('cached_input_tokens'),output_tokens:sum('output_tokens'),reasoning_tokens:sum('reasoning_tokens'),total_tokens:sum('total_tokens'),cost_usd:costed.reduce((total,item)=>total+(item.usage.cost_usd??0),0),cost_recorded_runs:costed.length});
  }
  return{schema_version:1,scope:taskId?'task':'project',task_id:taskId??null,tasks:byTask,totals:{invocations:byTask.reduce((sum,item)=>sum+item.invocations,0),recorded_runs:byTask.reduce((sum,item)=>sum+item.recorded_runs,0),unrecorded_runs:byTask.reduce((sum,item)=>sum+item.unrecorded_runs,0),input_tokens:byTask.reduce((sum,item)=>sum+item.input_tokens,0),cached_input_tokens:byTask.reduce((sum,item)=>sum+item.cached_input_tokens,0),output_tokens:byTask.reduce((sum,item)=>sum+item.output_tokens,0),reasoning_tokens:byTask.reduce((sum,item)=>sum+item.reasoning_tokens,0),total_tokens:byTask.reduce((sum,item)=>sum+item.total_tokens,0),cost_usd:byTask.reduce((sum,item)=>sum+item.cost_usd,0),cost_recorded_runs:byTask.reduce((sum,item)=>sum+item.cost_recorded_runs,0)}};
}

export async function prepareRoleInvocation(root:string,taskId:string,roleValue:AcceptanceRole):Promise<RoleInvocation>{
  const role=roleSchema.parse(roleValue),task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error(`task not found: ${taskId}`);
  const runPath=path.join(task.path,'ACCEPTANCE_RUN.json'),run=JSON.parse(await readFile(runPath,'utf8')) as {run_id?:string;stage?:string;current_head?:string|null;plan_hash?:string|null};
  const allowed:Record<AcceptanceRole,string[]>={M:['m_working'],V:['plan_compiled'],R:['v_passed']};if(!run.run_id||!run.stage||!allowed[role].includes(run.stage))throw new Error(`${role} invocation is illegal from ${run.stage??'unknown'}`);
  await (await import('./project.js')).verifyExecutionPreflight(root,taskId);
  const previous=await invocationRecords(root,taskId),roleTail=[...previous].reverse().filter(item=>item.role===role),tail=[] as RoleInvocation[];for(const item of roleTail){if(!item.failure_fingerprint)break;tail.push(item)}
  if(tail.length){const repeated=tail.findIndex(item=>item.failure_fingerprint!==tail[0].failure_fingerprint);const count=repeated<0?tail.length:repeated;const contract=(await readFile(path.join(task.path,'ACCEPTANCE_CONTRACT_V2.md'),'utf8'));const limit=Number(contract.match(/repeated_failure_limit:\s*(\d+)/)?.[1]??2);if(count>=limit)throw new Error(`${role} Provider circuit is open after ${count} identical failures (${tail[0].failure_fingerprint})`)}
  if(!(await exists(path.join(task.path,'BUDGET.md'))))await runtimeInit(task.path);
  const budget=await readBudget(task.path),knownTokens=previous.reduce((sum,item)=>sum+(item.usage.total_tokens??0),0);if(knownTokens>=budget.max_tokens)throw new Error(`Task token budget reached before ${role} invocation: ${knownTokens}/${budget.max_tokens}`);
  const workspace=await readWorkspace(root,taskId),actualHead=await git(workspace.worktree,['rev-parse','HEAD']);
  if(role!=='M'&&(!run.current_head||actualHead!==run.current_head||await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all'])))throw new Error(`${role} requires the current clean stable candidate HEAD`);
  const id=`INV-${taskId}-${role}-${randomUUID()}`,base=invocationRoot(root,taskId,id),evidenceRoot=path.join(base,'evidence');await mkdir(evidenceRoot,{recursive:true});
  let candidatePath=workspace.worktree,access:'read_write'|'read_only_snapshot'='read_write',fingerprint:string;
  if(role==='M')fingerprint=sha256(await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all']));
  else{candidatePath=path.join(base,'candidate');access='read_only_snapshot';await extractSnapshot(workspace.worktree,actualHead,candidatePath);fingerprint=await treeFingerprint(candidatePath);await makeReadOnly(candidatePath)}
  const files=[path.join(task.path,'ACCEPTANCE_CONTRACT_V2.md'),runPath];if(role!=='M')files.push(path.join(acceptanceOutput(root,taskId),'EXECUTION_PLAN.json'));if(role==='R')files.push(path.join(acceptanceOutput(root,taskId),'V'));
  const context=[] as Array<{file:string;sha256:string}>;for(const file of files){const info=await lstat(file).catch(()=>null);if(!info)throw new Error(`${role} context is missing: ${path.relative(root,file)}`);if(info.isDirectory()){for(const name of (await readdir(file)).filter(item=>item.endsWith('.json')&&!item.startsWith('controlled-input-')).sort())context.push(await contextRecord(root,path.join(file,name)))}else context.push(await contextRecord(root,file))}
  const prompt=rolePrompt({taskId,role,head:actualHead,contextRoot:root,context,evidenceRoot}),now=new Date().toISOString(),cfg=await readProviderConfig(root),provider=cfg.active_provider,doctor=(await (await import('./project.js')).providerDoctor(root)).find(item=>item.active);if(!doctor?.resolved||!doctor.available||!doctor.compatible)throw new Error(`active Provider is not runnable: ${doctor?.reason??'missing diagnostic'}`);const providerConfig=cfg.providers[provider],probeHash=provider==='codex'?await ensureCodexRuntimeProbe(root,role,doctor.resolved,doctor.version,providerConfig.args):null;
  const invocation=invocationSchema.parse({schema_version:2,invocation_id:id,task_id:taskId,run_id:run.run_id,role,status:'prepared',provider,provider_identity:{executable:providerConfig.executable,resolved:doctor.resolved,args_sha256:sha256(JSON.stringify(providerConfig.args)),version:doctor.version},candidate:{path:candidatePath,access,head:actualHead,fingerprint},evidence_root:evidenceRoot,context,forbidden_actions:['merge','push','deploy','credential_write','production_data','external_side_effect'],prompt_hash:sha256(prompt),pid:null,exit_code:null,timed_out:false,output_sha256:null,output_truncated:false,usage:emptyUsage,failure_fingerprint:null,created_at:now,started_at:null,finished_at:null,last_error:null,heartbeat_at:null,runtime_probe_hash:probeHash,token_limit:Math.max(1,budget.max_tokens-knownTokens),cost_limit_usd:null,result_status:'none',result_error:null});
  await atomicWriteMany(root,[{file:path.join(base,'PROMPT.txt'),content:prompt},{file:invocationFile(root,taskId,id),content:`${JSON.stringify(invocation,null,2)}\n`}]);return invocation;
}

export function buildProviderArgs(provider:string,args:string[],role:AcceptanceRole,candidate:string,prompt:string,evidenceRoot?:string):string[]{
  if(provider!=='codex')throw new Error(`${provider} does not declare an enforceable role sandbox adapter`);
  const updated=[...args],index=updated.indexOf('--sandbox');if(index>=0&&updated[index+1])updated[index+1]='workspace-write';else updated.push('--sandbox','workspace-write');
  if(evidenceRoot)updated.push('--add-dir',evidenceRoot);
  if(role!=='M'){
    if(!evidenceRoot)throw new Error(`${role} Provider requires a dedicated writable Evidence root`);
    if(!updated.includes('--skip-git-repo-check'))updated.push('--skip-git-repo-check');
  }
  return ['-C',candidate,...updated,prompt];
}

async function runRoleInvocationInternal(root:string,taskId:string,id:string,limits:{maxTokens?:number;maxCostUsd?:number}={}):Promise<RoleInvocation>{
  let invocation=await readRoleInvocation(root,taskId,id);if(invocation.status!=='prepared'&&invocation.status!=='interrupted')throw new Error(`role invocation is not runnable from ${invocation.status}`);
  const cfg=await readProviderConfig(root),provider=cfg.providers[cfg.active_provider];if(invocation.provider!==cfg.active_provider)throw new Error('active provider changed after role preparation');
  const doctor=(await (await import('./project.js')).providerDoctor(root)).find(item=>item.active);if(!doctor?.resolved||!doctor.available||!doctor.compatible)throw new Error(`active Provider preflight failed: ${doctor?.reason??'missing diagnostic'}`);const identity={executable:provider.executable,resolved:doctor.resolved,args_sha256:sha256(JSON.stringify(provider.args)),version:doctor.version};if(invocation.provider_identity&&JSON.stringify(invocation.provider_identity)!==JSON.stringify(identity))throw new Error('Provider executable, version, or arguments changed after role preparation; prepare a new invocation');
  const prompt=await readFile(path.join(invocationRoot(root,taskId,id),'PROMPT.txt'),'utf8');if(sha256(prompt)!==invocation.prompt_hash)throw new Error('role prompt integrity failure');
  const args=buildProviderArgs(cfg.active_provider,provider.args,invocation.role,invocation.candidate.path,prompt,invocation.evidence_root),startedAt=new Date().toISOString(),deadlineAt=new Date(Date.now()+provider.timeout_seconds*1000).toISOString();
  for(const directory of [path.join(control(root),'shared-cache','tmp'),path.join(control(root),'shared-cache','npm'),path.join(control(root),'shared-cache','maven')])await mkdir(directory,{recursive:true});
  const child=spawn(provider.executable,args,{cwd:invocation.candidate.path,detached:process.platform!=='win32',env:providerEnvironment(root,{SPEC_LOOP_ROLE:invocation.role,SPEC_LOOP_INVOCATION_ID:id,SPEC_LOOP_EVIDENCE_ROOT:invocation.evidence_root}),stdio:['ignore','pipe','pipe']});
  const tokenLimit=Math.min(invocation.token_limit??Number.MAX_SAFE_INTEGER,limits.maxTokens??Number.MAX_SAFE_INTEGER),costLimit=Math.min(invocation.cost_limit_usd??Number.MAX_VALUE,limits.maxCostUsd??Number.MAX_VALUE);
  let stdout='',stderr='',stdoutBytes=0,stderrBytes=0,outputTruncated=false,timedOut=false,settled=false,usageScan='',liveUsage=usageSchema.parse(emptyUsage),fuseReason:string|null=null;
  const trip=(reason:string)=>{if(fuseReason||settled)return;fuseReason=reason;signalProcessTree(child.pid,'SIGTERM');setTimeout(()=>{if(!settled)signalProcessTree(child.pid,'SIGKILL')},1000).unref()};
  const inspectUsage=(text:string)=>{usageScan=(usageScan+text).slice(-262_144);const observed=providerUsage(usageScan);if(observed.recorded)liveUsage=observed;if(observed.total_tokens!==null&&observed.total_tokens>=tokenLimit)trip(`live token budget reached (${observed.total_tokens}/${tokenLimit})`);if(observed.cost_usd!==null&&observed.cost_usd>=costLimit)trip(`live cost budget reached (${observed.cost_usd}/${costLimit})`)};
  const collect=(target:'stdout'|'stderr',chunk:Buffer)=>{const used=target==='stdout'?stdoutBytes:stderrBytes,remaining=Math.max(0,MAX_PROVIDER_OUTPUT_BYTES-used);if(remaining<chunk.length)outputTruncated=true;const text=chunk.subarray(0,remaining).toString();if(target==='stdout'){stdout+=text;stdoutBytes+=Math.min(remaining,chunk.length);inspectUsage(chunk.toString())}else{stderr+=text;stderrBytes+=Math.min(remaining,chunk.length)}};
  let timer:NodeJS.Timeout;
  const completion=new Promise<{code:number;stdout:string;stderr:string;timedOut:boolean}>((resolve,reject)=>{
    timer=setTimeout(()=>{timedOut=true;trip(`Provider timeout reached (${provider.timeout_seconds}s)`)},provider.timeout_seconds*1000);
    child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
    child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code:127,stdout,stderr:`${stderr}\n${error.message}`.trim(),timedOut:false})});
    child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code:timedOut?124:fuseReason?125:(code??1),stdout,stderr,timedOut})});
  });
  invocation=invocationSchema.parse({...invocation,status:'running',pid:child.pid,started_at:startedAt,heartbeat_at:startedAt,last_error:null,token_limit:Number.isFinite(tokenLimit)?tokenLimit:null,cost_limit_usd:Number.isFinite(costLimit)?costLimit:null});
  const heartbeatValue=(active:boolean,at=new Date().toISOString())=>`${JSON.stringify({schema_version:1,invocation_id:id,task_id:taskId,role:invocation.role,pid:child.pid,active,phase:active?'provider_running':'provider_stopped',heartbeat_at:at,deadline_at:deadlineAt,remaining_ms:active?Math.max(0,Date.parse(deadlineAt)-Date.now()):0,usage:liveUsage,token_limit:invocation.token_limit,cost_limit_usd:invocation.cost_limit_usd},null,2)}\n`;
  await atomicWriteMany(root,[
    {file:heartbeatFile(root,taskId,id),content:heartbeatValue(true,startedAt)},
    {file:invocationFile(root,taskId,id),content:`${JSON.stringify(invocation,null,2)}\n`},
  ]);
  let heartbeatTimer:NodeJS.Timeout|undefined,heartbeatWork:Promise<void>=Promise.resolve();const heartbeat=async(active:boolean)=>atomicWriteMany(root,[{file:heartbeatFile(root,taskId,id),content:heartbeatValue(active)}]);const scheduleHeartbeat=()=>{heartbeatTimer=setTimeout(()=>{heartbeatWork=heartbeat(true).catch(()=>undefined).finally(()=>{if(!settled)scheduleHeartbeat()})},2_000)};scheduleHeartbeat();
  const result=await completion;if(heartbeatTimer)clearTimeout(heartbeatTimer);await heartbeatWork;await heartbeat(false).catch(()=>undefined);
  let boundaryError:string|null=null;
  if(invocation.role==='M'&&result.code===0&&!result.timedOut){
    const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']),status=await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all']);
    const mergeCommits=head===invocation.candidate.head?'':await git(workspace.worktree,['rev-list','--merges',`${invocation.candidate.head}..${head}`]);
    const task=(await scanTasks(root)).find(item=>item.task_id===taskId),spec=task?await readMarkdown(path.join(task.path,'SPEC.md')):null,targetSpec=spec?z.object({target_spec:z.string().optional()}).passthrough().parse(spec.data).target_spec?.split(path.sep).join('/')??null:null,changed=head===invocation.candidate.head?[]:(await git(workspace.worktree,['diff','--name-only',`${invocation.candidate.head}..${head}`])).split('\n').filter(Boolean);
    if(status)boundaryError='M invocation left an uncommitted candidate';else if(head===invocation.candidate.head)boundaryError='M invocation did not produce a new HEAD';else if(mergeCommits)boundaryError='M invocation produced a forbidden merge commit';else if(targetSpec&&changed.includes(targetSpec))boundaryError=`M invocation modified the approved formal Task specification: ${targetSpec}`;else invocation=invocationSchema.parse({...invocation,candidate:{...invocation.candidate,head,fingerprint:sha256(await git(workspace.worktree,['ls-tree','-r','--full-tree',head]))}});
  }else if(invocation.role!=='M'){
    const workspace=await readWorkspace(root,taskId),head=await git(workspace.worktree,['rev-parse','HEAD']),status=await git(workspace.worktree,['status','--porcelain=v1','--untracked-files=all']);
    if(head!==invocation.candidate.head||status)boundaryError='verification role observed a changed source candidate';
    else if(await treeFingerprint(invocation.candidate.path)!==invocation.candidate.fingerprint)boundaryError='verification role modified its read-only candidate snapshot';
  }
  const finalUsage=providerUsage(result.stdout),usage=finalUsage.recorded?finalUsage:liveUsage,failureMessage=fuseReason??result.stderr,failureFingerprint=result.code===0&&!result.timedOut?null:providerFailureFingerprint(invocation.role,result.code,result.timedOut,failureMessage),output=`OUTPUT_TRUNCATED ${outputTruncated}\nUSAGE_RECORDED ${usage.recorded}\nFUSE ${fuseReason??'none'}\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`,outputFile=path.join(invocationRoot(root,taskId,id),'PROVIDER.txt');await atomicWriteMany(root,[{file:outputFile,content:output}]);
  const controllerState=await readRoleInvocation(root,taskId,id);
  if(controllerState.status==='cancelled'){invocation=invocationSchema.parse({...controllerState,candidate:invocation.candidate,pid:null,exit_code:result.code,timed_out:result.timedOut,output_sha256:sha256(output),output_truncated:outputTruncated,usage,failure_fingerprint:failureFingerprint,finished_at:controllerState.finished_at??new Date().toISOString()});await writeInvocation(root,invocation);return invocation}
  const status=result.timedOut?'timed_out':result.code!==0||boundaryError?'failed':'succeeded';invocation=invocationSchema.parse({...invocation,status,pid:null,exit_code:result.code,timed_out:result.timedOut,output_sha256:sha256(output),output_truncated:outputTruncated,usage,failure_fingerprint:boundaryError?providerFailureFingerprint(invocation.role,result.code,result.timedOut,boundaryError):failureFingerprint,finished_at:new Date().toISOString(),last_error:boundaryError??fuseReason??(result.code===0?null:`provider exit ${result.code}`),result_status:status==='succeeded'?'awaiting_ingestion':'none',result_error:null});await writeInvocation(root,invocation);return invocation;
}

export async function runRoleInvocation(root:string,taskId:string,id:string,limits:{maxTokens?:number;maxCostUsd?:number}={}):Promise<RoleInvocation>{
  const invocation=await readRoleInvocation(root,taskId,id),task=(await scanTasks(root)).find(item=>item.task_id===taskId);if(!task)throw new Error(`task not found: ${taskId}`);const state=await readState(task.path);
  const stepType=invocation.role==='M'?'role.m':invocation.role==='V'?'role.v':'role.r',ref=path.relative(root,invocationFile(root,taskId,id)).split(path.sep).join('/');
  const started=await startExecutionStep(root,{taskId,round:state.current_round,runId:invocation.run_id,stepType,label:`${invocation.role} invocation`,summary:`${invocation.role} 在隔离权限边界中运行 ${id}`,refs:[ref]});
  try{
    const result=await runRoleInvocationInternal(root,taskId,id,limits),outcome=result.status==='succeeded'?'success':result.status==='cancelled'?'cancelled':result.status==='failed'||result.status==='timed_out'?'failure':'interrupted';
    await finishExecutionStep(root,started,{outcome,summary:`${invocation.role} invocation ${result.status}`,refs:[ref]});return result;
  }catch(error){await finishExecutionStep(root,started,{outcome:'failure',summary:`${invocation.role} invocation 启动或完整性检查失败`,refs:[ref]});throw error}
}

export async function cancelRoleInvocation(root:string,taskId:string,id:string):Promise<RoleInvocation>{
  let invocation=await readRoleInvocation(root,taskId,id);if(invocation.status==='cancelled')return invocation;if(['succeeded','failed','timed_out'].includes(invocation.status))return invocation;
  const pid=invocation.pid;
  await terminateProcessTree(pid);
  invocation=invocationSchema.parse({...invocation,status:'cancelled',pid:null,finished_at:new Date().toISOString(),last_error:'cancelled by controller'});await writeInvocation(root,invocation);await atomicWriteMany(root,[{file:heartbeatFile(root,taskId,id),content:`${JSON.stringify({schema_version:1,invocation_id:id,task_id:taskId,pid,active:false,heartbeat_at:new Date().toISOString()},null,2)}\n`}]).catch(()=>undefined);return invocation;
}

export async function reconcileRoleInvocation(root:string,taskId:string,id:string):Promise<RoleInvocation>{
  let invocation=await readRoleInvocation(root,taskId,id);if(invocation.status!=='running'||!invocation.pid)return invocation;
  let alive=true;try{process.kill(invocation.pid,0)}catch{alive=false}if(alive)return invocation;
  invocation=invocationSchema.parse({...invocation,status:'interrupted',pid:null,finished_at:new Date().toISOString(),last_error:'provider process disappeared; result remains unknown'});await writeInvocation(root,invocation);
  await reconcileInterruptedExecutionSteps(root,{taskId,stepTypes:[invocation.role==='M'?'role.m':invocation.role==='V'?'role.v':'role.r'],summary:'角色 Provider 进程已消失；结果保持 unknown'});return invocation;
}

export async function assertSucceededRoleInvocation(root:string,taskId:string,id:string,role:AcceptanceRole):Promise<RoleInvocation>{const invocation=await readRoleInvocation(root,taskId,id);if(invocation.role!==role||invocation.status!=='succeeded')throw new Error(`${role} result requires a succeeded managed invocation`);return invocation}

async function regularEvidenceFiles(directory:string):Promise<string[]>{const result:string[]=[];for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const file=path.join(directory,entry.name);if(entry.isFile()&&!entry.isSymbolicLink()&&entry.name!=='RESULT.json')result.push(file)}return result.sort()}
export async function ingestSucceededRoleResult(root:string,taskId:string,id:string):Promise<RoleInvocation>{
  let invocation=await assertSucceededRoleInvocation(root,taskId,id,(await readRoleInvocation(root,taskId,id)).role);
  if(invocation.result_status==='ingested')return invocation;
  try{
    if(invocation.role==='M'){
      const evidence=await regularEvidenceFiles(invocation.evidence_root);if(!evidence.length)throw new Error('M succeeded but produced no self-test Evidence');
      await (await import('./acceptance-loop.js')).submitMakerCandidate(root,taskId,evidence,id);await (await import('./acceptance-loop.js')).compileAcceptancePlan(root,taskId);
    }else{
      const resultFile=path.join(invocation.evidence_root,'RESULT.json');if(!(await exists(resultFile))){invocation=invocationSchema.parse({...invocation,result_status:'awaiting_ingestion',result_error:'Provider succeeded without Evidence/RESULT.json'});await writeInvocation(root,invocation);return invocation}
      if(invocation.role==='V')await (await import('./acceptance-loop.js')).recordVResult(root,taskId,resultFile);else await (await import('./acceptance-loop.js')).recordRResult(root,taskId,resultFile);
    }
    invocation=invocationSchema.parse({...await readRoleInvocation(root,taskId,id),result_status:'ingested',result_error:null});await writeInvocation(root,invocation);return invocation;
  }catch(error){invocation=invocationSchema.parse({...await readRoleInvocation(root,taskId,id),result_status:'invalid',result_error:(error as Error).message.slice(0,1000)});await writeInvocation(root,invocation);return invocation}
}
