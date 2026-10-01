import test from 'node:test'
import assert from 'node:assert/strict'
import {springT2Passed} from '../tools/phase4-spring-result.mjs'

const good={exitCode:0,tests:2,failures:0,errors:0,initialStatus:'',finalStatus:'',initialHead:'abc',finalHead:'abc'}
test('Spring PASS binds the same clean target HEAD before and after Maven',()=>{
  assert.equal(springT2Passed(good),true)
  assert.equal(springT2Passed({...good,finalHead:'def'}),false)
  assert.equal(springT2Passed({...good,finalStatus:' M pom.xml'}),false)
  assert.equal(springT2Passed({...good,errors:1}),false)
})
