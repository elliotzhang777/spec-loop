import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import YAML from 'yaml';
import { atomicWriteMany, exists, readMarkdown, sha256, stringifyMarkdown } from './files.js';
import { readProject, readProviderConfig, scanTasks, verifyTaskExecutionApproval } from './project.js';
import { evidenceRecords, readState } from './task.js';
import { acceptanceSchema, planSchema } from './schemas.js';
import type { WebGateRequirement } from './model.js';
import { validImage } from './review.js';

const exec = promisify(execFile);
const control = (root:string) => path.join(root, '.spec-loop');
const gateIdSchema=z.string().regex(/^[a-z][a-z0-9-]*$/);
const safeRelativePathSchema=z.string().min(1).refine(value=>!path.isAbsolute(value)&&!value.split(/[\\/]/).includes('..')&&!value.startsWith('-'),{message:'must be a safe relative path'});
const gateAcSchema=z.array(z.string().regex(/^AC-[1-9]\d*$/)).min(1);
const commandGateSchema=z.object({
  id:gateIdSchema,kind:z.literal('command').optional(),command:z.array(z.string().min(1)).min(1),
  timeout_seconds:z.number().int().positive().max(3600),ac:gateAcSchema.optional(),
}).strict();
const playwrightGateSchema=z.object({
  id:gateIdSchema,kind:z.literal('playwright'),timeout_seconds:z.number().int().positive().max(3600),
  ac:gateAcSchema,
  config:safeRelativePathSchema.optional(),tests:z.array(safeRelativePathSchema).default([]),
  projects:z.array(z.string().min(1).regex(/^[A-Za-z0-9._-]+$/)).default([]),
  grep:z.string().min(1).max(500).optional(),require_screenshots:z.boolean().default(true),
}).strict();
const gateDefinitionSchema=z.union([commandGateSchema,playwrightGateSchema]);
const databasePolicySchema=z.object({
  lifecycle:z.enum(['persistent','disposable']).default('persistent'),
  reset:z.enum(['transaction','fixtures','schema','container']).default('fixtures'),
  reason:z.string().min(10).optional(),
}).strict();
const gateConfigSchema=z.object({
  schema_version:z.literal(1),
  scope_kind:z.enum(['task','wave']).optional(),
  wave_id:z.string().regex(/^W[A-Z0-9-]*$/).optional(),
  coverage:z.enum(['targeted','full']).default('targeted'),
  database:databasePolicySchema.default({lifecycle:'persistent',reset:'fixtures'}),
  gates:z.array(gateDefinitionSchema).min(1),
}).strict().superRefine((value,ctx)=>{
  if(value.wave_id&&!value.scope_kind)ctx.addIssue({code:'custom',message:'wave_id requires scope_kind'});
  if(value.scope_kind&&value.gates.some((gate)=>!gate.ac?.length))
    ctx.addIssue({code:'custom',message:'scoped Gate Plan requires AC coverage on every Gate'});
  if(value.scope_kind==='wave'&&value.coverage!=='full')
    ctx.addIssue({code:'custom',message:'wave scope requires full coverage'});
  if(value.database.lifecycle==='persistent'&&value.database.reset==='container')
    ctx.addIssue({code:'custom',message:'persistent database lifecycle may not use container reset'});
  if(value.database.lifecycle==='disposable'&&!value.database.reason)
    ctx.addIssue({code:'custom',message:'disposable database lifecycle requires an explicit reason'});
});
const manifestSchema = z.object({schema_version:z.literal(1),task_id:z.string(),repository:z.string(),worktree:z.string(),branch:z.string(),base_commit:z.string().regex(/^[a-f0-9]{40,64}$/),head:z.string().regex(/^[a-f0-9]{40,64}$/),created_at:z.iso.datetime()}).strict();
const stageSchema = z.enum(['prepared','executed','collected','verified','reported']);
const harnessStateSchema = z.object({schema_version:z.literal(1),task_id:z.string(),stage:stageSchema,workspace:z.string(),base_commit:z.string(),head:z.string(),sequence:z.number().int().positive(),evidence_hashes:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)),updated_at:z.iso.datetime(),last_error:z.string().nullable()}).strict();
const collectSchema = z.object({schema_version:z.literal(1),task_id:z.string(),workspace:z.string(),base_commit:z.string(),head:z.string(),status:z.array(z.string()),diff_stat:z.string(),worktree_fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),collected_at:z.iso.datetime()}).strict();
const playwrightStatsSchema=z.object({expected:z.number().int().nonnegative(),unexpected:z.number().int().nonnegative(),flaky:z.number().int().nonnegative(),skipped:z.number().int().nonnegative(),duration_ms:z.number().nonnegative()}).strict();
const webAttachmentSchema=z.object({file:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()}).strict();
const webManifestSchema=z.object({
  schema_version:z.literal(1),task_id:z.string(),gate_id:z.string(),base_commit:z.string(),head:z.string(),
  ac:z.array(z.string().regex(/^AC-[1-9]\d*$/)).min(1),
  runner:z.object({
    package:z.enum(['@playwright/test','playwright']),version:z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/),
    cli_sha256:z.string().regex(/^[a-f0-9]{64}$/),lockfile:z.string().min(1),lockfile_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  stats:playwrightStatsSchema.nullable(),screenshots:z.number().int().nonnegative(),files:z.array(webAttachmentSchema),
  html_report:z.string().nullable(),validation_errors:z.array(z.string()),created_at:z.iso.datetime(),
}).strict();
const webEvidenceSchema=z.object({
  manifest:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),stats:playwrightStatsSchema,
  ac:z.array(z.string().regex(/^AC-[1-9]\d*$/)).min(1),screenshots:z.number().int().nonnegative(),files:z.number().int().nonnegative(),
}).strict();
const gateResultSchema = z.object({
  schema_version:z.literal(1),task_id:z.string(),id:z.string(),kind:z.enum(['command','playwright']).default('command'),
  scope_kind:z.enum(['task','wave']).optional(),wave_id:z.string().regex(/^W[A-Z0-9-]*$/).optional(),
  coverage:z.enum(['targeted','full']).default('targeted'),
  database_lifecycle:z.enum(['persistent','disposable']).default('persistent'),
  plan_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  ac:z.array(z.string().regex(/^AC-[1-9]\d*$/)).optional(),
  command:z.array(z.string()),cwd:z.string(),exit_code:z.number().int(),timed_out:z.boolean(),duration_ms:z.number().int().nonnegative(),
  base_commit:z.string(),head:z.string(),artifact:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),
  web_evidence:webEvidenceSchema.nullable().default(null),created_at:z.iso.datetime(),
}).strict();
const gateResultsSchema = z.array(gateResultSchema).min(1);
export type WorkspaceManifest = z.infer<typeof manifestSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
type HarnessState = z.infer<typeof harnessStateSchema>;

function gatePlanHash(config:z.infer<typeof gateConfigSchema>):string { return sha256(JSON.stringify(config)); }

async function git(cwd:string,args:string[]){return (await exec('git',args,{cwd,maxBuffer:10_000_000})).stdout.trim()}
async function worktreeStatus(cwd:string){return git(cwd,['status','--porcelain=v1','--untracked-files=all'])}
async function worktreeFingerprint(cwd:string):Promise<string>{
  const listed=(await exec('git',['ls-files','-co','--exclude-standard','-z'],{cwd,maxBuffer:10_000_000})).stdout;
  const entries=[] as Array<{file:string;kind:'file'|'symlink'|'deleted';sha256:string|null}>;
  for(const file of listed.split('\0').filter(Boolean).sort()){
    const target=path.join(cwd,file),info=await lstat(target).catch(()=>null);
    if(!info){entries.push({file,kind:'deleted',sha256:null});continue}
    if(info.isSymbolicLink())entries.push({file,kind:'symlink',sha256:sha256(await readlink(target))});
    else if(info.isFile())entries.push({file,kind:'file',sha256:sha256(await readFile(target))});
    else throw new Error(`candidate contains unsupported tracked path type: ${file}`);
  }
  return sha256(JSON.stringify(entries));
}
function collectedFingerprint(value:z.infer<typeof collectSchema>):string {
  if(!value.worktree_fingerprint)throw new Error('Collect Evidence predates content fingerprints; rerun Harness execute and collect');
  return value.worktree_fingerprint;
}
function stateFile(root:string,taskId:string){return path.join(control(root),'output',`${taskId}-harness-state.json`)}
async function readHarnessState(root:string,taskId:string):Promise<HarnessState>{return harnessStateSchema.parse(JSON.parse(await readFile(stateFile(root,taskId),'utf8')))}
async function writeHarnessState(root:string,state:HarnessState){await atomicWriteMany(root,[{file:stateFile(root,state.task_id),content:JSON.stringify(state,null,2)+'\n'}])}
async function advance(root:string,taskId:string,from:HarnessState['stage']|null,to:HarnessState['stage'],m:WorkspaceManifest,head:string,error:string|null=null,newHashes:Record<string,string>={}){
  let sequence=1,evidenceHashes:Record<string,string>={};
  if(from){const current=await readHarnessState(root,taskId);if(current.stage!==from)throw new Error(`harness ${to} is illegal from ${current.stage}`);if(current.workspace!==m.worktree||current.base_commit!==m.base_commit)throw new Error('harness state does not match workspace manifest');sequence=current.sequence+1;evidenceHashes=current.evidence_hashes}
  await writeHarnessState(root,{schema_version:1,task_id:taskId,stage:to,workspace:m.worktree,base_commit:m.base_commit,head,sequence,evidence_hashes:{...evidenceHashes,...newHashes},updated_at:new Date().toISOString(),last_error:error});
}

export async function initGateConfig(root:string){const file=path.join(control(root),'GATES.md');if(await exists(file))return;await atomicWriteMany(root,[{file,content:stringifyMarkdown({schema_version:1,scope_kind:'task',coverage:'targeted',database:{lifecycle:'persistent',reset:'fixtures'},gates:[]},'# Gates\n\n普通 Task 使用定向 Gate 和长驻数据库；整轮全量验证使用独立 Heavy Task，并把 `scope_kind` 改为 `wave`、`coverage` 改为 `full`。')}])}
export async function readGateConfig(root:string){await initGateConfig(root);return gateConfigSchema.parse((await readMarkdown(path.join(control(root),'GATES.md'))).data)}
export async function readGates(root:string){return (await readGateConfig(root)).gates}

async function validateGateScope(root:string,taskId:string,config:z.infer<typeof gateConfigSchema>):Promise<void>{
  const task=(await scanTasks(root)).find((item)=>item.task_id===taskId);
  if(!task)throw new Error('task not found');
  const state=await readState(task.path);
  if(state.level!=='heavy'&&config.coverage==='full')
    throw new Error('non-Heavy task may not run full coverage; use targeted gates and reserve full regression for the final Heavy Task');
  if(state.level!=='heavy'&&config.database.lifecycle==='disposable')
    throw new Error('non-Heavy task may not create a disposable database; reuse the project validation database');
  if(!config.scope_kind)return;
  const acceptance=acceptanceSchema.parse((await readMarkdown(path.join(task.path,'ACCEPTANCE.md'))).data);
  const criterionIds=new Set(acceptance.criteria.map((criterion)=>criterion.id));
  for(const gate of config.gates){
    const coverage=gate.ac??[];
    if(new Set(coverage).size!==coverage.length||coverage.some((id)=>!criterionIds.has(id)))
      throw new Error(`${gate.id}: scoped Gate AC coverage is invalid`);
  }
  if(config.scope_kind==='wave'){
    if(state.level!=='heavy')throw new Error('wave scope requires an independent Heavy Task');
    if(!config.wave_id)throw new Error('wave scope requires wave_id');
  }
}

async function webRequirements(root:string,taskId:string):Promise<WebGateRequirement[]> {
  const task=(await scanTasks(root)).find((item)=>item.task_id===taskId);
  if(!task)throw new Error('task not found');
  const acceptance=acceptanceSchema.parse((await readMarkdown(path.join(task.path,'ACCEPTANCE.md'))).data);
  const plan=planSchema.parse((await readMarkdown(path.join(task.path,'PLAN.md'))).data);
  const state=await readState(task.path);
  const hash=sha256(JSON.stringify(acceptance));
  if(state.acceptance_hash&&state.acceptance_hash!==hash)throw new Error('ACCEPTANCE.md changed after plan');
  if(plan.acceptance_hash&&plan.acceptance_hash!==hash)throw new Error('ACCEPTANCE.md changed after plan');
  if(acceptance.web_gates.length&&(!plan.acceptance_hash||!state.acceptance_hash))throw new Error('required Web Gate is not bound to CLI-managed Task State');
  return acceptance.web_gates;
}

function sameStrings(left:string[],right:string[]):boolean {
  return left.length===right.length&&[...left].sort().every((value,index)=>value===[...right].sort()[index]);
}

async function validatePlaywrightDeclarations(root:string,taskId:string,gates:z.infer<typeof gateDefinitionSchema>[]):Promise<WebGateRequirement[]> {
  const required=await webRequirements(root,taskId);
  const task=(await scanTasks(root)).find((item)=>item.task_id===taskId);
  if(!task)throw new Error('task not found');
  const acceptance=acceptanceSchema.parse((await readMarkdown(path.join(task.path,'ACCEPTANCE.md'))).data);
  const visualAc=new Set(acceptance.human_reviews.flatMap((review)=>review.ac));
  const configured=gates.filter((gate):gate is z.infer<typeof playwrightGateSchema>=>gate.kind==='playwright');
  for(const requirement of required){
    const gate=configured.find((entry)=>entry.id===requirement.id);
    if(!gate)throw new Error(`${requirement.id}: required Playwright Gate is missing from GATES.md`);
    if(!sameStrings(gate.ac,requirement.ac))throw new Error(`${requirement.id}: Playwright Gate AC coverage differs from ACCEPTANCE.md`);
    if(gate.ac.some((ac)=>visualAc.has(ac))&&!gate.require_screenshots)throw new Error(`${requirement.id}: a Playwright Gate covering a visual Review AC must require screenshots`);
  }
  for(const gate of configured)if(!required.some((item)=>item.id===gate.id))throw new Error(`${gate.id}: Playwright Gate is not declared as required in ACCEPTANCE.md`);
  return required;
}

async function validateWorkspace(root:string,taskId:string,m:WorkspaceManifest){
  const project=await readProject(root),projectRepo=await realpath(project.repository);if(m.task_id!==taskId||m.repository!==projectRepo)throw new Error('workspace manifest identity mismatch');
  const expected=path.resolve(control(root),'worktrees',taskId.toLowerCase());if(path.resolve(m.worktree)!==expected)throw new Error('workspace path escapes managed worktree root');
  const actual=await realpath(m.worktree),managedParent=await realpath(path.dirname(expected)),expectedReal=path.join(managedParent,path.basename(expected));if(actual!==expectedReal)throw new Error('workspace path is a symlink or alias');
  if((await lstat(m.worktree)).isSymbolicLink())throw new Error('workspace may not be a symbolic link');
  if(await git(m.worktree,['rev-parse','--show-toplevel'])!==actual)throw new Error('workspace is not the Git worktree root');
  const branch=await git(m.worktree,['branch','--show-current']);if(branch!==m.branch)throw new Error('workspace branch differs from manifest');
}

export async function createWorkspace(root:string,taskId:string):Promise<WorkspaceManifest>{
  const project=await readProject(root);const task=(await scanTasks(root)).find(t=>t.task_id===taskId);if(!task)throw new Error('task not found');
  const state=await readState(task.path);if(!['planned','working','iterating'].includes(state.status))throw new Error(`workspace is illegal for task state ${state.status}`);
  await verifyTaskExecutionApproval(root,taskId);
  const repo=await realpath(project.repository);if(await git(repo,['rev-parse','--show-toplevel'])!==repo)throw new Error('repository must be the Git worktree root');
  if(await git(repo,['status','--porcelain']))throw new Error('repository must be clean before workspace creation');
  const base=await git(repo,['rev-parse','HEAD']);const branch=`spec-loop/${taskId.toLowerCase()}`;const wt=path.resolve(control(root),'worktrees',taskId.toLowerCase());
  await mkdir(path.dirname(wt),{recursive:true});if(await exists(wt))throw new Error('worktree already exists');
  try{await git(repo,['show-ref','--verify','--quiet',`refs/heads/${branch}`]);throw new Error('workspace branch already exists')}catch(error){if((error as Error).message==='workspace branch already exists')throw error}
  await git(repo,['worktree','add','-b',branch,wt,base]);
  const m=manifestSchema.parse({schema_version:1,task_id:taskId,repository:repo,worktree:wt,branch,base_commit:base,head:base,created_at:new Date().toISOString()});
  await atomicWriteMany(root,[{file:path.join(control(root),'output',`${taskId}-workspace.json`),content:JSON.stringify(m,null,2)+'\n'}]);return m;
}
export async function readWorkspace(root:string,taskId:string){const m=manifestSchema.parse(JSON.parse(await readFile(path.join(control(root),'output',`${taskId}-workspace.json`),'utf8')));await validateWorkspace(root,taskId,m);return m}

const SHELLS=new Set(['sh','bash','zsh','fish','dash','ash','ksh','ksh93','mksh','csh','tcsh','cmd','cmd.exe','powershell','pwsh','nu','nushell','xonsh','elvish','osh','oil','rc','busybox','toybox','env']);
const COMMAND_DISPATCHERS=new Set(['npx','bunx','xargs','parallel','find','expect','script','timeout','watch','nohup','nice','stdbuf']);
const INLINE_INTERPRETER_FLAGS:Record<string,Set<string>>={
  node:new Set(['-e','--eval','-p','--print','-r','--require','--import','--loader','--experimental-loader']),
  'node.exe':new Set(['-e','--eval','-p','--print','-r','--require','--import','--loader','--experimental-loader']),
  bun:new Set(['-e','--eval','-p','--print','-r','--preload']),deno:new Set(['eval']),
  python:new Set(['-c','-m']),python2:new Set(['-c','-m']),python3:new Set(['-c','-m']),'python3.exe':new Set(['-c','-m']),
  ruby:new Set(['-e','--eval','-r','--require']),perl:new Set(['-e','-m']),
  php:new Set(['-r','--run','-b','--process-begin','-r','--process-code','-f','--process-file','-e','--process-end','-d','--define','-c','--php-ini']),osascript:new Set(['-e']),
};
function interpreterFamily(bin:string):string{
  if(/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(bin))return bin.endsWith('.exe')?'python3.exe':'python3';
  return bin;
}
function assertGateCommand(command:string[]){
  const bin=path.basename(command[0]).toLowerCase();if(SHELLS.has(bin))throw new Error(`shell or command dispatcher is forbidden in gate: ${command[0]}`);
  if(COMMAND_DISPATCHERS.has(bin))throw new Error(`shell or command dispatcher is forbidden in gate: ${command[0]}`);
  const inlineFlags=INLINE_INTERPRETER_FLAGS[interpreterFamily(bin)];
  if(inlineFlags&&command.slice(1).some((arg)=>[...inlineFlags].some((flag)=>{
    const value=arg.toLowerCase();return value===flag||(flag.startsWith('--')?value.startsWith(`${flag}=`):flag.length===2&&value.startsWith(flag));
  })))
    throw new Error(`inline interpreter or preload dispatch is forbidden in gate: ${command[0]}`);
  if(['npm','pnpm','yarn','bun'].includes(bin)&&command.slice(1).some((arg)=>['exec','dlx','x'].includes(arg.toLowerCase())))throw new Error(`shell or command dispatcher is forbidden in gate: ${command.join(' ')}`);
  if(bin==='sudo'||bin==='su')throw new Error(`privilege escalation is forbidden in gate: ${command[0]}`);
  if(bin==='git'&&['push','merge','rebase','reset','clean','checkout','switch','branch','tag','commit'].includes((command[1]??'').toLowerCase()))throw new Error(`mutating git command is forbidden in gate: ${command.join(' ')}`);
  const joined=command.join(' ').toLowerCase();if(/\b(deploy|publish|release)\b/.test(joined))throw new Error(`release command is forbidden in gate: ${command.join(' ')}`);
}
function assertDatabaseLifecycle(command:string[],config:z.infer<typeof gateConfigSchema>){
  if(config.database.lifecycle!=='persistent')return;
  const bin=path.basename(command[0]).toLowerCase(),args=command.slice(1).map((item)=>item.toLowerCase());
  const mutatesContainer=
    ((bin==='docker'||bin==='podman')&&['run','rm','create'].includes(args[0]??''))||
    ((bin==='docker'||bin==='podman')&&args[0]==='compose'&&['up','down','rm'].includes(args[1]??''))||
    (bin==='docker-compose'&&['up','down','rm'].includes(args[0]??''));
  if(mutatesContainer)throw new Error('persistent database Gate may not create or remove containers; start the long-lived validation database outside the Gate');
}
function gateEnvironment(config:z.infer<typeof gateConfigSchema>):Record<string,string>{
  return {
    SPEC_LOOP_VERIFICATION_COVERAGE:config.coverage,
    SPEC_LOOP_DATABASE_LIFECYCLE:config.database.lifecycle,
    SPEC_LOOP_DATABASE_RESET:config.database.reset,
  };
}
function runProcess(bin:string,args:string[],cwd:string,timeout:number,input?:string,extraEnv:Record<string,string>={}):Promise<{code:number;stdout:string;stderr:string;timedOut:boolean}>{return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,detached:process.platform!=='win32',env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp',...extraEnv},stdio:[input===undefined?'ignore':'pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false,settled=false;
  const kill=(signal:NodeJS.Signals)=>{try{if(process.platform==='win32')child.kill(signal);else process.kill(-(child.pid as number),signal)}catch{child.kill(signal)}};
  const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');setTimeout(()=>{if(!settled)kill('SIGKILL')},1000).unref()},timeout);
  child.stdout!.on('data',d=>stdout+=d);child.stderr!.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>{settled=true;clearTimeout(timer);resolve({code:timedOut?124:(code??1),stdout,stderr,timedOut})});if(input!==undefined)child.stdin!.end(input);
})}

export async function prepareHarness(root:string,taskId:string,prompt:string){
  const m=await readWorkspace(root,taskId);const task=(await scanTasks(root)).find(t=>t.task_id===taskId);if(!task)throw new Error('task not found');const state=await readState(task.path);if(state.status!=='working')throw new Error(`harness prepare requires working task, got ${state.status}`);
  await verifyTaskExecutionApproval(root,taskId);const head=await git(m.worktree,['rev-parse','HEAD']);
  const decisions=await import('./confirmation-decisions.js');
  const remoteCandidates=(await decisions.listConfirmationDecisions(root)).filter((item)=>item.status==='active'&&item.task_id===taskId&&item.request_type==='verification'&&item.round===state.current_round);
  let remote=remoteCandidates.at(-1)??null;
  if(remote){
    const canonical=await (await import('./review.js')).canonicalGitRevision(m.worktree,remote.revision);
    const acceptance=(await readMarkdown(path.join(task.path,'ACCEPTANCE.md'))).data;
    const gatePlan=(await readMarkdown(path.join(control(root),'GATES.md'))).data;
    const screenshots=(await (await import('./review.js')).readVisualReviews(task.path)).flatMap((review)=>review.artifacts.map((item)=>item.sha256)).sort();
    if(!decisions.confirmationDecisionHasValidContent(remote)||remote.project_id!==(await readProject(root)).project_id||remote.risk!==state.level
      ||remote.facts.acceptance_hash!==sha256(JSON.stringify(acceptance))||remote.facts.gate_plan_hash!==sha256(JSON.stringify(gatePlan))
      ||JSON.stringify([...remote.facts.screenshot_hashes].sort())!==JSON.stringify(screenshots))throw new Error('structured verification decision authority is not current');
    if(canonical!==head)remote=null;
  }
  if(remote?.action==='defer_verification')throw new Error('current candidate verification was deferred by a structured user decision');
  if(remote?.action==='authorize_verification')await decisions.consumeConfirmationDecision(root,{commandId:remote.command_id,contentHash:remote.content_hash,consumer:'harness-prepare'});
  const payload={schema_version:1,task_id:taskId,round:state.current_round,state:state.status,base_commit:m.base_commit,worktree:m.worktree,head,prompt_hash:sha256(prompt),prepared_at:new Date().toISOString()};
  const serialized=JSON.stringify(payload,null,2)+'\n',file=path.join(control(root),'output',`${taskId}-prepare.json`);await atomicWriteMany(root,[{file,content:serialized}]);await advance(root,taskId,null,'prepared',m,head,null,{prepare:sha256(serialized)});return file;
}
export async function executeHarness(root:string,taskId:string,prompt:string){
  const m=await readWorkspace(root,taskId);const state=await readHarnessState(root,taskId);if(state.stage!=='prepared')throw new Error(`harness execute is illegal from ${state.stage}`);await verifyTaskExecutionApproval(root,taskId);
  const cfg=await readProviderConfig(root),p=cfg.providers[cfg.active_provider];let args=[...p.args];if(cfg.active_provider==='codex')args=['-C',m.worktree,...args,prompt];else args=[...args,prompt];
  const startedAt=new Date().toISOString(),result=await runProcess(p.executable,args,m.worktree,p.timeout_seconds*1000);const head=await git(m.worktree,['rev-parse','HEAD']);const content=`PROVIDER ${cfg.active_provider}\nSTARTED ${startedAt}\nTIMED_OUT ${result.timedOut}\nEXIT ${result.code}\nHEAD ${head}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`;
  const rel=`.spec-loop/output/${taskId}-provider.txt`,hash=sha256(content);await atomicWriteMany(root,[{file:path.join(root,rel),content}]);await advance(root,taskId,'prepared','executed',m,head,result.code===0?null:`provider exit ${result.code}`,{provider:hash});return{code:result.code,timed_out:result.timedOut,head,artifact:rel,sha256:hash};
}
export async function collectHarness(root:string,taskId:string){
  const m=await readWorkspace(root,taskId);const current=await readHarnessState(root,taskId);if(current.stage!=='executed')throw new Error(`harness collect is illegal from ${current.stage}`);
  const head=await git(m.worktree,['rev-parse','HEAD']),status=await git(m.worktree,['status','--short']),diff=await git(m.worktree,['diff','--stat',m.base_commit]),fingerprint=await worktreeFingerprint(m.worktree);const value=collectSchema.parse({schema_version:1,task_id:taskId,workspace:m.worktree,base_commit:m.base_commit,head,status:status.split('\n').filter(Boolean),diff_stat:diff,worktree_fingerprint:fingerprint,collected_at:new Date().toISOString()});
  const serialized=JSON.stringify(value,null,2)+'\n';await atomicWriteMany(root,[{file:path.join(control(root),'output',`${taskId}-collect.json`),content:serialized}]);await advance(root,taskId,'executed','collected',m,head,null,{collect:sha256(serialized)});return value;
}

function playwrightPackageRoots(worktree:string,gate:z.infer<typeof playwrightGateSchema>):string[]{
  const roots=new Set<string>([path.resolve(worktree)]);
  const inputs=[...(gate.config?[gate.config]:[]),...gate.tests];
  for(const input of inputs){
    let current=path.dirname(path.resolve(worktree,input));
    while(current.startsWith(path.resolve(worktree)+path.sep)){
      roots.add(current);
      const parent=path.dirname(current);if(parent===current)break;current=parent;
    }
  }
  return [...roots];
}

async function lockedPlaywrightDependency(worktree:string,packageRoot:string,name:'@playwright/test'|'playwright',version:string):Promise<{file:string;sha256:string}> {
  const worktreeReal=await realpath(worktree);let current=await realpath(packageRoot);
  while(current===worktreeReal||current.startsWith(worktreeReal+path.sep)){
    for(const filename of ['package-lock.json','pnpm-lock.yaml','yarn.lock']){
      const file=path.join(current,filename),info=await lstat(file).catch(()=>null);
      if(!info)continue;
      if(!info.isFile()||info.isSymbolicLink())throw new Error(`Playwright lockfile is invalid: ${file}`);
      const actual=await realpath(file);
      if(actual!==worktreeReal&&!actual.startsWith(worktreeReal+path.sep))throw new Error('Playwright lockfile resolves outside the managed worktree');
      const relative=path.relative(worktreeReal,actual).split(path.sep).join('/');
      try{await git(worktreeReal,['ls-files','--error-unmatch',relative])}catch{throw new Error(`Playwright lockfile must be tracked by Git: ${relative}`)}
      const content=await readFile(actual),text=content.toString('utf8');let locked=false;
      if(filename==='package-lock.json'){
        let value:unknown;try{value=JSON.parse(text)}catch{throw new Error('Playwright package-lock.json is malformed')}
        const lock=value as {packages?:Record<string,{version?:string}>;dependencies?:Record<string,{version?:string}>};
        locked=lock.packages?.[`node_modules/${name}`]?.version===version||lock.dependencies?.[name]?.version===version;
      }else if(filename==='pnpm-lock.yaml'){
        let value:unknown;try{value=YAML.parse(text)}catch{throw new Error('Playwright pnpm-lock.yaml is malformed')}
        const lock=value as {packages?:Record<string,unknown>;snapshots?:Record<string,unknown>;importers?:Record<string,unknown>};
        const keyMatches=(key:string):boolean=>{
          const normalized=key.startsWith('/')?key.slice(1):key;
          return normalized.startsWith(`${name}@`)&&normalized.slice(name.length+1).split('(')[0]===version;
        };
        locked=[...Object.keys(lock.packages??{}),...Object.keys(lock.snapshots??{})].some(keyMatches);
        if(!locked)for(const importer of Object.values(lock.importers??{})){
          if(!importer||typeof importer!=='object')continue;
          for(const section of ['dependencies','devDependencies','optionalDependencies']){
            const entry=(importer as Record<string,unknown>)[section];
            if(!entry||typeof entry!=='object')continue;
            const dependency=(entry as Record<string,unknown>)[name];
            const pinned=typeof dependency==='string'?dependency:(dependency&&typeof dependency==='object'?(dependency as {version?:unknown}).version:null);
            if(typeof pinned==='string'&&pinned.split('(')[0]===version){locked=true;break}
          }
          if(locked)break;
        }
      }else{
        const escapedName=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),escapedVersion=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const block=new RegExp(`^(?:["']?${escapedName}@[^\\n]+["']?):\\r?\\n((?:[ \\t].*(?:\\r?\\n|$))*)`,'gm');let match:RegExpExecArray|null;
        while((match=block.exec(text))!==null)if(new RegExp(`^[ \\t]+version:?[ \\t]+["']?${escapedVersion}["']?[ \\t]*$`,'m').test(match[1])){locked=true;break}
      }
      if(!locked)throw new Error(`${name} ${version} is not pinned by ${relative}`);
      return{file:relative,sha256:sha256(content)};
    }
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  throw new Error(`Playwright Gate requires a tracked package-lock.json, pnpm-lock.yaml, or yarn.lock pinning ${name} ${version}`);
}

async function resolvePlaywrightCli(worktree:string,packageRoots:string[]=[worktree]):Promise<{cli:string;package:'@playwright/test'|'playwright';version:string;cliSha256:string;lockfile:string;lockfileSha256:string}>{
  const worktreeReal=await realpath(worktree),prefix=worktreeReal+path.sep;
  const candidates=packageRoots.flatMap(packageRoot=>[
    {cli:path.join(packageRoot,'node_modules','@playwright','test','cli.js'),pkg:path.join(packageRoot,'node_modules','@playwright','test','package.json'),name:'@playwright/test' as const},
    {cli:path.join(packageRoot,'node_modules','playwright','cli.js'),pkg:path.join(packageRoot,'node_modules','playwright','package.json'),name:'playwright' as const},
  ]);
  for(const candidate of candidates){
    const info=await lstat(candidate.cli).catch(()=>null),pkgInfo=await lstat(candidate.pkg).catch(()=>null);
    if(!info||!info.isFile()||info.isSymbolicLink()||!pkgInfo||!pkgInfo.isFile()||pkgInfo.isSymbolicLink())continue;
    const actual=await realpath(candidate.cli),actualPkg=await realpath(candidate.pkg);
    if(!actual.startsWith(prefix))throw new Error('Playwright CLI resolves outside the managed worktree');
    if(!actualPkg.startsWith(prefix))throw new Error('Playwright package metadata resolves outside the managed worktree');
    const metadata=JSON.parse(await readFile(actualPkg,'utf8')) as {name?:string;version?:string};
    if(metadata.name!==candidate.name||!metadata.version||!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version))throw new Error('invalid target-local Playwright package metadata');
    const lock=await lockedPlaywrightDependency(worktree,packageRootFor(candidate.cli),candidate.name,metadata.version);
    return {cli:actual,package:candidate.name,version:metadata.version,cliSha256:sha256(await readFile(actual)),lockfile:lock.file,lockfileSha256:lock.sha256};
  }
  throw new Error('Playwright Gate requires target-local @playwright/test or playwright in node_modules');
}

function packageRootFor(cli:string):string {
  const marker=`${path.sep}node_modules${path.sep}`,index=cli.lastIndexOf(marker);
  if(index<0)throw new Error('Playwright CLI is not inside node_modules');
  return cli.slice(0,index);
}

async function collectWebAttachments(root:string,dir:string):Promise<Array<{file:string;sha256:string;bytes:number}>>{
  const files:Array<{file:string;sha256:string;bytes:number}>=[];
  async function visit(current:string):Promise<void>{
    for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const target=path.join(current,entry.name);
      if(entry.isSymbolicLink())throw new Error(`Playwright artifact may not be a symbolic link: ${target}`);
      if(entry.isDirectory())await visit(target);
      else if(entry.isFile()){
        const content=await readFile(target),relative=path.relative(root,target).split(path.sep).join('/');
        files.push({file:relative,sha256:sha256(content),bytes:content.length});
      }
    }
  }
  await visit(dir);
  return files.sort((a,b)=>a.file.localeCompare(b.file));
}

async function screenshotCount(root:string,files:Array<{file:string}>,resultsRoot:string):Promise<number>{
  const prefix=resultsRoot.split(path.sep).join('/').replace(/\/+$/,'')+'/';
  let count=0;
  for(const item of files.filter(item=>item.file.startsWith(prefix)&&/\.png$/i.test(item.file))){
    if(validImage(await readFile(path.join(root,item.file)),'image/png'))count++;
  }
  return count;
}

function passingTests(report:unknown):number {
  let count=0;
  const visit=(value:unknown)=>{
    if(!value||typeof value!=='object')return;
    const node=value as {suites?:unknown[];specs?:Array<{tests?:Array<{projectName?:unknown;results?:Array<{status?:unknown}>}>}>};
    for(const suite of node.suites??[])visit(suite);
    for(const spec of node.specs??[])for(const test of spec.tests??[]){
      if(typeof test.projectName==='string'&&(test.results??[]).some((result)=>result.status==='passed'))count++;
    }
  };
  const root=report as {config?:unknown;suites?:unknown[]};
  if(!root||typeof root.config!=='object'||!Array.isArray(root.suites))return 0;
  visit(root);return count;
}

async function assertSafePlaywrightInput(worktree:string,value:string,label:string):Promise<void>{
  const target=path.resolve(worktree,value),worktreeReal=await realpath(worktree),info=await lstat(target).catch(()=>null);
  if(!info||info.isSymbolicLink()||(!info.isFile()&&!info.isDirectory()))throw new Error(`${label} is missing, symbolic, or not a regular path: ${value}`);
  const actual=await realpath(target);
  if(!actual.startsWith(worktreeReal+path.sep))throw new Error(`${label} resolves outside the managed worktree: ${value}`);
}

async function runPlaywrightGate(root:string,taskId:string,m:WorkspaceManifest,gate:z.infer<typeof playwrightGateSchema>,config:z.infer<typeof gateConfigSchema>,startHead:string,startFingerprint:string):Promise<GateResult>{
  const started=Date.now(),createdAt=new Date().toISOString();
  const webRoot=path.join(control(root),'output',`${taskId}-web-${gate.id}`);
  await rm(webRoot,{recursive:true,force:true});await mkdir(webRoot,{recursive:true});
  const resultsDir=path.join(webRoot,'test-results'),htmlDir=path.join(webRoot,'html-report'),jsonFile=path.join(webRoot,'results.json');
  if(gate.config){
    const config=path.resolve(m.worktree,gate.config),worktreeReal=await realpath(m.worktree),prefix=worktreeReal+path.sep;
    const info=await lstat(config).catch(()=>null);
    if(!info||!info.isFile()||info.isSymbolicLink())throw new Error(`${gate.id}: Playwright config is missing or invalid`);
    if(!(await realpath(config)).startsWith(prefix))throw new Error(`${gate.id}: Playwright config escapes worktree`);
  }
  for(const testPath of gate.tests)await assertSafePlaywrightInput(m.worktree,testPath,`${gate.id}: Playwright test path`);
  const runner=await resolvePlaywrightCli(m.worktree,playwrightPackageRoots(m.worktree,gate));
  const args=[runner.cli,'test',...gate.tests];
  if(gate.config)args.push('--config',gate.config);
  for(const projectName of gate.projects)args.push('--project',projectName);
  if(gate.grep)args.push('--grep',gate.grep);
  args.push('--output',resultsDir,'--reporter','line,json,html');
  const result=await runProcess(process.execPath,args,m.worktree,gate.timeout_seconds*1000,undefined,{
    CI:'1',PLAYWRIGHT_HTML_OPEN:'never',PLAYWRIGHT_HTML_OUTPUT_DIR:htmlDir,PLAYWRIGHT_JSON_OUTPUT_FILE:jsonFile,
    ...gateEnvironment(config),
  });
  const head=await git(m.worktree,['rev-parse','HEAD']),endFingerprint=await worktreeFingerprint(m.worktree);
  if(head!==startHead)throw new Error('Playwright Gate changed Git HEAD');
  if(endFingerprint!==startFingerprint)throw new Error('Playwright Gate changed the candidate worktree');
  const validationErrors:string[]=[];let stats:z.infer<typeof playwrightStatsSchema>|null=null,observedPassing=0;
  try{
    const report=JSON.parse(await readFile(jsonFile,'utf8')) as {stats?:{expected?:number;unexpected?:number;flaky?:number;skipped?:number;duration?:number}};
    observedPassing=passingTests(report);
    stats=playwrightStatsSchema.parse({
      expected:report.stats?.expected,unexpected:report.stats?.unexpected,flaky:report.stats?.flaky,
      skipped:report.stats?.skipped,duration_ms:report.stats?.duration,
    });
  }catch(error){validationErrors.push(`invalid or missing Playwright JSON report: ${(error as Error).message}`)}
  if(stats){
    if(stats.expected<1)validationErrors.push('Playwright Gate must execute at least one passing test');
    if(observedPassing<1||observedPassing<stats.expected)validationErrors.push('Playwright JSON report does not contain the expected passed browser test results');
    if(stats.unexpected>0)validationErrors.push(`Playwright reported ${stats.unexpected} unexpected test result(s)`);
    if(stats.flaky>0)validationErrors.push(`Playwright reported ${stats.flaky} flaky test result(s)`);
    if(stats.skipped>0)validationErrors.push(`Playwright reported ${stats.skipped} skipped test result(s)`);
  }
  let htmlReport:string|null=null;
  try{
    const htmlFile=path.join(htmlDir,'index.html'),html=await readFile(htmlFile,'utf8');
    if(!/<html[\s>]/i.test(html)||!/<\/html>/i.test(html))throw new Error('index.html is not a complete HTML document');
    htmlReport=path.relative(root,htmlFile).split(path.sep).join('/');
  }catch(error){validationErrors.push(`invalid or missing Playwright HTML report: ${(error as Error).message}`)}
  const attachments=await collectWebAttachments(root,webRoot),screenshots=await screenshotCount(root,attachments,path.relative(root,resultsDir));
  if(gate.require_screenshots&&screenshots<1)validationErrors.push('Playwright Gate requires at least one valid screenshot');
  const manifestValue=webManifestSchema.parse({
    schema_version:1,task_id:taskId,gate_id:gate.id,base_commit:m.base_commit,head,ac:gate.ac,
    runner:{package:runner.package,version:runner.version,cli_sha256:runner.cliSha256,lockfile:runner.lockfile,lockfile_sha256:runner.lockfileSha256},stats,screenshots,
    files:attachments,html_report:htmlReport,validation_errors:validationErrors,created_at:createdAt,
  });
  const manifestContent=JSON.stringify(manifestValue,null,2)+'\n',manifestRel=path.relative(root,path.join(webRoot,'manifest.json')).split(path.sep).join('/');
  const finalCode=result.timedOut?124:(result.code===0&&validationErrors.length===0?0:(result.code||1));
  const content=`TASK ${taskId}\nKIND playwright\nCOMMAND ${JSON.stringify([process.execPath,...args])}\nCWD ${m.worktree}\nTIMED_OUT ${result.timedOut}\nEXIT ${finalCode}\nBASE ${m.base_commit}\nHEAD ${head}\nTESTS ${stats?.expected??0}\nUNEXPECTED ${stats?.unexpected??'UNKNOWN'}\nFLAKY ${stats?.flaky??'UNKNOWN'}\nSCREENSHOTS ${screenshots}\nMANIFEST ${manifestRel}\n\nVALIDATION\n${validationErrors.join('\n')}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}\n`;
  const artifactRel=`.spec-loop/output/${taskId}-gate-${gate.id}.txt`;
  await atomicWriteMany(root,[
    {file:path.join(webRoot,'manifest.json'),content:manifestContent},
    {file:path.join(root,artifactRel),content},
  ]);
  return gateResultSchema.parse({
    schema_version:1,task_id:taskId,id:gate.id,kind:'playwright',command:[process.execPath,...args],cwd:m.worktree,
    coverage:config.coverage,database_lifecycle:config.database.lifecycle,plan_sha256:gatePlanHash(config),
    exit_code:finalCode,timed_out:result.timedOut,duration_ms:Date.now()-started,base_commit:m.base_commit,head,
    artifact:artifactRel,sha256:sha256(content),
    web_evidence:stats?{manifest:manifestRel,sha256:sha256(manifestContent),stats,ac:gate.ac,screenshots,files:attachments.length}:null,
    created_at:createdAt,
  });
}

export async function runGates(root:string,taskId:string):Promise<GateResult[]>{
  const m=await readWorkspace(root,taskId),current=await readHarnessState(root,taskId);if(current.stage!=='collected')throw new Error(`harness verify is illegal from ${current.stage}`);const config=await readGateConfig(root),gates=config.gates,results:GateResult[]=[];
  await validateGateScope(root,taskId,config);
  await validatePlaywrightDeclarations(root,taskId,gates);
  const startHead=await git(m.worktree,['rev-parse','HEAD']);if(startHead!==current.head)throw new Error('workspace HEAD changed after collect');
  const collectRaw=await readFile(path.join(control(root),'output',`${taskId}-collect.json`),'utf8');
  if(current.evidence_hashes.collect!==sha256(collectRaw))throw new Error('Harness Collect Evidence hash mismatch');
  const collect=collectSchema.parse(JSON.parse(collectRaw));
  const startStatus=await worktreeStatus(m.worktree),startFingerprint=await worktreeFingerprint(m.worktree);
  if(startStatus!==collect.status.join('\n')||startFingerprint!==collectedFingerprint(collect))throw new Error('candidate worktree changed after collect');
  for(const gate of gates){
    if(gate.kind==='playwright'){
      const result=await runPlaywrightGate(root,taskId,m,gate,config,startHead,startFingerprint);
      results.push(gateResultSchema.parse({...result,scope_kind:config.scope_kind,wave_id:config.wave_id,coverage:config.coverage,database_lifecycle:config.database.lifecycle,plan_sha256:gatePlanHash(config),ac:gate.ac}));
      continue;
    }
    assertGateCommand(gate.command);assertDatabaseLifecycle(gate.command,config);const started=Date.now(),createdAt=new Date().toISOString(),result=await runProcess(gate.command[0],gate.command.slice(1),m.worktree,gate.timeout_seconds*1000,undefined,gateEnvironment(config)),head=await git(m.worktree,['rev-parse','HEAD']),endFingerprint=await worktreeFingerprint(m.worktree);if(head!==startHead)throw new Error('gate command changed Git HEAD');if(endFingerprint!==startFingerprint)throw new Error('gate command changed the candidate worktree');const content=`TASK ${taskId}\nKIND command\nSCOPE ${config.scope_kind??'legacy'}\nWAVE ${config.wave_id??''}\nCOVERAGE ${config.coverage}\nDATABASE_LIFECYCLE ${config.database.lifecycle}\nDATABASE_RESET ${config.database.reset}\nAC ${JSON.stringify(gate.ac??[])}\nCOMMAND ${JSON.stringify(gate.command)}\nCWD ${m.worktree}\nTIMED_OUT ${result.timedOut}\nEXIT ${result.code}\nBASE ${m.base_commit}\nHEAD ${head}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}\n`,rel=`.spec-loop/output/${taskId}-gate-${gate.id}.txt`;await atomicWriteMany(root,[{file:path.join(root,rel),content}]);results.push(gateResultSchema.parse({schema_version:1,task_id:taskId,id:gate.id,kind:'command',scope_kind:config.scope_kind,wave_id:config.wave_id,coverage:config.coverage,database_lifecycle:config.database.lifecycle,plan_sha256:gatePlanHash(config),ac:gate.ac,command:gate.command,cwd:m.worktree,exit_code:result.code,timed_out:result.timedOut,duration_ms:Date.now()-started,base_commit:m.base_commit,head,artifact:rel,sha256:sha256(content),web_evidence:null,created_at:createdAt}))
  }
  const serialized=JSON.stringify(results,null,2)+'\n';await atomicWriteMany(root,[{file:path.join(control(root),'output',`${taskId}-gates.json`),content:serialized}]);await advance(root,taskId,'collected','verified',m,startHead,results.every(x=>x.exit_code===0)?null:'one or more gates failed',{gates:sha256(serialized)});return results;
}

async function validateGateEvidence(root:string,taskId:string,m:WorkspaceManifest,head:string,gates:GateResult[]):Promise<void>{
  const requirements=await webRequirements(root,taskId);
  const config=await readGateConfig(root),definitions=config.gates;
  await validateGateScope(root,taskId,config);
  if(definitions.length!==gates.length||definitions.some((definition)=>!gates.some((gate)=>gate.id===definition.id)))
    throw new Error('Gate Plan changed after execution');
  for(const requirement of requirements){
    const gate=gates.find((item)=>item.id===requirement.id&&item.kind==='playwright');
    if(!gate)throw new Error(`${requirement.id}: required Playwright evidence is missing`);
    if(!gate.web_evidence||!sameStrings(gate.web_evidence.ac,requirement.ac))throw new Error(`${requirement.id}: Playwright Evidence AC coverage mismatch`);
  }
  for(const g of gates){
    if(g.task_id!==taskId||g.cwd!==m.worktree||g.base_commit!==m.base_commit||g.head!==head)throw new Error(`${g.id}: stale or mismatched gate evidence`);
    const definition=definitions.find((item)=>item.id===g.id);
    if(!definition)throw new Error(`${g.id}: Gate definition is missing`);
    if(g.scope_kind!==config.scope_kind||g.wave_id!==config.wave_id||g.coverage!==config.coverage||g.database_lifecycle!==config.database.lifecycle||!sameStrings(g.ac??[],definition.ac??[])||g.plan_sha256!==gatePlanHash(config))
      throw new Error(`${g.id}: Gate Plan, scope or AC coverage changed after execution`);
    const artifactPath=path.resolve(root,g.artifact);
    if(!artifactPath.startsWith(path.resolve(root)+path.sep))throw new Error(`${g.id}: gate artifact escapes project root`);
    const artifact=await readFile(artifactPath);if(sha256(artifact)!==g.sha256)throw new Error(`${g.id}: gate artifact hash mismatch`);
    if(g.kind==='playwright'){
      if(!g.web_evidence)throw new Error(`${g.id}: missing Playwright evidence`);
      const playwrightDefinition=definitions.find((item):item is z.infer<typeof playwrightGateSchema>=>item.id===g.id&&item.kind==='playwright');
      if(!playwrightDefinition)throw new Error(`${g.id}: Playwright Gate definition is missing`);
      const runner=await resolvePlaywrightCli(m.worktree,playwrightPackageRoots(m.worktree,playwrightDefinition));
      const manifestPath=path.resolve(root,g.web_evidence.manifest);
      if(!manifestPath.startsWith(path.resolve(root)+path.sep))throw new Error(`${g.id}: Playwright manifest escapes project root`);
      const manifestRaw=await readFile(manifestPath);if(sha256(manifestRaw)!==g.web_evidence.sha256)throw new Error(`${g.id}: Playwright manifest hash mismatch`);
      const web=webManifestSchema.parse(JSON.parse(manifestRaw.toString('utf8')));
      if(web.task_id!==taskId||web.gate_id!==g.id||web.base_commit!==m.base_commit||web.head!==head||!sameStrings(web.ac,g.web_evidence.ac))throw new Error(`${g.id}: stale or mismatched Playwright manifest`);
      if(!runner||web.runner.package!==runner.package||web.runner.version!==runner.version||web.runner.cli_sha256!==runner.cliSha256||web.runner.lockfile!==runner.lockfile||web.runner.lockfile_sha256!==runner.lockfileSha256)throw new Error(`${g.id}: target-local Playwright runner or dependency lock changed after Gate`);
      if(!web.stats||web.stats.expected<1||web.stats.unexpected>0||web.stats.flaky>0||web.stats.skipped>0||web.validation_errors.length)throw new Error(`${g.id}: invalid Playwright result summary`);
      if(web.screenshots!==g.web_evidence.screenshots||web.files.length!==g.web_evidence.files)throw new Error(`${g.id}: Playwright evidence summary mismatch`);
      for(const item of web.files){
        const target=path.resolve(root,item.file);
        if(!target.startsWith(path.resolve(root)+path.sep))throw new Error(`${g.id}: Playwright attachment escapes project root`);
        const info=await lstat(target).catch(()=>null);
        if(!info||!info.isFile()||info.isSymbolicLink())throw new Error(`${g.id}: invalid Playwright attachment: ${item.file}`);
        const content=await readFile(target);if(content.length!==item.bytes||sha256(content)!==item.sha256)throw new Error(`${g.id}: Playwright attachment hash mismatch: ${item.file}`);
      }
      if(!web.html_report||!web.files.some((item)=>item.file===web.html_report))throw new Error(`${g.id}: missing hashed Playwright HTML report`);
      const html=await readFile(path.join(root,web.html_report),'utf8');
      if(!/<html[\s>]/i.test(html)||!/<\/html>/i.test(html))throw new Error(`${g.id}: invalid Playwright HTML report`);
      const resultsRoot=path.relative(root,path.join(control(root),'output',`${taskId}-web-${g.id}`,'test-results'));
      const observedScreenshots=await screenshotCount(root,web.files,resultsRoot);
      if(observedScreenshots!==web.screenshots||(playwrightDefinition.require_screenshots&&web.screenshots<1))
        throw new Error(`${g.id}: invalid or missing Playwright screenshots`);
    }
  }
}

export async function reportHarness(root:string,taskId:string){
  const m=await readWorkspace(root,taskId),current=await readHarnessState(root,taskId);if(current.stage!=='verified')throw new Error(`harness report is illegal from ${current.stage}`);
  const collectRaw=await readFile(path.join(control(root),'output',`${taskId}-collect.json`),'utf8'),gatesRaw=await readFile(path.join(control(root),'output',`${taskId}-gates.json`),'utf8'),collected=collectSchema.parse(JSON.parse(collectRaw)),gates=gateResultsSchema.parse(JSON.parse(gatesRaw)),head=await git(m.worktree,['rev-parse','HEAD']);
  if(current.evidence_hashes.collect!==sha256(collectRaw)||current.evidence_hashes.gates!==sha256(gatesRaw))throw new Error('Harness Evidence hash chain mismatch');
  if(collected.task_id!==taskId||collected.workspace!==m.worktree||collected.base_commit!==m.base_commit||collected.head!==head||current.head!==head)throw new Error('stale or mismatched collect evidence');
  if(await worktreeStatus(m.worktree)!==collected.status.join('\n')||await worktreeFingerprint(m.worktree)!==collectedFingerprint(collected))throw new Error('candidate worktree differs from collected evidence');
  await validateGateEvidence(root,taskId,m,head,gates);
  const config=await readGateConfig(root);
  const passed=gates.every(g=>g.exit_code===0&&!g.timed_out),content=`# Harness Report — ${taskId}\n\n- Base: ${collected.base_commit}\n- Head: ${collected.head}\n- Verification scope: ${config.scope_kind??'legacy'}${config.wave_id?` (${config.wave_id})`:''}\n- Coverage: ${config.coverage}\n- Database lifecycle: ${config.database.lifecycle} (${config.database.reset})\n- Gate verdict: ${passed?'PASS':'FAIL'}\n- Modified entries: ${collected.status.length}\n\n## Gates\n${gates.map(g=>`- ${g.id} (${g.kind}, AC ${g.ac?.join(', ')||'legacy'}): exit ${g.exit_code}, timeout ${g.timed_out}, artifact ${g.artifact}, sha256 ${g.sha256}${g.web_evidence?`, tests ${g.web_evidence.stats.expected}, screenshots ${g.web_evidence.screenshots}, web manifest ${g.web_evidence.manifest}`:''}`).join('\n')}\n`,file=path.join(control(root),'output',`${taskId}-harness-report.md`);
  const reportHash=sha256(content);await atomicWriteMany(root,[{file,content}]);await advance(root,taskId,'verified','reported',m,head,passed?null:'gate verdict failed',{report:reportHash});return{passed,head,file,sha256:reportHash};
}

export async function validateRequiredWebGates(root:string,taskId:string,revision:string):Promise<string[]>{
  const requirements=await webRequirements(root,taskId);
  if(!requirements.length)return[];
  const m=await readWorkspace(root,taskId),state=await readHarnessState(root,taskId);
  if(state.stage!=='reported'||state.last_error)throw new Error('required Web Gate does not have a passing Harness Report');
  const canonical=(await git(m.worktree,['rev-parse','--verify',`${revision}^{commit}`])).toLowerCase();
  if(canonical!==state.head)throw new Error('required Web Gate Evidence targets a different Git revision');
  const collected=collectSchema.parse(JSON.parse(await readFile(path.join(control(root),'output',`${taskId}-collect.json`),'utf8')));
  if(await worktreeStatus(m.worktree)!==collected.status.join('\n')||await worktreeFingerprint(m.worktree)!==collectedFingerprint(collected))throw new Error('candidate worktree changed after Harness Report');
  const reportFile=path.join(control(root),'output',`${taskId}-harness-report.md`);
  if(state.evidence_hashes.report!==sha256(await readFile(reportFile)))throw new Error('Harness Report hash mismatch');
  const gatesRaw=await readFile(path.join(control(root),'output',`${taskId}-gates.json`),'utf8');
  if(state.evidence_hashes.gates!==sha256(gatesRaw))throw new Error('Harness Gate Evidence hash mismatch');
  const gates=gateResultsSchema.parse(JSON.parse(gatesRaw));
  await validateGateEvidence(root,taskId,m,state.head,gates);
  if(gates.some((gate)=>gate.exit_code!==0||gate.timed_out))throw new Error('required Web Gate did not pass');
  return requirements.map((item)=>item.id);
}

export async function reconcileHarness(root:string,taskId:string){
  const m=await readWorkspace(root,taskId),head=await git(m.worktree,['rev-parse','HEAD']);let state:HarnessState;
  try{state=await readHarnessState(root,taskId)}catch{throw new Error('no valid harness state to reconcile')}
  const required:Record<HarnessState['stage'],string[]>={prepared:[`${taskId}-prepare.json`],executed:[`${taskId}-prepare.json`,`${taskId}-provider.txt`],collected:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`],verified:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`,`${taskId}-gates.json`],reported:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`,`${taskId}-gates.json`,`${taskId}-harness-report.md`]};
  for(const name of required[state.stage])if(!(await exists(path.join(control(root),'output',name))))throw new Error(`harness state ${state.stage} is missing ${name}`);
  const hashFiles:Record<string,string>={prepare:`${taskId}-prepare.json`,provider:`${taskId}-provider.txt`,collect:`${taskId}-collect.json`,gates:`${taskId}-gates.json`,report:`${taskId}-harness-report.md`};for(const [key,expected] of Object.entries(state.evidence_hashes)){const file=hashFiles[key];if(!file||sha256(await readFile(path.join(control(root),'output',file)))!==expected)throw new Error(`harness Evidence hash mismatch: ${key}`)}
  if(state.stage==='verified'||state.stage==='reported'){
    const gates=gateResultsSchema.parse(JSON.parse(await readFile(path.join(control(root),'output',`${taskId}-gates.json`),'utf8')));
    await validateGateEvidence(root,taskId,m,state.head,gates);
  }
  const headChanged=head!==state.head;
  let worktreeChanged=false;
  if(['collected','verified','reported'].includes(state.stage)){
    const collected=collectSchema.parse(JSON.parse(await readFile(path.join(control(root),'output',`${taskId}-collect.json`),'utf8')));
    worktreeChanged=!collected.worktree_fingerprint||await worktreeStatus(m.worktree)!==collected.status.join('\n')||await worktreeFingerprint(m.worktree)!==collected.worktree_fingerprint;
  }
  const staleHeadEvidence=headChanged||worktreeChanged||state.last_error?.startsWith('workspace HEAD changed')===true;
  const reconciled={
    ...state,
    head,
    stage:staleHeadEvidence?'prepared':state.stage,
    sequence:state.sequence+1,
    evidence_hashes:staleHeadEvidence?{prepare:state.evidence_hashes.prepare}:state.evidence_hashes,
    updated_at:new Date().toISOString(),
    last_error:staleHeadEvidence?'workspace HEAD or worktree changed; rerun execute/collect/verify':state.last_error,
  };
  await writeHarnessState(root,reconciled);return reconciled;
}

export async function writebackDelivery(root:string,taskId:string){const item=(await scanTasks(root)).find(t=>t.task_id===taskId);if(!item)throw new Error('task not found');const state=await readState(item.path);if(state.status!=='delivered')throw new Error('task is not delivered');const evidence=await evidenceRecords(item.path);const content=`# Project Write-back — ${taskId}\n\n- Project: ${(await readProject(root)).project_id}\n- Status: delivered\n- Round: ${state.current_round}\n- Revision: ${state.code_revision}\n- Evidence: ${evidence.map(e=>e.id).join(', ')}\n\nThis is a generated external-system write-back draft. No external write was performed.\n`;const file=path.join(control(root),'output',`${taskId}-writeback.md`);await atomicWriteMany(root,[{file,content}]);return file}
