import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { cli, tempRoot } from './helpers.mjs';
import { containsRealPlaceholder, defaultTargetSpecAssetRoot, loadTargetSpecTemplate } from '../dist/target-spec.js';

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
  assert.match(template.template_version,/^\d+\.\d+\.\d+$/);
  assert.deepEqual(template.assets.map(x=>x.path),[
    'README.md','roadmap.md','architecture.md','pending-board.md','verification-board.md',
    '01-product/_template.md','02-feature/_template.md','03-design/_template.md','04-task/_template.md',
  ]);
  assert.equal(new Set(template.assets.map(x=>x.role)).size,9);
  assert.equal(template.assets.filter(x=>x.kind==='template').length,4);
  await assert.rejects(loadTargetSpecTemplate(path.join(defaultTargetSpecAssetRoot,'missing')),/manifest is missing/);
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
  assert.match(result.stderr,/target spec directory must be a real directory/);
});
