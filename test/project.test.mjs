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
  const providers=cli(['providers','show',root,'--json']);assert.equal(providers.code,0);const p=JSON.parse(providers.stdout);assert.equal(p.find(x=>x.id==='codex').active,true);assert.notEqual(cli(['providers','set',root,'--active','qoder']).code,0);
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
  const tasks=JSON.parse(cli(['tasks','list',root,'--json']).stdout);assert.equal(tasks.length,1);assert.equal(tasks[0].task_id,'TASK-PROJECT-1');assert.equal(tasks[0].status,'draft');
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
