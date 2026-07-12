#!/usr/bin/env node
import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LEVELS } from './model.js';
import { atomicWriteMany, assertNoSecrets } from './files.js';
import { appendAttempt, checkTask, deliverTask, initTask, planTask, readState, runtimeInit, startRound, verifyTask } from './task.js';
import { guard, readBudget, readLedger, renderSummary } from './runtime.js';
import { approveProposal, checkTargetSpecLibrary, createProposal, createTaskFromProposal, initProject, initTargetSpecLibrary, providerDoctor, readProject, readProjectState, scanTasks, setActiveProvider } from './project.js';
import { collectHarness, createWorkspace, executeHarness, prepareHarness, reportHarness, runGates, writebackDelivery } from './execution.js';

const program = new Command();
program.name('spec-loop').description('Specification-driven local task loops').version('0.1.0');

function root(value: string): string { return path.resolve(value); }
function print(value: unknown, json?: boolean): void { console.log(json ? JSON.stringify(value, null, 2) : value); }

async function action(fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (error as Error).message;
    console.error(`spec-loop: ${message}`);
    process.exitCode = 1;
  }
}

program.command('init').argument('<task-dir>').requiredOption('--level <level>').requiredOption('--id <id>').requiredOption('--title <title>').option('--repository <path>', '.', 'target business repository').action((dir, options) => action(async () => {
  if (!LEVELS.includes(options.level)) throw new Error(`invalid level: ${options.level}`);
  await initTask(root(dir), { id: options.id, title: options.title, level: options.level, repository: path.resolve(options.repository) });
  console.log(`initialized ${options.id} (${options.level}) at ${root(dir)}`);
}));

program.command('check').argument('<task-dir>').option('--json').action((dir, options) => action(async () => {
  const errors = await checkTask(root(dir));
  print({ ok: errors.length === 0, errors }, options.json);
  if (errors.length) process.exitCode = 1;
}));

program.command('status').argument('<task-dir>').option('--json').action((dir, options) => action(async () => {
  const state = await readState(root(dir));
  print(options.json ? state : `${state.task_id} ${state.level} ${state.status} round=${state.current_round} version=${state.state_version}`, options.json);
}));

program.command('next').argument('<task-dir>').action((dir) => action(async () => {
  const state = await readState(root(dir));
  const next: Record<string, string> = {
    draft: 'Fill SPEC.md, PLAN.md and ACCEPTANCE.md, then run: spec-loop plan <task-dir>',
    planned: 'Run: spec-loop round <task-dir>',
    working: 'Complete the current Round, then run: spec-loop verify <task-dir> ...',
    verifying: 'Fill DELIVERY.md and run deliver, or run verify --result fail to iterate',
    iterating: 'Resolve the failure, then run: spec-loop round <task-dir> (Guard runs automatically)',
    delivered: 'Terminal state: delivered',
  };
  console.log(next[state.status]);
}));

program.command('plan').argument('<task-dir>').action((dir) => action(async () => {
  const state = await planTask(root(dir)); console.log(`${state.task_id}: ${state.status}`);
}));

program.command('round').argument('<task-dir>').action((dir) => action(async () => {
  const state = await startRound(root(dir)); console.log(`${state.task_id}: working Round ${state.current_round}`);
}));

program.command('verify').argument('<task-dir>')
  .addOption(new Option('--result <result>').choices(['pass', 'fail']).makeOptionMandatory())
  .requiredOption('--evidence <file>').requiredOption('--verifier <identity>')
  .option('--independent', 'verifier is independent').option('--human-check', 'human check completed').option('--revision <revision>')
  .action((dir, options) => action(async () => {
    const state = await verifyTask(root(dir), { result: options.result, artifact: options.evidence, verifier: options.verifier, independent: Boolean(options.independent), human: Boolean(options.humanCheck), revision: options.revision });
    console.log(`${state.task_id}: ${state.status}`);
  }));

program.command('deliver').argument('<task-dir>').action((dir) => action(async () => {
  const state = await deliverTask(root(dir)); console.log(`${state.task_id}: delivered at Round ${state.current_round}`);
}));

program.command('runtime-init').argument('<task-dir>').action((dir) => action(async () => {
  await runtimeInit(root(dir)); console.log('runtime initialized');
}));

program.command('attempt').argument('<task-dir>').requiredOption('--action <description>')
  .addOption(new Option('--outcome <outcome>').choices(['success', 'failure', 'no_progress']).makeOptionMandatory())
  .requiredOption('--tokens <tokens>').requiredOption('--work <units>').option('--error <fingerprint>').option('--round <number>')
  .action((dir, options) => action(async () => {
    assertNoSecrets(`${options.action}\n${options.error ?? ''}`, 'Attempt input');
    const attempt = await appendAttempt(root(dir), {
      action: options.action, outcome: options.outcome, error_fingerprint: options.outcome === 'success' ? null : (options.error ?? null),
      tokens: Number(options.tokens), work_units: Number(options.work), ...(options.round ? { round: Number(options.round) } : {}),
    });
    console.log(`recorded Attempt ${attempt.attempt} in Round ${attempt.round}`);
  }));

program.command('guard').argument('<task-dir>').option('--json').action((dir, options) => action(async () => {
  const taskRoot = root(dir); const state = await readState(taskRoot);
  const result = guard(await readBudget(taskRoot), await readLedger(taskRoot, state));
  print(options.json ? result : `${result.decision}: ${result.reason}`, options.json);
  if (result.decision === 'stop') process.exitCode = 5;
  else if (result.decision === 'needs_user') process.exitCode = 3;
}));

program.command('summary').argument('<task-dir>').action((dir) => action(async () => {
  const taskRoot = root(dir); const state = await readState(taskRoot); const budget = await readBudget(taskRoot); const attempts = await readLedger(taskRoot, state);
  const content = renderSummary(state, budget, attempts, guard(budget, attempts));
  await atomicWriteMany(taskRoot, [{ file: path.join(taskRoot, 'RUN_SUMMARY.md'), content }]);
  console.log(content.trimEnd());
}));

const projectCmd=program.command('project').description('Project Loop control plane');
projectCmd.command('init').argument('<project-dir>').requiredOption('--id <id>').requiredOption('--name <name>').requiredOption('--repository <path>').option('--branch <branch>','default Git branch','main').addOption(new Option('--risk <level>').choices(['light','standard','heavy']).default('standard')).action((dir,o)=>action(async()=>{await initProject(root(dir),{id:o.id,name:o.name,repository:path.resolve(o.repository),branch:o.branch,risk:o.risk});console.log(`initialized project ${o.id}`)}));
projectCmd.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const p=await readProject(root(dir));const s=await readProjectState(root(dir));const tasks=await scanTasks(root(dir));print(o.json?{project:p,state:s,derived:{active:tasks.filter(t=>t.status!=='delivered'),recent_delivery:tasks.filter(t=>t.status==='delivered')}}:`${p.project_id} ${p.name}: ${tasks.length} tasks, ${tasks.filter(t=>t.resumable).length} resumable`,o.json)}));
projectCmd.command('spec-init').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await initTargetSpecLibrary(root(dir)),o.json)));
projectCmd.command('spec-check').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const result=await checkTargetSpecLibrary(root(dir));print(result,o.json);if(!result.ok)process.exitCode=1}));

const tasksCmd=program.command('tasks').description('Rebuildable task registry queries');
tasksCmd.command('list').argument('<project-dir>').option('--state <state>').option('--project <id>').option('--json').action((dir,o)=>action(async()=>{let tasks=await scanTasks(root(dir));if(o.state)tasks=tasks.filter(t=>t.status===o.state);if(o.project)tasks=tasks.filter(t=>t.project_id===o.project);print(o.json?tasks:tasks.map(t=>`${t.task_id}\t${t.status}\t${t.level}\tround=${t.round}`).join('\n'),o.json)}));
tasksCmd.command('show').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const item=(await scanTasks(root(dir))).find(t=>t.task_id===id);if(!item)throw new Error('task not found');print(item,o.json)}));
tasksCmd.command('resumable').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const items=(await scanTasks(root(dir))).filter(t=>t.resumable);print(o.json?items:items.map(t=>t.task_id).join('\n'),o.json)}));

const triage=program.command('triage').description('Manual proposal and approval flow');
triage.command('propose').argument('<project-dir>').requiredOption('--source <source>').requiredOption('--goal <goal>').addOption(new Option('--risk <level>').choices(['light','standard','heavy']).default('standard')).addOption(new Option('--priority <priority>').choices(['P0','P1','P2','P3']).default('P1')).requiredOption('--reason <reason>').requiredOption('--ac <criterion...>').action((dir,o)=>action(async()=>console.log(await createProposal(root(dir),{source:o.source,goal:o.goal,risk:o.risk,priority:o.priority,reason:o.reason,criteria:o.ac}))));
triage.command('approve').argument('<project-dir>').argument('<proposal-id>').requiredOption('--by <identity>').action((dir,id,o)=>action(async()=>console.log(await approveProposal(root(dir),id,o.by))));
triage.command('create-task').argument('<project-dir>').argument('<proposal-id>').requiredOption('--id <task-id>').requiredOption('--title <title>').action((dir,p,o)=>action(async()=>console.log(await createTaskFromProposal(root(dir),p,o.id,o.title))));

const providers=program.command('providers').description('Provider configuration and diagnostics');
providers.command('show').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const results=await providerDoctor(root(dir));print(results,o.json)}));
providers.command('set').argument('<project-dir>').addOption(new Option('--active <provider>').choices(['codex','claude-code','qoder']).makeOptionMandatory()).action((dir,o)=>action(async()=>{await setActiveProvider(root(dir),o.active);console.log(`active provider: ${o.active}`)}));

const workspace=program.command('workspace').description('Task worktree management');
workspace.command('create').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await createWorkspace(root(dir),id),o.json)));

const gate=program.command('gate').description('Deterministic T1 command gates');
gate.command('run').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const results=await runGates(root(dir),id);print(results,o.json);if(results.some(r=>r.exit_code!==0))process.exitCode=1}));

const harness=program.command('harness').description('prepare → execute → collect → verify → report');
harness.command('prepare').argument('<project-dir>').argument('<task-id>').requiredOption('--prompt <text>').action((dir,id,o)=>action(async()=>console.log(await prepareHarness(root(dir),id,o.prompt))));
harness.command('execute').argument('<project-dir>').argument('<task-id>').requiredOption('--prompt <text>').action((dir,id,o)=>action(async()=>{const r=await executeHarness(root(dir),id,o.prompt);print(r,true);if(r.code!==0)process.exitCode=1}));
harness.command('collect').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await collectHarness(root(dir),id),o.json)));
harness.command('verify').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const r=await runGates(root(dir),id);print(r,o.json);if(r.some(x=>x.exit_code!==0))process.exitCode=1}));
harness.command('report').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await reportHarness(root(dir),id),o.json)));

program.command('writeback').argument('<project-dir>').argument('<task-id>').action((dir,id)=>action(async()=>console.log(await writebackDelivery(root(dir),id))));

await program.parseAsync();
