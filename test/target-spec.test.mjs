import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { cli, tempRoot } from './helpers.mjs';
import { containsRealPlaceholder, defaultTargetSpecAssetRoot, loadTargetSpecBundle, loadTargetSpecTemplate } from '../dist/target-spec.js';

async function projectFixture(name='TARGET'){
  const root=await tempRoot(`target-spec-${name.toLowerCase()}-`),repo=path.join(root,'repo');
  await mkdir(repo);
  const result=cli(['project','init',root,'--id',`PROJ-${name}`,'--name',name,'--repository',repo]);
  assert.equal(result.code,0,result.stderr);
  return {root,repo};
}

test('versioned target-spec manifest is complete and every bundled asset loads',async()=>{
  const template=await loadTargetSpecTemplate();
  assert.equal(template.schema_version,1);
  assert.equal(template.template_version,'1.1.1');
  assert.deepEqual(template.assets.map(x=>x.path),[
    'README.md','roadmap.md','architecture.md','pending-board.md','verification-board.md',
    '01-product/_template.md','02-feature/_template.md','03-design/_template.md','04-task/_template.md',
  ]);
  assert.equal(new Set(template.assets.map(x=>x.role)).size,9);
  assert.equal(template.assets.filter(x=>x.kind==='template').length,4);
  const legacy=await loadTargetSpecTemplate(path.resolve(defaultTargetSpecAssetRoot,'../v1'));
  assert.equal(legacy.template_version,'1.0.0');
  assert.doesNotMatch(legacy.assets.find(x=>x.path==='04-task/_template.md').content,/人工效果验收/);
  await assert.rejects(loadTargetSpecTemplate(path.join(defaultTargetSpecAssetRoot,'missing')),/manifest is missing/);
});

test('v3 backend, frontend and fullstack profiles load the split source specification libraries',async()=>{
  const backend=await loadTargetSpecBundle('backend'),frontend=await loadTargetSpecBundle('frontend'),fullstack=await loadTargetSpecBundle('fullstack');
  assert.equal(backend.template_version,'2.0.2');
  assert.equal(backend.primary_spec_root,'spec');
  assert.equal(backend.backend_task_root,'spec/05-task');
  assert.equal(backend.frontend_task_root,null);
  assert.ok(backend.assets.some(item=>item.install_path==='AGENT.md'));
  assert.ok(backend.assets.some(item=>item.install_path==='spec/03-decisions/_template.md'));
  assert.equal(frontend.frontend_task_root,'spec/05-task');
  assert.ok(frontend.assets.some(item=>item.install_path==='spec/05-task/_template.md'));
  assert.equal(fullstack.primary_spec_root,'backend/spec');
  assert.equal(fullstack.backend_task_root,'backend/spec/05-task');
  assert.equal(fullstack.frontend_task_root,'frontend/spec/05-task');
  assert.ok(fullstack.assets.some(item=>item.install_path==='backend/spec/architecture.md'));
  assert.ok(fullstack.assets.some(item=>item.install_path==='frontend/spec/00-conventions/development-guidelines.md'));
});

test('backend and frontend profiles install only their own specification library at the source root',async()=>{
  for(const profile of ['backend','frontend']){
    const root=await tempRoot(`target-spec-${profile}-`),repo=path.join(root,'repo');await mkdir(repo);
    const result=cli(['project','init',root,'--id',`PROJ-${profile.toUpperCase()}`,'--name',profile,'--repository',repo,'--spec-profile',profile]);
    assert.equal(result.code,0,result.stderr);
    assert.match(await readFile(path.join(repo,'AGENT.md'),'utf8'),profile==='backend'?/后端服务规格驱动/:/前端 Web 规格驱动/);
    assert.match(await readFile(path.join(repo,'spec','README.md'),'utf8'),profile==='backend'?/主规格库/:/卫星规格库/);
    if(profile==='backend')await assert.rejects(lstat(path.join(repo,'frontend')));
    else await assert.rejects(lstat(path.join(repo,'backend')));
  }
});

test('fullstack profile installs source-owned main and satellite specs, preserves files, and validates WEB-TASK traces',async()=>{
  const root=await tempRoot('target-spec-fullstack-'),repo=path.join(root,'repo'),custom='# Existing backend agent rules\n\nKeep this source-owned file unchanged.\n';
  await mkdir(path.join(repo,'backend'),{recursive:true});
  await writeFile(path.join(repo,'backend','AGENT.md'),custom);
  let result=cli(['project','init',root,'--id','PROJ-FULLSTACK','--name','Fullstack','--repository',repo,'--spec-profile','fullstack']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(await readFile(path.join(repo,'backend','AGENT.md'),'utf8'),custom);
  assert.match(await readFile(path.join(repo,'backend','spec','README.md'),'utf8'),/主规格库/);
  assert.match(await readFile(path.join(repo,'frontend','spec','README.md'),'utf8'),/卫星规格库/);
  const project=await readFile(path.join(root,'.spec-loop','PROJECT.md'),'utf8');
  assert.match(project,/spec_profile: fullstack/);
  assert.match(project,/spec_root: backend\/spec/);

  result=cli(['project','spec-check',root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stdout,/placeholder content/);
  for(const file of [
    'backend/spec/00-conventions/development-guidelines.md','backend/spec/roadmap.md','backend/spec/architecture.md',
    'frontend/spec/00-conventions/development-guidelines.md',
  ])await writeFile(path.join(repo,file),`# ${path.basename(file)}\n\n- 状态：已批准\n\nThe project-specific baseline is approved and contains no unresolved values.\n`);
  await writeFile(path.join(repo,'backend','spec','01-product','PROD-001-core.md'),'# PROD-001：Core product\n\n- 状态：已批准\n- Roadmap：[roadmap](../roadmap.md)\n\n## Result\n\nApproved product baseline.\n');
  await writeFile(path.join(repo,'backend','spec','02-feature','FEAT-001-shell.md'),'# FEAT-001：Application shell\n\n- 状态：已批准\n- 所属产品：[PROD-001](../01-product/PROD-001-core.md)\n\n## Result\n\nApproved feature baseline.\n');
  await writeFile(path.join(repo,'backend','spec','04-design','DES-001-shell.md'),'# DES-001：Application shell design\n\n- 状态：已批准\n- 所属特性：[FEAT-001](../02-feature/FEAT-001-shell.md)\n\n## Result\n\nApproved design and API contract.\n');
  await writeFile(path.join(repo,'frontend','spec','05-task','WEB-TASK-001-shell.md'),'# WEB-TASK-001：Application shell\n\n- 状态：已批准\n- 关联设计/API 契约：[`DES-001`](../../../backend/spec/04-design/DES-001-shell.md)\n\n## Result\n\nImplement the approved browser shell.\n');
  result=cli(['project','spec-check',root,'--json']);
  assert.equal(result.code,0,result.stdout+result.stderr);

  const missing=path.join(repo,'frontend','spec','05-task','_template.md');
  await rm(missing);
  result=cli(['project','spec-check',root,'--json']);
  assert.notEqual(result.code,0);assert.match(result.stdout,/missing target spec file/);
  result=cli(['project','spec-init',root,'--json']);
  assert.equal(result.code,0,result.stderr);
  assert.match(await readFile(missing,'utf8'),/WEB-TASK-000/);
});

test('Spec-Loop own specification library passes the shared checker',async()=>{
  const root=await tempRoot('target-spec-self-'),control=path.join(root,'.spec-loop'),now=new Date().toISOString();
  await mkdir(control,{recursive:true});
  await writeFile(path.join(control,'PROJECT.md'),`---
schema_version: 1
project_id: PROJ-SPEC-LOOP-SELF
name: Spec-Loop Self Check
repository: ${process.cwd()}
spec_root: spec
default_branch: main
tasks_root: .spec-loop/tasks
output_root: .spec-loop/output
risk_level: heavy
external_issue: null
created_at: ${now}
updated_at: ${now}
---

# Project

Temporary read-only metadata for the self-hosted specification check.
`);
  const result=cli(['project','spec-check',root,'--json']);
  assert.equal(result.code,0,result.stdout+result.stderr);
});

test('project init and spec-init share assets, fill gaps and never overwrite entries',async()=>{
  const root=await tempRoot('target-spec-preserve-'),repo=path.join(root,'repo'),custom='# Existing specification guide\n\nThis project-owned guide must remain byte-for-byte unchanged.\n';
  await mkdir(path.join(repo,'spec'),{recursive:true});
  await writeFile(path.join(repo,'spec','README.md'),custom);
  let result=cli(['project','init',root,'--id','PROJ-PRESERVE','--name','Preserve','--repository',repo]);
  assert.equal(result.code,0,result.stderr);
  const template=await loadTargetSpecTemplate();
  assert.equal(await readFile(path.join(repo,'spec','README.md'),'utf8'),custom);
  for(const asset of template.assets){
    if(asset.path!=='README.md')assert.equal(await readFile(path.join(repo,'spec',asset.path),'utf8'),asset.content);
  }
  const architecture=path.join(repo,'spec','architecture.md');
  await rm(architecture);
  result=cli(['project','spec-check',root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stdout,/missing target spec file: spec\/architecture\.md/);
  result=cli(['project','spec-init',root,'--json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(await readFile(architecture,'utf8'),template.assets.find(x=>x.role==='architecture').content);
  assert.equal(await readFile(path.join(repo,'spec','README.md'),'utf8'),custom);

  await rm(architecture);
  await symlink(path.join(repo,'missing-architecture.md'),architecture);
  result=cli(['project','spec-init',root,'--json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal((await lstat(architecture)).isSymbolicLink(),true);
  result=cli(['project','spec-check',root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stdout,/symbolic link/);
});

test('placeholder detection rejects unresolved values but permits explanatory prose and code',()=>{
  assert.equal(containsRealPlaceholder('# Result\n\nTODO\n'),true);
  assert.equal(containsRealPlaceholder('# Result\n\n- Owner: <owner>\n'),true);
  assert.equal(containsRealPlaceholder('# Result\n\n- Endpoint: https://<host>/v1\n'),true);
  assert.equal(containsRealPlaceholder('# Result\n\n- Owner: TODO (assign before delivery)\n'),true);
  assert.equal(containsRealPlaceholder('| Item | Value\n|---|---\n| owner | 待填写\n'),true);
  assert.equal(containsRealPlaceholder('# Rules\n\nThis checker rejects TODO, TBD, unknown and placeholder values.\n\n```text\nprojects/<project>/\nTODO\n```\n'),false);
});

test('spec-check accepts legal IDs with optional kebab-case names and prose terms',async()=>{
  const f=await projectFixture('NAMES'),spec=path.join(f.repo,'spec');
  await writeFile(path.join(spec,'01-product','PROD-001-core-product.md'),'# PROD-001：Core product\n\n- 状态：已批准\n- Roadmap：[roadmap](../roadmap.md)\n\n## Result\n\nThe product documents approved behavior.\n');
  await writeFile(path.join(spec,'02-feature','FEAT-001-health-check.md'),'# FEAT-001：Health check\n\n- 状态：进行中\n- 所属产品：[PROD-001](../01-product/PROD-001-core-product.md)\n\n## Rules\n\nThe checker rejects TODO, TBD, unknown and placeholder values when they are unresolved fields.\n');
  await writeFile(path.join(spec,'03-design','DES-001-health-check-design.md'),'# DES-001：Health design\n\n- 状态：待验证\n- 所属特性：[FEAT-001](../02-feature/FEAT-001-health-check.md)\n- 总体架构：[architecture](../architecture.md)\n\n## Design\n\nLiteral paths such as `projects/<project>/` are documentation, not unresolved content.\n');
  await writeFile(path.join(spec,'04-task','TASK-001-implement-health-check.md'),'# TASK-001：Implement health check\n\n- 状态：已完成\n- 所属设计：[DES-001](../03-design/DES-001-health-check-design.md)\n\n## Result\n\nThe implementation is complete and verified.\n');
  await writeFile(path.join(spec,'04-task','TASK-002.md'),'# TASK-002：Exact ID filename\n\n- 状态：草稿\n- 所属设计：[DES-001](../03-design/DES-001-health-check-design.md)\n\n## Goal\n\nExercise the backwards-compatible exact ID form.\n');
  const result=cli(['project','spec-check',f.root,'--json']);
  assert.equal(result.code,0,result.stdout+result.stderr);
});

test('spec-check adversarially rejects invalid names, IDs, statuses, placeholders and traces',async()=>{
  const f=await projectFixture('REJECT'),dir=path.join(f.repo,'spec','04-task');
  const check=()=>cli(['project','spec-check',f.root,'--json']);
  const validBody='- 状态：草稿\n- Proposal：PROP-1\n- Spec-Loop Task：.spec-loop/tasks/example\n\n## Goal\n\nExercise strict validation.\n';

  let file=path.join(dir,'TASK-003-Bad-Name.md');
  await writeFile(file,`# TASK-003：Bad filename\n\n${validBody}`);
  let result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/invalid target spec filename/);await rm(file);

  file=path.join(dir,'TASK-bad-name.md');
  await writeFile(file,`# TASK-bad：Bad ID\n\n${validBody}`);
  result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/invalid or missing target spec ID/);await rm(file);

  file=path.join(dir,'TASK-003.md');
  await writeFile(file,'# TASK-003：Bad status\n\n- 状态：部分完成\n- Proposal：PROP-1\n- Spec-Loop Task：.spec-loop/tasks/example\n\n## Goal\n\nExercise strict validation.\n');
  result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/invalid or missing target spec status/);await rm(file);

  await writeFile(file,'# TASK-003：Placeholder\n\n- 状态：草稿\n- Proposal：PROP-1\n- Spec-Loop Task：.spec-loop/tasks/example\n\n## Goal\n\nTODO\n');
  result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/placeholder content/);await rm(file);

  await writeFile(file,'# TASK-003：Broken trace\n\n- 状态：草稿\n- 所属设计：[DES-999](../03-design/DES-999-missing.md)\n\n## Goal\n\nExercise trace validation.\n');
  result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/broken upstream trace DES-999/);await rm(file);

  await symlink(path.join(f.repo,'outside.md'),file);
  result=check();assert.notEqual(result.code,0);assert.match(result.stdout,/symbolic link/);
});

test('spec-init and spec-check reject symlinked specification layers',async()=>{
  const f=await projectFixture('LAYER'),layer=path.join(f.repo,'spec','03-design'),outside=path.join(f.repo,'outside-design');
  await rm(layer,{recursive:true});
  await mkdir(outside);
  await symlink(outside,layer);
  let result=cli(['project','spec-check',f.root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stdout,/target spec layer must be a real directory/);
  result=cli(['project','spec-init',f.root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/target spec directory must (?:be a real directory|use real directories)/);
});

test('spec-init and spec-check reject symlinked ancestors of a nested spec_root',async()=>{
  const f=await projectFixture('ANCESTOR'),outside=path.join(f.root,'outside'),link=path.join(f.repo,'linked');
  await rm(path.join(f.repo,'spec'),{recursive:true});
  await mkdir(outside);
  await symlink(outside,link);
  const projectFile=path.join(f.root,'.spec-loop','PROJECT.md');
  const project=await readFile(projectFile,'utf8');
  await writeFile(projectFile,project.replace('spec_root: spec','spec_root: linked/spec'));
  let result=cli(['project','spec-check',f.root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stdout,/spec_root must use real directories: linked/);
  result=cli(['project','spec-init',f.root,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/spec_root must use real directories: linked/);
  await assert.rejects(lstat(path.join(outside,'spec')),/ENOENT/);
});
