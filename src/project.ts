import { access, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteAcrossRoots, atomicWriteMany, assertSubstantive, exists, readMarkdown, recoverCrossRootTransactions, sha256, stringifyMarkdown } from './files.js';
import { readState } from './task.js';
import { initialFiles } from './templates.js';

const risk = z.enum(['light', 'standard', 'heavy']);
export const projectSchema = z.object({ schema_version:z.literal(1), project_id:z.string().regex(/^PROJ-[A-Z0-9-]+$/), name:z.string().min(2), repository:z.string().min(1), spec_root:z.string().min(1).default('spec'), default_branch:z.string().min(1), tasks_root:z.string().min(1), output_root:z.string().min(1), risk_level:risk, external_issue:z.string().nullable(), created_at:z.iso.datetime(), updated_at:z.iso.datetime() }).strict();
export const projectStateSchema = z.object({ schema_version:z.literal(1), project_id:z.string(), state_version:z.number().int().positive(), current_goal:z.string(), next_action:z.string(), candidates:z.array(z.string()), ignored:z.array(z.object({ item:z.string(), reason:z.string() }).strict()), updated_at:z.iso.datetime() }).strict();
export const providerConfigSchema = z.object({ schema_version:z.literal(1), active_provider:z.enum(['codex','claude-code','qoder']), providers:z.object({ codex:z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict(), 'claude-code':z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict(), qoder:z.object({enabled:z.boolean(),executable:z.string(),args:z.array(z.string()),timeout_seconds:z.number().int().positive()}).strict() }).strict() }).strict();
const proposalSchema = z.object({ schema_version:z.literal(1), proposal_id:z.string().regex(/^PROP-[1-9]\d*$/), project_id:z.string(), source:z.string().min(3), suggested_goal:z.string().min(3), risk_level:risk, priority:z.enum(['P0','P1','P2','P3']), reason:z.string().min(3), initial_acceptance:z.array(z.object({id:z.string().regex(/^AC-[1-9]\d*$/),text:z.string().min(3)}).strict()).min(1), created_at:z.iso.datetime() }).strict();
const approvalSchema = z.object({ schema_version:z.literal(1), approval_id:z.string().regex(/^APR-[1-9]\d*$/), proposal_id:z.string(), proposal_hash:z.string().length(64), approved_by:z.string().min(2), approved_at:z.iso.datetime(), expires_at:z.iso.datetime(), approved_scope:z.array(z.enum(['create_task','execute_in_worktree'])).min(1), risk_level:risk }).strict();

const control=(root:string)=>path.join(root,'.spec-loop');
const targetSpecFiles=(name:string)=>[
  {file:'README.md',content:`# ${name} 规格库\n\n本目录是目标工程自身的产品、特性、设计、任务与验证事实源。Spec-Loop 的运行状态保存在项目控制目录，不能替代这里的业务规格。\n\n## 追踪链\n\n\`roadmap → product → feature → design → task → evidence/delivery\`\n`},
  {file:'roadmap.md',content:`# ${name} Roadmap\n\n## 当前阶段\n\n- 规格库已初始化，尚未批准产品实施阶段。\n\n## 变更规则\n\n所有工程任务必须关联本规格库中的 Product、Feature、Design 或 Task，并在交付后回写实际结果。\n`},
  {file:'pending-board.md',content:'# 待完成任务看板\n\n当前无已批准工单。看板是可重建视图，不是状态事实源。\n'},
  {file:'verification-board.md',content:'# 验证看板\n\n当前无等待独立验证的工单。\n'},
  {file:'01-product/_template.md',content:'# PROD-NNN：产品规格标题\n\n- 状态：草稿\n- 负责人：待定\n\n## 背景与问题\n\n待填写。\n\n## 产品目标\n\n待填写。\n\n## 范围\n\n待填写。\n\n## 实际结果\n\n待交付后回写。\n'},
  {file:'02-feature/_template.md',content:'# FEAT-NNN：特性标题\n\n- 状态：草稿\n- 所属产品：待填写\n\n## 用户价值\n\n待填写。\n\n## 行为与规则\n\n待填写。\n\n## 验收标准\n\n- AC-1：待填写。\n\n## 实际交付\n\n待交付后回写。\n'},
  {file:'03-design/_template.md',content:'# DES-NNN：设计标题\n\n- 状态：草稿\n- 所属特性：待填写\n\n## 设计目标\n\n待填写。\n\n## 方案与取舍\n\n待填写。\n\n## 风险与验证\n\n待填写。\n\n## 实际实现\n\n待交付后回写。\n'},
  {file:'04-task/_template.md',content:'# TASK-NNN：工程工单标题\n\n- 状态：草稿\n- 所属设计：待填写\n\n## 目标\n\n待填写。\n\n## 验收标准\n\n- [ ] AC-1：待填写。\n\n## 交付记录\n\n待交付后回写 Evidence、Round 和 revision。\n'},
];

export async function initTargetSpecLibrary(root:string):Promise<{created:string[];preserved:string[]}>{
  const project=await readProject(root);const specRoot=path.resolve(project.repository,project.spec_root);const created:string[]=[];const preserved:string[]=[];const writes=[];
  for(const item of targetSpecFiles(project.name)){const file=path.join(specRoot,item.file);if(await exists(file))preserved.push(file);else{created.push(file);writes.push({file,content:item.content})}}
  for(const dir of ['01-product','02-feature','03-design','04-task'])await mkdir(path.join(specRoot,dir),{recursive:true});
  if(writes.length)await atomicWriteMany(project.repository,writes);
  return {created,preserved};
}

export async function checkTargetSpecLibrary(root:string):Promise<{ok:boolean;errors:string[]} >{
  const project=await readProject(root),repo=path.resolve(project.repository),specRoot=path.resolve(repo,project.spec_root),errors:string[]=[];
  if(!specRoot.startsWith(repo+path.sep)){errors.push('spec_root escapes target repository');return {ok:false,errors}}
  if(await exists(specRoot)){const info=await lstat(specRoot);if(info.isSymbolicLink())errors.push('spec_root may not be a symbolic link')}
  const placeholder=/(?:\b(?:tbd|todo|unknown|placeholder|fill me)\b|待填写|待补充|<[^>]+>|\{\{[^}]+\}\})/i;
  for(const item of targetSpecFiles(project.name)){const file=path.join(specRoot,item.file);if(!(await exists(file))){errors.push(`missing target spec file: ${path.relative(repo,file)}`);continue}const info=await lstat(file);if(info.isSymbolicLink()){errors.push(`target spec file may not be a symbolic link: ${path.relative(repo,file)}`);continue}const content=await readFile(file,'utf8');if(content.trim().length<20)errors.push(`empty target spec file: ${path.relative(repo,file)}`);if(!item.file.endsWith('_template.md')&&placeholder.test(content))errors.push(`placeholder content in target spec file: ${path.relative(repo,file)}`)}
  const layers=[['01-product',/^PROD-[0-9]{3}-.+\.md$/, /^# (PROD-[0-9]{3})[：:]/],['02-feature',/^FEAT-[0-9]{3}-.+\.md$/, /^# (FEAT-[0-9]{3})[：:]/],['03-design',/^DES-[0-9]{3}-.+\.md$/, /^# (DES-[0-9]{3})[：:]/],['04-task',/^TASK-[A-Z0-9][A-Z0-9-]*\.md$/, /^# (TASK-[A-Z0-9][A-Z0-9-]*)[：:]/]] as const;
  const statuses=new Set(['草稿','已批准','进行中','待验证','已完成','已取消']);
  const documents:Array<{id:string;dir:string;file:string;content:string}>=[];
  for(const [dir,nameRe,headingRe] of layers){const layer=path.join(specRoot,dir);if(!(await exists(layer)))continue;for(const name of await readdir(layer)){if(name==='_template.md'||!name.endsWith('.md'))continue;const file=path.join(layer,name),info=await lstat(file);if(info.isSymbolicLink()){errors.push(`target spec may not be a symbolic link: ${path.relative(repo,file)}`);continue}const content=await readFile(file,'utf8'),heading=content.match(headingRe);if(!nameRe.test(name))errors.push(`invalid target spec filename: ${path.relative(repo,file)}`);if(!heading||!name.startsWith(heading[1]))errors.push(`target spec ID differs from filename: ${path.relative(repo,file)}`);else documents.push({id:heading[1],dir,file,content});const status=content.match(/^- 状态：(.+)$/m)?.[1];if(!status||!statuses.has(status))errors.push(`invalid or missing target spec status: ${path.relative(repo,file)}`);if(placeholder.test(content))errors.push(`placeholder content in target spec: ${path.relative(repo,file)}`)}}
  const ids=new Set(documents.map(x=>x.id));for(const doc of documents){let upstream:RegExp|null=null;if(doc.dir==='02-feature')upstream=/\bPROD-[0-9]{3}\b/;else if(doc.dir==='03-design')upstream=/\bFEAT-[0-9]{3}\b/;else if(doc.dir==='04-task'&&!/^- Proposal：PROP-[1-9]\d*$/m.test(doc.content))upstream=/\bDES-[0-9]{3}\b/;if(upstream){const ref=doc.content.match(upstream)?.[0];if(!ref)errors.push(`missing upstream trace in target spec: ${path.relative(repo,doc.file)}`);else if(!ids.has(ref))errors.push(`broken upstream trace ${ref} in target spec: ${path.relative(repo,doc.file)}`)}if(doc.dir==='04-task'&&/^- Proposal：/m.test(doc.content)&&!/^\- Spec-Loop Task：.+$/m.test(doc.content))errors.push(`proposal task missing Spec-Loop Task trace: ${path.relative(repo,doc.file)}`)}
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
