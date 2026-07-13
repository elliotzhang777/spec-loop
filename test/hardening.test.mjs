import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cli, tempRoot, writeMd } from './helpers.mjs';
import { atomicWriteAcrossRoots, recoverCrossRootTransactions } from '../dist/files.js';

function git(cwd,args){const r=spawnSync('git',args,{cwd,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()}

async function fixture(name='HARD'){
  const root=await tempRoot(`phase3-${name.toLowerCase()}-`),repo=path.join(root,'repo');await mkdir(repo);git(repo,['init','-b','main']);git(repo,['config','user.email','test@example.com']);git(repo,['config','user.name','Test']);await writeFile(path.join(repo,'check.mjs'),"console.log('pass')\n");await writeFile(path.join(repo,'sleep.mjs'),"setTimeout(()=>{},10_000)\n");git(repo,['add','.']);git(repo,['commit','-m','initial']);
  assert.equal(cli(['project','init',root,'--id',`PROJ-${name}`,'--name',name,'--repository',repo]).code,0);const proposal=cli(['triage','propose',root,'--source','security review','--goal','Exercise hardened harness','--reason','Need adversarial evidence','--ac','security gate passes']).stdout.trim();assert.equal(cli(['triage','approve',root,proposal,'--by','reviewer']).code,0);assert.equal(cli(['triage','create-task',root,proposal,'--id',`TASK-${name}-1`,'--title','Harden harness']).code,0);
  const task=path.join(root,'.spec-loop','tasks',`task-${name.toLowerCase()}-1`);await writeMd(path.join(task,'PLAN.md'),{schema_version:1,task_id:`TASK-${name}-1`,version:1,ac_coverage:['AC-1']},'# Plan\n\nRun the hardened execution sequence.');assert.equal(cli(['plan',task]).code,0);assert.equal(cli(['round',task]).code,0);git(repo,['add','.']);git(repo,['commit','-m','specs']);
  const providers=path.join(root,'.spec-loop','PROVIDERS.md'),doc=(await readFile(providers,'utf8')).replace('executable: codex','executable: /usr/bin/true');await writeFile(providers,doc);return{root,repo,task,taskId:`TASK-${name}-1`,proposal};
}

async function throughCollect(name='FLOW'){
  const f=await fixture(name);await writeMd(path.join(f.root,'.spec-loop','GATES.md'),{schema_version:1,gates:[{id:'test',command:[process.execPath,'check.mjs'],timeout_seconds:30}]},'# Gates\n\nAdversarial fixture.');assert.equal(cli(['workspace','create',f.root,f.taskId]).code,0);assert.equal(cli(['harness','prepare',f.root,f.taskId,'--prompt','test']).code,0);assert.equal(cli(['harness','execute',f.root,f.taskId,'--prompt','test']).code,0);assert.equal(cli(['harness','collect',f.root,f.taskId]).code,0);return f;
}

test('workspace rejects dirty repository and expired execution approval',async()=>{
  const dirty=await fixture('DIRTY');await writeFile(path.join(dirty.repo,'dirty.txt'),'dirty');let result=cli(['workspace','create',dirty.root,dirty.taskId]);assert.notEqual(result.code,0);assert.match(result.stderr,/must be clean/);
  const expired=await fixture('EXPIRE'),approvalFile=path.join(expired.root,'.spec-loop','approvals','APR-1.json'),approval=JSON.parse(await readFile(approvalFile,'utf8'));approval.expires_at='2000-01-01T00:00:00.000Z';await writeFile(approvalFile,JSON.stringify(approval,null,2)+'\n');result=cli(['workspace','create',expired.root,expired.taskId]);assert.notEqual(result.code,0);assert.match(result.stderr,/no valid execute_in_worktree approval/);
});

test('Harness enforces stage order and reconcile checks durable files',async()=>{
  const f=await fixture('STATE');await writeMd(path.join(f.root,'.spec-loop','GATES.md'),{schema_version:1,gates:[{id:'test',command:[process.execPath,'check.mjs'],timeout_seconds:30}]},'# Gates\n\nState fixture.');assert.equal(cli(['workspace','create',f.root,f.taskId]).code,0);assert.equal(cli(['harness','prepare',f.root,f.taskId,'--prompt','test']).code,0);let result=cli(['harness','collect',f.root,f.taskId]);assert.notEqual(result.code,0);assert.match(result.stderr,/illegal from prepared/);result=cli(['harness','reconcile',f.root,f.taskId,'--json']);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).stage,'prepared');
});

test('Harness reconcile rolls stale collected evidence back to a rerunnable stage',async()=>{
  const f=await throughCollect('DRIFT'),manifest=JSON.parse(await readFile(path.join(f.root,'.spec-loop','output',`${f.taskId}-workspace.json`),'utf8'));await writeFile(path.join(manifest.worktree,'drift.txt'),'new committed fact\n');git(manifest.worktree,['add','drift.txt']);git(manifest.worktree,['commit','-m','change head after collect']);
  let result=cli(['harness','reconcile',f.root,f.taskId,'--json']);assert.equal(result.code,0,result.stderr);const state=JSON.parse(result.stdout);assert.equal(state.stage,'prepared');assert.deepEqual(Object.keys(state.evidence_hashes),['prepare']);assert.match(state.last_error,/rerun execute\/collect\/verify/);
  assert.equal(cli(['harness','execute',f.root,f.taskId,'--prompt','refresh evidence']).code,0);result=cli(['harness','collect',f.root,f.taskId,'--json']);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).head,git(manifest.worktree,['rev-parse','HEAD']));
});

test('Gate rejects shell dispatchers and records hard timeout',async()=>{
  const shell=await throughCollect('SHELL');await writeMd(path.join(shell.root,'.spec-loop','GATES.md'),{schema_version:1,gates:[{id:'bad',command:['sh','-c','git push'],timeout_seconds:10}]},'# Gates\n\nShell bypass attempt.');let result=cli(['gate','run',shell.root,shell.taskId]);assert.notEqual(result.code,0);assert.match(result.stderr,/dispatcher is forbidden/);
  const timeout=await throughCollect('TIME');await writeMd(path.join(timeout.root,'.spec-loop','GATES.md'),{schema_version:1,gates:[{id:'timeout',command:[process.execPath,'sleep.mjs'],timeout_seconds:1}]},'# Gates\n\nTimeout fixture.');result=cli(['gate','run',timeout.root,timeout.taskId,'--json']);assert.notEqual(result.code,0);const gates=JSON.parse(result.stdout);assert.equal(gates[0].timed_out,true);assert.equal(gates[0].exit_code,124);
});

test('Harness report rejects tampered gate artifact',async()=>{
  const f=await throughCollect('TAMPER');assert.equal(cli(['gate','run',f.root,f.taskId]).code,0);const gates=JSON.parse(await readFile(path.join(f.root,'.spec-loop','output',`${f.taskId}-gates.json`),'utf8'));await writeFile(path.join(f.root,gates[0].artifact),'forged');const report=cli(['harness','report',f.root,f.taskId]);assert.notEqual(report.code,0);assert.match(report.stderr,/(artifact hash mismatch|Evidence hash chain mismatch)/);
});

test('target spec check rejects placeholders and symlinked required files',async()=>{
  const f=await fixture('SPEC');const roadmap=path.join(f.repo,'spec','roadmap.md');await writeFile(roadmap,'# Roadmap\n\nTODO\n');let result=cli(['project','spec-check',f.root,'--json']);assert.notEqual(result.code,0);assert.match(result.stdout,/placeholder content/);await writeFile(roadmap,'# Valid Roadmap\n\nA maintained and approved direction without placeholders.\n');const broken=path.join(f.repo,'spec','02-feature','FEAT-001-broken.md');await writeFile(broken,'# FEAT-001：Broken trace\n\n- 状态：草稿\n\n## 用户价值\n\nA feature without an upstream product reference.\n');result=cli(['project','spec-check',f.root,'--json']);assert.notEqual(result.code,0);assert.match(result.stdout,/missing upstream trace/);spawnSync('rm',[broken]);const board=path.join(f.repo,'spec','pending-board.md');await writeFile(path.join(f.repo,'outside.md'),'# Outside\n\nExternal content that must not be trusted.\n');spawnSync('rm',[board]);await symlink(path.join(f.repo,'outside.md'),board);result=cli(['project','spec-check',f.root,'--json']);assert.notEqual(result.code,0);assert.match(result.stdout,/symbolic link/);
});

test('cross-root transaction writes both roots and recovers a prepared journal',async()=>{
  const parent=await tempRoot('cross-root-'),control=path.join(parent,'control'),repo=path.join(parent,'repo');await mkdir(control);await mkdir(repo);await atomicWriteAcrossRoots(control,[control,repo],[{file:path.join(control,'task.md'),content:'task\n'},{file:path.join(repo,'spec.md'),content:'spec\n'}]);assert.equal(await readFile(path.join(control,'task.md'),'utf8'),'task\n');assert.equal(await readFile(path.join(repo,'spec.md'),'utf8'),'spec\n');
  const txDir=path.join(control,'.spec-loop-cross-tx'),dataDir=path.join(repo,'.spec-loop-cross-tx-data');await mkdir(txDir,{recursive:true});await mkdir(dataDir,{recursive:true});const content='recovered\n',temp=path.join(dataDir,'manual-0.tmp'),target=path.join(repo,'recovered.md');await writeFile(temp,content);const hash=createHash('sha256').update(content).digest('hex');await writeFile(path.join(txDir,'manual.json'),JSON.stringify({id:'manual',status:'prepared',allowed_roots:[path.resolve(control),path.resolve(repo)],writes:[{target,temp,hash}]},null,2));await recoverCrossRootTransactions(control,[control,repo]);assert.equal(await readFile(target,'utf8'),content);
  await assert.rejects(()=>atomicWriteAcrossRoots(control,[control,repo],[{file:path.join(parent,'escape.md'),content:'escape'}]),/escapes allowed roots/);
});
