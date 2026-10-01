import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cli, tempRoot } from './helpers.mjs';
import { assertSubstantive } from '../dist/files.js';

test('substantive checks preserve domain precision words but reject bare placeholders',()=>{
  assert.doesNotThrow(()=>assertSubstantive('Historical task timing has unknown precision after import.','criterion'));
  assert.doesNotThrow(()=>assertSubstantive('旧数据中的未知耗时要明确标识。','criterion'));
  assert.doesNotThrow(()=>assertSubstantive('仅含 unknown 的字段以及显式 TODO/TBD/待填写占位内容仍被拒绝。','criterion'));
  assert.doesNotThrow(()=>assertSubstantive('TODO must be rejected when used as an unfinished field.','criterion'));
  for(const value of ['unknown','未知','TODO','TBD','待填写','TODO:','待填写：','TODO: implement criterion','Complete this TODO field','验收步骤：待填写。','The validation strategy is TBD.','验收步骤：待填写（负责人确认后补充）。','The validation strategy is TBD pending review.','待填写（负责人确认后补充）。','TBD pending review.','TODO implement criterion','TODO is pending review.','TBD is pending review.','TODO must be implemented before acceptance.','TODO（负责人确认后补充）。','TBD(implement criterion)','The validation strategy is TBD(implement criterion).','The validation strategy is TBD（负责人确认后补充）。','验收步骤待填写','The validation strategy stays TBD.','TODO is pending review; TODO is a placeholder term.','TODO is a placeholder term and the validation strategy is TBD.','显式 TODO/TBD/待填写占位内容仍被拒绝且验收步骤待填写。','placeholder: acceptance steps to be completed after review','fill me with the acceptance steps after review','The acceptance steps are placeholders pending review.']){
    assert.throws(()=>assertSubstantive(value,'criterion'),/placeholder content/);
  }
});

test('original TASK-029 contract passes the P Proposal entry without acceptance text changes',async()=>{
  const contract=JSON.parse(await readFile(new URL('./fixtures/task-029-original-contract.json',import.meta.url),'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(contract)).digest('hex'),'61004c12ac3f77fc96e1f3d47ae5cc5cb0111eb234457292fc3cdb3d4cf8459b');
  const root=await tempRoot('project-task-029-proposal-'),repo=path.join(root,'repo');await mkdir(repo);
  const initialized=cli(['project','init',root,'--id','PROJ-TASK-029','--name','Original contract','--repository',repo]);
  assert.equal(initialized.code,0,initialized.stderr);
  assert.equal(cli(['project','protocol',root,'--set','v2']).code,0);
  const contractFile=path.join(root,'contract.json');await writeFile(contractFile,JSON.stringify(contract));
  const result=cli(['triage','propose',root,'--source','Approved Phase 4 TASK-029 Heavy specification','--goal','Finalize execution-view compatibility, security, performance and browser Heavy validation','--risk','heavy','--reason','TASK-029 original approved contract','--contract',contractFile]);
  assert.equal(result.code,0,result.stderr);
  const proposal=JSON.parse(await readFile(path.join(root,'.spec-loop','proposals',`${result.stdout.trim()}.json`),'utf8'));
  assert.deepEqual(proposal.acceptance_contract,contract);
  assert.deepEqual(proposal.initial_acceptance,contract.criteria.map(({id,text})=>({id,text})));
});

test('Proposal entry rejects placeholder fields independently',async()=>{
  const original=JSON.parse(await readFile(new URL('./fixtures/task-029-original-contract.json',import.meta.url),'utf8'));
  const root=await tempRoot('project-proposal-placeholders-'),repo=path.join(root,'repo');await mkdir(repo);
  const initialized=cli(['project','init',root,'--id','PROJ-PLACEHOLDERS','--name','Placeholders','--repository',repo]);
  assert.equal(initialized.code,0,initialized.stderr);
  assert.equal(cli(['project','protocol',root,'--set','v2']).code,0);
  const contractFile=path.join(root,'contract.json');
  for(const [field,value,rejection] of [['source','unknown'],['goal','TODO:'],['reason','待填写：'],['criterion','unknown'],['criterion','未知',/Too small/],['criterion','验收步骤：待填写。'],['criterion','验收步骤：待填写（负责人确认后补充）。'],['criterion','待填写（负责人确认后补充）。'],['criterion','TODO is pending review.'],['criterion','TODO（负责人确认后补充）。'],['criterion','验收步骤待填写'],['criterion','显式 TODO/TBD/待填写占位内容仍被拒绝且验收步骤待填写。'],['scenario','TBD:'],['scenario','TBD pending review.'],['scenario','TBD is pending review.'],['scenario','TBD(implement criterion)'],['expected','待填写：'],['expected','The validation strategy is TBD.'],['expected','The validation strategy is TBD pending review.'],['expected','The validation strategy is TBD(implement criterion).'],['expected','The validation strategy is TBD（负责人确认后补充）。'],['expected','The validation strategy stays TBD.'],['expected','TODO is a placeholder term and the validation strategy is TBD.'],['expected','TODO implement criterion'],['expected','TODO must be implemented before acceptance.']]){
    const contract=structuredClone(original);
    if(field==='criterion')contract.criteria[0].text=value;
    if(field==='scenario')contract.use_cases[0].scenario=value;
    if(field==='expected')contract.assertions[0].expected=value;
    await writeFile(contractFile,JSON.stringify(contract));
    const result=cli(['triage','propose',root,'--source',field==='source'?value:'Approved source','--goal',field==='goal'?value:'Create the approved task','--risk','heavy','--reason',field==='reason'?value:'Approved reason','--contract',contractFile]);
    assert.notEqual(result.code,0,`${field}=${value} unexpectedly passed`);
    assert.match(result.stderr,rejection??/placeholder content/,`${field}=${value} failed for an unrelated reason`);
  }
  for(const value of ['placeholder: acceptance steps to be completed after review','fill me with the acceptance steps after review','The acceptance steps are placeholder pending review.','The acceptance steps are placeholders pending review.']){
    const contract=structuredClone(original);
    contract.criteria[0].text=value;
    await writeFile(contractFile,JSON.stringify(contract));
    const rejected=cli(['triage','propose',root,'--source','Approved source','--goal','Create the approved task','--risk','heavy','--reason','Approved reason','--contract',contractFile]);
    assert.notEqual(rejected.code,0,`${value} unexpectedly passed`);
    assert.match(rejected.stderr,/placeholder content/,`${value} failed for an unrelated reason`);
  }
  const explanation=structuredClone(original);
  explanation.criteria[0].text='TODO is a placeholder term; complete acceptance criteria must explain this rule.';
  await writeFile(contractFile,JSON.stringify(explanation));
  const accepted=cli(['triage','propose',root,'--source','Approved source','--goal','Explain placeholder validation','--risk','heavy','--reason','Complete explanatory acceptance text','--contract',contractFile]);
  assert.equal(accepted.code,0,accepted.stderr);
});

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
    criteria:[{id:'AC-1',text:'v2 contract is enforced while old timing may have unknown precision',risk_tags:['functional'],waivable:true}],
    use_cases:[{id:'UC-1',ac:['AC-1'],scenario:'create a task under the v2 project default with unknown timing'}],
    tools:[{id:'contract-test',kind:'unit',gate_id:'project-protocol-test',command:['node','--test','test/project.test.mjs'],playwright:null}],
    assertions:[{id:'AS-1',ac:['AC-1'],tool_id:'contract-test',operator:'exit_code_zero',expected:'exit code 0'}],
    evidence_requirements:[{id:'ER-1',ac:['AC-1'],tool_id:'contract-test',kind:'test_report',required:true}],
    budgets:{max_semantic_reworks:2,max_infrastructure_retries_per_stage:1,repeated_failure_limit:2},
  },null,2));
  const proposal=cli(['triage','propose',root,'--source','v2 approved source','--goal','Create v2 task','--risk','standard','--reason','Exercise v2 project default','--contract',contractFile]);
  assert.equal(proposal.code,0,proposal.stderr);assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','owner']).code,0);
  const approvalFile=path.join(root,'.spec-loop','approvals','APR-2.json');
  const approvalSignatureFile=path.join(root,'.spec-loop','approvals','APR-2.sha256');
  const approvedRaw=await readFile(approvalFile,'utf8');
  const approvedSignature=await readFile(approvalSignatureFile,'utf8');
  const extendedRaw=JSON.stringify({...JSON.parse(approvedRaw),expires_at:'2099-01-01T00:00:00.000Z'},null,2)+'\n';
  await writeFile(approvalFile,extendedRaw);
  const alteredApproval=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-V2-1','--title','Create v2 task']);
  assert.notEqual(alteredApproval.code,0);assert.match(alteredApproval.stderr,/no valid create_task approval/);
  await writeFile(approvalSignatureFile,`${createHash('sha256').update(extendedRaw).digest('hex')}\n`);
  assert.notEqual(cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-V2-1','--title','Create v2 task']).code,0);
  const downgradedApproval=JSON.parse(approvedRaw);downgradedApproval.schema_version=1;delete downgradedApproval.contract_hash;
  await writeFile(approvalFile,JSON.stringify(downgradedApproval,null,2)+'\n');
  assert.notEqual(cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-V2-1','--title','Create v2 task']).code,0);
  const proposalFile=path.join(root,'.spec-loop','proposals',`${proposal.stdout.trim()}.json`);
  const proposalRaw=await readFile(proposalFile,'utf8');
  const downgradedProposal=JSON.parse(proposalRaw);downgradedProposal.schema_version=1;delete downgradedProposal.acceptance_contract;
  const downgradedProposalRaw=JSON.stringify(downgradedProposal,null,2)+'\n';
  await writeFile(proposalFile,downgradedProposalRaw);
  downgradedApproval.proposal_hash=createHash('sha256').update(downgradedProposalRaw).digest('hex');
  await writeFile(approvalFile,JSON.stringify(downgradedApproval,null,2)+'\n');
  assert.notEqual(cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-V2-1','--title','Create v2 task']).code,0);
  await writeFile(proposalFile,proposalRaw);
  await writeFile(approvalFile,approvedRaw);
  await writeFile(approvalSignatureFile,approvedSignature);
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
  const approvedContractFile=path.join(root,'.spec-loop','tasks','task-v2-1','ACCEPTANCE_CONTRACT_V2.md');
  const approvedContractRaw=await readFile(approvedContractFile,'utf8');
  await writeFile(approvedContractFile,approvedContractRaw.replace(/^(contract_hash: )[a-f0-9]{64}$/m,`$1${'0'.repeat(64)}`));
  const invalidDoctor=JSON.parse(cli(['project','doctor',root,'--json']).stdout);
  assert.equal(invalidDoctor.ok,false);assert.equal(invalidDoctor.tasks[1].blocking_reason,'invalid v2 contract');
  await writeFile(approvedContractFile,approvedContractRaw);
  assert.equal(cli(['project','protocol',root,'--set','v1']).code,0);
  tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);
  assert.deepEqual(tasks.map(item=>[item.task_id,item.protocol]),[['TASK-LEGACY-1','v1'],['TASK-V2-1','v2']]);
});

test('approved proposal explicitly adopts a matching named draft target task', async()=>{
  const root=await tempRoot('project-adopt-');const repo=path.join(root,'repo');await mkdir(repo);
  cli(['project','init',root,'--id','PROJ-ADOPT','--name','Adopt','--repository',repo]);
  const target=path.join(repo,'spec','04-task','TASK-ADOPT-1-existing-draft.md');
  await writeFile(target,'# TASK-ADOPT-1：Adopt draft\n\n- 状态：草稿\n- 所属设计：[DES-001](../03-design/DES-001-example.md)\n\n## 目标\n\nAdopt safely.\n\n## 验收标准\n\n- [ ] AC-1：matching acceptance；\n');
  const proposal=cli(['triage','propose',root,'--source','approved product plan','--goal','Adopt safely','--reason','Draft was written before execution','--ac','matching acceptance']);assert.equal(proposal.code,0,proposal.stderr);
  cli(['triage','approve',root,proposal.stdout.trim(),'--by','zhangbo']);
  const rejected=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-1','--title','Adopt draft']);assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/--adopt-existing/);
  const adopted=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-1','--title','Adopt draft','--adopt-existing']);assert.equal(adopted.code,0,adopted.stderr);
  const content=await readFile(target,'utf8');assert.match(content,/- 状态：已批准/);assert.match(content,/- Proposal：PROP-1/);assert.match(content,/- Spec-Loop Task：/);assert.match(content,/所属设计/);
  assert.match(await readFile(path.join(root,'.spec-loop','tasks','task-adopt-1','SPEC.md'),'utf8'),/target_spec: spec\/04-task\/TASK-ADOPT-1-existing-draft\.md/);
  await assert.rejects(readFile(path.join(repo,'spec','04-task','TASK-ADOPT-1.md'),'utf8'));
});

test('approved v2 proposal adopts an exact approved but unbound target task', async()=>{
  const root=await tempRoot('project-adopt-approved-'),repo=path.join(root,'repo');await mkdir(repo);
  assert.equal(cli(['project','init',root,'--id','PROJ-ADOPT-APPROVED','--name','Adopt approved','--repository',repo]).code,0);
  assert.equal(cli(['project','protocol',root,'--set','v2']).code,0);
  const target=path.join(repo,'spec','04-task','TASK-ADOPT-3-approved.md');
  await writeFile(target,'# TASK-ADOPT-3：Adopt approved\n\n- 状态：已批准\n- 风险等级：standard\n\n## 验收标准\n\n- [ ] AC-1：approved target remains approved\n');
  const contractFile=path.join(root,'contract.json');
  await writeFile(contractFile,JSON.stringify({
    schema_version:2,task_id:'TASK-ADOPT-3',version:1,risk:'standard',critical_path:false,depends_on:[],
    criteria:[{id:'AC-1',text:'approved target remains approved',risk_tags:['functional'],waivable:false}],
    use_cases:[{id:'UC-1',ac:['AC-1'],scenario:'adopt an already approved task without changing its acceptance'}],
    tools:[{id:'adopt-test',kind:'unit',gate_id:'adopt-test',command:['node','--test','test/project.test.mjs'],playwright:null}],
    assertions:[{id:'AS-1',ac:['AC-1'],tool_id:'adopt-test',operator:'exit_code_zero',expected:'target remains approved'}],
    evidence_requirements:[{id:'ER-1',ac:['AC-1'],tool_id:'adopt-test',kind:'test_report',required:true}],
    budgets:{max_semantic_reworks:2,max_infrastructure_retries_per_stage:1,repeated_failure_limit:2},
  },null,2));
  const proposal=cli(['triage','propose',root,'--source','approved target task','--goal','Adopt approved target','--risk','standard','--reason','Bind an existing approved task','--contract',contractFile]);
  assert.equal(proposal.code,0,proposal.stderr);
  assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','owner']).code,0);
  const adopted=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-3','--title','Adopt approved','--adopt-existing']);
  assert.equal(adopted.code,0,adopted.stderr);
  const content=await readFile(target,'utf8');assert.match(content,/^- 状态：已批准$/m);assert.match(content,/^- Proposal：PROP-1$/m);
  assert.match(content,/^- Spec-Loop Task：/m);
  assert.match(await readFile(path.join(root,'.spec-loop','tasks','task-adopt-3','ACCEPTANCE_CONTRACT_V2.md'),'utf8'),/contract_hash:/);
});

test('task creation fails closed when multiple target specs match one ID',async()=>{
  const root=await tempRoot('project-adopt-ambiguous-'),repo=path.join(root,'repo');await mkdir(repo);
  cli(['project','init',root,'--id','PROJ-ADOPT-AMBIGUOUS','--name','Adopt ambiguous','--repository',repo]);
  const directory=path.join(repo,'spec','04-task');
  for(const name of ['TASK-ADOPT-2-first.md','TASK-ADOPT-2-second.md'])await writeFile(path.join(directory,name),'# TASK-ADOPT-2：Adopt draft\n\n- 状态：草稿\n\n## 验收标准\n\n- [ ] AC-1：matching acceptance\n');
  const proposal=cli(['triage','propose',root,'--source','approved product plan','--goal','Adopt safely','--reason','Reject ambiguous authority','--ac','matching acceptance']);assert.equal(proposal.code,0,proposal.stderr);
  assert.equal(cli(['triage','approve',root,proposal.stdout.trim(),'--by','zhangbo']).code,0);
  const result=cli(['triage','create-task',root,proposal.stdout.trim(),'--id','TASK-ADOPT-2','--title','Adopt draft','--adopt-existing']);assert.notEqual(result.code,0);assert.match(result.stderr,/multiple target task specs/);
  await assert.rejects(readFile(path.join(root,'.spec-loop','tasks','task-adopt-2','TASK_STATE.md'),'utf8'));
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
