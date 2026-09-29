import assert from 'node:assert/strict'
import path from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { cli, fillContracts, readMd, tempRoot, writeMd } from './helpers.mjs'
import { startAcceptanceRun } from '../dist/acceptance-loop.js'
import { configureWaveBudget } from '../dist/scheduler-control.js'
export function git(root,args){const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout.trim()}
export async function waveFixture({failFirst=true,visual=false,blockFirst=false,malformedFirst=false}={}){
  const root=await tempRoot('wave-review-'),repository=path.join(root,'repo');await mkdir(repository)
  git(repository,['init','-b','main']);git(repository,['config','user.email','fixture@example.com']);git(repository,['config','user.name','Fixture'])
  await writeFile(path.join(repository,'check.mjs'),"console.log('approved deterministic check passed')\n")
  git(repository,['add','.']);git(repository,['commit','-m','base'])
  assert.equal(cli(['project','init',root,'--id','PROJ-WAVE-REVIEW','--name','波次统一验收测试','--repository',repository]).code,0)
  assert.equal(cli(['project','protocol',root,'--set','v2']).code,0)
  const provider=path.join(root,'provider.mjs')
  await writeFile(provider,`#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
if(process.argv.includes('--version')){console.log('codex fixture 1.0');process.exit(0)}
const root=${JSON.stringify(root)},evidence=process.env.SPEC_LOOP_EVIDENCE_ROOT,role=process.env.SPEC_LOOP_ROLE;
let dir=evidence;while(!fs.existsSync(path.join(dir,'INVOCATION.json'))){const parent=path.dirname(dir);if(parent===dir)throw Error('no invocation');dir=parent;}
const invocation=JSON.parse(fs.readFileSync(path.join(dir,'INVOCATION.json'))),id=invocation.task_id;
if(role==='M'){fs.writeFileSync(id+'-candidate.txt',invocation.invocation_id);execFileSync('git',['add',id+'-candidate.txt']);execFileSync('git',['commit','-m',invocation.invocation_id]);fs.writeFileSync(path.join(evidence,'self-test.txt'),'self-test '+invocation.invocation_id);}
else{const base=path.join(root,'.spec-loop','output',id+'-acceptance-v2'),plan=JSON.parse(fs.readFileSync(path.join(base,'EXECUTION_PLAN.json'))),run=JSON.parse(fs.readFileSync(path.join(root,'.spec-loop','tasks',id.toLowerCase(),'ACCEPTANCE_RUN.json')));
const marker=path.join(root,'.spec-loop','shared-cache',id+'-first-v-failed'),fail=role==='V'&&id==='TASK-REVIEW-1'&&(${JSON.stringify(failFirst)}||${blockFirst}||${malformedFirst})&&(${JSON.stringify(failFirst)}==='always'||!fs.existsSync(marker));if(fail)fs.writeFileSync(marker,'failed');
const report=path.join(evidence,'report.txt');fs.writeFileSync(report,role+' independent report '+invocation.invocation_id);
fs.writeFileSync(path.join(evidence,'RESULT.json'),JSON.stringify({task_id:id,contract_hash:run.contract_hash,plan_hash:plan.plan_hash,head:plan.head,invocation_id:invocation.invocation_id,verdict:fail?'fail':'pass',classification:fail?(${blockFirst}?'spec_ambiguity':'implementation_problem'):null,failed_ac:fail?['AC-1']:[],message:fail?'report fields were missing; implement the fix':'independent complete evidence passed',evidence:[{file:report,ac:['AC-1'],requirement_ids:['ER-1']}],...(role==='R'?{v_evidence_set_hash:run.last_v_evidence_set_hash}:{})}));}
if(${malformedFirst}&&role==='V'&&id==='TASK-REVIEW-1'&&!fs.existsSync(path.join(root,'.spec-loop','shared-cache','malformed-emitted'))){fs.writeFileSync(path.join(root,'.spec-loop','shared-cache','malformed-emitted'),'yes');const file=path.join(evidence,'RESULT.json'),result=JSON.parse(fs.readFileSync(file));delete result.verdict;fs.writeFileSync(file,JSON.stringify(result));}
console.log(JSON.stringify({usage:{input_tokens:1,output_tokens:1,total_tokens:2,cost_usd:0.001}}));
`);await chmod(provider,0o755)
  const providers=path.join(root,'.spec-loop','PROVIDERS.md');await writeFile(providers,(await readFile(providers,'utf8')).replace('executable: codex',`executable: ${provider}`))
  await writeMd(path.join(root,'.spec-loop','GATES.md'),{schema_version:1,scope_kind:'task',wave_id:'WREVIEW',coverage:'targeted',database:{lifecycle:'persistent',reset:'fixtures'},gates:[{id:'check',ac:['AC-1'],command:[process.execPath,'check.mjs'],timeout_seconds:30}]},'# Approved Gates\n\nDeterministic fixture check.')
  const taskIds=['TASK-REVIEW-1','TASK-REVIEW-2']
  for(const id of taskIds){
    const contract={schema_version:2,task_id:id,version:1,risk:'standard',critical_path:false,depends_on:[],criteria:[{id:'AC-1',text:'完整漏洞报告必须包含全部字段',risk_tags:['functional'],waivable:false}],use_cases:[{id:'UC-1',ac:['AC-1'],scenario:'check complete report fields'}],tools:[{id:'check',kind:'unit',gate_id:'check',command:[process.execPath,'check.mjs'],playwright:null}],assertions:[{id:'AS-1',ac:['AC-1'],tool_id:'check',operator:'exit_code_zero',expected:'exit code zero'}],evidence_requirements:[{id:'ER-1',ac:['AC-1'],tool_id:'check',kind:'test_report',required:true}],budgets:{max_semantic_reworks:2,max_infrastructure_retries_per_stage:1,repeated_failure_limit:2}}
    const file=path.join(root,id+'.json');await writeFile(file,JSON.stringify(contract))
    const proposal=cli(['triage','propose',root,'--source','approved wave fixture','--goal','完整报告与统一验收','--reason','test continuous repair and final review','--contract',file]);assert.equal(proposal.code,0,proposal.stderr)
    assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','owner']).code,0)
    const created=cli(['triage','create-task',root,proposal.stdout.trim(),'--id',id,'--title','报告字段校验']);assert.equal(created.code,0,created.stderr)
    const task=path.join(root,'.spec-loop','tasks',id.toLowerCase()),approvedSpec=await readMd(path.join(task,'SPEC.md'));await fillContracts(task,{id,title:'报告字段校验',level:'standard'})
    const filled=await readMd(path.join(task,'SPEC.md'));await writeMd(path.join(task,'SPEC.md'),{...filled.data,...approvedSpec.data},filled.body)
    if(visual&&id===taskIds[0]){const doc=await readMd(path.join(task,'ACCEPTANCE.md'));await writeMd(path.join(task,'ACCEPTANCE.md'),{...doc.data,human_reviews:[{id:'REVIEW-1',kind:'visual',required:true,ac:['AC-1']}]},doc.body)}
    assert.equal(cli(['plan',task]).code,0)
    if(visual&&id===taskIds[0])assert.equal(cli(['round',task]).code,0)
    await startAcceptanceRun(root,id)
  }
  git(repository,['add','.']);git(repository,['commit','-m','approved Task specs'])
  for(const id of taskIds){const workspace=cli(['workspace','create',root,id,'--json']);assert.equal(workspace.code,0,workspace.stderr)}
  await configureWaveBudget(root,{maxParallel:2,maxElapsedSeconds:120,maxTokens:1000,maxCostUsd:1})
  return{root,repository,taskIds,taskRoot:id=>path.join(root,'.spec-loop','tasks',id.toLowerCase())}
}
