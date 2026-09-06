import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertNoSecrets, atomicWriteMany, exists, sha256 } from './files.js';
import { buildExecutionSnapshot } from './execution-view.js';
import { readProject, scanTasks } from './project.js';

const schedulerConfigSchema=z.object({schema_version:z.literal(1),mode:z.literal('report_only'),paused:z.boolean(),cursor_max_age_hours:z.number().int().positive().max(168),updated_at:z.iso.datetime()}).strict();
const cursorSchema=z.object({schema_version:z.literal(1),project_id:z.string(),sequence:z.number().int().positive(),source_fingerprint:z.string().length(64),canonical_report_hash:z.string().length(64),scanned_at:z.iso.datetime()}).strict();
const feedbackSchema=z.object({schema_version:z.literal(1),items:z.array(z.object({dedupe_key:z.string().length(64),disposition:z.enum(['adopted','false_positive','dismissed'])}).strict())}).strict();
const suggestionSchema=z.object({source:z.string(),dedupe_key:z.string().length(64),task_id:z.string(),protocol:z.enum(['v1','v2']),stage:z.string(),dependencies:z.array(z.string()),risk:z.enum(['light','standard','heavy']),estimated_cost:z.number().int().positive(),ready:z.boolean(),reason:z.string()}).strict();
const reportSchema=z.object({
  schema_version:z.literal(1),mode:z.literal('report_only'),project_id:z.string(),source_fingerprint:z.string().length(64),canonical_report_hash:z.string().length(64),equivalent_to_previous:z.boolean(),full_scan:z.boolean(),
  suggestions:z.array(suggestionSchema),metrics:z.object({suggestions:z.number().int().nonnegative(),duplicates:z.number().int().nonnegative(),duplicate_rate:z.number().min(0).max(1),adopted:z.number().int().nonnegative(),false_positives:z.number().int().nonnegative(),adoption_rate:z.number().min(0).max(1).nullable(),missing_data:z.number().int().nonnegative(),scan_duration_ms:z.number().int().nonnegative()}).strict(),generated_at:z.iso.datetime(),
}).strict();

export type SchedulerReport=z.infer<typeof reportSchema>;
const control=(root:string)=>path.join(root,'.spec-loop'),configFile=(root:string)=>path.join(control(root),'SCHEDULER.json'),cursorFile=(root:string)=>path.join(control(root),'output','scheduler-cursor.json'),reportFile=(root:string)=>path.join(control(root),'output','scheduler-report.json');

export async function initReportScheduler(root:string){const file=configFile(root);if(!(await exists(file))){const value=schedulerConfigSchema.parse({schema_version:1,mode:'report_only',paused:false,cursor_max_age_hours:24,updated_at:new Date().toISOString()});await atomicWriteMany(root,[{file,content:`${JSON.stringify(value,null,2)}\n`}])}return schedulerConfigSchema.parse(JSON.parse(await readFile(file,'utf8')))}
export async function setReportSchedulerPaused(root:string,paused:boolean){const current=await initReportScheduler(root),updated=schedulerConfigSchema.parse({...current,paused,updated_at:new Date().toISOString()});await atomicWriteMany(root,[{file:configFile(root),content:`${JSON.stringify(updated,null,2)}\n`}]);return updated}

async function acquire(root:string):Promise<()=>Promise<void>>{const lock=path.join(control(root),'scheduler-report.lock');try{await mkdir(lock);await writeFile(path.join(lock,'owner.json'),`${JSON.stringify({pid:process.pid,created_at:new Date().toISOString()})}\n`,{flag:'wx'})}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('report-only scheduler scan is already running');throw error}return()=>rm(lock,{recursive:true,force:true})}

function dependencies(reason:string|null):string[]{return reason?.startsWith('unfinished dependencies: ')?reason.slice('unfinished dependencies: '.length).split(', ').filter(Boolean):[]}
function estimatedCost(level:string,reworks:number):number{return({light:1,standard:3,heavy:8}[level]??5)+reworks*2}

export async function runReportScheduler(root:string):Promise<SchedulerReport>{
  const release=await acquire(root),started=Date.now();
  try{
    const config=await initReportScheduler(root);if(config.paused)throw new Error('report-only scheduler is paused');
    const project=await readProject(root),tasks=await scanTasks(root),snapshot=await buildExecutionSnapshot(root),snapshotById=new Map(snapshot.tasks.map(item=>[item.task_id,item]));
    let previous:z.infer<typeof cursorSchema>|null=null,fullScan=true;
    if(await exists(cursorFile(root))){try{previous=cursorSchema.parse(JSON.parse(await readFile(cursorFile(root),'utf8')))}catch(error){throw new Error(`scheduler cursor is invalid: ${(error as Error).message}`)}if(previous.project_id!==project.project_id)throw new Error('scheduler cursor belongs to a different Project');fullScan=Date.now()-Date.parse(previous.scanned_at)>config.cursor_max_age_hours*3600_000}
    const raw=tasks.map(task=>{
      const projected=snapshotById.get(task.task_id),reworks=projected?.acceptance?.semantic_reworks_used??0,deps=dependencies(task.blocking_reason),stage=task.protocol_stage??task.status;
      const ready=task.protocol==='v2'?['m_working','plan_compiled','v_passed'].includes(stage)&&!task.blocking_reason:task.resumable&&!task.blocking_reason;
      const reason=task.blocking_reason??(ready?'ready under current protocol and dependency facts':stage==='candidate'||task.status==='delivered'?'terminal candidate or delivered task':`not runnable from ${stage}`);
      const fact={project_id:project.project_id,task_id:task.task_id,protocol:task.protocol,stage,dependencies:deps,risk:task.level,reason};
      return suggestionSchema.parse({source:`project-task:${task.task_id}`,dedupe_key:sha256(JSON.stringify(fact)),task_id:task.task_id,protocol:task.protocol,stage,dependencies:deps,risk:task.level,estimated_cost:estimatedCost(task.level,reworks),ready,reason});
    }).sort((left,right)=>left.task_id.localeCompare(right.task_id));
    const seen=new Set<string>(),suggestions=raw.filter(item=>{if(seen.has(item.dedupe_key))return false;seen.add(item.dedupe_key);return true}),duplicates=raw.length-suggestions.length;
    let feedback:z.infer<typeof feedbackSchema>={schema_version:1,items:[]};const feedbackFile=path.join(control(root),'SCHEDULER_FEEDBACK.json');if(await exists(feedbackFile))feedback=feedbackSchema.parse(JSON.parse(await readFile(feedbackFile,'utf8')));
    const currentKeys=new Set(suggestions.map(item=>item.dedupe_key)),relevant=feedback.items.filter(item=>currentKeys.has(item.dedupe_key)),adopted=relevant.filter(item=>item.disposition==='adopted').length,falsePositives=relevant.filter(item=>item.disposition==='false_positive').length,decided=adopted+falsePositives;
    const sourceFingerprint=sha256(JSON.stringify({project_id:project.project_id,default_protocol:project.default_task_protocol,snapshot_revision:snapshot.revision,tasks:suggestions.map(({dedupe_key})=>dedupe_key)}));
    const canonical={schema_version:1,mode:'report_only',project_id:project.project_id,source_fingerprint:sourceFingerprint,suggestions,quality:{duplicates,adopted,false_positives:falsePositives,missing_data:snapshot.diagnostics.length}},canonicalReportHash=sha256(JSON.stringify(canonical)),now=new Date().toISOString();
    const report=reportSchema.parse({schema_version:1,mode:'report_only',project_id:project.project_id,source_fingerprint:sourceFingerprint,suggestions,canonical_report_hash:canonicalReportHash,equivalent_to_previous:previous?.canonical_report_hash===canonicalReportHash,full_scan:fullScan,metrics:{suggestions:suggestions.length,duplicates,duplicate_rate:raw.length?duplicates/raw.length:0,adopted,false_positives:falsePositives,adoption_rate:decided?adopted/decided:null,missing_data:snapshot.diagnostics.length,scan_duration_ms:Date.now()-started},generated_at:now});
    assertNoSecrets(JSON.stringify(report),'report-only scheduler output');
    const cursor=cursorSchema.parse({schema_version:1,project_id:project.project_id,sequence:(previous?.sequence??0)+1,source_fingerprint:sourceFingerprint,canonical_report_hash:canonicalReportHash,scanned_at:now});
    await atomicWriteMany(root,[{file:reportFile(root),content:`${JSON.stringify(report,null,2)}\n`},{file:cursorFile(root),content:`${JSON.stringify(cursor,null,2)}\n`}]);return report;
  }finally{await release()}
}

export async function readReportSchedulerStatus(root:string){const config=await initReportScheduler(root),cursor=await exists(cursorFile(root))?cursorSchema.parse(JSON.parse(await readFile(cursorFile(root),'utf8'))):null,report=await exists(reportFile(root))?reportSchema.parse(JSON.parse(await readFile(reportFile(root),'utf8'))):null;return{config,cursor,report}}
