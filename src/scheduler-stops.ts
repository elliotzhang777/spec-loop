import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicWriteMany } from './files.js';
import { withOwnedDirectoryLock } from './owned-lock.js';
import { withOperationTimeout } from './latest-writer.js';
import { startManagedProcess, type ManagedProcessHandle } from './managed-process.js';

type StopResult = Record<string, unknown> & { task_id: string };
export type WatchdogStopCondition = { source: 'invocation' | 'effect' | 'driver' | 'wave'; id: string; pid?: number | null; process_started_at?: string | null };
export interface StopBatchOptions {
  maxElapsedMs?: number;
  taskTimeoutMs?: number;
  maxParallel?: number;
  executeStop?: (taskId: string, timeoutMs: number) => Promise<Record<string, unknown>>;
  watchdogConditions?: Record<string, WatchdogStopCondition[]>;
  watchdogStaleSeconds?: number;
}

// Intents outlive the bounded caller. All generations use this mutex, so an old
// completion cannot overwrite a newer request while waiting for file I/O.
async function intent(root: string, taskId: string, value: Record<string, unknown>, expectedRequest?: string) {
  const dir=path.join(root,'.spec-loop','scheduler','stop-intents'),file=path.join(dir,`${taskId}.json`);
  return withOwnedDirectoryLock(path.join(dir,`${taskId}.lock`),{name:'stop intent generation',maxWaitMs:1_000},async()=>{
    const current=await readFile(file,'utf8').then(raw=>JSON.parse(raw)).catch(error=>{if(error.code==='ENOENT')return null;throw error});
    if(expectedRequest&&current&&current.request_id!==expectedRequest)return false;
    if(!expectedRequest&&current?.request_id===value.request_id&&current.status!=='requested')return false;
    if(!expectedRequest&&current&&current.request_id!==value.request_id&&typeof current.requested_at==='string'&&current.requested_at>=String(value.requested_at))return false;
    await atomicWriteMany(root,[{file,content:`${JSON.stringify(value,null,2)}\n`}]);
    return true;
  });
}

// A direct, verified retry may settle only the intent it observed before stopping.
export async function completeVerifiedTaskStopIntent(root:string,taskId:string,requestId:string) {
  const dir=path.join(root,'.spec-loop','scheduler','stop-intents'),file=path.join(dir,`${taskId}.json`);
  return withOwnedDirectoryLock(path.join(dir,`${taskId}.lock`),{name:'stop intent generation',maxWaitMs:1_000},async()=>{
    const current=await readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error});
    if(!current||current.request_id!==requestId)return false;
    if(current.status==='completed')return true;
    const now=new Date().toISOString();
    await atomicWriteMany(root,[{file,content:`${JSON.stringify({...current,status:'completed',attempted_at:now,completed_at:now,last_error:null,recovery:'verified_direct_stop'},null,2)}\n`}]);
    return true;
  });
}

export async function runBoundedTaskStops(root: string, taskIds: string[], reason: string, options: StopBatchOptions = {}) {
  const maxElapsedMs=options.maxElapsedMs??10_000,taskTimeoutMs=options.taskTimeoutMs??3_000,maxParallel=options.maxParallel??4;
  if(!Number.isFinite(maxElapsedMs)||maxElapsedMs<200||!Number.isFinite(taskTimeoutMs)||taskTimeoutMs<1||!Number.isInteger(maxParallel)||maxParallel<1||maxParallel>16)throw new Error('invalid stop batch budget');
  const tasks=[...new Set(taskIds)].sort();
  if(tasks.some(id=>!/^(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*$/.test(id)))throw new Error('invalid stop Task id');
  const began=performance.now(),deadline=began+maxElapsedMs,cleanupReserve=Math.min(1_000,maxElapsedMs/4),workDeadline=deadline-cleanupReserve;
  const requestId=randomUUID(),requestedAt=new Date().toISOString(),results=new Map<string,StopResult>(),handles=new Map<string,ManagedProcessHandle>();
  const remaining=()=>Math.max(1,deadline-performance.now());
  const incomplete=(id:string,error:string):StopResult=>({task_id:id,status:'stop_incomplete',stop_complete:false,error,request_id:requestId});
  const base=(id:string)=>({schema_version:1,task_id:id,request_id:requestId,status:'requested',reason,requested_at:requestedAt,attempted_at:null,completed_at:null,last_error:null,...(options.watchdogConditions?.[id]?{watchdog_conditions:options.watchdogConditions[id],stale_seconds:options.watchdogStaleSeconds??15}:{})});
  const cli=fileURLToPath(new URL('./cli.js',import.meta.url));
  let expired=false,next=0;
  await withOperationTimeout(mkdir(path.join(root,'.spec-loop','scheduler','stop-intents'),{recursive:true}),remaining(),'stop directory preparation');
  const execute=options.executeStop??(async(id:string,timeout:number)=>{
    const managed=startManagedProcess({bin:process.execPath,args:[cli,'scheduler','control','stop-task',root,'--task',id,'--reason',reason,'--stop-request',requestId,'--json'],cwd:root,
      timeoutMs:timeout,pipeDrainTimeoutMs:100,terminationTimeoutMs:cleanupReserve,terminationGraceMs:50,detached:false,maxCaptureBytes:256*1024});
    handles.set(id,managed);
    try{
      const result=await managed.completion;
      if(result.timedOut||result.code!==0||!result.termination_verified)throw new Error(result.timedOut?'Task stop worker exceeded deadline':result.stderr.trim()||'Task stop worker failed or exit was not verified');
      const parsed:unknown=JSON.parse(result.stdout);
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||(parsed as Record<string,unknown>).task_id!==id)throw new Error('Task stop worker returned invalid facts');
      return parsed as Record<string,unknown>;
    }finally{if(managed.child.exitCode!==null||managed.child.signalCode!==null)handles.delete(id);}
  });
  const requested=new Set<string>();
  // Persist the complete stop set before launching any destructive worker.
  // If preparation exhausts the budget, leave incomplete intents for retry.
  const requests=tasks.map(async id=>{
    try{
      const owned=await withOperationTimeout(intent(root,id,base(id)),Math.min(1_000,remaining()),'stop intent persistence');
      if(owned)requested.add(id);else results.set(id,incomplete(id,'a newer stop request owns this intent'));
    }catch(error){results.set(id,incomplete(id,(error as Error).message));}
  });
  await withOperationTimeout(Promise.all(requests),Math.max(1,workDeadline-performance.now()),'stop intent preparation').catch(()=>{expired=true;});
  const workers=Array.from({length:Math.min(maxParallel,tasks.length)},async()=>{
    for(;;){const index=next++;if(index>=tasks.length||expired)return;const id=tasks[index];
      if(performance.now()>=workDeadline){results.set(id,incomplete(id,'stop batch deadline reached'));continue;}
      if(!requested.has(id))continue;
      try{
        if(expired||performance.now()>=workDeadline){results.set(id,incomplete(id,'stop batch deadline reached'));continue;}
        const timeout=Math.max(1,Math.min(taskTimeoutMs,workDeadline-performance.now()));
        const value=await withOperationTimeout(execute(id,timeout),Math.min(timeout+cleanupReserve,remaining()),'Task stop');
        if(!expired)results.set(id,{...value,task_id:id,request_id:requestId});
      }catch(error){if(!expired)results.set(id,incomplete(id,(error as Error).message));const handle=handles.get(id);if(handle&&handle.child.exitCode===null&&handle.child.signalCode===null)expired=true;}
    }
  });
  try{await withOperationTimeout(Promise.all(workers),Math.max(1,workDeadline-performance.now()),'stop batch');}
  catch{expired=true;}
  // Bound cleanup too. A timed-out injected operation or an unverified child
  // leaves an explicit incomplete intent; no late callback writes completion.
  await withOperationTimeout(Promise.allSettled([...handles.values()].map(handle=>handle.terminate({graceMs:0,timeoutMs:remaining()}))),remaining(),'stop worker cleanup').catch(()=>{expired=true;});
  for(const id of tasks){if(!results.has(id))results.set(id,incomplete(id,'stop batch deadline reached'));}
  const stopped=tasks.map(id=>results.get(id)!);
  const writes=stopped.map(async result=>{
    const complete=result.stop_complete===true;
    const persisted=await intent(root,result.task_id,{...base(result.task_id),status:complete?'completed':'stop_incomplete',attempted_at:new Date().toISOString(),completed_at:complete?new Date().toISOString():null,last_error:complete?null:String(result.error??'Task stop was not verified')},requestId);
    if(!persisted)throw new Error('stop outcome generation was superseded');
  });
  const persisted=await withOperationTimeout(Promise.allSettled(writes),remaining(),'stop outcome persistence').catch(()=>null);
  for(let index=0;index<stopped.length;index++){if(!persisted||persisted[index].status==='rejected')stopped[index]={...stopped[index],status:'stop_incomplete',stop_complete:false,error:'stop outcome persistence was not verified'};}
  return{request_id:requestId,stopped_tasks:stopped,stop_complete:stopped.every(item=>item.stop_complete===true),stop_duration_ms:Math.max(0,performance.now()-began)};
}
