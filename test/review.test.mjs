import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { artifact, cli, fillContracts, fillRound, readMd, tempRoot, writeMd } from './helpers.mjs';

async function visualTask(name='VISUAL'){
  const parent=await tempRoot(`review-${name.toLowerCase()}-`),root=path.join(parent,'task'),repo=path.join(parent,'repo');
  await mkdir(repo);spawnSync('git',['init','-b','main'],{cwd:repo});spawnSync('git',['config','user.email','test@example.com'],{cwd:repo});spawnSync('git',['config','user.name','Test'],{cwd:repo});
  await writeFile(path.join(repo,'app.txt'),'candidate\n');spawnSync('git',['add','.'],{cwd:repo});spawnSync('git',['commit','-m','candidate'],{cwd:repo});
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim();
  assert.equal(cli(['init',root,'--level','standard','--id',`TASK-${name}`,'--title','Review visual result','--repository',repo]).code,0);
  await fillContracts(root,{id:`TASK-${name}`,title:'Review visual result',level:'standard',criteria:['web behavior works','visual result is accepted']});
  const acceptance=await readMd(path.join(root,'ACCEPTANCE.md'));
  await writeMd(path.join(root,'ACCEPTANCE.md'),{
    ...acceptance.data,
    human_reviews:[{id:'REVIEW-1',kind:'visual',required:true,ac:['AC-2']}],
  },acceptance.body);
  const planned=cli(['plan',root]);assert.equal(planned.code,0,planned.stderr);
  assert.equal(cli(['round',root]).code,0);
  await fillRound(root,1);
  const screenshot=path.join(root,'candidate.png');
  await writeFile(screenshot,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
  const evidence=await artifact(root,'verification.txt');
  return{root,repo,revision,screenshot,evidence};
}

test('required visual review blocks verification until revision-bound human approval',async()=>{
  const f=await visualTask('VISUAL');
  let result=cli(['verify',f.root,'--result','pass','--evidence',f.evidence,'--verifier','checker','--revision',f.revision]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/required visual review has not been requested/);

  result=cli(['review','request',f.root,'--id','REVIEW-1','--revision',f.revision,'--evidence',f.screenshot,'--json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'pending');
  result=cli(['review','decide',f.root,'--id','REVIEW-1','--result','approved','--by','zhangbo','--note','界面层级、密度和主要交互效果符合预期','--json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'approved');
  result=cli(['review','status',f.root,'--json']);
  assert.equal(JSON.parse(result.stdout)[0].code_revision,f.revision);

  result=cli(['verify',f.root,'--result','pass','--evidence',f.evidence,'--verifier','checker','--revision',f.revision]);
  assert.equal(result.code,0,result.stderr);
  assert.match(result.stdout,/verifying/);
});

test('visual approval is invalid after revision drift or screenshot tampering',async()=>{
  const stale=await visualTask('STALE');
  assert.equal(cli(['review','request',stale.root,'--id','REVIEW-1','--revision',stale.revision,'--evidence',stale.screenshot]).code,0);
  assert.equal(cli(['review','decide',stale.root,'--id','REVIEW-1','--result','approved','--by','reviewer','--note','效果图通过']).code,0);
  await writeFile(path.join(stale.repo,'app.txt'),'candidate b\n');spawnSync('git',['add','.'],{cwd:stale.repo});spawnSync('git',['commit','-m','candidate b'],{cwd:stale.repo});
  const nextRevision=spawnSync('git',['rev-parse','HEAD'],{cwd:stale.repo,encoding:'utf8'}).stdout.trim();
  let result=cli(['verify',stale.root,'--result','pass','--evidence',stale.evidence,'--verifier','checker','--revision',nextRevision]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/stale for current Round, revision or Acceptance/);

  const tamper=await visualTask('TAMPERVISUAL');
  result=cli(['review','request',tamper.root,'--id','REVIEW-1','--revision',tamper.revision,'--evidence',tamper.screenshot,'--json']);
  assert.equal(result.code,0,result.stderr);
  const record=JSON.parse(result.stdout);
  assert.equal(cli(['review','decide',tamper.root,'--id','REVIEW-1','--result','approved','--by','reviewer','--note','效果图通过']).code,0);
  await writeFile(path.join(tamper.root,record.artifacts[0].file),'forged image');
  result=cli(['verify',tamper.root,'--result','pass','--evidence',tamper.evidence,'--verifier','checker','--revision',tamper.revision]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/artifact hash or media validation failed/);
});

test('visual review request only accepts image evidence',async()=>{
  const f=await visualTask('MEDIA');
  const text=path.join(f.root,'not-an-image.txt');
  await writeFile(text,'not an image');
  const result=cli(['review','request',f.root,'--id','REVIEW-1','--revision',f.revision,'--evidence',text]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/only accepts PNG/);
  const fake=path.join(f.root,'fake.png');
  await writeFile(fake,Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000000000000000000049444154000000000000000049454e4400000000','hex'));
  const forged=cli(['review','request',f.root,'--id','REVIEW-1','--revision',f.revision,'--evidence',fake]);
  assert.notEqual(forged.code,0);
  assert.match(forged.stderr,/not a valid image\/png/);
});

test('visual review rejects a symbolic parent directory',async()=>{
  const f=await visualTask('SYMLINKPARENT'),outside=path.join(path.dirname(f.root),'outside-reviews');
  await mkdir(outside);
  await symlink(outside,path.join(f.root,'reviews'));
  const result=cli(['review','request',f.root,'--id','REVIEW-1','--revision',f.revision,'--evidence',f.screenshot]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/parent is symbolic/);
});

test('visual contract downgrade and decision projection forgery are rejected',async()=>{
  const contract=await visualTask('CONTRACT');
  const acceptance=await readMd(path.join(contract.root,'ACCEPTANCE.md'));
  const downgraded={...acceptance.data,human_reviews:[],web_gates:[]};
  await writeMd(path.join(contract.root,'ACCEPTANCE.md'),downgraded,acceptance.body);
  const plan=await readMd(path.join(contract.root,'PLAN.md'));
  const forgedHash=createHash('sha256').update(JSON.stringify(downgraded)).digest('hex');
  await writeMd(path.join(contract.root,'PLAN.md'),{...plan.data,acceptance_hash:forgedHash},plan.body);
  let result=cli(['verify',contract.root,'--result','pass','--evidence',contract.evidence,'--verifier','checker','--revision',contract.revision]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/ACCEPTANCE.md changed after plan/);

  const forged=await visualTask('FORGED');
  assert.equal(cli(['review','request',forged.root,'--id','REVIEW-1','--revision',forged.revision,'--evidence',forged.screenshot]).code,0);
  const review=await readMd(path.join(forged.root,'reviews','REVIEW-1.md'));
  await writeMd(path.join(forged.root,'reviews','REVIEW-1.md'),{
    ...review.data,status:'approved',reviewer:'forger',reviewed_at:new Date().toISOString(),note:'forged',
    decision_hash:review.data.history_tail_hash,
  },review.body);
  result=cli(['verify',forged.root,'--result','pass','--evidence',forged.evidence,'--verifier','checker','--revision',forged.revision]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/(projection differs|pending review history is inconsistent|decision history differs)/);
});
