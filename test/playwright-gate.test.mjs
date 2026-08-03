import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { artifact, cli, fillDelivery, fillRound, readMd, tempRoot, writeMd } from './helpers.mjs';

function git(cwd,args){const result=spawnSync('git',args,{cwd,encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim()}

async function webFixture(name='WEB',tests=['tests/e2e.spec.ts'],timeoutSeconds=30,deleteTrackedCandidate=false,packageRoot='.',requireScreenshots=true,includeLock=true){
  const root=await tempRoot(`playwright-${name.toLowerCase()}-`),repo=path.join(root,'repo');
  await mkdir(path.join(repo,packageRoot,'node_modules','@playwright','test'),{recursive:true});
  await mkdir(path.join(repo,'tests'),{recursive:true});
  const fakeCli=String.raw`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),output=args[args.indexOf('--output')+1];
const mode=args.join(' '),hang=mode.includes('hang');
if(hang){setTimeout(()=>{},10000)}else{
fs.mkdirSync(output,{recursive:true});
fs.mkdirSync(process.env.PLAYWRIGHT_HTML_OUTPUT_DIR,{recursive:true});
const zero=args.some(value=>value.includes('zero'));
const flaky=mode.includes('flaky'),skipped=mode.includes('skipped');
const report={config:{rootDir:process.cwd()},suites:[{title:'e2e',specs:zero?[]:[{title:'flow',tests:[{projectName:'chromium',results:[{status:'passed'}]}]}]}],stats:{expected:zero?0:1,unexpected:0,flaky:flaky?1:0,skipped:skipped?1:0,duration:17}};
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE,JSON.stringify(report));
if(!mode.includes('nohtml'))fs.writeFileSync(path.join(process.env.PLAYWRIGHT_HTML_OUTPUT_DIR,'index.html'),'<html><body>Playwright report</body></html>');
if(!zero&&!mode.includes('noscreenshot'))fs.writeFileSync(path.join(output,'home.png'),mode.includes('badimage')?Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000000000000000000049444154000000000000000049454e4400000000','hex'):Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
console.log(zero?'zero tests':'one browser test passed');`;
  const fakeCliClosed=`${fakeCli}\n}`;
  await writeFile(path.join(repo,packageRoot,'node_modules','@playwright','test','cli.js'),fakeCliClosed);
  await writeFile(path.join(repo,packageRoot,'node_modules','@playwright','test','package.json'),JSON.stringify({name:'@playwright/test',version:'1.50.0'}));
  if(includeLock)await writeFile(path.join(repo,packageRoot,'package-lock.json'),JSON.stringify({
    name:'web-fixture',lockfileVersion:3,packages:{'':{name:'web-fixture'},'node_modules/@playwright/test':{version:'1.50.0'}},
  }));
  await writeFile(path.join(repo,'delete-me.txt'),'tracked candidate file\n');
  for(const testPath of tests){
    await mkdir(path.dirname(path.join(repo,testPath)),{recursive:true});
    await writeFile(path.join(repo,testPath),'// target Playwright test fixture\n');
  }
  git(repo,['init','-b','main']);git(repo,['config','user.email','test@example.com']);git(repo,['config','user.name','Test']);
  git(repo,['add','-f','.']);git(repo,['commit','-m','initial web fixture']);
  assert.equal(cli(['project','init',root,'--id',`PROJ-${name}`,'--name',name,'--repository',repo]).code,0);
  const proposal=cli(['triage','propose',root,'--source','web delivery','--goal','Verify browser behavior','--reason','Need real browser evidence','--ac','browser flow passes']).stdout.trim();
  assert.equal(cli(['triage','approve',root,proposal,'--by','reviewer']).code,0);
  assert.equal(cli(['triage','create-task',root,proposal,'--id',`TASK-${name}`,'--title','Verify web flow']).code,0);
  const task=path.join(root,'.spec-loop','tasks',`task-${name.toLowerCase()}`);
  const acceptance=await readMd(path.join(task,'ACCEPTANCE.md'));
  await writeMd(path.join(task,'ACCEPTANCE.md'),{...acceptance.data,web_gates:[{id:'web-e2e',kind:'playwright',required:true,ac:['AC-1']}]},acceptance.body);
  await writeMd(path.join(task,'PLAN.md'),{schema_version:1,task_id:`TASK-${name}`,version:1,ac_coverage:['AC-1']},'# Plan\n\nRun the target-local Playwright suite and collect browser evidence.');
  const planned=cli(['plan',task]);assert.equal(planned.code,0,planned.stderr);assert.equal(cli(['round',task]).code,0);
  await fillRound(task,1);
  git(repo,['add','.']);git(repo,['commit','-m','add target specifications']);
  const provider=path.join(root,'.spec-loop','PROVIDERS.md'),providerDoc=(await readFile(provider,'utf8')).replace('executable: codex','executable: /usr/bin/true');
  await writeFile(provider,providerDoc);
  await writeMd(path.join(root,'.spec-loop','GATES.md'),{
    schema_version:1,
    gates:[{id:'web-e2e',kind:'playwright',ac:['AC-1'],tests,projects:[],timeout_seconds:timeoutSeconds,require_screenshots:requireScreenshots}],
  },'# Gates\n\nTarget-local Playwright functional and visual verification.');
  const workspaceResult=cli(['workspace','create',root,`TASK-${name}`,'--json']);assert.equal(workspaceResult.code,0,workspaceResult.stderr);
  const workspace=JSON.parse(workspaceResult.stdout),candidateFile=path.join(workspace.worktree,tests[0]),candidateContent='// dirty candidate content v1\n';
  await writeFile(candidateFile,candidateContent);
  if(deleteTrackedCandidate)await rm(path.join(workspace.worktree,'delete-me.txt'));
  assert.equal(cli(['harness','prepare',root,`TASK-${name}`,'--prompt','verify web']).code,0);
  assert.equal(cli(['harness','execute',root,`TASK-${name}`,'--prompt','verify web']).code,0);
  assert.equal(cli(['harness','collect',root,`TASK-${name}`]).code,0);
  return{root,task,taskId:`TASK-${name}`,candidateFile,candidateContent};
}

test('Playwright Gate runs target-local CLI, proves tests ran, and hashes browser artifacts',async()=>{
  const f=await webFixture();
  let result=cli(['harness','verify',f.root,f.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);
  const gate=JSON.parse(result.stdout)[0];
  assert.equal(gate.kind,'playwright');
  assert.equal(gate.exit_code,0);
  assert.equal(gate.web_evidence.stats.expected,1);
  assert.equal(gate.web_evidence.screenshots,1);
  assert.match(gate.plan_sha256,/^[a-f0-9]{64}$/);
  const manifest=JSON.parse(await readFile(path.join(f.root,gate.web_evidence.manifest),'utf8'));
  assert.equal(manifest.runner.lockfile,'package-lock.json');
  const screenshot=manifest.files.find(item=>item.file.endsWith('/home.png'));
  assert.ok(screenshot);

  const gateFile=path.join(f.root,'.spec-loop','GATES.md'),gateDoc=await readMd(gateFile);
  gateDoc.data.gates[0].timeout_seconds=31;
  await writeMd(gateFile,gateDoc.data,gateDoc.body);
  result=cli(['harness','report',f.root,f.taskId]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/Gate Plan/);
  gateDoc.data.gates[0].timeout_seconds=30;
  await writeMd(gateFile,gateDoc.data,gateDoc.body);

  const original=await readFile(path.join(f.root,screenshot.file));
  await writeFile(path.join(f.root,screenshot.file),'tampered');
  result=cli(['harness','report',f.root,f.taskId]);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/Playwright attachment hash mismatch/);
  await writeFile(path.join(f.root,screenshot.file),original);
  result=cli(['harness','report',f.root,f.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);
  const report=JSON.parse(result.stdout);assert.equal(report.passed,true);
  const verificationArtifact=await artifact(f.task,'web-verification.txt');
  await writeFile(f.candidateFile,'// dirty candidate content v2 with same Git status\n');
  result=cli(['verify',f.task,'--result','pass','--evidence',verificationArtifact,'--verifier','independent-web-verifier','--revision',report.head]);
  assert.notEqual(result.code,0);assert.match(result.stderr,/candidate worktree changed after Harness Report/);
  await writeFile(f.candidateFile,f.candidateContent);
  result=cli(['verify',f.task,'--result','pass','--evidence',verificationArtifact,'--verifier','independent-web-verifier','--revision',report.head]);
  assert.equal(result.code,0,result.stderr);
  const nativeEvidence=JSON.parse(await readFile(path.join(f.task,'evidence','EV-1.json'),'utf8'));
  assert.deepEqual(nativeEvidence.controls.web_gates,['web-e2e']);
  await fillDelivery(f.task,{id:f.taskId,round:1,revision:report.head,evidenceId:'EV-1',criteriaCount:1});
  await writeFile(f.candidateFile,'// dirty candidate content v3 before delivery\n');
  result=cli(['deliver',f.task]);assert.notEqual(result.code,0);assert.match(result.stderr,/candidate worktree changed after Harness Report/);
  await writeFile(f.candidateFile,f.candidateContent);
  result=cli(['deliver',f.task]);assert.equal(result.code,0,result.stderr);
  await writeFile(path.join(f.root,screenshot.file),'tampered after report');
  result=cli(['harness','reconcile',f.root,f.taskId,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/Playwright attachment hash mismatch/);
});

test('Playwright Gate discovers a target-local CLI in a nested web package',async()=>{
  const f=await webFixture('WEBMONOREPO',['frontend/tests/e2e.spec.ts'],30,false,'frontend');
  const result=cli(['harness','verify',f.root,f.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);
  const gate=JSON.parse(result.stdout)[0];
  assert.equal(gate.exit_code,0);
  assert.match(gate.command[1],/frontend[/\\]node_modules[/\\]@playwright[/\\]test[/\\]cli\.js$/);
});

test('Playwright Gate rejects flaky, skipped, missing HTML, invalid image and timeout evidence',async()=>{
  for(const [name,testPath,pattern] of [
    ['WEBFLAKY','tests/flaky.spec.ts',/flaky/],
    ['WEBSKIPPED','tests/skipped.spec.ts',/skipped/],
    ['WEBNOHTML','tests/nohtml.spec.ts',/HTML report/],
    ['WEBBADIMAGE','tests/badimage.spec.ts',/valid screenshot/],
  ]){
    const f=await webFixture(name,[testPath]);
    const result=cli(['harness','verify',f.root,f.taskId,'--json']);
    assert.notEqual(result.code,0);assert.ok(result.stdout,result.stderr);
    const gate=JSON.parse(result.stdout)[0],log=await readFile(path.join(f.root,gate.artifact),'utf8');
    assert.match(log,pattern);
  }
  const timed=await webFixture('WEBHANG',['tests/hang.spec.ts'],1);
  const result=cli(['harness','verify',timed.root,timed.taskId,'--json']);
  assert.notEqual(result.code,0);assert.ok(result.stdout,result.stderr);
  const gate=JSON.parse(result.stdout)[0];assert.equal(gate.timed_out,true);assert.equal(gate.exit_code,124);
});

test('Playwright Gate rejects a successful process that executed zero tests or produced no screenshot',async()=>{
  const f=await webFixture('WEBZERO',['tests/zero.spec.ts']);
  const result=cli(['harness','verify',f.root,f.taskId,'--json']);
  assert.notEqual(result.code,0);
  assert.ok(result.stdout,result.stderr);
  const gate=JSON.parse(result.stdout)[0];
  assert.equal(gate.kind,'playwright');
  assert.equal(gate.exit_code,1);
  const artifact=await readFile(path.join(f.root,gate.artifact),'utf8');
  assert.match(artifact,/must execute at least one passing test/);
  assert.match(artifact,/requires at least one valid screenshot/);
});

test('Playwright Gate allows screenshot-free functional evidence when the Gate explicitly opts out',async()=>{
  const f=await webFixture('WEBNOSCREENSHOT',['tests/noscreenshot.spec.ts'],30,false,'.',false);
  let result=cli(['harness','verify',f.root,f.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);
  const gate=JSON.parse(result.stdout)[0];
  assert.equal(gate.exit_code,0);
  assert.equal(gate.web_evidence.stats.expected,1);
  assert.equal(gate.web_evidence.screenshots,0);
  result=cli(['harness','report',f.root,f.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).passed,true);
});

test('Playwright Gate rejects an installed CLI that is not pinned by a tracked lockfile',async()=>{
  const f=await webFixture('WEBUNLOCKED',['tests/e2e.spec.ts'],30,false,'.',true,false);
  const result=cli(['harness','verify',f.root,f.taskId,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/requires a tracked .*lock/i);
});

test('Playwright Gate fingerprints tracked deletions and rejects legacy Collect Evidence without a content fingerprint',async()=>{
  const deletion=await webFixture('WEBDELETE',['tests/delete.spec.ts'],30,true);
  let result=cli(['harness','verify',deletion.root,deletion.taskId,'--json']);
  assert.equal(result.code,0,result.stderr);

  const legacy=await webFixture('WEBLEGACY',['tests/legacy.spec.ts']);
  const output=path.join(legacy.root,'.spec-loop','output');
  const collectFile=path.join(output,`${legacy.taskId}-collect.json`);
  const collect=JSON.parse(await readFile(collectFile,'utf8'));
  delete collect.worktree_fingerprint;
  const serialized=JSON.stringify(collect,null,2)+'\n';
  await writeFile(collectFile,serialized);
  const stateFile=path.join(output,`${legacy.taskId}-harness-state.json`);
  const state=JSON.parse(await readFile(stateFile,'utf8'));
  state.evidence_hashes.collect=createHash('sha256').update(serialized).digest('hex');
  await writeFile(stateFile,JSON.stringify(state,null,2)+'\n');
  result=cli(['harness','verify',legacy.root,legacy.taskId,'--json']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/predates content fingerprints/);
});
