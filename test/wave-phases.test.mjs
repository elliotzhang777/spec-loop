import test from 'node:test'
import assert from 'node:assert/strict'
import { batchWaveStep } from '../dist/wave-phases.js'

const row=(task_id,stage,ready=true,blocked_by=[])=>({task_id,stage,ready,blocked_by})
const decide=(phase,tasks,attempted=[])=>batchWaveStep(phase,tasks,new Set(attempted))

test('a batch waits for every M, then every V, before starting R',()=>{
  assert.deepEqual(decide('implementation',[row('A','plan_compiled'),row('B','m_working')]).task_ids,['B'])
  const initial=decide('implementation',[row('A','plan_compiled'),row('B','plan_compiled')])
  assert.equal(initial.phase,'initial_v');assert.equal(initial.verification_round,1);assert.deepEqual(initial.task_ids,['A','B'])
  assert.deepEqual(decide('initial_v',[row('A','v_passed'),row('B','plan_compiled')]).task_ids,['B'])
  assert.equal(decide('initial_v',[row('A','v_passed'),row('B','v_passed')]).phase,'initial_r')
  assert.equal(decide('initial_r',[row('A','candidate'),row('B','candidate')]).status,'complete')
})

test('the whole batch gets one consolidated repair and no third verification',()=>{
  const repair=decide('initial_v',[row('A','m_working'),row('B','v_passed')])
  assert.equal(repair.phase,'repair');assert.equal(repair.verification_round,1);assert.deepEqual(repair.task_ids,['A'])
  const recheck=decide('repair',[row('A','plan_compiled'),row('B','v_passed')])
  assert.equal(recheck.phase,'recheck_v');assert.equal(recheck.verification_round,2);assert.deepEqual(recheck.task_ids,['A'])
  const exhausted=decide('recheck_v',[row('A','m_working'),row('B','v_passed')])
  assert.equal(exhausted.status,'blocked');assert.match(exhausted.reason,/recheck_v.*A:m_working/)
  const reviewFailure=decide('recheck_r',[row('A','m_working'),row('B','candidate')])
  assert.equal(reviewFailure.status,'blocked')
})

test('R failure joins the same repair, and repeated or held actions cannot spin',()=>{
  assert.equal(decide('initial_r',[row('A','m_working'),row('B','candidate')]).phase,'repair')
  assert.match(decide('initial_v',[row('A','plan_compiled')],['initial_v:A']).reason,/already attempted/)
  assert.match(decide('implementation',[row('A','m_working',false,['PREREQ'])]).reason,/blocked by PREREQ/)
})

test('a Task awaiting human review does not block independent V-passed Tasks from R',()=>{
  const ready=decide('initial_v',[row('A','waiting_human_review',false),row('B','v_passed')])
  assert.equal(ready.phase,'initial_r');assert.deepEqual(ready.task_ids,['B'])
  assert.equal(decide('initial_r',[row('A','waiting_human_review',false),row('B','candidate')]).status,'complete')
})
