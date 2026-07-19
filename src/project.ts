import { access, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteAcrossRoots, atomicWriteMany, assertSubstantive, exists, readMarkdown, recoverCrossRootTransactions, sha256, stringifyMarkdown } from './files.js';
import { readState } from './task.js';
import { initialFiles } from './templates.js';
import { containsRealPlaceholder, loadTargetSpecTemplate } from './target-spec.js';

const risk = z.enum(['light', 'standard', 'heavy']);
export const projectSchema = z.object({ schema_version:z.literal(1), project_id:z.string().regex(/^PROJ-[A-Z0-9-]+$/), name:z.string().min(2), repository:z.string().min(1), spec_root:z.string().min(1).default('spec'), default_branch:z.string().min(1), tasks_root:z.string().min(1), output_root:z.string().min(1), risk_level:risk, external_issue:z.string().nullable(), created_at:z.iso.datetime(), updated_at:z.iso.datetime() }).strict();
export const projectStateSchema = z.object({ schema_version:z.literal(1), project_id:z.string(), state_version:z.number().int().positive(), current_goal:z.string(), next_action:z.string(), candidates:z.array(z.string()), ignored:z.array(z.object({ item:z.string(), reason:z.string() }).strict()), updated_at:z.iso.datetime() }).strict();
export const providerConfigSchema = z.object({ schema_version:z.literal(1), active_provider:z.enum(['codex','claude-code','qoder']), providers:z.object({ codex:z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict(), 'claude-code':z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict(), qoder:z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict() }).strict() }).strict();
const proposalSchema = z.object({ schema_version:z.literal(1), proposal_id:z.string().regex(/^PROP-[1-9]\d*$/), project_id:z.string(), source:z.string().min(3), suggested_goal:z.string().min(3), risk_level:risk, priority:z.enum(['P0','P1','P2','P3']), reason:z.string().min(3), initial_acceptance:z.array(z.object({id:z.string().regex(/^AC-[1-9]\d*$/),text:z.string().min(3)}).strict()).min(1), created_at:z.iso.datetime() }).strict();
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
  const project=await readProject(root),resolved=resolveSpecRoot(project.repository,project.spec_root),template=await loadTargetSpecTemplate(),created:string[]=[],preserved:string[]=[],writes=[];
  await assertRealDirectoryChain(resolved.repo,resolved.specRoot,'spec_root');
  const dirs=[...new Set(template.assets.map(item=>path.dirname(path.join(resolved.specRoot,item.path))))];
  for(const dir of dirs){if(await entryExists(dir)){const info=await lstat(dir);if(info.isSymbolicLink()||!info.isDirectory())throw new Error(`target spec directory must be a real directory: ${path.relative(resolved.repo,dir)}`)}}
  for(const item of template.assets){const file=path.join(resolved.specRoot,item.path);if(await entryExists(file))preserved.push(file);else{created.push(file);writes.push({file,content:item.content})}}
  for(const dir of dirs)await mkdir(dir,{recursive:true});
  if(writes.length)await atomicWriteMany(resolved.repo,writes);
  return {created,preserved};
}

export async function checkTargetSpecLibrary(root:string):Promise<{ok:boolean;errors:string[]} >{
  const project=await readProject(root),errors:string[]=[];
  let repo:string,specRoot:string;
  try{({repo,specRoot}=resolveSpecRoot(project.repository,project.spec_root))}catch(error){errors.push((error as Error).message);return {ok:false,errors}}
  const template=await loadTargetSpecTemplate();
  try{await assertRealDirectoryChain(repo,specRoot,'spec_root')}catch(error){errors.push((error as Error).message);return {ok:false,errors}}
  const invalidAssetDirs=new Set<string>();
  const assetDirs=new Set(template.assets.map(item=>path.dirname(path.join(specRoot,item.path))));
  for(const dir of assetDirs){
    if(dir===specRoot||!(await entryExists(dir)))continue;
    const info=await lstat(dir);
    if(info.isSymbolicLink()||!info.isDirectory()){errors.push(`target spec layer must be a real directory: ${path.relative(repo,dir)}`);invalidAssetDirs.add(dir)}
  }
  for(const item of template.assets){
    const file=path.join(specRoot,item.path);
    if(invalidAssetDirs.has(path.dirname(file)))continue;
    if(!(await entryExists(file))){errors.push(`missing target spec file: ${path.relative(repo,file)}`);continue}
    const info=await lstat(file);
    if(info.isSymbolicLink()||!info.isFile()){errors.push(`target spec file must be a regular file and may not be a symbolic link: ${path.relative(repo,file)}`);continue}
    const content=await readFile(file,'utf8');
    if(content.trim().length<20)errors.push(`empty target spec file: ${path.relative(repo,file)}`);
    if(item.check_placeholders&&containsRealPlaceholder(content))errors.push(`placeholder content in target spec file: ${path.relative(repo,file)}`);
  }
  const layers=[
    {dir:'01-product',id:/^PROD-[0-9]{3}$/,heading:/^# (PROD-[^：:\s]+)[：:]/m,trace:/^- Roadmap：.*roadmap\.md/m},
    {dir:'02-feature',id:/^FEAT-[0-9]{3}$/,heading:/^# (FEAT-[^：:\s]+)[：:]/m,trace:/^- 所属产品：.*\b(PROD-[0-9]{3})\b/m},
    {dir:'03-design',id:/^DES-[0-9]{3}$/,heading:/^# (DES-[^：:\s]+)[：:]/m,trace:/^- 所属特性：.*\b(FEAT-[0-9]{3})\b/m},
    {dir:'04-task',id:/^TASK-(?:[0-9]{3}|[A-Z0-9]+(?:-[A-Z0-9]+)*)$/,heading:/^# (TASK-[^：:\s]+)[：:]/m,trace:/^- 所属设计：.*\b(DES-[0-9]{3})\b/m},
  ];
  const statuses=new Set(['草稿','已批准','进行中','待验证','已完成','已取消']);
  const documents:Array<{id:string;dir:string;file:string;content:string}>=[];
  for(const config of layers){
    const layer=path.join(specRoot,config.dir);
    if(!(await entryExists(layer)))continue;
    if(invalidAssetDirs.has(layer))continue;
    const layerInfo=await lstat(layer);
    if(layerInfo.isSymbolicLink()||!layerInfo.isDirectory()){errors.push(`target spec layer must be a real directory: ${path.relative(repo,layer)}`);continue}
    for(const name of await readdir(layer)){
      if(name==='_template.md'||!name.endsWith('.md'))continue;
      const file=path.join(layer,name),info=await lstat(file);
      if(info.isSymbolicLink()||!info.isFile()){errors.push(`target spec must be a regular file and may not be a symbolic link: ${path.relative(repo,file)}`);continue}
      const content=await readFile(file,'utf8'),heading=content.match(config.heading),id=heading?.[1];
      if(!id||!config.id.test(id))errors.push(`invalid or missing target spec ID: ${path.relative(repo,file)}`);
      const stem=name.slice(0,-3),suffix=id&&stem.startsWith(`${id}-`)?stem.slice(id.length+1):null;
      const validFilename=Boolean(id&&(stem===id||(suffix!==null&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suffix))));
      if(!validFilename)errors.push(`invalid target spec filename or ID mismatch: ${path.relative(repo,file)}`);
      if(id&&config.id.test(id)&&validFilename)documents.push({id,dir:config.dir,file,content});
      const status=content.match(/^- 状态：(.+)$/m)?.[1]?.trim();
      if(!status||!statuses.has(status))errors.push(`invalid or missing target spec status: ${path.relative(repo,file)}`);
      if(containsRealPlaceholder(content))errors.push(`placeholder content in target spec: ${path.relative(repo,file)}`);
    }
  }
  const ids=new Set(documents.map(x=>x.id));
  for(const doc of documents){
    const config=layers.find(x=>x.dir===doc.dir)!;
    const proposalTask=doc.dir==='04-task'&&/^- Proposal：PROP-[1-9]\d*$/m.test(doc.content);
    if(doc.dir==='01-product'){
      if(!config.trace.test(doc.content))errors.push(`missing upstream trace in target spec: ${path.relative(repo,doc.file)}`);
    }else if(!proposalTask){
      const ref=doc.content.match(config.trace)?.[1];
      if(!ref)errors.push(`missing upstream trace in target spec: ${path.relative(repo,doc.file)}`);
      else if(!ids.has(ref))errors.push(`broken upstream trace ${ref} in target spec: ${path.relative(repo,doc.file)}`);
    }
    if(proposalTask&&!/^- Spec-Loop Task：\S.+$/m.test(doc.content))errors.push(`proposal task missing Spec-Loop Task trace: ${path.relative(repo,doc.file)}`);
  }
  return {ok:errors.length===0,errors};
}

export async function initProject(root:string,input:{id:string;name:string;repository:string;branch:string;risk:z.infer<typeof risk>}):Promise<void>{
  const c=control(root); if(await exists(path.join(c,'PROJECT.md')))throw new Error('project already initialized');
  await access(input.repository); const now=new Date().toISOString();
  const project={schema_version:1 as const,project_id:input.id,name:input.name,repository:path.resolve(input.repository),spec_root:'spec',default_branch:input.branch,tasks_root:'.spec-loop/tasks',output_root:'.spec-loop/output',risk_level:input.risk,external_issue:null,created_at:now,updated_at:now};
  const state={schema_version:1 as const,project_id:input.id,state_version:1,current_goal:'Not set',next_action:'Run manual triage or create an approved task',candidates:[],ignored:[],updated_at:now};
  const config={schema_version:1 as const,active_provider:'codex' as const,providers:{codex:{enabled:true,executable:'codex',args:['exec','--json','--sandbox','workspace-write','--ephemeral'],timeout_seconds:1800},'claude-code':{enabled:false,executable:'claude',args:[],timeout_seconds:1800},qoder:{enabled:false,executable:'qoder',args:[],timeout_seconds:1800}}};
  projectSchema.parse(project);projectStateSchema.parse(state);providerConfigSchema.parse(config);
  await mkdir(path.join(c,'tasks'),{recursive:true});await mkdir(path.join(c,'proposals'),{recursive:true});await mkdir(path.join(c,'approvals'),{recursive:true});await mkdir(path.join(c,'output'),{recursive:true});
  await atomicWriteMany(root,[{file:path.join(c,'PROJECT.md'),content:stringifyMarkdown(project,'# Project\n\nProject metadata is CLI-managed.')},{file:path.join(c,'PROJECT_STATE.md'),content:stringifyMarkdown(state,'# Project State\n\nTask summaries are derived, not authoritative.')},{file:path.join(c,'PROVIDERS.md'),content:stringifyMarkdown(config,'# Providers\n\nDefault provider: Codex.')}]);
  await initTargetSpecLibrary(root);
}
export async function readProject(root:string){const doc=await readMarkdown(path.join(control(root),'PROJECT.md'));return projectSchema.parse(doc.data)}
export async function readProjectState(root:string){return projectStateSchema.parse((await readMarkdown(path.join(control(root),'PROJECT_STATE.md'))).data)}
export async function readProviderConfig(root:string){const cfg=providerConfigSchema.parse((await readMarkdown(path.join(control(root),'PROVIDERS.md'))).data);if(!cfg.providers[cfg.active_provider].enabled)throw new Error('active provider is disabled');return cfg}
export async function setActiveProvider(root:string,id:'codex'|'claude-code'|'qoder'):Promise<void>{const doc=await readMarkdown(path.join(control(root),'PROVIDERS.md'));const cfg=providerConfigSchema.parse(doc.data);if(!cfg.providers[id].enabled)throw new Error(`${id} provider is disabled`);const updated={...cfg,active_provider:id};await atomicWriteMany(root,[{file:path.join(control(root),'PROVIDERS.md'),content:stringifyMarkdown(updated,doc.body)}])}

export interface TaskIndex {task_id:string;path:string;project_id:string;status:string;level:string;round:number;state_version:number;resumable:boolean}
export async function scanTasks(root:string):Promise<TaskIndex[]>{const project=await readProject(root);const dir=path.resolve(root,project.tasks_root);const out:TaskIndex[]=[];for(const entry of (await readdir(dir,{withFileTypes:true}))){if(!entry.isDirectory())continue;const taskRoot=path.join(dir,entry.name);if(!(await exists(path.join(taskRoot,'TASK_STATE.md'))))continue;const s=await readState(taskRoot);out.push({task_id:s.task_id,path:taskRoot,project_id:project.project_id,status:s.status,level:s.level,round:s.current_round,state_version:s.state_version,resumable:['planned','working','verifying','iterating'].includes(s.status)})}const ids=out.map(x=>x.task_id);if(new Set(ids).size!==ids.length)throw new Error('duplicate task ID in project');return out.sort((a,b)=>a.task_id.localeCompare(b.task_id))}

export async function createProposal(root:string,input:{source:string;goal:string;risk:z.infer<typeof risk>;priority:'P0'|'P1'|'P2'|'P3';reason:string;criteria:string[]}):Promise<string>{const p=await readProject(root);const dir=path.join(control(root),'proposals');const n=(await readdir(dir)).filter(x=>/^PROP-\d+\.json$/.test(x)).length+1;const value={schema_version:1 as const,proposal_id:`PROP-${n}`,project_id:p.project_id,source:input.source,suggested_goal:input.goal,risk_level:input.risk,priority:input.priority,reason:input.reason,initial_acceptance:input.criteria.map((text,i)=>({id:`AC-${i+1}`,text})),created_at:new Date().toISOString()};proposalSchema.parse(value);assertSubstantive(JSON.stringify(value),'proposal');await atomicWriteMany(root,[{file:path.join(dir,`${value.proposal_id}.json`),content:JSON.stringify(value,null,2)+'\n'}]);return value.proposal_id}
export async function approveProposal(root:string,id:string,by:string,ttlHours=24):Promise<string>{if(!Number.isFinite(ttlHours)||ttlHours<=0||ttlHours>168)throw new Error('approval ttl must be within 0–168 hours');const file=path.join(control(root),'proposals',`${id}.json`),raw=await readFile(file,'utf8'),p=proposalSchema.parse(JSON.parse(raw)),dir=path.join(control(root),'approvals'),n=(await readdir(dir)).filter(x=>/^APR-\d+\.json$/.test(x)).length+1,approvedAt=new Date(),value={schema_version:1 as const,approval_id:`APR-${n}`,proposal_id:id,proposal_hash:sha256(raw),approved_by:by,approved_at:approvedAt.toISOString(),expires_at:new Date(approvedAt.getTime()+ttlHours*3600_000).toISOString(),approved_scope:['create_task','execute_in_worktree'] as Array<'create_task'|'execute_in_worktree'>,risk_level:p.risk_level};approvalSchema.parse(value);await atomicWriteMany(root,[{file:path.join(dir,`${value.approval_id}.json`),content:JSON.stringify(value,null,2)+'\n'}]);return value.approval_id}
export async function verifyApproval(root:string,proposalId:string,scope:'create_task'|'execute_in_worktree',expectedRisk?:z.infer<typeof risk>):Promise<void>{
  const raw=await readFile(path.join(control(root),'proposals',`${proposalId}.json`),'utf8');
  const proposal=proposalSchema.parse(JSON.parse(raw));
  const files=(await readdir(path.join(control(root),'approvals'))).filter(x=>x.endsWith('.json'));
  for(const f of files){
    const approvalRaw=await readFile(path.join(control(root),'approvals',f),'utf8');
    const a=approvalSchema.parse(JSON.parse(approvalRaw));
    if(a.proposal_id===proposalId&&a.proposal_hash===sha256(raw)&&a.approved_scope.includes(scope)&&a.risk_level===proposal.risk_level&&(!expectedRisk||a.risk_level===expectedRisk)&&Date.parse(a.expires_at)>Date.now())return;
  }
  throw new Error(`proposal has no valid ${scope} approval`);
}
export async function verifyTaskExecutionApproval(root:string,taskId:string):Promise<void>{const item=(await scanTasks(root)).find(x=>x.task_id===taskId);if(!item)throw new Error('task not found');const spec=(await readMarkdown(path.join(item.path,'SPEC.md'))).data as {proposal_id?:string;level?:z.infer<typeof risk>};if(!spec.proposal_id)throw new Error('task is not bound to an approved proposal');await verifyApproval(root,spec.proposal_id,'execute_in_worktree',spec.level)}
function normalizeCriterion(value:string):string{return value.trim().replace(/[；。.]$/u,'').trim()}

function adoptTargetTask(content:string,taskId:string,title:string,proposalId:string,taskPath:string,level:z.infer<typeof risk>,criteria:Array<{id:string;text:string}>):string{
  const heading=content.match(/^# ([^：:]+)[：:]\s*(.+)$/m);
  if(!heading||heading[1]!==taskId||heading[2].trim()!==title)throw new Error('existing target task ID or title differs from requested task');
  if(!/^- 状态：草稿$/m.test(content))throw new Error('only a draft target task may be adopted');
  if(/^- (?:Spec-Loop Task|Proposal)：/m.test(content))throw new Error('existing target task is already bound');
  const existing=[...content.matchAll(/^- \[ \] (AC-[1-9]\d*)[：:]\s*(.+)$/gm)].map(x=>({id:x[1],text:normalizeCriterion(x[2])}));
  const approved=criteria.map(x=>({id:x.id,text:normalizeCriterion(x.text)}));
  if(JSON.stringify(existing)!==JSON.stringify(approved))throw new Error('existing target task acceptance differs from approved proposal');
  return content
    .replace(/^- 风险等级：(?:light|standard|heavy)\n/m,'')
    .replace(/^- 状态：草稿$/m,`- 状态：已批准\n- 风险等级：${level}\n- Spec-Loop Task：${taskPath}\n- Proposal：${proposalId}`);
}

export async function createTaskFromProposal(root:string,proposalId:string,taskId:string,title:string,adoptExisting=false):Promise<string>{await verifyApproval(root,proposalId,'create_task');const p=proposalSchema.parse(JSON.parse(await readFile(path.join(control(root),'proposals',`${proposalId}.json`),'utf8'))),project=await readProject(root);await initTargetSpecLibrary(root);await recoverCrossRootTransactions(root,[root,project.repository]);const targetTask=path.resolve(project.repository,project.spec_root,'04-task',`${taskId}.md`),taskRoot=path.resolve(root,project.tasks_root,taskId.toLowerCase());if(await exists(path.join(taskRoot,'TASK_STATE.md')))throw new Error('task already exists in control root');const targetExists=await exists(targetTask);if(targetExists&&!adoptExisting)throw new Error('target task already exists; pass --adopt-existing to bind an approved draft');if(!targetExists&&adoptExisting)throw new Error('cannot adopt a missing target task');await mkdir(path.join(taskRoot,'ROUNDS'),{recursive:true});await mkdir(path.join(taskRoot,'evidence'),{recursive:true});const base=initialFiles({id:taskId,title,level:p.risk_level,repository:project.repository}).map(x=>({file:path.join(taskRoot,x.file),content:x.content}));const spec=stringifyMarkdown({schema_version:1,task_id:taskId,title,level:p.risk_level,target_spec:path.relative(project.repository,targetTask),proposal_id:proposalId},`# Goal\n\n${p.suggested_goal}\n\n## Scope\n\nImplement the approved proposal.\n\n## Non-goals\n\nDo not exceed the approved proposal scope.`),acceptance=stringifyMarkdown({schema_version:1,task_id:taskId,criteria:p.initial_acceptance},'# Acceptance Contract\n\nCreated from an approved proposal.'),ac=p.initial_acceptance.map(x=>`- [ ] ${x.id}：${x.text}`).join('\n'),taskPath=path.relative(project.repository,taskRoot),target=targetExists?adoptTargetTask(await readFile(targetTask,'utf8'),taskId,title,proposalId,taskPath,p.risk_level,p.initial_acceptance):`# ${taskId}：${title}\n\n- 状态：已批准\n- 风险等级：${p.risk_level}\n- Spec-Loop Task：${taskPath}\n- Proposal：${proposalId}\n\n## 目标\n\n${p.suggested_goal}\n\n## 验收标准\n\n${ac}\n\n## 交付记录\n\n任务 Delivery 后回写 Round、Evidence 和 revision。\n`;const writes=base.filter(x=>!x.file.endsWith('/SPEC.md')&&!x.file.endsWith('/ACCEPTANCE.md'));writes.push({file:path.join(taskRoot,'SPEC.md'),content:spec},{file:path.join(taskRoot,'ACCEPTANCE.md'),content:acceptance},{file:targetTask,content:target});await atomicWriteAcrossRoots(root,[root,project.repository],writes);return taskRoot}

export async function providerDoctor(root:string){const cfg=await readProviderConfig(root);const results=[];for(const [id,p] of Object.entries(cfg.providers)){let available=true;try{await accessExecutable(p.executable)}catch{available=false}results.push({id,enabled:p.enabled,active:id===cfg.active_provider,executable:p.executable,available})}return results}
async function accessExecutable(bin:string){return new Promise<void>((resolve,reject)=>{const child=spawn('/usr/bin/env',['which',bin]);child.on('close',c=>c===0?resolve():reject(new Error('missing')));child.on('error',reject)})}
