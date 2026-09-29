export type BatchWavePhase='implementation'|'initial_v'|'initial_r'|'repair'|'recheck_v'|'recheck_r';
export type BatchWaveTask={task_id:string;stage:string;ready:boolean;blocked_by:string[]};
export type BatchWaveStep={phase:BatchWavePhase;verification_round:0|1|2;role:'M'|'V'|'R'|null;task_ids:string[];status:'dispatch'|'complete'|'blocked';reason:string|null};

// This is a wave-wide barrier. A Task may be attempted only once per role in
// each phase; an infrastructure retry or semantic rework cannot silently add
// a third verification round. The caller persists the phase before dispatch.
export function batchWaveStep(phase:BatchWavePhase,tasks:BatchWaveTask[],attempted:ReadonlySet<string>):BatchWaveStep{
  if(!tasks.length)throw new Error('batch wave requires at least one approved Task');
  let current=phase;
  for(let transition=0;transition<6;transition++){
    const round:0|1|2=current==='implementation'?0:current.startsWith('initial')||current==='repair'?1:2;
    const role:'M'|'V'|'R'=current==='implementation'||current==='repair'?'M':current.endsWith('_v')?'V':'R';
    const stage=role==='M'?'m_working':role==='V'?'plan_compiled':'v_passed';
    const pending=tasks.filter(task=>task.stage===stage);
    const ready=pending.filter(task=>task.ready&&!attempted.has(`${current}:${task.task_id}`));
    if(ready.length)return{phase:current,verification_round:round,role,task_ids:ready.map(task=>task.task_id),status:'dispatch',reason:null};
    if(pending.length){
      const detail=pending.map(task=>`${task.task_id}:${attempted.has(`${current}:${task.task_id}`)?'already attempted':task.blocked_by.length?`blocked by ${task.blocked_by.join(',')}`:'not ready'}`).join('; ');
      return{phase:current,verification_round:round,role:null,task_ids:[],status:'blocked',reason:`${current} cannot advance: ${detail}`};
    }
    const stages=new Set(tasks.map(task=>task.stage));
    const allowed=current==='implementation'?['plan_compiled']:current==='initial_v'?['v_passed','m_working','waiting_human_review']:current==='initial_r'?['candidate','m_working','waiting_human_review']:current==='repair'?['plan_compiled','v_passed','candidate','waiting_human_review']:current==='recheck_v'?['v_passed','candidate','waiting_human_review']:['candidate','waiting_human_review'];
    if(tasks.some(task=>!allowed.includes(task.stage))){
      const detail=tasks.filter(task=>!allowed.includes(task.stage)).map(task=>`${task.task_id}:${task.stage}`).join('; ');
      return{phase:current,verification_round:round,role:null,task_ids:[],status:'blocked',reason:`${current} has unresolved Tasks: ${detail}`};
    }
    if(current==='recheck_r')return{phase:current,verification_round:2,role:null,task_ids:[],status:'complete',reason:null};
    if(current==='initial_r'&&!stages.has('m_working'))return{phase:current,verification_round:1,role:null,task_ids:[],status:'complete',reason:null};
    current=current==='implementation'?'initial_v':current==='initial_v'?(stages.has('m_working')?'repair':'initial_r'):current==='initial_r'?'repair':current==='repair'?'recheck_v':'recheck_r';
  }
  throw new Error('batch wave phase transition exceeded its fixed bound');
}
