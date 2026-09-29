import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWriteMany, atomicWriteTelemetry, removeTelemetryFile } from './files.js';
import { readProject } from './project.js';
import { processMatches, inspectProcess, processStartedAt, signalProcessTree, terminateProcessTree } from './process-control.js';
import { runRetentionMaintenance } from './maintenance.js';
import { acquireOwnedDirectoryLock, inspectOwnedDirectoryLock, type OwnedDirectoryLock } from './owned-lock.js';
import { createLatestValueWriter, withOperationTimeout, withAbortableOperationTimeout } from './latest-writer.js';
import { runManagedProcess, startManagedProcess } from './managed-process.js';

const supervisorMarkerSchema = z.object({
  schema_version: z.literal(1),
  project_root: z.string(),
  pid: z.number().int().positive(),
  process_started_at: z.string().min(5),
  interval_seconds: z.number().int().min(1).max(300),
  stale_seconds: z.number().int().min(3).max(3600),
  cycle_timeout_seconds: z.number().int().min(3).max(600),
  started_at: z.iso.datetime(),
  heartbeat_at: z.iso.datetime(),
  iteration: z.number().int().nonnegative(),
  state: z.enum(['starting', 'checking', 'healthy', 'degraded', 'stopping']),
  worker_pid: z.number().int().positive().nullable(),
  worker_process_started_at: z.string().nullable().default(null),
  last_check_at: z.iso.datetime().nullable(),
  last_check_ok: z.boolean().nullable(),
  last_unhealthy_count: z.number().int().nonnegative().nullable(),
  last_stopped_tasks: z.array(z.string()),
  last_error: z.string().max(1000).nullable(),
  last_maintenance_at: z.iso.datetime().nullable().default(null),
  last_maintenance_archived: z.number().int().nonnegative().default(0),
  last_maintenance_errors: z.number().int().nonnegative().default(0),
  successful_watchdogs: z.number().int().nonnegative().default(0),
  consecutive_failures: z.number().int().nonnegative().default(0),
  max_consecutive_failures: z.number().int().positive().default(3),
  last_recovery_action: z.string().max(500).nullable().default(null),
  control_io: z.object({
    writes_started: z.number().int().nonnegative(), writes_completed: z.number().int().nonnegative(), coalesced_updates: z.number().int().nonnegative(),
    last_duration_ms: z.number().int().nonnegative().nullable(), max_duration_ms: z.number().int().nonnegative(), consecutive_failures: z.number().int().nonnegative(),
    last_error: z.string().nullable(), last_write_at: z.iso.datetime().nullable(),
  }).strict().nullable().default(null),
  test_mode: z.boolean().default(false),
  test_session_id: z.string().min(1).max(200).nullable().default(null),
  max_runtime_seconds: z.number().int().positive().nullable().default(null),
}).strict();

type SupervisorMarker = z.infer<typeof supervisorMarkerSchema>;

const supervisorCircuitSchema=z.object({schema_version:z.literal(1),circuit_open:z.boolean(),opened_at:z.iso.datetime().nullable(),reason:z.string().max(1000).nullable(),consecutive_failures:z.number().int().nonnegative(),automatic_restarts:z.array(z.iso.datetime()).max(100),updated_at:z.iso.datetime()}).strict();
type SupervisorCircuit=z.infer<typeof supervisorCircuitSchema>;

const markerFile = (root: string) => path.join(root, '.spec-loop', 'scheduler', 'SUPERVISOR.json');
const circuitFile = (root: string) => path.join(root, '.spec-loop', 'scheduler', 'SUPERVISOR_CIRCUIT.json');
const lockDir = (root: string) => path.join(root, '.spec-loop', 'locks', 'scheduler-supervisor.lock');
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function readMarker(root: string): Promise<SupervisorMarker> {
  return supervisorMarkerSchema.parse(JSON.parse(await readFile(markerFile(root), 'utf8')));
}

async function readCircuit(root:string):Promise<SupervisorCircuit>{try{return supervisorCircuitSchema.parse(JSON.parse(await readFile(circuitFile(root),'utf8')))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return supervisorCircuitSchema.parse({schema_version:1,circuit_open:false,opened_at:null,reason:null,consecutive_failures:0,automatic_restarts:[],updated_at:new Date().toISOString()})}}
async function writeCircuit(root:string,value:SupervisorCircuit):Promise<void>{await atomicWriteMany(root,[{file:circuitFile(root),content:`${JSON.stringify(supervisorCircuitSchema.parse(value),null,2)}\n`}])}
export async function schedulerSupervisorCircuitStatus(projectRoot:string){const root=await realpath(projectRoot);return readCircuit(root)}
export async function resetSchedulerSupervisorCircuit(projectRoot:string){const root=await realpath(projectRoot),status=await schedulerSupervisorStatus(root);if(status.running)throw new Error('stop the scheduler Supervisor before resetting its circuit');const value=supervisorCircuitSchema.parse({schema_version:1,circuit_open:false,opened_at:null,reason:null,consecutive_failures:0,automatic_restarts:[],updated_at:new Date().toISOString()});await writeCircuit(root,value);return value}

async function releaseSupervisorFiles(root: string, processStart: string, lock: OwnedDirectoryLock): Promise<void> {
  try {
    await withOperationTimeout(removeTelemetryFile(root, markerFile(root), async () => {
      const marker = await readMarker(root).catch(() => null);
      return marker?.pid === process.pid && marker.process_started_at === processStart;
    }), 5_000, 'Supervisor heartbeat removal');
  } finally { await lock.release(); }
}

async function watchdogCycle(
  root: string,
  staleSeconds: number,
  timeoutSeconds: number,
  onWorker: (worker: ChildProcess | null, identity: string | null) => Promise<void>,
): Promise<{ ok: boolean; unhealthy: unknown[]; stopped_tasks: Array<{ task_id?: string }> }> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  let outputBytes = 0, errorBytes = 0, outputError: Error | null = null;
  const managed = startManagedProcess({
    bin: process.execPath,
    args: [cli, 'scheduler', 'control', 'watchdog', root, '--stale-seconds', String(staleSeconds), '--apply', '--json'],
    cwd: root, timeoutMs: timeoutSeconds * 1000, maxCaptureBytes: 1_000_000,
    onStdout(chunk) {
      outputBytes += chunk.length;
      if (outputBytes > 1_000_000) { outputError = new Error('watchdog cycle output exceeded 1 MB'); void managed.terminate(); }
    },
    onStderr(chunk) {
      errorBytes += chunk.length;
      if (errorBytes > 100_000) { outputError = new Error('watchdog cycle error output exceeded 100 KB'); void managed.terminate(); }
    },
  });
  try {
    const identity = await managed.processStartedAt;
    if (managed.child.exitCode === null && managed.child.signalCode === null && !identity) throw new Error('cannot establish watchdog Worker process start identity');
    await onWorker(managed.child, identity);
    const result = await managed.completion;
    if (!result.termination_verified) throw new Error('watchdog worker stop was not verified');
    if (outputError) throw outputError;
    if (result.timedOut) throw new Error(`watchdog cycle exceeded ${timeoutSeconds}s and was killed`);
    if (result.identity_error) throw new Error(result.identity_error);
    if (result.code !== 0) throw new Error((result.stderr.trim() || `watchdog cycle exited ${result.code}`).slice(0, 1000));
    try {
      const parsed = JSON.parse(result.stdout) as { ok?: boolean; unhealthy?: unknown[]; stopped_tasks?: Array<{ task_id?: string }> };
      return { ok: parsed.ok === true, unhealthy: Array.isArray(parsed.unhealthy) ? parsed.unhealthy : [], stopped_tasks: Array.isArray(parsed.stopped_tasks) ? parsed.stopped_tasks : [] };
    } catch (error) { throw new Error(`watchdog cycle returned invalid JSON: ${(error as Error).message}`); }
  } catch (error) {
    const stopped = await managed.terminate({ graceMs: 500 });
    const completion = await managed.completion;
    if (!stopped && !completion.termination_verified) throw new Error(`${(error as Error).message}; watchdog worker stop was not verified`);
    throw error;
  } finally { await onWorker(null, null); }
}

export async function schedulerSupervisorStatus(projectRoot: string) {
  const root = await realpath(projectRoot),circuit=await readCircuit(root), info = await lstat(markerFile(root)).catch(() => null);
  if (!info) return { running: false, healthy: false, reason: circuit.circuit_open?'circuit_open' as const:'not_started' as const, marker: null,circuit };
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('scheduler Supervisor marker is invalid');
  let marker: SupervisorMarker;
  try { marker = await readMarker(root); } catch (error) { return { running: false, healthy: false, reason: `invalid_marker: ${(error as Error).message}`, marker: null }; }
  if (marker.project_root !== root) return { running: false, healthy: false, reason: 'project_root_mismatch' as const, marker };
  const identity=await inspectProcess(marker.pid,marker.process_started_at);
  if(identity.status==='unknown')return{running:true,healthy:false,reason:'identity_unknown' as const,marker,circuit};
  if (identity.status!=='alive') return { running: false, healthy: false, reason: circuit.circuit_open?'circuit_open' as const:'stale_pid' as const, marker,circuit };
  const heartbeatAgeMs = Math.max(0, Date.now() - Date.parse(marker.heartbeat_at));
  const heartbeatLimitMs = Math.max(5000, marker.interval_seconds * 3000);
  if(circuit.circuit_open)return{running:true,healthy:false,reason:'circuit_open' as const,heartbeat_age_ms:heartbeatAgeMs,marker,circuit};
  if (heartbeatAgeMs > heartbeatLimitMs) return { running: true, healthy: false, reason: 'stale_heartbeat' as const, heartbeat_age_ms: heartbeatAgeMs, marker,circuit };
  if(marker.state==='degraded'&&marker.consecutive_failures<marker.max_consecutive_failures)return{running:true,healthy:false,reason:'watchdog_retrying' as const,heartbeat_age_ms:heartbeatAgeMs,marker};
  if (marker.state !== 'healthy') return { running: true, healthy: false, reason: marker.state, heartbeat_age_ms: heartbeatAgeMs, marker };
  if(marker.successful_watchdogs<1||marker.last_check_ok!==true)return{running:true,healthy:false,reason:'watchdog_not_ready' as const,heartbeat_age_ms:heartbeatAgeMs,marker};
  if((marker.control_io?.consecutive_failures??0)>0)return{running:true,healthy:false,reason:'control_io_degraded' as const,heartbeat_age_ms:heartbeatAgeMs,marker};
  return { running: true, healthy: true, reason: 'healthy' as const, heartbeat_age_ms: heartbeatAgeMs, marker };
}

export async function serveSchedulerSupervisor(projectRoot: string, options: {
  intervalSeconds?: number; staleSeconds?: number; cycleTimeoutSeconds?: number; maxConsecutiveFailures?: number;
  slowWriteMs?: number; testMode?: boolean; maxRuntimeSeconds?: number; testSessionId?: string | null; lastRecoveryAction?: string | null;
} = {}): Promise<void> {
  const root = await realpath(projectRoot);
  await readProject(root);
  const persistedCircuit=await readCircuit(root);if(persistedCircuit.circuit_open)throw new Error(`scheduler Supervisor circuit is open: ${persistedCircuit.reason??'explicit reset required'}`);
  const intervalSeconds = options.intervalSeconds ?? 5, staleSeconds = options.staleSeconds ?? 15, cycleTimeoutSeconds = options.cycleTimeoutSeconds ?? 60;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 300) throw new Error('Supervisor interval must be 1–300 seconds');
  if (!Number.isInteger(staleSeconds) || staleSeconds < 3 || staleSeconds > 3600) throw new Error('stale heartbeat threshold must be 3–3600 seconds');
  if (!Number.isInteger(cycleTimeoutSeconds) || cycleTimeoutSeconds < 3 || cycleTimeoutSeconds > 600) throw new Error('watchdog cycle timeout must be 3–600 seconds');
  const processStart = await processStartedAt(process.pid);
  if (!processStart) throw new Error('cannot establish scheduler Supervisor process identity');
  const maxConsecutiveFailures=options.maxConsecutiveFailures??3,slowWriteMs=options.slowWriteMs??2_000;
  if(!Number.isInteger(maxConsecutiveFailures)||maxConsecutiveFailures<1||maxConsecutiveFailures>20)throw new Error('Supervisor failure threshold must be 1–20');
  if(!Number.isInteger(slowWriteMs)||slowWriteMs<100||slowWriteMs>60_000)throw new Error('Supervisor slow-write threshold must be 100–60000ms');
  if(options.testMode&&(!Number.isInteger(options.maxRuntimeSeconds)||Number(options.maxRuntimeSeconds)<1||Number(options.maxRuntimeSeconds)>3600))throw new Error('test mode requires maxRuntimeSeconds between 1 and 3600');
  const ownedLock=await acquireOwnedDirectoryLock(lockDir(root),{name:'scheduler Supervisor',maxWaitMs:0,missingOwnerProtectionMs:5_000,telemetryFile:path.join(root,'.spec-loop','scheduler','control-health','supervisor-lock.json')});
  let stopping = false, worker: ChildProcess | null = null, circuitOpen=false;
  let marker: SupervisorMarker = supervisorMarkerSchema.parse({
    schema_version: 1, project_root: root, pid: process.pid, process_started_at: processStart,
    interval_seconds: intervalSeconds, stale_seconds: staleSeconds, cycle_timeout_seconds: cycleTimeoutSeconds,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), iteration: 0,
    state: 'starting', worker_pid: null, worker_process_started_at: null, last_check_at: null, last_check_ok: null,
    last_unhealthy_count: null, last_stopped_tasks: [], last_error: null,
    last_maintenance_at: null, last_maintenance_archived: 0, last_maintenance_errors: 0,
    successful_watchdogs:0,consecutive_failures:0,max_consecutive_failures:maxConsecutiveFailures,last_recovery_action:options.lastRecoveryAction??null,control_io:null,
    test_mode:Boolean(options.testMode),test_session_id:options.testSessionId??null,max_runtime_seconds:options.testMode?options.maxRuntimeSeconds??null:null,
  });
  const writer=createLatestValueWriter<SupervisorMarker>(snapshot=>withAbortableOperationTimeout(signal=>atomicWriteTelemetry(root,{file:markerFile(root),content:`${JSON.stringify(snapshot,null,2)}\n`},signal),slowWriteMs,'Supervisor heartbeat write'))
  const persist = async (change: Partial<SupervisorMarker> = {}) => {
    marker = supervisorMarkerSchema.parse({ ...marker, ...change, heartbeat_at: new Date().toISOString(),control_io:writer.stats() });
    const snapshot = marker;
    await writer.enqueue(snapshot);
    const io=writer.stats();if((io.last_duration_ms??0)>slowWriteMs)throw new Error(`Supervisor heartbeat write exceeded ${slowWriteMs}ms (${io.last_duration_ms}ms)`);
  };
  const stop = () => { stopping = true; signalProcessTree(worker?.pid,'SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const runtimeDeadline=options.testMode?Date.now()+Number(options.maxRuntimeSeconds)*1000:null;
  const runtimeTimer=runtimeDeadline?setTimeout(stop,Math.max(1,runtimeDeadline-Date.now())):null;runtimeTimer?.unref();
  try {
    await persist();
    while (!stopping) {
      if(runtimeDeadline&&Date.now()>=runtimeDeadline){stopping=true;break}
      if(circuitOpen){await persist({state:'degraded',worker_pid:null,worker_process_started_at:null,last_error:marker.last_error??'watchdog circuit is open'}).catch(()=>{stopping=true});const until=Date.now()+intervalSeconds*1000;while(!stopping&&Date.now()<until)await delay(Math.min(200,until-Date.now()));continue}
      marker.iteration += 1;
      await persist({ state: 'checking', worker_pid: null, worker_process_started_at: null });
      const heartbeat = setInterval(() => { void persist().catch(() => { stopping = true; signalProcessTree(worker?.pid,'SIGKILL'); }); }, Math.min(2000, intervalSeconds * 1000));
      let failedResult:{ok:boolean;unhealthy:unknown[];stopped_tasks:Array<{task_id?:string}>}|null=null;
      try {
        const result = await watchdogCycle(root, staleSeconds, cycleTimeoutSeconds, async (current, identity) => {
          worker = current;
          await persist({ worker_pid: current?.pid ?? null, worker_process_started_at: identity });
        });
        if(!result.ok){failedResult=result;throw new Error(`watchdog reported unhealthy state (${result.unhealthy.length} unhealthy records)`)}
        await persist({
          state: 'healthy', worker_pid: null, worker_process_started_at: null, last_check_at: new Date().toISOString(), last_check_ok: result.ok,
          last_unhealthy_count: result.unhealthy.length,
          last_stopped_tasks: result.stopped_tasks.length
            ? result.stopped_tasks.flatMap((item) => typeof item.task_id === 'string' ? [item.task_id] : [])
            : marker.last_stopped_tasks,
          last_error: null, successful_watchdogs:marker.successful_watchdogs+1, consecutive_failures:0,
        });
        if(!marker.last_maintenance_at||Date.now()-Date.parse(marker.last_maintenance_at)>=24*60*60*1000){
          const maintenance=await runRetentionMaintenance(root,5);
          await persist({last_maintenance_at:maintenance.ran_at,last_maintenance_archived:maintenance.archived.length,last_maintenance_errors:maintenance.errors.length});
        }
      } catch (error) {
        if (!stopping){const failures=marker.consecutive_failures+1;circuitOpen=failures>=maxConsecutiveFailures||/worker stop was not verified/.test((error as Error).message);const message=`${(error as Error).message}${circuitOpen?`; watchdog circuit opened after ${failures} consecutive failures`:''}`.slice(0,1000);if(circuitOpen){const previous=await readCircuit(root);await writeCircuit(root,supervisorCircuitSchema.parse({...previous,circuit_open:true,opened_at:new Date().toISOString(),reason:message,consecutive_failures:failures,updated_at:new Date().toISOString()})).catch(()=>{stopping=true})}await persist({ state: 'degraded', worker_pid: null, worker_process_started_at: null, last_check_at: new Date().toISOString(), last_check_ok: false,last_unhealthy_count:failedResult?.unhealthy.length??marker.last_unhealthy_count,last_stopped_tasks:failedResult?.stopped_tasks.length?failedResult.stopped_tasks.flatMap(item=>typeof item.task_id==='string'?[item.task_id]:[]):marker.last_stopped_tasks,consecutive_failures:failures,last_error:message }).catch(()=>{stopping=true})}
      } finally { clearInterval(heartbeat); worker = null; }
      if (stopping) break;
      const until = Date.now() + intervalSeconds * 1000;
      while (!stopping && Date.now() < until) await delay(Math.min(200, until - Date.now()));
    }
    marker=supervisorMarkerSchema.parse({...marker,state:'stopping',worker_pid:null,worker_process_started_at:null,heartbeat_at:new Date().toISOString(),control_io:writer.stats()});
    await writer.close(marker);
  } finally {
    if(runtimeTimer)clearTimeout(runtimeTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await writer.close().catch(() => {});
    await releaseSupervisorFiles(root, processStart,ownedLock);
  }
}

export async function startManagedSchedulerSupervisor(projectRoot: string, options: {
  intervalSeconds?: number; staleSeconds?: number; cycleTimeoutSeconds?: number; maxConsecutiveFailures?: number;
  slowWriteMs?: number; testMode?: boolean; maxRuntimeSeconds?: number; testSessionId?: string | null;
} = {}) {
  if(options.testMode&&(!Number.isInteger(options.maxRuntimeSeconds)||Number(options.maxRuntimeSeconds)<1||Number(options.maxRuntimeSeconds)>3600))throw new Error('test mode requires maxRuntimeSeconds between 1 and 3600');
  const root = await realpath(projectRoot);let current = await schedulerSupervisorStatus(root),recoveryAction:string|null=null;
  let circuit=await readCircuit(root);if(circuit.circuit_open)throw new Error(`scheduler Supervisor circuit is open and requires explicit reset: ${circuit.reason??'failure threshold reached'}`);
  if(options.testMode&&current.running&&current.marker?.test_mode&&current.marker.test_session_id!==options.testSessionId){const stopped=await terminateProcessTree(current.marker.pid,current.marker.process_started_at,1_000);if(!stopped.stopped)throw new Error(`cannot replace stale test Supervisor session safely: ${stopped.reason}`);recoveryAction=`replaced test Supervisor session ${current.marker.test_session_id??'unknown'}`;current=await schedulerSupervisorStatus(root)}
  if(current.running&&!current.healthy&&['starting','checking','watchdog_not_ready','watchdog_retrying'].includes(current.reason)){
    const until=Date.now()+Math.min(30_000,Math.max(10_000,((current.marker?.interval_seconds??1)+(current.marker?.cycle_timeout_seconds??3))*1000));while(Date.now()<until){await delay(100);current=await schedulerSupervisorStatus(root);if(current.healthy)return current;if(!current.running||['stale_heartbeat','degraded','control_io_degraded'].includes(current.reason))break}
  }
  if(current.running&&current.healthy)return current;
  if(current.running&&current.marker&&['stale_heartbeat','degraded','control_io_degraded'].includes(current.reason)){
    const stopped=await terminateProcessTree(current.marker.pid,current.marker.process_started_at,1_000);if(!stopped.stopped)throw new Error(`cannot recover unhealthy scheduler Supervisor safely: ${stopped.reason}`);
    const cutoff=Date.now()-10*60*1000,restarts=circuit.automatic_restarts.filter(value=>Date.parse(value)>=cutoff);if(restarts.length>=3){const reason='automatic Supervisor restart limit reached (3 in 10 minutes)';circuit=supervisorCircuitSchema.parse({...circuit,circuit_open:true,opened_at:new Date().toISOString(),reason,automatic_restarts:restarts,updated_at:new Date().toISOString()});await writeCircuit(root,circuit);throw new Error(`${reason}; explicit circuit reset is required`)}
    circuit=supervisorCircuitSchema.parse({...circuit,automatic_restarts:[...restarts,new Date().toISOString()],updated_at:new Date().toISOString()});await writeCircuit(root,circuit);
    recoveryAction=`restarted ${current.reason} Supervisor PID ${current.marker.pid}`;
    for(let attempt=0;attempt<100&&(await processMatches(current.marker.pid,current.marker.process_started_at));attempt++)await delay(50);
    current=await schedulerSupervisorStatus(root);
  }
  if(current.running)return current;
  if (current.marker || current.reason.startsWith('invalid_marker')) await rm(markerFile(root), { force: true });
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, '_scheduler-supervise', root,
    '--interval-seconds', String(options.intervalSeconds ?? 5),
    '--stale-seconds', String(options.staleSeconds ?? 15),
    '--cycle-timeout-seconds', String(options.cycleTimeoutSeconds ?? 60),
    '--max-consecutive-failures',String(options.maxConsecutiveFailures??3),
    '--slow-write-ms',String(options.slowWriteMs??2_000),
    ...(recoveryAction?['--last-recovery-action',recoveryAction]:[]),
    ...(options.testMode?['--test-mode','--max-runtime-seconds',String(options.maxRuntimeSeconds??60),'--test-session-id',options.testSessionId??randomTestSession()]:[]),
  ], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  for (let attempt = 0; attempt < 300; attempt++) {
    await delay(50);
    const status = await schedulerSupervisorStatus(root).catch(() => null);
    if (status?.healthy) return status;
    const currentCircuit=await readCircuit(root);if(currentCircuit.circuit_open)throw new Error(`scheduler Supervisor circuit opened during startup: ${currentCircuit.reason??'explicit reset required'}`);
    try { process.kill(child.pid as number, 0); } catch { break; }
  }
  const status=await schedulerSupervisorStatus(root).catch(()=>null);throw new Error(`scheduler Supervisor did not pass a successful watchdog within 15 seconds${status?` (${status.reason})`:''}`);
}

function randomTestSession():string{return `test-${process.pid}-${Date.now()}`}

export async function stopManagedSchedulerSupervisor(projectRoot: string) {
  const root = await realpath(projectRoot), status = await schedulerSupervisorStatus(root);
  if (!status.running || !status.marker) {
    if (status.marker) await rm(markerFile(root), { force: true });
    const inspection=await inspectOwnedDirectoryLock(lockDir(root));
    if(inspection.exists&&['dead_process','pid_reused','invalid_owner'].includes(inspection.reason)){const recovered=await acquireOwnedDirectoryLock(lockDir(root),{name:'scheduler Supervisor',maxWaitMs:0,missingOwnerProtectionMs:5_000});await recovered.release()}
    return { stopped: false, reason: status.reason };
  }
  if (status.marker.worker_pid && status.marker.worker_process_started_at) {
    const workerStop = await terminateProcessTree(status.marker.worker_pid, status.marker.worker_process_started_at, 500);
    if (!workerStop.stopped) throw new Error(`scheduler watchdog worker did not stop safely: ${workerStop.reason}`);
  }
  const stopped = await terminateProcessTree(status.marker.pid, status.marker.process_started_at, 5_000);
  if (!stopped.stopped) throw new Error(`scheduler Supervisor did not stop safely: ${stopped.reason}`);
  await rm(markerFile(root), { force: true });
  const recovered=await acquireOwnedDirectoryLock(lockDir(root),{name:'scheduler Supervisor',maxWaitMs:5_000,missingOwnerProtectionMs:5_000});await recovered.release();
  return { stopped: true, reason: stopped.reason };
}

function xml(value:string):string{return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')}
export async function schedulerSupervisorLaunchdPlan(projectRoot:string){
  const root=await realpath(projectRoot),project=await readProject(root),here=path.dirname(fileURLToPath(import.meta.url)),templateFile=path.resolve(here,'..','assets','launchd','com.spec-loop.scheduler-supervisor.plist.template'),cli=fileURLToPath(new URL('./cli.js',import.meta.url)),label=`com.spec-loop.scheduler-supervisor.${project.project_id.toLowerCase().replace(/[^a-z0-9.-]/g,'-')}`,destination=path.join(process.env.HOME??'', 'Library','LaunchAgents',`${label}.plist`),logs=path.join(root,'.spec-loop','logs');
  const template=await readFile(templateFile,'utf8'),plist=template.replaceAll('__LABEL__',xml(label)).replaceAll('__NODE__',xml(process.execPath)).replaceAll('__CLI__',xml(cli)).replaceAll('__PROJECT_ROOT__',xml(root)).replaceAll('__LOG_OUT__',xml(path.join(logs,'supervisor.out.log'))).replaceAll('__LOG_ERR__',xml(path.join(logs,'supervisor.err.log')));
  return{schema_version:1,label,destination,plist,install_commands:[`mkdir -p ${JSON.stringify(logs)} ${JSON.stringify(path.dirname(destination))}`,`# save the returned plist to ${JSON.stringify(destination)}`,`launchctl bootstrap gui/$(id -u) ${JSON.stringify(destination)}`],uninstall_command:`launchctl bootout gui/$(id -u) ${JSON.stringify(destination)}`,installed:false,destructive_action_performed:false};
}

async function launchctl(args:string[]):Promise<{code:number;stdout:string;stderr:string}>{const result=await runManagedProcess({bin:'/bin/launchctl',args,timeoutMs:10_000,pipeDrainTimeoutMs:1_000,maxCaptureBytes:256_000});return{code:result.code,stdout:result.stdout.trim(),stderr:(result.timedOut?`${result.stderr}\nlaunchctl timed out after 10s`:result.stderr).trim()}}

export async function installSchedulerSupervisorLaunchd(projectRoot:string){
  if(process.platform!=='darwin')throw new Error('launchd installation is supported only on macOS');
  const plan=await schedulerSupervisorLaunchdPlan(projectRoot),home=process.env.HOME;if(!home)throw new Error('HOME is unavailable');const allowed=path.join(home,'Library','LaunchAgents')+path.sep;if(!plan.destination.startsWith(allowed))throw new Error('launchd destination escapes ~/Library/LaunchAgents');
  const existing=await readFile(plan.destination,'utf8').catch(()=>null);if(existing!==null&&existing!==plan.plist)throw new Error(`launchd plist already exists with different content: ${plan.destination}`);
  await mkdir(path.dirname(plan.destination),{recursive:true});await mkdir(path.join(path.resolve(projectRoot),'.spec-loop','logs'),{recursive:true});if(existing===null)await writeFile(plan.destination,plan.plist,{mode:0o644,flag:'wx'});
  const domain=`gui/${process.getuid?.()??0}`,printed=await launchctl(['print',`${domain}/${plan.label}`]);if(printed.code!==0){const loaded=await launchctl(['bootstrap',domain,plan.destination]);if(loaded.code!==0)throw new Error(`launchctl bootstrap failed: ${loaded.stderr||loaded.stdout||loaded.code}`)}
  return{...plan,installed:true,destructive_action_performed:true,installed_at:new Date().toISOString()};
}

export async function uninstallSchedulerSupervisorLaunchd(projectRoot:string){
  if(process.platform!=='darwin')throw new Error('launchd removal is supported only on macOS');
  const plan=await schedulerSupervisorLaunchdPlan(projectRoot),domain=`gui/${process.getuid?.()??0}`,loaded=await launchctl(['print',`${domain}/${plan.label}`]);if(loaded.code===0){const stopped=await launchctl(['bootout',domain,plan.destination]);if(stopped.code!==0)throw new Error(`launchctl bootout failed: ${stopped.stderr||stopped.stdout||stopped.code}`)}
  await rm(plan.destination,{force:true});return{schema_version:1,label:plan.label,destination:plan.destination,installed:false,destructive_action_performed:true,uninstalled_at:new Date().toISOString()};
}
