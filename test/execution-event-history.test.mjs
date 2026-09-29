import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {randomUUID,createHash} from 'node:crypto'
import {cli} from './helpers.mjs'
import {archiveExecutionEvents,readExecutionEvents,startExecutionStep,finishExecutionStep,cancelTaskExecution} from '../dist/execution-events.js'

async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'execution-history-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.spec-loop'));await writeFile(path.join(root,'.spec-loop/PROJECT.md'),'---\nproject_id: PROJ-HISTORY\n---\nHistory fixture.\n');return root}
const hash=value=>createHash('sha256').update(value).digest('hex')

test('history above 32 MiB remains readable, rotates on write and keeps cross-segment steps and cancellation',{timeout:90_000},async t=>{
 const root=await fixture(t),file=path.join(root,'.spec-loop/EXECUTION_EVENTS.jsonl');let previous=null,lines=[]
 for(let n=1;n<=2300;n++){const value={schema_version:1,sequence:n,event_id:randomUUID(),step_run_id:null,project_id:'PROJ-HISTORY',task_id:null,round:null,run_id:null,owner_pid:null,kind:'annotation',step_type:null,label:'Historical annotation',summary:'Preserved audit history.',occurred_at:new Date(0).toISOString(),outcome:null,refs:Array.from({length:50},()=> 'evidence/'+ 'document'.repeat(40)),previous_hash:previous};previous=hash(JSON.stringify(value));lines.push(JSON.stringify({...value,event_hash:previous})+'\n')}
 await writeFile(file,lines.join(''));assert.ok((await stat(file)).size>32*1024*1024);lines=[]
 assert.equal((await readExecutionEvents(root)).length,2300)
 const step=await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.analyze',label:'Cross segment step',summary:'Open step preserved across rotation.'})
 assert.ok((await readdir(path.join(root,'.spec-loop/execution-event-archive'))).length>=4);assert.ok((await stat(file)).size<=8*1024*1024)
 const archived=await archiveExecutionEvents(root);assert.equal(archived.history_preserved,true);assert.equal((await stat(file)).size,0)
 const finish=await finishExecutionStep(root,step,{outcome:'success',summary:'Finished after explicit archival.'});assert.equal(finish.sequence,step.sequence+1)
 const other=await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.change',label:'Cancel after archive',summary:'Open cancellation fixture.'});await archiveExecutionEvents(root)
 const cancellation=await cancelTaskExecution(root,{taskId:'TASK-HISTORY',round:1});assert.ok(cancellation.closed.some(item=>item.step_run_id===other.step_run_id));assert.equal((await cancelTaskExecution(root,{taskId:'TASK-HISTORY',round:1})).alreadyCancelled,true)
 const events=await readExecutionEvents(root);assert.equal(events[2299].event_hash,previous);assert.equal(events.at(-1).outcome,'cancelled')
})

test('archival hashes and the global chain reject damaged or missing segments',async t=>{
 const root=await fixture(t);await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.analyze',label:'Archive integrity',summary:'Preserve open step identity.'});await archiveExecutionEvents(root)
 const dir=path.join(root,'.spec-loop/execution-event-archive'),file=path.join(dir,(await readdir(dir))[0]),original=await readFile(file,'utf8')
 await writeFile(file,original.replace('Preserve open step identity.','Modified historical identity.'));await assert.rejects(readExecutionEvents(root),/integrity|hash/)
 await writeFile(file,original);assert.equal((await readExecutionEvents(root)).length,2)
 await finishExecutionStep(root,(await readExecutionEvents(root))[1],{outcome:'success',summary:'Finish cross segment.'});await rm(file);await assert.rejects(readExecutionEvents(root),/sequence|hash|open step|integrity/)
})


test('losing every archived segment cannot silently restart the event chain',async t=>{
 const root=await fixture(t);await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.analyze',label:'Archive deletion',summary:'Detect complete archive deletion.'});await archiveExecutionEvents(root)
 await rm(path.join(root,'.spec-loop/execution-event-archive'),{recursive:true,force:true});await assert.rejects(readExecutionEvents(root),/integrity/)
 await assert.rejects(startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.change',label:'Unsafe restart',summary:'Must preserve existing history.'}),/integrity/)
})


test('archive-events CLI seals history and permits an open step to finish afterwards',async t=>{
 const root=await fixture(t),step=await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.analyze',label:'CLI archive',summary:'Open step across CLI archive.'})
 const result=cli(['maintenance','archive-events',root,'--json']);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).event_count,2)
 assert.equal((await finishExecutionStep(root,step,{outcome:'success',summary:'Finished after CLI archival.'})).sequence,3)
})

test('reader rejects a closed step run id reused with a valid recomputed chain',async t=>{
 const root=await fixture(t),file=path.join(root,'.spec-loop/EXECUTION_EVENTS.jsonl')
 for(let i=0;i<2;i++){const start=await startExecutionStep(root,{taskId:'TASK-HISTORY',round:1,stepType:'work.analyze',label:`Analysis ${i}`,summary:`Run analysis ${i}`});await finishExecutionStep(root,start,{outcome:'success'})}
 const events=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse)
 events[3].step_run_id=events[1].step_run_id;events[4].step_run_id=events[1].step_run_id
 for(let i=3;i<events.length;i++){events[i].previous_hash=events[i-1].event_hash;const {event_hash,...facts}=events[i];events[i].event_hash=hash(JSON.stringify(facts))}
 await writeFile(file,events.map(JSON.stringify).join('\n')+'\n')
 await assert.rejects(readExecutionEvents(root),/duplicate step run id/)
})

test('event writer rejects Secret canaries in task identities',async t=>{
 const root=await fixture(t)
 await assert.rejects(startExecutionStep(root,{taskId:'TASK-token=abcdefghijk',round:1,stepType:'work.analyze',label:'Safe label',summary:'Safe summary'}),/secret/i)
 assert.deepEqual(await readExecutionEvents(root),[])
})
