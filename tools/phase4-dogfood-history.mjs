import assert from 'node:assert/strict'

const requiredStages=['m_working','m_submitted','plan_compiled','v_passed','candidate']
const stageActors={m_submitted:'M',plan_compiled:'controller',v_passed:'V',candidate:'R'}

export function auditAutonomousRun(run,approvedAt){
  assert.equal(run?.stage,'candidate','dogfood Task must reach Candidate')
  assert.ok(Array.isArray(run.history)&&run.history.length>=requiredStages.length,'complete managed history is required')
  assert.ok(Date.parse(approvedAt)<=Date.parse(run.created_at),'P approval must precede the managed run')
  const stages=run.history.map(entry=>entry.stage)
  let cursor=0
  for(const entry of run.history){
    assert.equal(entry.sequence,++cursor,'managed history sequence must be complete')
    assert.notEqual(entry.actor,'human',`loop-time human action at sequence ${entry.sequence}`)
    assert.notEqual(entry.stage,'waiting_human_review',`loop-time human wait at sequence ${entry.sequence}`)
    assert.ok(['controller','M','V','R'].includes(entry.actor),`unexpected managed actor at sequence ${entry.sequence}`)
    if(stageActors[entry.stage])assert.equal(entry.actor,stageActors[entry.stage],`invalid ${entry.stage} actor at sequence ${entry.sequence}`)
  }
  assert.equal(stages.at(-1),'candidate','managed history must end at Candidate')
  let index=-1
  for(const stage of requiredStages){
    index=stages.indexOf(stage,index+1)
    assert.ok(index>=0,`managed history is missing ${stage}`)
  }
  return {events:run.history.length,automated:true,approved_at:approvedAt,candidate_at:run.history.at(-1).occurred_at}
}
