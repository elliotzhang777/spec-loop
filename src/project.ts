import { access, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteAcrossRoots, atomicWriteMany, assertSubstantive, exists, readMarkdown, recoverCrossRootTransactions, sha256, stringifyMarkdown } from './files.js';
import { readState } from './task.js';
import { initialFiles } from './templates.js';
import { containsRealPlaceholder, loadTargetSpecBundle, type TargetSpecBundleAsset, type TargetSpecProfile } from './target-spec.js';
import type { TaskState } from './model.js';
import { runManagedProcess } from './managed-process.js';

const risk = z.enum(['light', 'standard', 'heavy']);
const taskProtocol = z.enum(['v1', 'v2']);
export type TaskProtocol = z.infer<typeof taskProtocol>;
export const projectSchema = z.object({ schema_version:z.literal(1), project_id:z.string().regex(/^PROJ-[A-Z0-9-]+$/), name:z.string().min(2), repository:z.string().min(1), spec_profile:z.enum(['standard','backend','frontend','fullstack']).default('standard'), spec_root:z.string().min(1).default('spec'), default_task_protocol:taskProtocol.default('v1'), default_branch:z.string().min(1), tasks_root:z.string().min(1), output_root:z.string().min(1), risk_level:risk, external_issue:z.string().nullable(), created_at:z.iso.datetime(), updated_at:z.iso.datetime() }).strict();
export const projectStateSchema = z.object({ schema_version:z.literal(1), project_id:z.string(), state_version:z.number().int().positive(), current_goal:z.string(), next_action:z.string(), candidates:z.array(z.string()), ignored:z.array(z.object({ item:z.string(), reason:z.string() }).strict()), updated_at:z.iso.datetime() }).strict();
const providerId=z.enum(['codex','claude-code','qoder']);
const providerDefinition=z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive(),idle_timeout_seconds:z.number().int().min(10).max(1800).default(300)}).strict();
export const providerConfigSchema = z.object({ schema_version:z.literal(1), active_provider:providerId, role_providers:z.object({M:providerId,V:providerId,R:providerId}).strict().optional(), providers:z.object({ codex:providerDefinition, 'claude-code':providerDefinition, qoder:providerDefinition }).strict() }).strict();
const proposalFields={proposal_id:z.string().regex(/^PROP-[1-9]\d*$/),project_id:z.string(),source:z.string().min(3),suggested_goal:z.string().min(3),risk_level:risk,priority:z.enum(['P0','P1','P2','P3']),reason:z.string().min(3),initial_acceptance:z.array(z.object({id:z.string().regex(/^AC-[1-9]\d*$/),text:z.string().min(3)}).strict()).min(1),created_at:z.iso.datetime()};
const proposalSchema = z.discriminatedUnion('schema_version',[
  z.object({schema_version:z.literal(1),...proposalFields}).strict(),
  z.object({schema_version:z.literal(2),...proposalFields,acceptance_contract:z.unknown()}).strict(),
]);
const approvalSchema = z.object({ schema_version:z.literal(1), approval_id:z.string().regex(/^APR-[1-9]\d*$/), proposal_id:z.string(), proposal_hash:z.string().length(64), approved_by:z.string().min(2), approved_at:z.iso.datetime(), expires_at:z.iso.datetime(), approved_scope:z.array(z.enum(['create_task','execute_in_worktree'])).min(1), risk_level:risk }).strict();

const control=(root:string)=>path.join(root,'.spec-loop');
async function entryExists(file:string):Promise<boolean>{
  try{await lstat(file);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}
}

function resolveSpecRoot(repository:string,specRoot:string):{repo:string;specRoot:string}{
  const repo=path.resolve(repository),resolved=path.resolve(repo,specRoot);
  if(!resolved.startsWith(repo+path.sep))throw new Error('spec_root escapes target repository');
  return {repo,specRoot:resolved};
}

async function assertRealDirectoryChain(root:string,target:string,label:string):Promise<void>{
  const relative=path.relative(root,target);
  if(relative.startsWith(`..${path.sep}`)||relative==='..'||path.isAbsolute(relative))throw new Error(`${label} escapes target repository`);
  let current=path.resolve(root);
  const parts=relative?relative.split(path.sep):[];
  for(const part of ['.',...parts]){
    if(part!=='.')current=path.join(current,part);
    let info;
    try{info=await lstat(current)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
    if(info.isSymbolicLink()||!info.isDirectory())throw new Error(`${label} must use real directories: ${path.relative(root,current)||'.'}`);
  }
}

export async function initTargetSpecLibrary(root:string):Promise<{created:string[];preserved:string[]}>{
  const project=await readProject(root),resolved=resolveSpecRoot(project.repository,project.spec_root),template=await loadTargetSpecBundle(project.spec_profile),created:string[]=[],preserved:string[]=[],writes=[];
  if(project.spec_profile!=='standard'&&project.spec_root!==template.primary_spec_root)throw new Error(`spec_root must be ${template.primary_spec_root} for ${project.spec_profile} profile`);
  await assertRealDirectoryChain(resolved.repo,resolved.specRoot,'spec_root');
  const assetFile=(item:TargetSpecBundleAsset)=>path.join(item.base==='repository'?resolved.repo:resolved.specRoot,item.install_path);
  const dirs=[...new Set(template.assets.map(item=>path.dirname(assetFile(item))))];
  for(const dir of dirs){await assertRealDirectoryChain(resolved.repo,dir,'target spec directory');if(await entryExists(dir)){const info=await lstat(dir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error(`target spec directory must be a real directory: ${path.relative(resolved.repo,dir)}`)}}
  for(const item of template.assets){const file=assetFile(item);if(await entryExists(file))preserved.push(file);else{created.push(file);writes.push({file,content:item.content})}}
  for(const dir of dirs)await mkdir(dir,{recursive:true});
  if(writes.length)await atomicWriteMany(resolved.repo,writes);
  return {created,preserved};
}

export async function checkTargetSpecLibrary(root:string):Promise<{ok:boolean;errors:string[]} >{
  const project=await readProject(root),errors:string[]=[];
  let repo:string,specRoot:string;
  try{({repo,specRoot}=resolveSpecRoot(project.repository,project.spec_root))}catch(error){errors.push((error as Error).message);return {ok:false,errors}}
  const template=await loadTargetSpecBundle(project.spec_profile);
  if(project.spec_profile!=='standard'&&project.spec_root!==template.primary_spec_root){errors.push(`spec_root must be ${template.primary_spec_root} for ${project.spec_profile} profile`);return {ok:false,errors}}
  try{await assertRealDirectoryChain(repo,specRoot,'spec_root')}catch(error){errors.push((error as Error).message);return {ok:false,errors}}
  const invalidAssetDirs=new Set<string>();
  const assetFile=(item:TargetSpecBundleAsset)=>path.join(item.base==='repository'?repo:specRoot,item.install_path);
  const assetDirs=new Set(template.assets.map(item=>path.dirname(assetFile(item))));
  for(const dir of assetDirs){
    if(dir===specRoot||!(await entryExists(dir)))continue;
    const info=await lstat(dir);
    if(info.isSymbolicLink()||!info.isDirectory()){errors.push(`target spec layer must be a real directory: ${path.relative(repo,dir)}`);invalidAssetDirs.add(dir)}
  }
  for(const item of template.assets){
    const file=assetFile(item);
    if(invalidAssetDirs.has(path.dirname(file)))continue;
    if(!(await entryExists(file))){errors.push(`missing target spec file: ${path.relative(repo,file)}`);continue}
    const info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()){errors.push(`target spec file must be a regular file and may not be a symbolic link: ${path.relative(repo,file)}`);continue}
    const content=await readFile(file,'utf8');
    if(content.trim().length<20)errors.push(`empty target spec file: ${path.relative(repo,file)}`);
    if(item.check_placeholders&&containsRealPlaceholder(content))errors.push(`placeholder content in target spec file: ${path.relative(repo,file)}`);
  }
  const backendSpec=specRoot,frontendSpec=project.spec_profile==='fullstack'?path.join(repo,'frontend','spec'):project.spec_profile==='frontend'?specRoot:null;
  const layers:Array<{root:string;dir:string;kind:'product'|'feature'|'decision'|'design'|'task'|'web-task';id:RegExp;heading:RegExp;trace:RegExp|null;localTrace:boolean}>=[];
  if(project.spec_profile!=='frontend'){
    layers.push(
      {root:backendSpec,dir:'01-product',kind:'product',id:/^PROD-[0-9]{3}$/,heading:/^# (PROD-[^：:\s]+)[：:]/m,trace:/^- Roadmap：.*roadmap\.md/m,localTrace:false},
      {root:backendSpec,dir:'02-feature',kind:'feature',id:/^FEAT-[0-9]{3}$/,heading:/^# (FEAT-[^：:\s]+)[：:]/m,trace:/^- 所属产品：.*\b(PROD-[0-9]{3})\b/m,localTrace:true},
    );
    if(project.spec_profile!=='standard')layers.push({root:backendSpec,dir:'03-decisions',kind:'decision',id:/^ADR-[0-9]{3}$/,heading:/^# (ADR-[^：:\s]+)[：:]/m,trace:null,localTrace:false});
    layers.push(
      {root:backendSpec,dir:project.spec_profile==='standard'?'03-design':'04-design',kind:'design',id:/^DES-[0-9]{3}$/,heading:/^# (DES-[^：:\s]+)[：:]/m,trace:/^- 所属特性：.*\b(FEAT-[0-9]{3})\b/m,localTrace:true},
      {root:backendSpec,dir:project.spec_profile==='standard'?'04-task':'05-task',kind:'task',id:/^TASK-(?:[0-9]{3}|[A-Z0-9]+(?:-[A-Z0-9]+)*)$/,heading:/^# (TASK-[^：:\s]+)[：:]/m,trace:/^- 所属设计：.*\b(DES-[0-9]{3})\b/m,localTrace:true},
    );
  }
  if(frontendSpec)layers.push({root:frontendSpec,dir:'05-task',kind:'web-task',id:/^WEB-TASK-(?:[0-9]{3}|[A-Z0-9]+(?:-[A-Z0-9]+)*)$/,heading:/^# (WEB-TASK-[^：:\s]+)[：:]/m,trace:/^- 关联设计\/API 契约：.*\b(DES-[0-9]{3})\b/m,localTrace:project.spec_profile==='fullstack'});
  const statuses=new Set(['草稿','已批准','进行中','待验证','已完成','已取消']);
  const documents:Array<{id:string;kind:string;file:string;content:string;config:typeof layers[number]}>=[];
  for(const config of layers){
    const layer=path.join(config.root,config.dir);
    if(!(await entryExists(layer)))continue;
    if(invalidAssetDirs.has(layer))continue;
    const layerInfo=await lstat(layer);
    if(layerInfo.isSymbolicLink()||!layerInfo.isDirectory()){errors.push(`target spec layer must be a real directory: ${path.relative(repo,layer)}`);continue}
    for(const name of await readdir(layer)){
      if(name==='_template.md'||name==='README.md'||!name.endsWith('.md'))continue;
      const file=path.join(layer,name),info=await lstat(file);
      if(info.isSymbolicLink()||!info.isFile()){errors.push(`target spec must be a regular file and may not be a symbolic link: ${path.relative(repo,file)}`);continue}
      const content=await readFile(file,'utf8'),heading=content.match(config.heading),id=heading?.[1];
      if(!id||!config.id.test(id))errors.push(`invalid or missing target spec ID: ${path.relative(repo,file)}`);
      const stem=name.slice(0,-3),suffix=id&&stem.startsWith(`${id}-`)?stem.slice(id.length+1):null;
      const validFilename=Boolean(id&&(stem===id||(suffix!==null&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix))));
      if(!validFilename)errors.push(`invalid target spec filename or ID mismatch: ${path.relative(repo,file)}`);
      if(id&&config.id.test(id)&&validFilename)documents.push({id,kind:config.kind,file,content,config});
      const status=content.match(/^- 状态：(.+)$/m)?.[1]?.trim();
      if(!status||!statuses.has(status))errors.push(`invalid or missing target spec status: ${path.relative(repo,file)}`);
      if(containsRealPlaceholder(content))errors.push(`placeholder content in target spec: ${path.relative(repo,file)}`);
    }
  }
  const ids=new Set(documents.map(x=>x.id));
  for(const doc of documents){
    const config=doc.config;
    const proposalTask=['task','web-task'].includes(doc.kind)&&/^- Proposal：PROP-[1-9]\d*$/m.test(doc.content);
    if(doc.kind==='product'){
      if(!config.trace?.test(doc.content))errors.push(`missing upstream trace in target spec: ${path.relative(repo,doc.file)}`);
    }else if(config.trace&&!proposalTask){
      const ref=doc.content.match(config.trace)?.[1];
      if(!ref)errors.push(`missing upstream trace in target spec: ${path.relative(repo,doc.file)}`);
      else if(config.localTrace&&!ids.has(ref))errors.push(`broken upstream trace ${ref} in target spec: ${path.relative(repo,doc.file)}`);
    }
    if(proposalTask&&!/^- Spec-Loop Task：\S.+$/m.test(doc.content))errors.push(`proposal task missing Spec-Loop Task trace: ${path.relative(repo,doc.file)}`);
  }
  return {ok:errors.length===0,errors};
}

export async function initProject(root:string,input:{id:string;name:string;repository:string;branch:string;risk:z.infer<typeof risk>;specProfile?:TargetSpecProfile}):Promise<void>{
  const c=control(root); if(await exists(path.join(c,'PROJECT.md')))throw new Error('project already initialized');
  await access(input.repository); const now=new Date().toISOString(),specProfile=input.specProfile??'standard',bundle=await loadTargetSpecBundle(specProfile);
  const project={schema_version:1 as const,project_id:input.id,name:input.name,repository:path.resolve(input.repository),spec_profile:specProfile,spec_root:bundle.primary_spec_root,default_task_protocol:'v1' as const,default_branch:input.branch,tasks_root:'.spec-loop/tasks',output_root:'.spec-loop/output',risk_level:input.risk,external_issue:null,created_at:now,updated_at:now};
  const state={schema_version:1 as const,project_id:input.id,state_version:1,current_goal:'Not set',next_action:'Run manual triage or create an approved task',candidates:[],ignored:[],updated_at:now};
  const config={schema_version:1 as const,active_provider:'codex' as const,role_providers:{M:'codex' as const,V:'codex' as const,R:'codex' as const},providers:{codex:{enabled:true,executable:'codex',args:['exec','--json','--sandbox','read-only','--ephemeral'],timeout_seconds:1800,idle_timeout_seconds:300},'claude-code':{enabled:false,executable:'claude',args:[],timeout_seconds:1800,idle_timeout_seconds:300},qoder:{enabled:false,executable:'qoder',args:[],timeout_seconds:1800,idle_timeout_seconds:300}}};
  projectSchema.parse(project);projectStateSchema.parse(state);providerConfigSchema.parse(config);
  await mkdir(path.join(c,'tasks'),{recursive:true});await mkdir(path.join(c,'proposals'),{recursive:true});await mkdir(path.join(c,'approvals'),{recursive:true});await mkdir(path.join(c,'output'),{recursive:true});
  await atomicWriteMany(root,[{file:path.join(c,'PROJECT.md'),content:stringifyMarkdown(project,'# Project\n\nProject metadata is CLI-managed.')},{file:path.join(c,'PROJECT_STATE.md'),content:stringifyMarkdown(state,'# Project State\n\nTask summaries are derived, not authoritative.')},{file:path.join(c,'PROVIDERS.md'),content:stringifyMarkdown(config,'# Providers\n\nDefault provider: Codex.')}]);
  await initTargetSpecLibrary(root);
}
export async function readProject(root:string){const doc=await readMarkdown(path.join(control(root),'PROJECT.md'));return projectSchema.parse(doc.data)}
export async function setDefaultTaskProtocol(root:string,protocol:TaskProtocol){
  const file=path.join(control(root),'PROJECT.md'),doc=await readMarkdown(file),project=projectSchema.parse(doc.data);
  const updated=projectSchema.parse({...project,default_task_protocol:taskProtocol.parse(protocol),updated_at:new Date().toISOString()});
  await atomicWriteMany(root,[{file,content:stringifyMarkdown(updated,doc.body)}]);
  return updated;
}
export async function readProjectState(root:string){return projectStateSchema.parse((await readMarkdown(path.join(control(root),'PROJECT_STATE.md'))).data)}
export async function readProviderConfig(root:string){const cfg=providerConfigSchema.parse((await readMarkdown(path.join(control(root),'PROVIDERS.md'))).data);if(!cfg.providers[cfg.active_provider].enabled)throw new Error('active provider is disabled');return cfg}
export function providerForRole(cfg:z.infer<typeof providerConfigSchema>,role:'M'|'V'|'R'){
  const id=cfg.role_providers?.[role]??cfg.active_provider;
  if(!cfg.providers[id].enabled)throw new Error(`${role} provider ${id} is disabled`);
  return{id,config:cfg.providers[id]};
}
export async function setActiveProvider(root:string,id:'codex'|'claude-code'|'qoder'):Promise<void>{const doc=await readMarkdown(path.join(control(root),'PROVIDERS.md'));const cfg=providerConfigSchema.parse(doc.data);if(!cfg.providers[id].enabled)throw new Error(`${id} provider is disabled`);const updated={...cfg,active_provider:id,role_providers:{M:id,V:id,R:id}};await atomicWriteMany(root,[{file:path.join(control(root),'PROVIDERS.md'),content:stringifyMarkdown(updated,doc.body)}])}
export async function setRoleProvider(root:string,role:'M'|'V'|'R',id:'codex'|'claude-code'|'qoder'):Promise<void>{const doc=await readMarkdown(path.join(control(root),'PROVIDERS.md'));const cfg=providerConfigSchema.parse(doc.data);if(!cfg.providers[id].enabled)throw new Error(`${id} provider is disabled`);const updated={...cfg,role_providers:{M:cfg.role_providers?.M??cfg.active_provider,V:cfg.role_providers?.V??cfg.active_provider,R:cfg.role_providers?.R??cfg.active_provider,[role]:id}};await atomicWriteMany(root,[{file:path.join(control(root),'PROVIDERS.md'),content:stringifyMarkdown(updated,doc.body)}])}

export interface TaskIndex {
  task_id:string;path:string;project_id:string;status:string;level:string;round:number;state_version:number;resumable:boolean;
  protocol:TaskProtocol;protocol_stage:string|null;blocking_reason:string|null;
}
export async function scanTasks(root:string):Promise<TaskIndex[]>{
  const project=await readProject(root),dir=path.resolve(root,project.tasks_root),out:TaskIndex[]=[];
  for(const entry of (await readdir(dir,{withFileTypes:true}))){
    if(!entry.isDirectory())continue;
    const taskRoot=path.join(dir,entry.name);
    if(!(await exists(path.join(taskRoot,'TASK_STATE.md'))))continue;
    const s=await readState(taskRoot),contractExists=await exists(path.join(taskRoot,'ACCEPTANCE_CONTRACT_V2.md')),runPath=path.join(taskRoot,'ACCEPTANCE_RUN.json'),runExists=await exists(runPath);
    let protocol:TaskProtocol=contractExists||runExists?'v2':'v1',protocolStage:string|null=null,blockingReason:string|null=null;
    if(runExists){
      try{
        const run=JSON.parse(await readFile(runPath,'utf8')) as {protocol_version?:number;stage?:string;active_conflict_id?:string|null};
        if(run.protocol_version!==2||typeof run.stage!=='string')throw new Error('invalid v2 run metadata');
        protocol='v2';protocolStage=run.stage;
        if(run.active_conflict_id)blockingReason=`active conflict: ${run.active_conflict_id}`;
        else if(run.stage==='waiting_human_review')blockingReason='waiting for human conflict resolution';
        else if(run.stage==='blocked_external')blockingReason='blocked by an external dependency';
        else if(run.stage==='cancelled')blockingReason='v2 run is cancelled';
      }catch(error){blockingReason=`invalid v2 run: ${(error as Error).message}`}
    }else if(protocol==='v2')protocolStage='contract_approved';
    out.push({task_id:s.task_id,path:taskRoot,project_id:project.project_id,status:s.status,level:s.level,round:s.current_round,state_version:s.state_version,resumable:['planned','working','verifying','iterating'].includes(s.status),protocol,protocol_stage:protocolStage,blocking_reason:blockingReason});
  }
  const ids=out.map(x=>x.task_id);if(new Set(ids).size!==ids.length)throw new Error('duplicate task ID in project');
  const byId=new Map(out.map(item=>[item.task_id,item]));
  for(const item of out){
    if(item.protocol!=='v2'||item.blocking_reason)continue;
    try{
      const contract=(await readMarkdown(path.join(item.path,'ACCEPTANCE_CONTRACT_V2.md'))).data as {depends_on?:unknown};
      if(!Array.isArray(contract.depends_on)||contract.depends_on.some(id=>typeof id!=='string')){item.blocking_reason='invalid v2 contract dependencies';continue}
      const unfinished=contract.depends_on.filter(id=>{const dependency=byId.get(id);return !dependency||(dependency.protocol==='v2'?dependency.protocol_stage!=='candidate':dependency.status!=='delivered')});
      if(unfinished.length)item.blocking_reason=`unfinished dependencies: ${unfinished.join(', ')}`;
    }catch(error){item.blocking_reason=`invalid v2 contract: ${(error as Error).message}`}
  }
  return out.sort((a,b)=>a.task_id.localeCompare(b.task_id));
}

export function selectActiveTask<T extends { state: TaskState }>(states: T[]): T | null {
  const newest = (items: T[]) => [...items].sort((left, right) => right.state.updated_at.localeCompare(left.state.updated_at))[0] ?? null;
  return newest(states.filter(({ state }) => ['working', 'verifying', 'iterating'].includes(state.status)))
    ?? newest(states.filter(({ state }) => state.status === 'planned'))
    ?? newest(states.filter(({ state }) => state.status === 'draft'));
}

export async function createProposal(root:string,input:{source:string;goal:string;risk:z.infer<typeof risk>;priority:'P0'|'P1'|'P2'|'P3';reason:string;criteria?:string[];acceptanceContract?:unknown}):Promise<string>{const p=await readProject(root);if(p.default_task_protocol==='v2'&&!input.acceptanceContract)throw new Error('project requires a P-prepared v2 Acceptance Contract; pass --contract');const dir=path.join(control(root),'proposals');const n=(await readdir(dir)).filter(x=>/^PROP-\d+\.json$/.test(x)).length+1;let initialAcceptance:Array<{id:string;text:string}>,value:unknown;if(input.acceptanceContract){const contract=(await import('./acceptance-loop.js')).acceptanceContractInputSchema.parse(input.acceptanceContract);if(contract.risk!==input.risk)throw new Error('Proposal risk differs from Acceptance Contract');initialAcceptance=contract.criteria.map(({id,text})=>({id,text}));if(input.criteria?.length&&JSON.stringify(input.criteria)!==JSON.stringify(initialAcceptance.map(item=>item.text)))throw new Error('--ac differs from the v2 Acceptance Contract');value={schema_version:2 as const,proposal_id:`PROP-${n}`,project_id:p.project_id,source:input.source,suggested_goal:input.goal,risk_level:input.risk,priority:input.priority,reason:input.reason,initial_acceptance:initialAcceptance,acceptance_contract:contract,created_at:new Date().toISOString()}}else{if(!input.criteria?.length)throw new Error('Proposal requires --ac or --contract');initialAcceptance=input.criteria.map((text,i)=>({id:`AC-${i+1}`,text}));value={schema_version:1 as const,proposal_id:`PROP-${n}`,project_id:p.project_id,source:input.source,suggested_goal:input.goal,risk_level:input.risk,priority:input.priority,reason:input.reason,initial_acceptance:initialAcceptance,created_at:new Date().toISOString()}}const parsed=proposalSchema.parse(value);assertSubstantive(JSON.stringify(parsed),'proposal');await atomicWriteMany(root,[{file:path.join(dir,`${parsed.proposal_id}.json`),content:JSON.stringify(parsed,null,2)+'\n'}]);return parsed.proposal_id}
export async function approveProposal(root:string,id:string,by:string,ttlHours=24,controllerCommandId?:string):Promise<string>{
  if(!Number.isFinite(ttlHours)||ttlHours<=0||ttlHours>168)throw new Error('approval ttl must be within 0–168 hours');
  if(await (await import('./confirmation-decisions.js')).hasProposalRejection(root,id))throw new Error('proposal was rejected by a current structured decision');
  const effectFile=controllerCommandId?path.join(control(root),'controller-effects',`${controllerCommandId}.json`):null;
  if(effectFile){
    const effectInfo=await lstat(effectFile).catch(()=>null);
    if(effectInfo){
      if(!effectInfo.isFile()||effectInfo.isSymbolicLink())throw new Error('proposal Controller effect marker is invalid');
      const effect=JSON.parse(await readFile(effectFile,'utf8')) as {command_id?:string;proposal_id?:string;approval_id?:string};
      if(effect.command_id!==controllerCommandId||effect.proposal_id!==id||!effect.approval_id)throw new Error('proposal Controller effect marker differs from the command');
      return effect.approval_id;
    }
  }
  const file=path.join(control(root),'proposals',`${id}.json`),raw=await readFile(file,'utf8'),p=proposalSchema.parse(JSON.parse(raw));
  const dir=path.join(control(root),'approvals'),n=(await readdir(dir)).filter(x=>/^APR-\d+\.json$/.test(x)).length+1,approvedAt=new Date();
  const value={schema_version:1 as const,approval_id:`APR-${n}`,proposal_id:id,proposal_hash:sha256(raw),approved_by:by,approved_at:approvedAt.toISOString(),expires_at:new Date(approvedAt.getTime()+ttlHours*3600_000).toISOString(),approved_scope:['create_task','execute_in_worktree'] as Array<'create_task'|'execute_in_worktree'>,risk_level:p.risk_level};
  approvalSchema.parse(value);
  const writes:Array<{file:string;content:string}>=[{file:path.join(dir,`${value.approval_id}.json`),content:JSON.stringify(value,null,2)+'\n'}];
  if(effectFile)writes.push({file:effectFile,content:`${JSON.stringify({schema_version:1,command_id:controllerCommandId,proposal_id:id,approval_id:value.approval_id},null,2)}\n`});
  await atomicWriteMany(root,writes);return value.approval_id;
}
export async function verifyApproval(root:string,proposalId:string,scope:'create_task'|'execute_in_worktree',expectedRisk?:z.infer<typeof risk>):Promise<z.infer<typeof approvalSchema>>{
  if(await (await import('./confirmation-decisions.js')).hasProposalRejection(root,proposalId))throw new Error('proposal approval was invalidated by a current structured rejection');
  const raw=await readFile(path.join(control(root),'proposals',`${proposalId}.json`),'utf8');
  const proposal=proposalSchema.parse(JSON.parse(raw));
  const files=(await readdir(path.join(control(root),'approvals'))).filter(x=>x.endsWith('.json'));
  for(const f of files){
    const approvalRaw=await readFile(path.join(control(root),'approvals',f),'utf8');
    const a=approvalSchema.parse(JSON.parse(approvalRaw));
    if(a.proposal_id===proposalId&&a.proposal_hash===sha256(raw)&&a.approved_scope.includes(scope)&&a.risk_level===proposal.risk_level&&(!expectedRisk||a.risk_level===expectedRisk)&&Date.parse(a.expires_at)>Date.now())return a;
  }
  throw new Error(`proposal has no valid ${scope} approval`);
}
function declaredTaskDependencies(content:string):string[]{
  const line=content.match(/^- 依赖(?:工单|任务)?[：:]\s*(.+)$/m)?.[1];if(!line||/^无(?:$|[，,。；;])/u.test(line.trim()))return[];
  const expanded=line.replace(/((?:WEB-)?TASK-)(\d+)[～~](?:(?:WEB-)?TASK-)?(\d+)/g,(_match,prefix,first,last)=>{
    const start=Number(first),end=Number(last),width=first.length,ids:string[]=[];for(let value=start;value<=end;value+=1)ids.push(`${prefix}${String(value).padStart(width,'0')}`);return ids.join('、');
  });
  return[...new Set(expanded.match(/(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*/g)??[])];
}
export async function unfinishedTaskDependencies(root:string,taskId:string):Promise<string[]>{
  const project=await readProject(root),tasks=await scanTasks(root),item=tasks.find(task=>task.task_id===taskId);if(!item)throw new Error('task not found');
  const spec=(await readMarkdown(path.join(item.path,'SPEC.md'))).data as {target_spec?:string};if(!spec.target_spec)return[];
  const repository=path.resolve(project.repository),target=path.resolve(repository,spec.target_spec);
  if(target!==repository&&!target.startsWith(`${repository}${path.sep}`))throw new Error('target spec path escapes the repository');
  const info=await lstat(target).catch(()=>null);if(!info)return[];if(!info.isFile()||info.isSymbolicLink())throw new Error('target spec path is invalid');
  const dependencies=declaredTaskDependencies(await readFile(target,'utf8')),byId=new Map(tasks.map(task=>[task.task_id,task.status]));
  return dependencies.filter(id=>byId.has(id)&&!['delivered','cancelled'].includes(byId.get(id) as string));
}
export async function verifyTaskDependencies(root:string,taskId:string):Promise<void>{
  const unfinished=await unfinishedTaskDependencies(root,taskId);if(unfinished.length)throw new Error(`${taskId}: blocked by unfinished dependencies: ${unfinished.join(', ')}`);
}
export async function verifyTaskExecutionApproval(root:string,taskId:string):Promise<void>{const item=(await scanTasks(root)).find(x=>x.task_id===taskId);if(!item)throw new Error('task not found');await verifyTaskDependencies(root,taskId);const spec=(await readMarkdown(path.join(item.path,'SPEC.md'))).data as {proposal_id?:string;level?:z.infer<typeof risk>},state=await readState(item.path);if(!spec.proposal_id)throw new Error('task is not bound to an approved proposal');if(spec.level!==state.level)throw new Error(`Task level mismatch: SPEC.md=${spec.level??'missing'}, TASK_STATE.md=${state.level}`);await verifyApproval(root,spec.proposal_id,'execute_in_worktree',state.level)}
function normalizeCriterion(value:string):string{return value.trim().replace(/[；。.]$/u,'').trim()}

function adoptTargetTask(content:string,taskId:string,title:string,proposalId:string,taskPath:string,level:z.infer<typeof risk>,criteria:Array<{id:string;text:string}>,protocol:TaskProtocol):string{
  const heading=content.match(/^# ([^：:]+)[：:]\s*(.+)$/m);
  if(!heading||heading[1]!==taskId||heading[2].trim()!==title)throw new Error('existing target task ID or title differs from requested task');
  if(!/^- 状态：草稿$/m.test(content))throw new Error('only a draft target task may be adopted');
  if(/^- (?:Spec-Loop Task|Proposal)：/m.test(content))throw new Error('existing target task is already bound');
  const existing=[...content.matchAll(/^- \[ \] (AC-[1-9]\d*)[：:]\s*(.+)$/gm)].map(x=>({id:x[1],text:normalizeCriterion(x[2])}));
  const approved=criteria.map(x=>({id:x.id,text:normalizeCriterion(x.text)}));
  if(JSON.stringify(existing)!==JSON.stringify(approved))throw new Error('existing target task acceptance differs from approved proposal');
  return content
    .replace(/^- 风险等级：(?:light|standard|heavy)\n/m,'')
    .replace(/^- 状态：草稿$/m,`- 状态：已批准\n- 风险等级：${level}\n- Spec-Loop Task：${taskPath}\n- Proposal：${proposalId}\n- 协议版本：${protocol==='v2'?'P/M/V/R v2':'v1'}`);
}

export async function createTaskFromProposal(root:string,proposalId:string,taskId:string,title:string,adoptExisting=false):Promise<string>{const approval=await verifyApproval(root,proposalId,'create_task');const p=proposalSchema.parse(JSON.parse(await readFile(path.join(control(root),'proposals',`${proposalId}.json`),'utf8'))),project=await readProject(root),bundle=await loadTargetSpecBundle(project.spec_profile);await initTargetSpecLibrary(root);await recoverCrossRootTransactions(root,[root,project.repository]);const isWeb=taskId.startsWith('WEB-TASK-'),targetRoot=isWeb?bundle.frontend_task_root:bundle.backend_task_root;if(!targetRoot)throw new Error(`${taskId}: ${project.spec_profile} profile has no ${isWeb?'frontend':'backend'} task library`);const targetTask=path.resolve(project.repository,targetRoot,`${taskId}.md`),taskRoot=path.resolve(root,project.tasks_root,taskId.toLowerCase());if(await exists(path.join(taskRoot,'TASK_STATE.md')))throw new Error('task already exists in control root');const targetExists=await exists(targetTask);if(targetExists&&!adoptExisting)throw new Error('target task already exists; pass --adopt-existing to bind an approved draft');if(!targetExists&&adoptExisting)throw new Error('cannot adopt a missing target task');await mkdir(path.join(taskRoot,'ROUNDS'),{recursive:true});await mkdir(path.join(taskRoot,'evidence'),{recursive:true});const base=initialFiles({id:taskId,title,level:p.risk_level,repository:project.repository}).map(x=>({file:path.join(taskRoot,x.file),content:x.content}));const spec=stringifyMarkdown({schema_version:1,task_id:taskId,title,level:p.risk_level,target_spec:path.relative(project.repository,targetTask),proposal_id:proposalId},`# Goal\n\n${p.suggested_goal}\n\n## Scope\n\nImplement the approved proposal.\n\n## Non-goals\n\nDo not exceed the approved proposal scope.`),acceptance=stringifyMarkdown({schema_version:1,task_id:taskId,criteria:p.initial_acceptance,human_reviews:[],web_gates:[]},'# Acceptance Contract\n\nCreated from an approved proposal. UI or visual tasks must add a required visual review; Web functional tasks must add a required Playwright Gate before planning.'),ac=p.initial_acceptance.map(x=>`- [ ] ${x.id}：${x.text}`).join('\n'),taskPath=path.relative(project.repository,taskRoot),target=targetExists?adoptTargetTask(await readFile(targetTask,'utf8'),taskId,title,proposalId,taskPath,p.risk_level,p.initial_acceptance,p.schema_version===2?'v2':'v1'):`# ${taskId}：${title}\n\n- 状态：已批准\n- 风险等级：${p.risk_level}\n- Spec-Loop Task：${taskPath}\n- Proposal：${proposalId}\n- 协议版本：${p.schema_version===2?'P/M/V/R v2':'v1'}\n\n## 目标\n\n${p.suggested_goal}\n\n## 验收标准\n\n${ac}\n\n## 验证范围\n\n- 层级：Task 增量验证\n- 所属波次：独立 Task\n- 只覆盖：本 Task AC、改动模块和直接依赖\n- 不覆盖：已交付兄弟 Task 的完整 Gate；波次全量回归由最终 Heavy Task 统一执行一次\n\n## 交付记录\n\n任务 Delivery 后回写 Round、Evidence 和 revision。\n`;const writes=base.filter(x=>!x.file.endsWith('/SPEC.md')&&!x.file.endsWith('/ACCEPTANCE.md'));writes.push({file:path.join(taskRoot,'SPEC.md'),content:spec},{file:path.join(taskRoot,'ACCEPTANCE.md'),content:acceptance},{file:targetTask,content:target});if(p.schema_version===2){const contract=(await import('./acceptance-loop.js')).acceptanceContractInputSchema.parse(p.acceptance_contract);if(contract.task_id!==taskId)throw new Error('Task ID differs from the approved v2 Acceptance Contract');const approved=(await import('./acceptance-loop.js')).approvedAcceptanceContractValue(contract,approval.approved_by,approval.approved_at);writes.push({file:path.join(taskRoot,'ACCEPTANCE_CONTRACT_V2.md'),content:stringifyMarkdown(approved,'# Acceptance Contract v2\n\nP prepared this contract inside the Proposal; human approval binds the complete Proposal and contract hash.')})}await atomicWriteAcrossRoots(root,[root,project.repository],writes);return taskRoot}

async function processProbe(bin:string,args:string[],timeoutMs=15_000):Promise<{code:number;output:string}>{const locale=[process.env.LC_ALL,process.env.LANG].find(value=>value&&/utf-?8/i.test(value))??'en_US.UTF-8',result=await runManagedProcess({bin,args,timeoutMs,pipeDrainTimeoutMs:1_000,maxCaptureBytes:64_000,env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp',LANG:locale,LC_ALL:locale,...(process.env.JAVA_HOME?{JAVA_HOME:process.env.JAVA_HOME}:{})}});return{code:result.code,output:result.timedOut?`probe timed out after ${timeoutMs}ms`:(`${result.stdout}${result.stderr}`).trim()}}
async function resolveExecutable(bin:string):Promise<string>{if(path.isAbsolute(bin)){await access(bin);return bin}return new Promise<string>((resolve,reject)=>{const child=spawn('/usr/bin/env',['which',bin],{stdio:['ignore','pipe','ignore']});let output='',settled=false;const timer=setTimeout(()=>{if(settled)return;settled=true;child.kill('SIGKILL');reject(new Error('executable lookup timed out'))},5_000);child.stdout.on('data',chunk=>output+=chunk);child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);code===0&&output.trim()?resolve(output.trim().split(/\r?\n/)[0]):reject(new Error('missing'))});child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error)})})}
async function declaredJavaMajor(repository:string):Promise<number|null>{
  const values:number[]=[];
  for(const file of ['pom.xml','build.gradle','build.gradle.kts']){
    const content=await readFile(path.join(repository,file),'utf8').catch(()=>null);if(!content)continue;
    const patterns=file==='pom.xml'
      ? [/<java\.version>\s*(\d+)\s*<\/java\.version>/gi,/<maven\.compiler\.(?:release|target|source)>\s*(\d+)\s*<\/maven\.compiler\.(?:release|target|source)>/gi,/<release>\s*(\d+)\s*<\/release>/gi]
      : [/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g,/languageVersion\s*=\s*JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g,/sourceCompatibility\s*=\s*(?:JavaVersion\.VERSION_)?(\d+)/g];
    for(const pattern of patterns)for(const match of content.matchAll(pattern)){const value=Number(match[1]);if(Number.isInteger(value)&&value>0)values.push(value)}
  }
  return values.length?Math.max(...values):null;
}
function runtimeJavaMajor(output:string):number|null{const match=output.match(/(?:version\s+"|openjdk\s+)(?:1\.)?(\d+)/i);return match?Number(match[1]):null}
export async function providerDoctor(root:string){
  const cfg=await readProviderConfig(root),results=[];
  for(const [id,p] of Object.entries(cfg.providers)){
    let available=true,compatible=true,resolved:string|null=null,version:string|null=null,reason:string|null=null;
    try{
      resolved=await resolveExecutable(p.executable);
      if(id==='codex'&&path.basename(resolved)==='codex'){
        const versionProbe=await processProbe(resolved,['--version']);version=versionProbe.output||null;
        const compatibility=await processProbe(resolved,[...p.args,'--help']);
        if(compatibility.code!==0){compatible=false;reason=`Codex Adapter arguments are incompatible: ${compatibility.output.slice(0,500)||`exit ${compatibility.code}`}`}
      }
    }catch(error){available=false;compatible=false;reason=`executable unavailable: ${(error as Error).message}`}
    const roles=(['M','V','R'] as const).filter(role=>(cfg.role_providers?.[role]??cfg.active_provider)===id);
    results.push({id,enabled:p.enabled,active:id===cfg.active_provider,roles,executable:p.executable,resolved,available,compatible,version,reason});
  }
  return results;
}

export async function verifyExecutionPreflight(root:string,taskId:string,options:{requireProvider?:boolean}={}):Promise<void>{
  const item=(await scanTasks(root)).find(task=>task.task_id===taskId);if(!item)throw new Error('task not found');
  await verifyTaskExecutionApproval(root,taskId);
  const state=await readState(item.path),config=await (await import('./execution.js')).readGateConfig(root);
  if(state.level==='heavy'&&(config.coverage!=='full'||config.scope_kind!=='wave'))throw new Error('Heavy Task requires at least one wave/full Gate before M starts; set scope_kind=wave and coverage=full');
  if(state.level==='heavy'&&!config.gates.some(gate=>gate.evidence_class==='mutation'&&gate.stability_runs>=2))throw new Error('Heavy Task requires a mutation-class Gate with stability_runs >= 2 before M starts');
  if(state.level!=='heavy'&&config.coverage==='full')throw new Error(`${state.level} Task conflicts with full verification; use coverage=targeted or change the approved Task level to heavy`);
  if(options.requireProvider!==false){const providers=await providerDoctor(root),cfg=await readProviderConfig(root);
    for(const role of ['M','V','R'] as const){const id=providerForRole(cfg,role).id,provider=providers.find(item=>item.id===id);
      if(!provider?.available||!provider.compatible)throw new Error(`${role} Provider ${id} preflight failed: ${provider?.reason??'provider unavailable'}`);}}
  const project=await readProject(root);
  for(const gate of config.gates){
    const executable=gate.kind==='playwright'?'node':gate.command[0];
    if(executable.startsWith('./')||executable.startsWith('../')){
      const target=path.resolve(project.repository,executable),repository=path.resolve(project.repository);
      if(target!==repository&&!target.startsWith(`${repository}${path.sep}`))throw new Error(`Gate ${gate.id} executable escapes the repository: ${executable}`);
      const info=await lstat(target).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink())throw new Error(`Gate ${gate.id} requires missing or unsafe executable ${executable}`);
      try{await access(target,process.platform==='win32'?0:1)}catch{throw new Error(`Gate ${gate.id} executable is not runnable: ${executable}`)}
      continue;
    }
    try{await resolveExecutable(executable)}catch{throw new Error(`Gate ${gate.id} requires unavailable executable ${executable}; install/configure it and rerun project doctor`)}
  }
  const buildFiles=['pom.xml','build.gradle','build.gradle.kts'];
  if((await Promise.all(buildFiles.map(file=>lstat(path.join(project.repository,file)).then(()=>true).catch(()=>false)))).some(Boolean)){
    let java:string;try{java=await resolveExecutable('java')}catch{throw new Error('Java project requires java, but it is unavailable in the managed PATH; configure JAVA_HOME/PATH before starting M')}
    const probe=await processProbe(java,['-version']),actual=runtimeJavaMajor(probe.output),required=await declaredJavaMajor(project.repository);
    if(probe.code!==0||actual===null)throw new Error('Java runtime preflight failed; run java -version and configure JAVA_HOME/PATH before starting M');
    if(required!==null&&actual<required)throw new Error(`Java ${required}+ is required by the project, but managed PATH resolves Java ${actual}; configure JAVA_HOME/PATH and rerun java -version before starting M`);
  }
}
