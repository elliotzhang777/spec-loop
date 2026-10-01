import test from 'node:test'
import assert from 'node:assert/strict'
import {auditAutonomousRun} from '../tools/phase4-dogfood-history.mjs'

const history=['m_working','m_submitted','plan_compiled','v_passed','candidate']
  .map((stage,index)=>({sequence:index+1,stage,actor:['controller','M','controller','V','R'][index],occurred_at:`2026-10-01T00:0${index}:00.000Z`}))
const run={stage:'candidate',created_at:'2026-10-01T00:00:00.000Z',history}

test('approved managed M/V/R history reaches Candidate without in-loop human input',()=>{
  assert.equal(auditAutonomousRun(run,'2026-09-30T23:59:00.000Z').automated,true)
})
test('historical human change_approach cannot be called autonomous dogfood',()=>{
  const compromised={...run,history:[...history.slice(0,3),{sequence:4,stage:'m_working',actor:'human',occurred_at:'2026-10-01T00:03:00.000Z'},...history.slice(3).map(entry=>({...entry,sequence:entry.sequence+1}))]}
  assert.throws(()=>auditAutonomousRun(compromised,'2026-09-30T23:59:00.000Z'),/loop-time human action/)
})
test('waiting for an operator and incomplete history both fail closed',()=>{
  const waiting={...run,history:history.map((entry,index)=>index===2?{...entry,stage:'waiting_human_review'}:entry)}
  assert.throws(()=>auditAutonomousRun(waiting,'2026-09-30T23:59:00.000Z'),/human wait/)
  assert.throws(()=>auditAutonomousRun({...run,history:history.slice(0,3)},'2026-09-30T23:59:00.000Z'),/complete managed history/)
})
