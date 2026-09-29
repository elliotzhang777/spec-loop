import test from 'node:test'
import assert from 'node:assert/strict'
import { createProviderObservations } from '../dist/provider-observations.js'

test('noise, repeated messages, stderr and increasing usage do not prolong useful progress',()=>{
  const value=createProviderObservations()
  assert.equal(value.push('检查目标文件\n'),true)
  assert.equal(value.push('检查目标文件\n'),false)
  for(let index=0;index<100;index++){
    assert.equal(value.push(`retry ${index}: connection failed\n`),false)
    assert.equal(value.push(`{"type":"heartbeat","timestamp":${index}}\n`),false)
    assert.equal(value.push(`{"usage":{"total_tokens":${index}}}\n`),false)
    assert.equal(value.push('fatal: same error\n','stderr'),false)
  }
  assert.equal(value.progressSequence(),1)
  assert.equal(value.push('{"type":"item.completed","item":{"id":"1","command":"node --test test/a.mjs"}}\n'),true)
  assert.equal(value.push('{"type":"item.completed","item":{"id":"2","command":"node --test test/a.mjs"}}\n'),false)
  assert.equal(value.push('{"type":"item.completed","item":{"id":"3","command":"node --test test/b.mjs"}}\n'),true)
})

test('usage is parsed once across chunk boundaries and UTF-8 fragments',()=>{
  const value=createProviderObservations('incremental')
  const data=Buffer.from('实际进展\n{"usage":{"total_tokens":1000,"cost_usd":0.02}}\n{"usage":{"total_tokens":10,"cost_usd":0.001}}')
  for(let index=0;index<data.length;index++)value.push(data.subarray(index,index+1))
  assert.equal(value.progressSequence(),1)
  assert.equal(value.finish().total_tokens,1010)
  assert.equal(value.usage().cost_usd,0.021)
  assert.equal(value.error(),null)
})

test('cumulative usage cannot move backwards or contradict its components',()=>{
  const value=createProviderObservations()
  value.push('{"usage":{"total_tokens":1000,"cost_usd":0.02}}\n')
  value.push('{"usage":{"total_tokens":10,"cost_usd":0.001}}\n')
  assert.equal(value.finish().total_tokens,1000)
  assert.equal(value.usage().recorded,false)
  assert.match(value.error(),/backwards/)
  const inconsistent=createProviderObservations()
  inconsistent.push('{"usage":{"input_tokens":10,"output_tokens":10,"total_tokens":1}}\n')
  assert.equal(inconsistent.usage().recorded,false)
  assert.match(inconsistent.error(),/contradict/)
})

test('incremental receipts deduplicate replay and reject changed events',()=>{
  const value=createProviderObservations('incremental'),event='{"event_id":"usage-1","usage":{"total_tokens":100}}\n'
  value.push(event);value.push(event)
  assert.equal(value.usage().total_tokens,100)
  value.push('{"event_id":"usage-1","usage":{"total_tokens":1}}\n')
  assert.equal(value.usage().total_tokens,100)
  assert.equal(value.usage().recorded,false)
})

test('oversized lines are bounded and cannot silently lose usage accounting',()=>{
  const value=createProviderObservations()
  value.push('x'.repeat(1_100_000)+'\n')
  value.push('{"usage":{"total_tokens":100,"cost_usd":0.01}}\n')
  assert.equal(value.finish().recorded,false)
  assert.match(value.error(),/limit/)
})

test('ordinary large Codex tool records retain later usage accounting',()=>{
  const value=createProviderObservations()
  value.push(JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'x'.repeat(450_000)}})+'\n')
  value.push('{"usage":{"total_tokens":100,"cost_usd":0.01}}\n')
  assert.equal(value.finish().recorded,true)
  assert.equal(value.error(),null)
  assert.equal(value.usage().total_tokens,100)
})


test('split cumulative components merge without undercounting or false backwards errors',()=>{
  for(const [input,output] of [[100,200],[200,100]]){
    const value=createProviderObservations();value.push(JSON.stringify({usage:{input_tokens:input}})+'\n');value.push(JSON.stringify({usage:{output_tokens:output,cost_usd:0.01}})+'\n');
    assert.equal(value.finish().total_tokens,300);assert.equal(value.error(),null);assert.equal(value.usage().recorded,true)
    value.push('{"usage":{"total_tokens":299}}\n');assert.equal(value.usage().recorded,false)
  }
})

test('usage within one envelope is counted independently and replayed exactly once',()=>{
  const value=createProviderObservations('incremental'),event={event_id:'envelope',items:[{usage:{total_tokens:100,cost_usd:0.01}},{usage:{total_tokens:100,cost_usd:0.01}}]}
  value.push(JSON.stringify(event)+'\n');value.push(JSON.stringify(event)+'\n');assert.equal(value.finish().total_tokens,200);assert.equal(value.usage().cost_usd,0.02);assert.equal(value.error(),null)
})

test('changing numeric JSON telemetry does not renew useful progress',()=>{
  const value=createProviderObservations();for(let n=0;n<100;n++)assert.equal(value.push(JSON.stringify({type:'status',counter:n,elapsed:n*10})+'\n'),false)
  assert.equal(value.push('{"type":"item.completed","item":{"command":"node check.mjs","exit_code":0}}\n'),true)
  assert.equal(value.push('{"type":"item.completed","item":{"command":"node check.mjs","exit_code":1}}\n'),false)
  assert.equal(value.progressSequence(),1)
})
