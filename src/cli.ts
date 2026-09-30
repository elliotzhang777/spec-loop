#!/usr/bin/env node
import { archiveExecutionEvents, managedProjectRootForTask } from './execution-events.js';
import { finalizeWaveReview, rebuildWaveReview, decideWaveReview, listWaveReviews, readWaveReview, refreshWaveReview, runAuthorizedWave } from './wave-review.js';
import { Command, Option } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LEVELS } from './model.js';
import { atomicWriteMany, assertNoSecrets } from './files.js';
import { appendAttempt, checkTask, deliverTask, initTask, planTask, readState, runtimeInit, startRound, verifyTask } from './task.js';
import { guard, readBudget, readLedger, renderSummary } from './runtime.js';
import { approveProposal, checkTargetSpecLibrary, createProposal, createTaskFromProposal, initProject, initTargetSpecLibrary, providerDoctor, readProject, readProjectState, scanTasks, setActiveProvider, setDefaultTaskProtocol, setRoleProvider } from './project.js';
import { collectHarness, createWorkspace, executeHarness, prepareHarness, reconcileHarness, reportHarness, runGates, writebackDelivery } from './execution.js';
import { decideVisualReview, readVisualReviews, requestVisualReview } from './review.js';
import { disableFeishuConnector, feishuConnectorStatus, initFeishuConfig, readFeishuConfig, superviseFeishuConnector, stopFeishuConnector } from './connectors/feishu.js';
import { acceptLocalConfirmationAction, listFeishuActionInbox, processFeishuAction } from './connectors/feishu-callback.js';
import { createLocalSpecLoopConfirmationController } from './connectors/feishu-controller.js';
import { buildExecutionSnapshot } from './execution-view.js';
import { closeExecutionViewServer, executionViewStatus, serveManagedExecutionView, startExecutionViewServer, startManagedExecutionView, stopManagedExecutionView } from './execution-view-server.js';
import { maybeAutoOpenExecutionView } from './view-auto-open.js';
import { finishWorkActivity, runWorkCommand, startWorkActivity, workActivityKindSchema } from './work-activity.js';
import { spawn } from 'node:child_process';
import {
  approveAcceptanceContract, buildAcceptanceSchedule, compileAcceptancePlan, readAcceptanceRun,
  recordRResult, recordVResult, resolveAcceptanceConflict, runControlledV, startAcceptanceRun,
  submitMakerCandidate, reconcileCandidateBaseline,
} from './acceptance-loop.js';
import { cancelRoleInvocation, ingestSucceededRoleResult, prepareRoleInvocation, readRoleInvocation, reconcileRoleInvocation, recoverBudgetStoppedMakerCandidate, runRoleInvocation, summarizeRoleUsage } from './role-orchestrator.js';
import { initReportScheduler, readReportSchedulerStatus, runReportScheduler, setReportSchedulerPaused } from './report-scheduler.js';
import { acquireProjectLease, acquireTaskLease, assertSchedulerAction, assertTaskLeaseResult, configureWaveBudget, initSchedulerControl, inspectSchedulerLiveness, killSchedulerControl, pauseSchedulerControl, planReadyWave, reconcileInterruptedWaves, reconcileSchedulerControl, releaseProjectLease, releaseTaskLease, renewProjectLease, renewTaskLease, retryDeadLetter, resumeSchedulerControl, runReadyWave, runSchedulerWatchdog, schedulerControlStatus, stopTaskExecution } from './scheduler-control.js';
import { installSchedulerSupervisorLaunchd, resetSchedulerSupervisorCircuit, schedulerSupervisorCircuitStatus, schedulerSupervisorLaunchdPlan, schedulerSupervisorStatus, serveSchedulerSupervisor, startManagedSchedulerSupervisor, stopManagedSchedulerSupervisor, uninstallSchedulerSupervisorLaunchd } from './scheduler-supervisor.js';
import { collectSpringEvidence, detectSpringBoot, planV2Gates, verifySpringEvidence, verifyV2GatePlan } from './toolchain.js';
import { archiveAcceptanceEvidence, inspectArtifacts, planWorktreeRetirement, retentionPolicy, retireWorktree, runRetentionMaintenance } from './maintenance.js';

const program = new Command();
program.name('spec-loop').description('Specification-driven local task loops').version('0.1.0');

function root(value: string): string { return path.resolve(value); }
function print(value: unknown, json?: boolean): void { console.log(json ? JSON.stringify(value, null, 2) : value); }

process.stdout.on('error',(error:NodeJS.ErrnoException)=>{if(error.code==='EPIPE')process.exit(0);throw error});

async function action(fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (error) {
    const message = error instanceof z.ZodError ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (error as Error).message;
    console.error(`spec-loop: ${message}`);
    process.exitCode = 1;
  }
}

program.command('init').argument('<task-dir>').requiredOption('--level <level>').requiredOption('--id <id>').requiredOption('--title <title>').option('--repository <path>', 'target business repository', '.').action((dir, options) => action(async () => {
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

program.command('round').argument('<task-dir>').option('--no-view').action((dir,o) => action(async () => {
  const state = await startRound(root(dir)); console.log(`${state.task_id}: working Round ${state.current_round}`);
  await maybeAutoOpenExecutionView(managedProjectRootForTask(root(dir)),o);
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

const review = program.command('review').description('Revision-bound human visual review');
review.command('request').argument('<task-dir>').requiredOption('--id <review-id>').requiredOption('--revision <revision>')
  .requiredOption('--evidence <file...>').option('--json').action((dir, options) => action(async () => {
    print(await requestVisualReview(root(dir), options.id, options.revision, options.evidence), options.json);
  }));
review.command('decide').argument('<task-dir>').requiredOption('--id <review-id>')
  .addOption(new Option('--result <result>').choices(['approved', 'rejected']).makeOptionMandatory())
  .requiredOption('--by <identity>').requiredOption('--note <text>').option('--json').action((dir, options) => action(async () => {
    print(await decideVisualReview(root(dir), options.id, options.result, options.by, options.note), options.json);
  }));
review.command('status').argument('<task-dir>').option('--json').action((dir, options) => action(async () => {
  const result = await readVisualReviews(root(dir));
  print(options.json ? result : result.map((item) => `${item.review_id}\t${item.status}\tround=${item.round}\trevision=${item.code_revision}`).join('\n'), options.json);
}));

const projectCmd=program.command('project').description('Project Loop control plane');
projectCmd.command('init').argument('<project-dir>').requiredOption('--id <id>').requiredOption('--name <name>').requiredOption('--repository <path>').option('--branch <branch>','default Git branch','main').addOption(new Option('--risk <level>').choices(['light','standard','heavy']).default('standard')).addOption(new Option('--spec-profile <profile>').choices(['standard','backend','frontend','fullstack']).default('standard')).action((dir,o)=>action(async()=>{await initProject(root(dir),{id:o.id,name:o.name,repository:path.resolve(o.repository),branch:o.branch,risk:o.risk,specProfile:o.specProfile});console.log(`initialized project ${o.id}`)}));
projectCmd.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const p=await readProject(root(dir));const s=await readProjectState(root(dir));const tasks=await scanTasks(root(dir)),latestTaskUpdate=tasks.map(task=>task.path).length?Math.max(...await Promise.all(tasks.map(async task=>Date.parse((await readState(task.path)).updated_at)))):null,stateStale=latestTaskUpdate!==null&&Date.parse(s.updated_at)<latestTaskUpdate;print(o.json?{project:p,state:s,state_authority:'compatibility_summary',state_stale:stateStale,derived_authority:'TASK_STATE.md + ACCEPTANCE_RUN.json + EXECUTION_EVENTS.jsonl',derived:{active:tasks.filter(t=>!['delivered','cancelled'].includes(t.status)),recent_delivery:tasks.filter(t=>t.status==='delivered'),cancelled:tasks.filter(t=>t.status==='cancelled')}}:`${p.project_id} ${p.name}: default_protocol=${p.default_task_protocol}, ${tasks.length} tasks, ${tasks.filter(t=>t.resumable).length} resumable, project_state=${stateStale?'stale compatibility summary':'current'}`,o.json)}));
projectCmd.command('spec-init').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await initTargetSpecLibrary(root(dir)),o.json)));
projectCmd.command('spec-check').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const result=await checkTargetSpecLibrary(root(dir));print(result,o.json);if(!result.ok)process.exitCode=1}));
projectCmd.command('protocol').description('Show or set the default protocol for newly proposed tasks').argument('<project-dir>')
  .addOption(new Option('--set <protocol>').choices(['v1','v2'])).option('--json')
  .action((dir,o)=>action(async()=>{
    const project=o.set?await setDefaultTaskProtocol(root(dir),o.set):await readProject(root(dir));
    print(o.json?{project_id:project.project_id,default_task_protocol:project.default_task_protocol}:project.default_task_protocol,o.json);
  }));
projectCmd.command('doctor').description('Report project protocol and task-level protocol blockers').argument('<project-dir>').option('--json')
  .action((dir,o)=>action(async()=>{
    const project=await readProject(root(dir)),tasks=await scanTasks(root(dir)),providers=await providerDoctor(root(dir));
    const report={ok:tasks.every(task=>!task.blocking_reason?.startsWith('invalid v2')),project_id:project.project_id,default_task_protocol:project.default_task_protocol,tasks:tasks.map(({task_id,status,protocol,protocol_stage,blocking_reason})=>({task_id,status,protocol,protocol_stage,blocking_reason})),providers};
    print(o.json?report:[`project=${report.project_id} default_protocol=${report.default_task_protocol} ok=${report.ok}`,...report.tasks.map(task=>`${task.task_id}\t${task.protocol}\t${task.protocol_stage??task.status}\t${task.blocking_reason??'ready'}`)].join('\n'),o.json);
    if(!report.ok)process.exitCode=1;
  }));

const tasksCmd=program.command('tasks').description('Rebuildable task registry queries');
tasksCmd.command('list').argument('<project-dir>').option('--state <state>').option('--project <id>').option('--json').action((dir,o)=>action(async()=>{let tasks=await scanTasks(root(dir));if(o.state)tasks=tasks.filter(t=>t.status===o.state);if(o.project)tasks=tasks.filter(t=>t.project_id===o.project);print(o.json?tasks:tasks.map(t=>`${t.task_id}\t${t.status}\t${t.level}\tprotocol=${t.protocol}\tstage=${t.protocol_stage??'-'}\tblocked=${t.blocking_reason??'-'}\tround=${t.round}`).join('\n'),o.json)}));
tasksCmd.command('show').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const item=(await scanTasks(root(dir))).find(t=>t.task_id===id);if(!item)throw new Error('task not found');print(item,o.json)}));
tasksCmd.command('resumable').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const items=(await scanTasks(root(dir))).filter(t=>t.resumable);print(o.json?items:items.map(t=>t.task_id).join('\n'),o.json)}));

program.command('snapshot').description('Rebuild the project execution timeline from .spec-loop facts').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{
  const snapshot=await buildExecutionSnapshot(root(dir));
  print(o.json?snapshot:{project:snapshot.project,active_task:snapshot.active_task,tasks:snapshot.tasks.map((task)=>({task_id:task.task_id,status:task.status,wall_clock_ms:task.wall_clock_ms,active_ms:task.active_ms,waiting_ms:task.waiting_ms,timing_precision:task.timing_precision}))},true);
}));

program.command('view').description('Open the local read-only execution timeline').argument('<project-dir>')
  .option('--port <port>','loopback port; 0 selects an available port','0').option('--no-open','do not open the system browser')
  .action((dir,o)=>action(async()=>{
    const {server,url}=await startExecutionViewServer(root(dir),{port:Number(o.port)});
    console.log(`spec-loop execution view: ${url}`);
    if(o.open){
      const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'cmd':'xdg-open';
      const args=process.platform==='win32'?['/c','start','',url]:[url];
      const child=spawn(command,args,{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
    }
    await new Promise<void>((resolve)=>{
      let closing=false;
      const stop=()=>{if(closing)return;closing=true;closeExecutionViewServer(server).then(resolve,resolve)};
      process.once('SIGINT',stop);process.once('SIGTERM',stop);server.once('close',resolve);
    });
  }));
const viewControl=program.command('view-control').description('Manage one background execution view per Project');
viewControl.command('start').argument('<project-dir>').option('--port <port>','loopback port; 0 selects an available port','0').option('--json').action((dir,o)=>action(async()=>print(await startManagedExecutionView(root(dir),Number(o.port)),o.json)));
viewControl.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await executionViewStatus(root(dir)),o.json)));
viewControl.command('open').argument('<project-dir>').action((dir)=>action(async()=>{const status=await executionViewStatus(root(dir));if(!status.running||!status.marker)throw new Error('execution view is not running');const child=spawn(process.platform==='darwin'?'/usr/bin/open':'xdg-open',[status.marker.url],{detached:true,stdio:'ignore'});child.unref();console.log(status.marker.url)}));
viewControl.command('stop').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await stopManagedExecutionView(root(dir)),o.json)));
program.command('_view-serve',{hidden:true}).argument('<project-dir>').option('--port <port>','loopback port','0').action((dir,o)=>action(async()=>serveManagedExecutionView(root(dir),Number(o.port))));
program.command('_wave-review-finalize',{hidden:true}).argument('<project-dir>').requiredOption('--wave <id>').action((dir,o)=>action(async()=>{const deadline=setTimeout(()=>process.exit(124),15_000);try{console.log(JSON.stringify(await finalizeWaveReview(root(dir),o.wave)))}finally{clearTimeout(deadline)}}));
program.command('_scheduler-supervise',{hidden:true}).argument('<project-dir>')
  .option('--interval-seconds <seconds>','seconds between watchdog cycles','5')
  .option('--stale-seconds <seconds>','execution heartbeat stale threshold','15')
  .option('--cycle-timeout-seconds <seconds>','hard timeout for one isolated watchdog cycle','60')
  .option('--max-consecutive-failures <count>','watchdog circuit-breaker threshold','3')
  .option('--slow-write-ms <milliseconds>','control-plane write degradation threshold','2000')
  .option('--last-recovery-action <description>')
  .option('--test-mode','mark this as a bounded test Supervisor')
  .option('--max-runtime-seconds <seconds>','required bounded lifetime in test mode')
  .option('--test-session-id <id>')
  .action((dir,o)=>action(async()=>serveSchedulerSupervisor(root(dir),{
    intervalSeconds:Number(o.intervalSeconds),staleSeconds:Number(o.staleSeconds),cycleTimeoutSeconds:Number(o.cycleTimeoutSeconds),
    maxConsecutiveFailures:Number(o.maxConsecutiveFailures),slowWriteMs:Number(o.slowWriteMs),lastRecoveryAction:o.lastRecoveryAction,
    testMode:Boolean(o.testMode),maxRuntimeSeconds:o.maxRuntimeSeconds===undefined?undefined:Number(o.maxRuntimeSeconds),testSessionId:o.testSessionId,
  })));

const activity=program.command('activity').description('Record detailed work inside the current Round');
activity.command('start').argument('<task-dir>')
  .addOption(new Option('--kind <kind>').choices(['reproduce','analyze','change']).makeOptionMandatory())
  .requiredOption('--label <label>').requiredOption('--summary <summary>').option('--ref <ref...>').option('--json')
  .action((dir,o)=>action(async()=>{
    const event=await startWorkActivity(root(dir),{kind:workActivityKindSchema.parse(o.kind),label:o.label,summary:o.summary,refs:o.ref});
    print(o.json?event:`started ${event.step_run_id} (${event.label})`,o.json);
  }));
activity.command('finish').argument('<task-dir>').requiredOption('--id <step-run-id>')
  .addOption(new Option('--outcome <outcome>').choices(['success','failure','interrupted','cancelled']).makeOptionMandatory())
  .option('--summary <summary>').option('--ref <ref...>').option('--json')
  .action((dir,o)=>action(async()=>{
    const event=await finishWorkActivity(root(dir),o.id,{outcome:o.outcome,summary:o.summary,refs:o.ref});
    print(o.json?event:`finished ${event.step_run_id} (${event.outcome})`,o.json);
  }));
activity.command('run').argument('<task-dir>').argument('<executable>').argument('[args...]')
  .addOption(new Option('--kind <kind>').choices(['command','playwright']).default('command'))
  .requiredOption('--label <label>').requiredOption('--summary <summary>').option('--ref <ref...>').option('--timeout-seconds <seconds>','hard command timeout','300').option('--json')
  .action((dir,executable,args,o)=>action(async()=>{
    const timeoutSeconds=Number(o.timeoutSeconds);if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<=0||timeoutSeconds>3600)throw new Error('--timeout-seconds must be > 0 and <= 3600');
    const result=await runWorkCommand(root(dir),{kind:o.kind,label:o.label,summary:o.summary,executable,args,refs:o.ref,timeoutMs:Math.round(timeoutSeconds*1000)});
    print(o.json?result:`${o.label}: exit=${result.exitCode}`,o.json);
    if(result.exitCode!==0)process.exitCode=result.exitCode;
  }));

const triage=program.command('triage').description('Manual proposal and approval flow');
triage.command('propose').argument('<project-dir>').requiredOption('--source <source>').requiredOption('--goal <goal>').addOption(new Option('--risk <level>').choices(['light','standard','heavy']).default('standard')).addOption(new Option('--priority <priority>').choices(['P0','P1','P2','P3']).default('P1')).requiredOption('--reason <reason>').option('--ac <criterion...>').option('--contract <json>','P-prepared v2 Acceptance Contract; approved together with the Proposal').action((dir,o)=>action(async()=>console.log(await createProposal(root(dir),{source:o.source,goal:o.goal,risk:o.risk,priority:o.priority,reason:o.reason,criteria:o.ac,...(o.contract?{acceptanceContract:JSON.parse(await readFile(root(o.contract),'utf8'))}:{})}))));
triage.command('approve').argument('<project-dir>').argument('<proposal-id>').requiredOption('--by <identity>').option('--ttl-hours <hours>','approval validity in hours','24').action((dir,id,o)=>action(async()=>console.log(await approveProposal(root(dir),id,o.by,Number(o.ttlHours)))));
triage.command('create-task').argument('<project-dir>').argument('<proposal-id>').requiredOption('--id <task-id>').requiredOption('--title <title>').option('--adopt-existing','bind an approved draft in the target spec library').action((dir,p,o)=>action(async()=>console.log(await createTaskFromProposal(root(dir),p,o.id,o.title,Boolean(o.adoptExisting)))));

const providers=program.command('providers').description('Provider configuration and diagnostics');
providers.command('show').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{const results=await providerDoctor(root(dir));print(results,o.json)}));
providers.command('set').argument('<project-dir>').addOption(new Option('--active <provider>').choices(['codex','claude-code','qoder']).makeOptionMandatory()).action((dir,o)=>action(async()=>{await setActiveProvider(root(dir),o.active);console.log(`active provider: ${o.active}`)}));
providers.command('set-role').argument('<project-dir>').addOption(new Option('--role <role>').choices(['M','V','R']).makeOptionMandatory()).addOption(new Option('--provider <provider>').choices(['codex','claude-code','qoder']).makeOptionMandatory()).action((dir,o)=>action(async()=>{await setRoleProvider(root(dir),o.role,o.provider);console.log(`${o.role} provider: ${o.provider}`)}));

const connectors=program.command('connectors').description('External notification and confirmation connectors');
const feishu=connectors.command('feishu').description('Feishu enterprise app bot connector');
feishu.command('init').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{
  const file=await initFeishuConfig(root(dir));print(o.json?{created:file}:`created ${file}`,o.json);
}));
feishu.command('check').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{
  const config=await readFeishuConfig(root(dir));print(o.json?{ok:true,enabled:config.enabled,targets:config.targets.length,approvers:config.approvers.length}:`feishu config ok: enabled=${config.enabled} targets=${config.targets.length} approvers=${config.approvers.length}`,o.json);
}));
feishu.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await feishuConnectorStatus(root(dir)),o.json)));
feishu.command('start').argument('<project-dir>').option('--holder <identity>').action((dir,o)=>action(async()=>{
  console.log('starting feishu connector; press Ctrl+C to stop');
  const projectRoot=root(dir);
  await superviseFeishuConnector(projectRoot,{holder:o.holder,confirmationController:createLocalSpecLoopConfirmationController(projectRoot)});
}));
feishu.command('stop').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await stopFeishuConnector(root(dir)),o.json)));
feishu.command('disable').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await disableFeishuConnector(root(dir)),o.json)));
feishu.command('reconcile').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{
  const projectRoot=root(dir),{reconcileFeishuConnector}=await import('./connectors/feishu-operations.js');
  print(await reconcileFeishuConnector(projectRoot,createLocalSpecLoopConfirmationController(projectRoot)),o.json);
}));
feishu.command('retry-dead-letter').argument('<project-dir>').option('--record <record-id...>').option('--json').action((dir,o)=>action(async()=>{
  const {retryFeishuDeadLetters}=await import('./connectors/feishu-progress.js');
  const retried=await retryFeishuDeadLetters(root(dir),o.record??[]);print(o.json?{retried}:`retried ${retried} Feishu dead-letter record(s)`,o.json);
}));
feishu.command('confirm-local').argument('<project-dir>').requiredOption('--request <request-id>')
  .addOption(new Option('--action <action-id>').choices([
    'approve_proposal','reject_proposal','choose_option','pause_task','approve_visual','reject_visual',
    'authorize_verification','defer_verification','accept_heavy','reject_heavy',
  ]).makeOptionMandatory())
  .requiredOption('--actor <identity>').option('--option <option-id>').option('--event <event-id>').option('--json')
  .action((dir,o)=>action(async()=>{
    const projectRoot=root(dir),project=await readProject(projectRoot);
    const result=await acceptLocalConfirmationAction(projectRoot,{
      eventId:o.event,projectId:project.project_id,actor:o.actor,requestId:o.request,action:o.action,optionId:o.option,
    });
    const record=await processFeishuAction(projectRoot,result.record.inbox_id,createLocalSpecLoopConfirmationController(projectRoot));
    print(o.json?{...result,record}:`processed local confirmation ${record.inbox_id} (${record.status})`,o.json);
  }));
feishu.command('inbox').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>{
  const records=await listFeishuActionInbox(root(dir));
  print(o.json?records:records.map((item)=>`${item.inbox_id}\t${item.status}\t${item.envelope.action_id}\t${item.envelope.request_id}`).join('\n'),o.json);
}));

const workspace=program.command('workspace').description('Task worktree management');
workspace.command('create').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await createWorkspace(root(dir),id),o.json)));

const gate=program.command('gate').description('Deterministic T1 command gates');
gate.command('run').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const results=await runGates(root(dir),id);print(results,o.json);if(results.some(r=>r.exit_code!==0))process.exitCode=1}));

const harness=program.command('harness').description('prepare → execute → collect → verify → report');
harness.command('prepare').argument('<project-dir>').argument('<task-id>').requiredOption('--prompt <text>').option('--no-view').action((dir,id,o)=>action(async()=>{const result=await prepareHarness(root(dir),id,o.prompt);console.log(result);await maybeAutoOpenExecutionView(root(dir),o)}));
harness.command('execute').argument('<project-dir>').argument('<task-id>').requiredOption('--prompt <text>').option('--no-view').action((dir,id,o)=>action(async()=>{await maybeAutoOpenExecutionView(root(dir),{...o,json:true});const r=await executeHarness(root(dir),id,o.prompt);print(r,true);if(r.code!==0)process.exitCode=1}));
harness.command('collect').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await collectHarness(root(dir),id),o.json)));
harness.command('verify').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>{const r=await runGates(root(dir),id);print(r,o.json);if(r.some(x=>x.exit_code!==0))process.exitCode=1}));
harness.command('report').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await reportHarness(root(dir),id),o.json)));
harness.command('reconcile').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await reconcileHarness(root(dir),id),o.json)));

const acceptance=program.command('acceptance').description('P → M → V → R Acceptance Protocol v2 (explicit opt-in; v1 tasks remain unchanged)');
const acceptanceContract=acceptance.command('contract').description('P Acceptance Contract');
acceptanceContract.command('approve').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--file <json>').requiredOption('--by <identity>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await approveAcceptanceContract(root(dir),id,root(o.file),o.by),o.json)));
acceptance.command('start').argument('<project-dir>').argument('<task-id>').option('--json').option('--no-view')
  .action((dir,id,o)=>action(async()=>{const result=await startAcceptanceRun(root(dir),id);print(result,o.json);await maybeAutoOpenExecutionView(root(dir),o)}));
acceptance.command('m-submit').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--self-test <file...>').option('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await submitMakerCandidate(root(dir),id,o.selfTest.map(root),o.invocation),o.json)));
acceptance.command('compile').argument('<project-dir>').argument('<task-id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await compileAcceptancePlan(root(dir),id),o.json)));
acceptance.command('v-run').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>{const result=await runControlledV(root(dir),id,o.invocation);print(result,o.json);if(result.run.stage!=='v_passed')process.exitCode=1}));
acceptance.command('v-record').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--file <json>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await recordVResult(root(dir),id,root(o.file)),o.json)));
acceptance.command('r-record').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--file <json>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await recordRResult(root(dir),id,root(o.file)),o.json)));
acceptance.command('resolve').argument('<project-dir>').argument('<task-id>')
  .requiredOption('--file <json>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await resolveAcceptanceConflict(root(dir),id,JSON.parse(await readFile(root(o.file),'utf8'))),o.json)));
acceptance.command('status').argument('<project-dir>').argument('<task-id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await readAcceptanceRun(root(dir),id),o.json)));
acceptance.command('schedule').argument('<project-dir>').option('--json')
  .action((dir,o)=>action(async()=>print(await buildAcceptanceSchedule(root(dir)),o.json)));
acceptance.command('reconcile-candidate').description('Inspect baseline drift; --apply invalidates stale verification and requeues M without merging').argument('<project-dir>').argument('<task-id>').option('--apply','apply a detected baseline-drift recovery').option('--json')
  .action((dir,id,o)=>action(async()=>print(await reconcileCandidateBaseline(root(dir),id,Boolean(o.apply)),o.json)));
acceptance.command('usage').description('Summarize locally recorded Provider token and cost facts').argument('<project-dir>').argument('[task-id]').option('--json')
  .action((dir,id,o)=>action(async()=>print(await summarizeRoleUsage(root(dir),id),o.json)));
const acceptanceRole=acceptance.command('role').description('Managed M/V/R provider invocations');
acceptanceRole.command('prepare').argument('<project-dir>').argument('<task-id>').addOption(new Option('--role <role>').choices(['M','V','R']).makeOptionMandatory()).option('--json')
  .action((dir,id,o)=>action(async()=>print(await prepareRoleInvocation(root(dir),id,o.role),o.json)));
acceptanceRole.command('run').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').option('--json').option('--no-view')
  .action((dir,id,o)=>action(async()=>{await maybeAutoOpenExecutionView(root(dir),o);const result=await runRoleInvocation(root(dir),id,o.invocation);print(result,o.json);if(result.status!=='succeeded')process.exitCode=1}));
acceptanceRole.command('ingest').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>{const result=await ingestSucceededRoleResult(root(dir),id,o.invocation);print(result,o.json);if(result.result_status!=='ingested')process.exitCode=1}));
acceptanceRole.command('recover-budget-m').description('Recover a clean M candidate stopped only by the former token budget after explicit budget extension').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').requiredOption('--by <actor>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await recoverBudgetStoppedMakerCandidate(root(dir),id,o.invocation,o.by),o.json)));
acceptanceRole.command('status').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await readRoleInvocation(root(dir),id,o.invocation),o.json)));
acceptanceRole.command('cancel').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await cancelRoleInvocation(root(dir),id,o.invocation),o.json)));
acceptanceRole.command('reconcile').argument('<project-dir>').argument('<task-id>').requiredOption('--invocation <id>').option('--json')
  .action((dir,id,o)=>action(async()=>print(await reconcileRoleInvocation(root(dir),id,o.invocation),o.json)));

const scheduler=program.command('scheduler').description('Project scheduler controls');
scheduler.command('init').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await initReportScheduler(root(dir)),o.json)));
scheduler.command('report').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await runReportScheduler(root(dir)),o.json)));
scheduler.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await readReportSchedulerStatus(root(dir)),o.json)));
scheduler.command('pause').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await setReportSchedulerPaused(root(dir),true),o.json)));
scheduler.command('resume').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await setReportSchedulerPaused(root(dir),false),o.json)));
const schedulerControl=scheduler.command('control').description('Lease, fencing, resource, Pause and Kill controls');
schedulerControl.command('init').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await initSchedulerControl(root(dir)),o.json)));
schedulerControl.command('acquire-project').argument('<project-dir>').requiredOption('--owner <identity>').requiredOption('--key <idempotency-key>').option('--ttl <seconds>','lease TTL','300').option('--json').action((dir,o)=>action(async()=>print(await acquireProjectLease(root(dir),{owner:o.owner,idempotencyKey:o.key,ttlSeconds:Number(o.ttl)}),o.json)));
schedulerControl.command('acquire-task').argument('<project-dir>').requiredOption('--project-lease <id>').requiredOption('--project-token <token>').requiredOption('--task <id>').requiredOption('--owner <identity>').requiredOption('--key <idempotency-key>').requiredOption('--resource <claim...>').addOption(new Option('--action <action>').choices(['start_m','start_v','start_r','run_gate']).makeOptionMandatory()).option('--ttl <seconds>','lease TTL','300').option('--json').action((dir,o)=>action(async()=>print(await acquireTaskLease(root(dir),{projectLeaseId:o.projectLease,projectFencingToken:Number(o.projectToken),taskId:o.task,owner:o.owner,idempotencyKey:o.key,ttlSeconds:Number(o.ttl),resources:o.resource,action:o.action}),o.json)));
schedulerControl.command('renew-project').argument('<project-dir>').requiredOption('--lease <id>').requiredOption('--token <token>').requiredOption('--owner-nonce <nonce>').requiredOption('--not-after <iso-time>').option('--ttl <seconds>','renewal TTL','60').option('--json').action((dir,o)=>action(async()=>print(await renewProjectLease(root(dir),{leaseId:o.lease,fencingToken:Number(o.token),ownerNonce:o.ownerNonce,ttlSeconds:Number(o.ttl),notAfter:o.notAfter}),o.json)));
schedulerControl.command('renew-task').argument('<project-dir>').requiredOption('--lease <id>').requiredOption('--token <token>').requiredOption('--owner-nonce <nonce>').requiredOption('--not-after <iso-time>').option('--ttl <seconds>','renewal TTL','60').option('--json').action((dir,o)=>action(async()=>print(await renewTaskLease(root(dir),{leaseId:o.lease,fencingToken:Number(o.token),ownerNonce:o.ownerNonce,ttlSeconds:Number(o.ttl),notAfter:o.notAfter}),o.json)));
schedulerControl.command('accept-result').argument('<project-dir>').requiredOption('--lease <id>').requiredOption('--token <token>').option('--invocation <id>').option('--json').action((dir,o)=>action(async()=>print(await assertTaskLeaseResult(root(dir),o.lease,Number(o.token),o.invocation),o.json)));
schedulerControl.command('release-task').argument('<project-dir>').requiredOption('--lease <id>').requiredOption('--token <token>').option('--json').action((dir,o)=>action(async()=>print(await releaseTaskLease(root(dir),o.lease,Number(o.token)),o.json)));
schedulerControl.command('release-project').argument('<project-dir>').requiredOption('--lease <id>').requiredOption('--token <token>').option('--json').action((dir,o)=>action(async()=>print(await releaseProjectLease(root(dir),o.lease,Number(o.token)),o.json)));
schedulerControl.command('authorize').argument('<action>').option('--json').action((value,o)=>action(async()=>print(assertSchedulerAction(value),o.json)));
schedulerControl.command('pause').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await pauseSchedulerControl(root(dir)),o.json)));
schedulerControl.command('resume').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await resumeSchedulerControl(root(dir)),o.json)));
schedulerControl.command('kill').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await killSchedulerControl(root(dir)),o.json)));
schedulerControl.command('stop-task').argument('<project-dir>').requiredOption('--task <id>').option('--reason <text>','auditable stop reason','stopped by user').option('--stop-request <uuid>','internal stop intent generation').option('--json').action((dir,o)=>action(async()=>print(await stopTaskExecution(root(dir),o.task,o.reason,o.stopRequest),o.json)));
schedulerControl.command('retry-task').description('Explicitly move one Scheduler DeadLetter to RetryWait').argument('<project-dir>').requiredOption('--task <id>').option('--json').action((dir,o)=>action(async()=>print(await retryDeadLetter(root(dir),o.task),o.json)));
schedulerControl.command('budget').description('Configure wave-wide concurrency, elapsed, token and cost ceilings').argument('<project-dir>').requiredOption('--max-parallel <count>').requiredOption('--max-elapsed-seconds <seconds>').requiredOption('--max-tokens <tokens>').requiredOption('--max-cost-usd <amount>').option('--json').action((dir,o)=>action(async()=>print(await configureWaveBudget(root(dir),{maxParallel:Number(o.maxParallel),maxElapsedSeconds:Number(o.maxElapsedSeconds),maxTokens:Number(o.maxTokens),maxCostUsd:Number(o.maxCostUsd)}),o.json)));
schedulerControl.command('run-ready').description('Plan by default; --execute continuously advances approved Tasks through M/V/R and produces one final review').argument('<project-dir>').requiredOption('--owner <identity>').option('--execute','start managed role invocations').option('--single-stage','diagnostic mode: stop after one stage').option('--task <ids...>','limit execution to approved Task IDs').option('--json').option('--no-view').action((dir,o)=>action(async()=>{
  if(o.execute)await maybeAutoOpenExecutionView(root(dir),o);
  const result=o.execute?await runReadyWave(root(dir),{owner:o.owner,taskIds:o.task,singleStage:o.singleStage}):await planReadyWave(root(dir),{taskIds:o.task?new Set<string>(o.task):undefined});print(result,o.json);if(o.execute&&!['completed','awaiting_wave_review'].includes(result.status))process.exitCode=5;
}));
const waveReview=schedulerControl.command('wave-review').description('One final review for an approved execution wave');
waveReview.command('list').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await listWaveReviews(root(dir)),o.json)));
waveReview.command('show').argument('<project-dir>').argument('<wave-id>').option('--json').action((dir,id,o)=>action(async()=>print(await readWaveReview(root(dir),id),o.json)));
waveReview.command('refresh').argument('<project-dir>').argument('<wave-id>').option('--json').action((dir,id,o)=>action(async()=>print(await refreshWaveReview(root(dir),id),o.json)));
waveReview.command('rebuild').description('Rebuild a failed review finalization while execution stays paused').argument('<project-dir>').argument('<wave-id>').option('--json').action((dir,id,o)=>action(async()=>print(await rebuildWaveReview(root(dir),id),o.json)));
waveReview.command('decide').argument('<project-dir>').argument('<wave-id>').requiredOption('--input <json-file>').option('--json').action((dir,id,o)=>action(async()=>print(await decideWaveReview(root(dir),id,JSON.parse(await readFile(path.resolve(o.input),'utf8'))),o.json)));
schedulerControl.command('run-approved').argument('<project-dir>').requiredOption('--authorization <id>').option('--launch-token <id>','internal launch generation').option('--json').option('--no-view').action((dir,o)=>action(async()=>{await maybeAutoOpenExecutionView(root(dir),o);print(await runAuthorizedWave(root(dir),o.authorization,{launchToken:o.launchToken}),o.json)}));
schedulerControl.command('health').description('Read-only PID, heartbeat, Driver and wave deadline liveness inspection').argument('<project-dir>').option('--stale-seconds <seconds>','heartbeat stale threshold','15').option('--json').action((dir,o)=>action(async()=>{const result=await inspectSchedulerLiveness(root(dir),Number(o.staleSeconds));print(result,o.json);if(!result.ok)process.exitCode=5}));
schedulerControl.command('watchdog').description('Inspect by default; --apply atomically stops Tasks with dead or stale execution owners').argument('<project-dir>').option('--stale-seconds <seconds>','heartbeat stale threshold','15').option('--apply','stop unhealthy Tasks').option('--json').action((dir,o)=>action(async()=>{const result=await runSchedulerWatchdog(root(dir),Number(o.staleSeconds),Boolean(o.apply));print(result,o.json);if(!result.ok&&!o.apply)process.exitCode=5}));
schedulerControl.command('supervisor-start')
  .description('Start the independent persistent watchdog Supervisor')
  .argument('<project-dir>')
  .option('--interval-seconds <seconds>', 'seconds between watchdog cycles', '5')
  .option('--stale-seconds <seconds>', 'execution heartbeat stale threshold', '15')
  .option('--cycle-timeout-seconds <seconds>', 'hard timeout for one isolated watchdog cycle', '60')
  .option('--max-consecutive-failures <count>','watchdog circuit-breaker threshold','3')
  .option('--slow-write-ms <milliseconds>','control-plane write degradation threshold','2000')
  .option('--test-mode','start a bounded test Supervisor')
  .option('--max-runtime-seconds <seconds>','required bounded lifetime in test mode')
  .option('--test-session-id <id>')
  .option('--json')
  .action((dir, o) => action(async () => {
    const result = await startManagedSchedulerSupervisor(root(dir), {
      intervalSeconds: Number(o.intervalSeconds), staleSeconds: Number(o.staleSeconds), cycleTimeoutSeconds: Number(o.cycleTimeoutSeconds),
      maxConsecutiveFailures:Number(o.maxConsecutiveFailures),slowWriteMs:Number(o.slowWriteMs),testMode:Boolean(o.testMode),
      maxRuntimeSeconds:o.maxRuntimeSeconds===undefined?undefined:Number(o.maxRuntimeSeconds),testSessionId:o.testSessionId,
    });
    print(result, o.json);
  }));
schedulerControl.command('supervisor-status')
  .description('Report Supervisor PID identity, heartbeat and latest watchdog result')
  .argument('<project-dir>').option('--json')
  .action((dir, o) => action(async () => {
    const result = await schedulerSupervisorStatus(root(dir));
    print(result, o.json);
    if (!result.running || !result.healthy) process.exitCode = 5;
  }));
schedulerControl.command('supervisor-circuit-status').description('Report the persistent Supervisor circuit breaker').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await schedulerSupervisorCircuitStatus(root(dir)),o.json)));
schedulerControl.command('supervisor-circuit-reset').description('Explicitly reset an open Supervisor circuit after the cause is fixed').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await resetSchedulerSupervisorCircuit(root(dir)),o.json)));
schedulerControl.command('supervisor-launchd-plan').description('Print an optional macOS launchd auto-restart plan without installing it').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await schedulerSupervisorLaunchdPlan(root(dir)),o.json)));
schedulerControl.command('supervisor-launchd-install').description('Preview by default; --apply installs and bootstraps the audited macOS launchd Supervisor').argument('<project-dir>').option('--apply','write and bootstrap the launchd service').option('--json').action((dir,o)=>action(async()=>print(o.apply?await installSchedulerSupervisorLaunchd(root(dir)):await schedulerSupervisorLaunchdPlan(root(dir)),o.json)));
schedulerControl.command('supervisor-launchd-uninstall').description('Requires --apply; boot out and remove only this Project Supervisor plist').argument('<project-dir>').option('--apply','perform the scoped uninstall').option('--json').action((dir,o)=>action(async()=>{if(!o.apply)throw new Error('launchd uninstall requires --apply');print(await uninstallSchedulerSupervisorLaunchd(root(dir)),o.json)}));
schedulerControl.command('supervisor-stop')
  .description('Stop the managed watchdog Supervisor without starting or cancelling business work')
  .argument('<project-dir>').option('--json')
  .action((dir, o) => action(async () => print(await stopManagedSchedulerSupervisor(root(dir)), o.json)));
schedulerControl.command('reconcile').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await reconcileSchedulerControl(root(dir)),o.json)));
schedulerControl.command('reconcile-waves').description('Inspect interrupted waves by default; --apply reconciles invocations and requeues safe work').argument('<project-dir>').option('--apply','persist interrupted/requeued state').option('--json').action((dir,o)=>action(async()=>print(await reconcileInterruptedWaves(root(dir),Boolean(o.apply)),o.json)));
schedulerControl.command('status').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await schedulerControlStatus(root(dir)),o.json)));

const toolchain=program.command('toolchain').description('Read-only Gate planning and native evidence adapters');
toolchain.command('detect-spring').argument('<repository>').option('--json').action((dir,o)=>action(async()=>print(await detectSpringBoot(root(dir)),o.json)));
toolchain.command('plan').argument('<project-dir>').argument('<task-id>').addOption(new Option('--stage <stage>').choices(['feedback','candidate','delivery','phase']).makeOptionMandatory()).option('--json').action((dir,id,o)=>action(async()=>print(await planV2Gates(root(dir),id,o.stage),o.json)));
toolchain.command('verify-plan').argument('<project-dir>').argument('<task-id>').addOption(new Option('--stage <stage>').choices(['feedback','candidate','delivery','phase']).makeOptionMandatory()).option('--json').action((dir,id,o)=>action(async()=>print(await verifyV2GatePlan(root(dir),id,o.stage),o.json)));
toolchain.command('collect-spring').argument('<project-dir>').argument('<task-id>').requiredOption('--reports <directory>').option('--json').action((dir,id,o)=>action(async()=>print(await collectSpringEvidence(root(dir),id,root(o.reports)),o.json)));
toolchain.command('verify-spring').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await verifySpringEvidence(root(dir),id),o.json)));

const maintenance=program.command('maintenance').description('Read-only artifact inventory and retention planning');
maintenance.command('inspect').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await inspectArtifacts(root(dir)),o.json)));
maintenance.command('retention-plan').description('Show bounded artifact, shared-cache and retirement policy without deleting data').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await retentionPolicy(root(dir)),o.json)));
maintenance.command('archive-events').description('Seal execution history into hashed segments while preserving open steps and the global event chain').argument('<project-dir>').option('--json').action((dir,o)=>action(async()=>print(await archiveExecutionEvents(root(dir)),o.json)));
maintenance.command('archive-evidence').description('Copy bounded authoritative Acceptance facts into a persistent hash manifest').argument('<project-dir>').argument('<task-id>').option('--json').action((dir,id,o)=>action(async()=>print(await archiveAcceptanceEvidence(root(dir),id),o.json)));
maintenance.command('enforce-retention').description('Archive bounded terminal Evidence without deleting worktrees or history').argument('<project-dir>').option('--max-tasks <n>','maximum Tasks archived in one cycle','5').option('--json').action((dir,o)=>action(async()=>print(await runRetentionMaintenance(root(dir),Number(o.maxTasks)),o.json)));
maintenance.command('retire-worktree').description('Preview by default; --apply removes only a clean terminal Worktree while preserving its branch and records').argument('<project-dir>').argument('<task-id>').option('--expected-head <commit>').option('--apply','perform the validated retirement').option('--json').action((dir,id,o)=>action(async()=>{
  if(o.apply&&!o.expectedHead)throw new Error('--apply requires --expected-head');
  print(o.apply?await retireWorktree(root(dir),id,o.expectedHead):await planWorktreeRetirement(root(dir),id,o.expectedHead),o.json);
}));

program.command('writeback').argument('<project-dir>').argument('<task-id>').action((dir,id)=>action(async()=>console.log(await writebackDelivery(root(dir),id))));

await program.parseAsync();
