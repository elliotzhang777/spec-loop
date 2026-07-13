import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { atomicWriteMany, exists, readMarkdown, sha256, stringifyMarkdown } from './files.js';
import { readProject, readProviderConfig, scanTasks, verifyTaskExecutionApproval } from './project.js';
import { evidenceRecords, readState } from './task.js';

const exec = promisify(execFile);
const control = (root:string) => path.join(root, '.spec-loop');
const gateConfigSchema = z.object({schema_version:z.literal(1),gates:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9-]*$/),command:z.array(z.string().min(1)).min(1),timeout_seconds:z.number().int().positive().max(3600)}).strict()).min(1)}).strict();
const manifestSchema = z.object({schema_version:z.literal(1),task_id:z.string(),repository:z.string(),worktree:z.string(),branch:z.string(),base_commit:z.string().regex(/^[a-f0-9]{40,64}$/),head:z.string().regex(/^[a-f0-9]{40,64}$/),created_at:z.iso.datetime()}).strict();
const stageSchema = z.enum(['prepared','executed','collected','verified','reported']);
const harnessStateSchema = z.object({schema_version:z.literal(1),task_id:z.string(),stage:stageSchema,workspace:z.string(),base_commit:z.string(),head:z.string(),sequence:z.number().int().positive(),evidence_hashes:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)),updated_at:z.iso.datetime(),last_error:z.string().nullable()}).strict();
const collectSchema = z.object({schema_version:z.literal(1),task_id:z.string(),workspace:z.string(),base_commit:z.string(),head:z.string(),status:z.array(z.string()),diff_stat:z.string(),collected_at:z.iso.datetime()}).strict();
const gateResultSchema = z.object({schema_version:z.literal(1),task_id:z.string(),id:z.string(),command:z.array(z.string()),cwd:z.string(),exit_code:z.number().int(),timed_out:z.boolean(),duration_ms:z.number().int().nonnegative(),base_commit:z.string(),head:z.string(),artifact:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),created_at:z.iso.datetime()}).strict();
const gateResultsSchema = z.array(gateResultSchema).min(1);
export type WorkspaceManifest = z.infer<typeof manifestSchema>;
export type GateResult = z.infer<typeof gateResultSchema>;
type HarnessState = z.infer<typeof harnessStateSchema>;

async function git(cwd:string,args:string[]){return (await exec('git',args,{cwd,maxBuffer:10_000_000})).stdout.trim()}
function stateFile(root:string,taskId:string){return path.join(control(root),'output',`${taskId}-harness-state.json`)}
async function readHarnessState(root:string,taskId:string):Promise<HarnessState>{return harnessStateSchema.parse(JSON.parse(await readFile(stateFile(root,taskId),'utf8')))}
async function writeHarnessState(root:string,state:HarnessState){await atomicWriteMany(root,[{file:stateFile(root,state.task_id),content:JSON.stringify(state,null,2)+'\n'}])}
async function advance(root:string,taskId:string,from:HarnessState['stage']|null,to:HarnessState['stage'],m:WorkspaceManifest,head:string,error:string|null=null,newHashes:Record<string,string>={}){
  let sequence=1,evidenceHashes:Record<string,string>={};
  if(from){const current=await readHarnessState(root,taskId);if(current.stage!==from)throw new Error(`harness ${to} is illegal from ${current.stage}`);if(current.workspace!==m.worktree||current.base_commit!==m.base_commit)throw new Error('harness state does not match workspace manifest');sequence=current.sequence+1;evidenceHashes=current.evidence_hashes}
  await writeHarnessState(root,{schema_version:1,task_id:taskId,stage:to,workspace:m.worktree,base_commit:m.base_commit,head,sequence,evidence_hashes:{...evidenceHashes,...newHashes},updated_at:new Date().toISOString(),last_error:error});
}

export async function initGateConfig(root:string){const file=path.join(control(root),'GATES.md');if(await exists(file))return;await atomicWriteMany(root,[{file,content:stringifyMarkdown({schema_version:1,gates:[]},'# Gates\n\nAdd deterministic command arrays before Harness execution.')}])}
export async function readGates(root:string){await initGateConfig(root);return gateConfigSchema.parse((await readMarkdown(path.join(control(root),'GATES.md'))).data).gates}

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

const SHELLS=new Set(['sh','bash','zsh','fish','dash','csh','tcsh','cmd','cmd.exe','powershell','pwsh','env']);
function assertGateCommand(command:string[]){
  const bin=path.basename(command[0]).toLowerCase();if(SHELLS.has(bin))throw new Error(`shell or command dispatcher is forbidden in gate: ${command[0]}`);
  if(bin==='sudo'||bin==='su')throw new Error(`privilege escalation is forbidden in gate: ${command[0]}`);
  if(bin==='git'&&['push','merge','rebase','reset','clean','checkout','switch','branch','tag','commit'].includes((command[1]??'').toLowerCase()))throw new Error(`mutating git command is forbidden in gate: ${command.join(' ')}`);
  const joined=command.join(' ').toLowerCase();if(/\b(deploy|publish|release)\b/.test(joined))throw new Error(`release command is forbidden in gate: ${command.join(' ')}`);
}
function runProcess(bin:string,args:string[],cwd:string,timeout:number,input?:string):Promise<{code:number;stdout:string;stderr:string;timedOut:boolean}>{return new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{cwd,detached:process.platform!=='win32',env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',TMPDIR:process.env.TMPDIR??'/tmp'},stdio:'pipe'});let stdout='',stderr='',timedOut=false,settled=false;
  const kill=(signal:NodeJS.Signals)=>{try{if(process.platform==='win32')child.kill(signal);else process.kill(-(child.pid as number),signal)}catch{child.kill(signal)}};
  const timer=setTimeout(()=>{timedOut=true;kill('SIGTERM');setTimeout(()=>{if(!settled)kill('SIGKILL')},1000).unref()},timeout);
  child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>{settled=true;clearTimeout(timer);resolve({code:timedOut?124:(code??1),stdout,stderr,timedOut})});if(input)child.stdin.end(input);else child.stdin.end();
})}

export async function prepareHarness(root:string,taskId:string,prompt:string){
  const m=await readWorkspace(root,taskId);const task=(await scanTasks(root)).find(t=>t.task_id===taskId);if(!task)throw new Error('task not found');const state=await readState(task.path);if(state.status!=='working')throw new Error(`harness prepare requires working task, got ${state.status}`);
  await verifyTaskExecutionApproval(root,taskId);const head=await git(m.worktree,['rev-parse','HEAD']);
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
  const head=await git(m.worktree,['rev-parse','HEAD']),status=await git(m.worktree,['status','--short']),diff=await git(m.worktree,['diff','--stat',m.base_commit]);const value=collectSchema.parse({schema_version:1,task_id:taskId,workspace:m.worktree,base_commit:m.base_commit,head,status:status.split('\n').filter(Boolean),diff_stat:diff,collected_at:new Date().toISOString()});
  const serialized=JSON.stringify(value,null,2)+'\n';await atomicWriteMany(root,[{file:path.join(control(root),'output',`${taskId}-collect.json`),content:serialized}]);await advance(root,taskId,'executed','collected',m,head,null,{collect:sha256(serialized)});return value;
}
export async function runGates(root:string,taskId:string):Promise<GateResult[]>{
  const m=await readWorkspace(root,taskId),current=await readHarnessState(root,taskId);if(current.stage!=='collected')throw new Error(`harness verify is illegal from ${current.stage}`);const gates=await readGates(root),results:GateResult[]=[];
  const startHead=await git(m.worktree,['rev-parse','HEAD']);if(startHead!==current.head)throw new Error('workspace HEAD changed after collect');
  for(const gate of gates){assertGateCommand(gate.command);const started=Date.now(),createdAt=new Date().toISOString(),result=await runProcess(gate.command[0],gate.command.slice(1),m.worktree,gate.timeout_seconds*1000),head=await git(m.worktree,['rev-parse','HEAD']);if(head!==startHead)throw new Error('gate command changed Git HEAD');const content=`TASK ${taskId}\nCOMMAND ${JSON.stringify(gate.command)}\nCWD ${m.worktree}\nTIMED_OUT ${result.timedOut}\nEXIT ${result.code}\nBASE ${m.base_commit}\nHEAD ${head}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}\n`,rel=`.spec-loop/output/${taskId}-gate-${gate.id}.txt`;await atomicWriteMany(root,[{file:path.join(root,rel),content}]);results.push(gateResultSchema.parse({schema_version:1,task_id:taskId,id:gate.id,command:gate.command,cwd:m.worktree,exit_code:result.code,timed_out:result.timedOut,duration_ms:Date.now()-started,base_commit:m.base_commit,head,artifact:rel,sha256:sha256(content),created_at:createdAt}))}
  const serialized=JSON.stringify(results,null,2)+'\n';await atomicWriteMany(root,[{file:path.join(control(root),'output',`${taskId}-gates.json`),content:serialized}]);await advance(root,taskId,'collected','verified',m,startHead,results.every(x=>x.exit_code===0)?null:'one or more gates failed',{gates:sha256(serialized)});return results;
}
export async function reportHarness(root:string,taskId:string){
  const m=await readWorkspace(root,taskId),current=await readHarnessState(root,taskId);if(current.stage!=='verified')throw new Error(`harness report is illegal from ${current.stage}`);
  const collectRaw=await readFile(path.join(control(root),'output',`${taskId}-collect.json`),'utf8'),gatesRaw=await readFile(path.join(control(root),'output',`${taskId}-gates.json`),'utf8'),collected=collectSchema.parse(JSON.parse(collectRaw)),gates=gateResultsSchema.parse(JSON.parse(gatesRaw)),head=await git(m.worktree,['rev-parse','HEAD']);
  if(current.evidence_hashes.collect!==sha256(collectRaw)||current.evidence_hashes.gates!==sha256(gatesRaw))throw new Error('Harness Evidence hash chain mismatch');
  if(collected.task_id!==taskId||collected.workspace!==m.worktree||collected.base_commit!==m.base_commit||collected.head!==head||current.head!==head)throw new Error('stale or mismatched collect evidence');
  for(const g of gates){if(g.task_id!==taskId||g.cwd!==m.worktree||g.base_commit!==m.base_commit||g.head!==head)throw new Error(`${g.id}: stale or mismatched gate evidence`);const artifact=await readFile(path.join(root,g.artifact));if(sha256(artifact)!==g.sha256)throw new Error(`${g.id}: gate artifact hash mismatch`)}
  const passed=gates.every(g=>g.exit_code===0&&!g.timed_out),content=`# Harness Report — ${taskId}\n\n- Base: ${collected.base_commit}\n- Head: ${collected.head}\n- Gate verdict: ${passed?'PASS':'FAIL'}\n- Modified entries: ${collected.status.length}\n\n## Gates\n${gates.map(g=>`- ${g.id}: exit ${g.exit_code}, timeout ${g.timed_out}, artifact ${g.artifact}, sha256 ${g.sha256}`).join('\n')}\n`,file=path.join(control(root),'output',`${taskId}-harness-report.md`);
  const reportHash=sha256(content);await atomicWriteMany(root,[{file,content}]);await advance(root,taskId,'verified','reported',m,head,passed?null:'gate verdict failed',{report:reportHash});return{passed,head,file,sha256:reportHash};
}
export async function reconcileHarness(root:string,taskId:string){
  const m=await readWorkspace(root,taskId),head=await git(m.worktree,['rev-parse','HEAD']);let state:HarnessState;
  try{state=await readHarnessState(root,taskId)}catch{throw new Error('no valid harness state to reconcile')}
  const required:Record<HarnessState['stage'],string[]>={prepared:[`${taskId}-prepare.json`],executed:[`${taskId}-prepare.json`,`${taskId}-provider.txt`],collected:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`],verified:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`,`${taskId}-gates.json`],reported:[`${taskId}-prepare.json`,`${taskId}-provider.txt`,`${taskId}-collect.json`,`${taskId}-gates.json`,`${taskId}-harness-report.md`]};
  for(const name of required[state.stage])if(!(await exists(path.join(control(root),'output',name))))throw new Error(`harness state ${state.stage} is missing ${name}`);
  const hashFiles:Record<string,string>={prepare:`${taskId}-prepare.json`,provider:`${taskId}-provider.txt`,collect:`${taskId}-collect.json`,gates:`${taskId}-gates.json`,report:`${taskId}-harness-report.md`};for(const [key,expected] of Object.entries(state.evidence_hashes)){const file=hashFiles[key];if(!file||sha256(await readFile(path.join(control(root),'output',file)))!==expected)throw new Error(`harness Evidence hash mismatch: ${key}`)}
  const headChanged=head!==state.head;
  const staleHeadEvidence=headChanged||state.last_error?.startsWith('workspace HEAD changed')===true;
  const reconciled={
    ...state,
    head,
    stage:staleHeadEvidence?'prepared':state.stage,
    sequence:state.sequence+1,
    evidence_hashes:staleHeadEvidence?{prepare:state.evidence_hashes.prepare}:state.evidence_hashes,
    updated_at:new Date().toISOString(),
    last_error:staleHeadEvidence?'workspace HEAD changed; rerun execute/collect/verify':state.last_error,
  };
  await writeHarnessState(root,reconciled);return reconciled;
}

export async function writebackDelivery(root:string,taskId:string){const item=(await scanTasks(root)).find(t=>t.task_id===taskId);if(!item)throw new Error('task not found');const state=await readState(item.path);if(state.status!=='delivered')throw new Error('task is not delivered');const evidence=await evidenceRecords(item.path);const content=`# Project Write-back — ${taskId}\n\n- Project: ${(await readProject(root)).project_id}\n- Status: delivered\n- Round: ${state.current_round}\n- Revision: ${state.code_revision}\n- Evidence: ${evidence.map(e=>e.id).join(', ')}\n\nThis is a generated external-system write-back draft. No external write was performed.\n`;const file=path.join(control(root),'output',`${taskId}-writeback.md`);await atomicWriteMany(root,[{file,content}]);return file}
