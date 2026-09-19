import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cli, tempRoot } from './helpers.mjs';

test('project init, provider doctor and rebuildable task queries', async()=>{
  const root=await tempRoot('project-loop-');const repo=path.join(root,'repo');await mkdir(repo);
  assert.equal(cli(['project','init',root,'--id','PROJ-DEMO','--name','Demo','--repository',repo]).code,0);
  assert.match(await readFile(path.join(repo,'spec','README.md'),'utf8'),/目标工程自身/);
  assert.equal(cli(['project','spec-check',root,'--json']).code,0);
  await rm(path.join(repo,'spec','03-design','_template.md'));
  assert.notEqual(cli(['project','spec-check',root,'--json']).code,0);
  assert.equal(cli(['project','spec-init',root]).code,0);
  assert.equal(cli(['project','spec-check',root,'--json']).code,0);
  const providers=cli(['providers','show',root,'--json']);assert.equal(providers.code,0);const p=JSON.parse(providers.stdout);assert.equal(p.find(x=>x.id==='codex').active,true);assert.deepEqual(p.find(x=>x.id==='codex').roles,['M','V','R']);assert.equal(cli(['providers','set-role',root,'--role','V','--provider','codex']).code,0);assert.notEqual(cli(['providers','set-role',root,'--role','V','--provider','qoder']).code,0);assert.notEqual(cli(['providers','set',root,'--active','qoder']).code,0);
  const list=cli(['tasks','list',root,'--json']);assert.equal(list.code,0);assert.deepEqual(JSON.parse(list.stdout),[]);
});

test('proposal requires approval before task creation and registry rebuilds from task dirs', async()=>{
  const root=await tempRoot('project-proposal-');const repo=path.join(root,'repo');await mkdir(repo);
  cli(['project','init',root,'--id','PROJ-APP','--name','Approval','--repository',repo]);
  const proposal=cli(['triage','propose',root,'--source','manual project review','--goal','Add a deterministic health check','--risk','standard','--priority','P1','--reason','Project lacks a health signal','--ac','health command exits zero','regression tests pass']);assert.equal(proposal.code,0);assert.equal(proposal.stdout.trim(),'PROP-1');
  let create=cli(['triage','create-task',root,'PROP-1','--id','TASK-PROJECT-1','--title','Add health check']);assert.notEqual(create.code,0);assert.match(create.stderr,/no valid .* approval/);
  assert.equal(cli(['triage','approve',root,'PROP-1','--by','zhangbo']).code,0);
  create=cli(['triage','create-task',root,'PROP-1','--id','TASK-PROJECT-1','--title','Add health check']);assert.equal(create.code,0,create.stderr);
  const targetTask=await readFile(path.join(repo,'spec','04-task','TASK-PROJECT-1.md'),'utf8');assert.match(targetTask,/AC-1：health command exits zero/);assert.match(targetTask,/Spec-Loop Task/);
  const checked=cli(['project','spec-check',root,'--json']);assert.equal(checked.code,0,checked.stdout+checked.stderr);
  const tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);assert.equal(tasks.length,1);assert.equal(tasks[0].task_id,'TASK-PROJECT-1');assert.equal(tasks[0].status,'draft');
});

test('project default protocol requires complete v2 contracts without migrating existing v1 tasks',async()=>{
  const root=await tempRoot('project-protocol-'),repo=path.join(root,'repo');await mkdir(repo);
  assert.equal(cli(['project','init',root,'--id','PROJ-PROTOCOL','--name','Protocol','--repository',repo]).code,0);
  assert.equal(JSON.parse(cli(['project','protocol',root,'--json']).stdout).default_task_protocol,'v1');
  const legacy=cli(['triage','propose',root,'--source','legacy approved source','--goal','Keep v1 task','--reason','Compatibility proof','--ac','legacy behavior remains readable']);
  assert.equal(legacy.code,0,legacy.stderr);assert.equal(cli(['triage','approve',root,legacy.stdout.trim(),'--by','owner']).code,0);
  assert.equal(cli(['triage','create-task',root,legacy.stdout.trim(),'--id','TASK-LEGACY-1','--title','Keep v1 task']).code,0);
  assert.equal(cli(['project','protocol',root,'--set','v2']).code,0);
  assert.equal(JSON.parse(cli(['project','protocol',root,'--json']).stdout).default_task_protocol,'v2');
  const missing=cli(['triage','propose',root,'--source','new approved source','--goal','Require v2 task','--reason','New default protocol','--ac','must be rejected']);
  assert.notEqual(missing.code,0);assert.match(missing.stderr,/requires a P-prepared v2 Acceptance Contract/);
  const contractFile=path.join(root,'contract.json');
  await writeFile(contractFile,JSON.stringify({
    schema_version:2,task_id:'TASK-V2-1',version:1,risk:'standard',critical_path:false,depends_on:[],
    criteria:[{id:'AC-1',text:'v2 contract is enforced',risk_tags:['functional'],waivable:true}],
    use_cases:[{id:'UC-1',ac:['AC-1'],scenario:'create a task under the v2 project default'}],
    tools:[{id:'contract-test',kind:'unit',gate_id:'project-protocol-test',command:['node','--test','test/project.test.mjs'],playwright:null}],
    assertions:[{id:'AS-1',ac:['AC-1'],tool_id:'contract-test',operator:'exit_code_zero',expected:'exit code 0'}],
    evidence_requirements:[{id:'ER-1',ac:['AC-1'],tool_id:'contract-test',kind:'test_report',required:true}],
    budgets:{max_semantic_reworks:2,max_infrastructure_retries_per_stage:1,repeated_failure_limit:2},
  },null,2));
  const proposal=cli(['triage','propose',root,'--source','v2 approved source','--goal','Create v2 task','--risk','standard','--reason','Exercise v2 project default','--contract',contractFile]);
  assert.equal(proposal.code,0,proposal.stderr);assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','owner']).code,0);
  assert.equal(cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-V2-1','--title','Create v2 task']).code,0);
  await readFile(path.join(root,'.spec-loop','tasks','task-v2-1','ACCEPTANCE_CONTRACT_V2.md'),'utf8');
  await assert.rejects(readFile(path.join(root,'.spec-loop','tasks','task-legacy-1','ACCEPTANCE_CONTRACT_V2.md'),'utf8'));
  assert.match(await readFile(path.join(repo,'spec','04-task','TASK-V2-1.md'),'utf8'),/协议版本：P\/M\/V\/R v2/);
  let tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);
  assert.deepEqual(tasks.map(item=>[item.task_id,item.protocol,item.protocol_stage]),[
    ['TASK-LEGACY-1','v1',null],['TASK-V2-1','v2','contract_approved'],
  ]);
  assert.match(cli(['project','status',root]).stdout,/default_protocol=v2/);
  const doctor=JSON.parse(cli(['project','doctor',root,'--json']).stdout);
  assert.equal(doctor.ok,true);assert.equal(doctor.default_task_protocol,'v2');assert.equal(doctor.tasks[1].blocking_reason,null);
  assert.equal(cli(['project','protocol',root,'--set','v1']).code,0);
  tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);
  assert.deepEqual(tasks.map(item=>[item.task_id,item.protocol]),[['TASK-LEGACY-1','v1'],['TASK-V2-1','v2']]);
});

test('approved proposal explicitly adopts a matching draft target task', async()=>{
  const root=await tempRoot('project-adopt-');const repo=path.join(root,'repo');await mkdir(repo);
  cli(['project','init',root,'--id','PROJ-ADOPT','--name','Adopt','--repository',repo]);
  const target=path.join(repo,'spec','04-task','TASK-ADOPT-1.md');
  await writeFile(target,'# TASK-ADOPT-1：Adopt draft\n\n- 状态：草稿\n- 所属设计：[DES-001](../03-design/DES-001-example.md)\n\n## 目标\n\nAdopt safely.\n\n## 验收标准\n\n- [ ] AC-1：matching acceptance；\n');
  const proposal=cli(['triage','propose',root,'--source','approved product plan','--goal','Adopt safely','--reason','Draft was written before execution','--ac','matching acceptance']);assert.equal(proposal.code,0,proposal.stderr);
  cli(['triage','approve',root,proposal.stdout.trim(),'--by','zhangbo']);
  const rejected=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-1','--title','Adopt draft']);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/--adopt-existing/);
  const adopted=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-1','--title','Adopt draft','--adopt-existing']);assert.equal(adopted.code,0,adopted.stderr);
  const content=await readFile(target,'utf8');assert.match(content,/- 状态：已批准/);assert.match(content,/- Proposal：PROP-1/);assert.match(content,/- Spec-Loop Task：/);assert.match(content,/所属设计/);
});

test('fullstack proposals route backend TASK and frontend WEB-TASK into their source specification libraries',async()=>{
  const root=await tempRoot('project-fullstack-route-'),repo=path.join(root,'repo');await mkdir(repo);
  let result=cli(['project','init',root,'--id','PROJ-ROUTE','--name','Route','--repository',repo,'--spec-profile','fullstack']);
  assert.equal(result.code,0,result.stderr);
  for(const [source,goal,id] of [
    ['backend delivery','Implement backend health','TASK-API-1'],
    ['frontend delivery','Implement browser health','WEB-TASK-SHELL-1'],
  ]){
    const proposal=cli(['triage','propose',root,'--source',source,'--goal',goal,'--reason','Need an independently traceable delivery','--ac','health path passes']);
    assert.equal(proposal.code,0,proposal.stderr);
    assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','zhangbo']).code,0);
    result=cli(['triage','create-task',root,proposal.stdout.trim(),'--id',id,'--title',goal]);
    assert.equal(result.code,0,result.stderr);
  }
  assert.match(await readFile(path.join(repo,'backend','spec','05-task','TASK-API-1.md'),'utf8'),/Proposal：PROP-1/);
  assert.match(await readFile(path.join(repo,'frontend','spec','05-task','WEB-TASK-SHELL-1.md'),'utf8'),/Proposal：PROP-2/);
  const tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);
  assert.deepEqual(tasks.map(item=>item.task_id),['TASK-API-1','WEB-TASK-SHELL-1']);
});
