import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { atomicWriteMany } from './files.js';
import { readProject } from './project.js';

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
  last_check_at: z.iso.datetime().nullable(),
  last_check_ok: z.boolean().nullable(),
  last_unhealthy_count: z.number().int().nonnegative().nullable(),
  last_stopped_tasks: z.array(z.string()),
  last_error: z.string().max(1000).nullable(),
}).strict();

type SupervisorMarker = z.infer<typeof supervisorMarkerSchema>;

const markerFile = (root: string) => path.join(root, '.spec-loop', 'scheduler', 'SUPERVISOR.json');
const lockDir = (root: string) => path.join(root, '.spec-loop', 'locks', 'scheduler-supervisor.lock');
const lockOwnerFile = (root: string) => path.join(lockDir(root), 'owner.json');
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function processStartedAt(pid: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value as string);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('process identity check timed out')); }, 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => code === 0 && stdout.trim()
      ? finish(undefined, stdout.trim())
      : finish(new Error(stderr.trim() || 'process is not running')));
  });
}

async function readMarker(root: string): Promise<SupervisorMarker> {
  return supervisorMarkerSchema.parse(JSON.parse(await readFile(markerFile(root), 'utf8')));
}

async function matchingProcess(pid: number, startedAt: string): Promise<boolean> {
  return (await processStartedAt(pid).catch(() => null)) === startedAt;
}

async function acquireSupervisorLock(root: string, processStart: string): Promise<void> {
  await mkdir(path.dirname(lockDir(root)), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockDir(root));
      await writeFile(lockOwnerFile(root), `${JSON.stringify({ pid: process.pid, process_started_at: processStart, created_at: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx' });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readFile(lockOwnerFile(root), 'utf8').then((raw) => JSON.parse(raw) as { pid?: number; process_started_at?: string }).catch(() => null);
      const alive = owner?.pid && owner.process_started_at ? await matchingProcess(owner.pid, owner.process_started_at) : false;
      if (alive) throw new Error(`scheduler Supervisor is already running as PID ${owner!.pid}`);
      await rm(lockDir(root), { recursive: true, force: true });
    }
  }
  throw new Error('could not acquire scheduler Supervisor lock');
}

async function releaseSupervisorFiles(root: string, processStart: string): Promise<void> {
  const marker = await readMarker(root).catch(() => null);
  if (marker?.pid === process.pid && marker.process_started_at === processStart) await rm(markerFile(root), { force: true });
  const owner = await readFile(lockOwnerFile(root), 'utf8').then((raw) => JSON.parse(raw) as { pid?: number; process_started_at?: string }).catch(() => null);
  if (owner?.pid === process.pid && owner.process_started_at === processStart) await rm(lockDir(root), { recursive: true, force: true });
}

async function watchdogCycle(
  root: string,
  staleSeconds: number,
  timeoutSeconds: number,
  onWorker: (worker: ChildProcess | null) => Promise<void>,
): Promise<{ ok: boolean; unhealthy: unknown[]; stopped_tasks: Array<{ task_id?: string }> }> {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'scheduler', 'control', 'watchdog', root, '--stale-seconds', String(staleSeconds), '--apply', '--json'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', settled = false;
    void onWorker(child).catch((error) => finish(error));
    const finish = (error?: Error, value?: { ok: boolean; unhealthy: unknown[]; stopped_tasks: Array<{ task_id?: string }> }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void onWorker(null).finally(() => error ? reject(error) : resolve(value!));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`watchdog cycle exceeded ${timeoutSeconds}s and was killed`));
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 1_000_000) { child.kill('SIGKILL'); finish(new Error('watchdog cycle output exceeded 1 MB')); }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > 100_000) { child.kill('SIGKILL'); finish(new Error('watchdog cycle error output exceeded 100 KB')); }
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) { finish(new Error((stderr.trim() || `watchdog cycle exited ${code ?? signal}`).slice(0, 1000))); return; }
      try {
        const parsed = JSON.parse(stdout) as { ok?: boolean; unhealthy?: unknown[]; stopped_tasks?: Array<{ task_id?: string }> };
        finish(undefined, { ok: parsed.ok === true, unhealthy: Array.isArray(parsed.unhealthy) ? parsed.unhealthy : [], stopped_tasks: Array.isArray(parsed.stopped_tasks) ? parsed.stopped_tasks : [] });
      } catch (error) { finish(new Error(`watchdog cycle returned invalid JSON: ${(error as Error).message}`)); }
    });
  });
}

export async function schedulerSupervisorStatus(projectRoot: string) {
  const root = await realpath(projectRoot), info = await lstat(markerFile(root)).catch(() => null);
  if (!info) return { running: false, healthy: false, reason: 'not_started' as const, marker: null };
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('scheduler Supervisor marker is invalid');
  let marker: SupervisorMarker;
  try { marker = await readMarker(root); } catch (error) { return { running: false, healthy: false, reason: `invalid_marker: ${(error as Error).message}`, marker: null }; }
  if (marker.project_root !== root) return { running: false, healthy: false, reason: 'project_root_mismatch' as const, marker };
  if (!(await matchingProcess(marker.pid, marker.process_started_at))) return { running: false, healthy: false, reason: 'stale_pid' as const, marker };
  const heartbeatAgeMs = Math.max(0, Date.now() - Date.parse(marker.heartbeat_at));
  const heartbeatLimitMs = Math.max(5000, marker.interval_seconds * 3000);
  if (heartbeatAgeMs > heartbeatLimitMs) return { running: true, healthy: false, reason: 'stale_heartbeat' as const, heartbeat_age_ms: heartbeatAgeMs, marker };
  if (marker.state === 'degraded') return { running: true, healthy: false, reason: 'degraded' as const, heartbeat_age_ms: heartbeatAgeMs, marker };
  return { running: true, healthy: true, reason: 'healthy' as const, heartbeat_age_ms: heartbeatAgeMs, marker };
}

export async function serveSchedulerSupervisor(projectRoot: string, options: { intervalSeconds?: number; staleSeconds?: number; cycleTimeoutSeconds?: number } = {}): Promise<void> {
  const root = await realpath(projectRoot);
  await readProject(root);
  const intervalSeconds = options.intervalSeconds ?? 5, staleSeconds = options.staleSeconds ?? 15, cycleTimeoutSeconds = options.cycleTimeoutSeconds ?? 60;
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 300) throw new Error('Supervisor interval must be 1–300 seconds');
  if (!Number.isInteger(staleSeconds) || staleSeconds < 3 || staleSeconds > 3600) throw new Error('stale heartbeat threshold must be 3–3600 seconds');
  if (!Number.isInteger(cycleTimeoutSeconds) || cycleTimeoutSeconds < 3 || cycleTimeoutSeconds > 600) throw new Error('watchdog cycle timeout must be 3–600 seconds');
  const processStart = await processStartedAt(process.pid);
  await acquireSupervisorLock(root, processStart);
  let stopping = false, worker: ChildProcess | null = null, writeTail = Promise.resolve();
  let marker: SupervisorMarker = supervisorMarkerSchema.parse({
    schema_version: 1, project_root: root, pid: process.pid, process_started_at: processStart,
    interval_seconds: intervalSeconds, stale_seconds: staleSeconds, cycle_timeout_seconds: cycleTimeoutSeconds,
    started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), iteration: 0,
    state: 'starting', worker_pid: null, last_check_at: null, last_check_ok: null,
    last_unhealthy_count: null, last_stopped_tasks: [], last_error: null,
  });
  const persist = async (change: Partial<SupervisorMarker> = {}) => {
    marker = supervisorMarkerSchema.parse({ ...marker, ...change, heartbeat_at: new Date().toISOString() });
    const snapshot = marker;
    writeTail = writeTail.then(() => atomicWriteMany(root, [{ file: markerFile(root), content: `${JSON.stringify(snapshot, null, 2)}\n` }]));
    await writeTail;
  };
  const stop = () => { stopping = true; worker?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await persist();
  try {
    while (!stopping) {
      marker.iteration += 1;
      await persist({ state: 'checking', worker_pid: null });
      const heartbeat = setInterval(() => { void persist().catch(() => { stopping = true; worker?.kill('SIGKILL'); }); }, Math.min(2000, intervalSeconds * 1000));
      try {
        const result = await watchdogCycle(root, staleSeconds, cycleTimeoutSeconds, async (current) => {
          worker = current;
          await persist({ worker_pid: current?.pid ?? null });
        });
        await persist({
          state: 'healthy', worker_pid: null, last_check_at: new Date().toISOString(), last_check_ok: result.ok,
          last_unhealthy_count: result.unhealthy.length,
          last_stopped_tasks: result.stopped_tasks.length
            ? result.stopped_tasks.flatMap((item) => typeof item.task_id === 'string' ? [item.task_id] : [])
            : marker.last_stopped_tasks,
          last_error: null,
        });
      } catch (error) {
        if (!stopping) await persist({ state: 'degraded', worker_pid: null, last_check_at: new Date().toISOString(), last_check_ok: false, last_error: (error as Error).message.slice(0, 1000) });
      } finally { clearInterval(heartbeat); worker = null; }
      if (stopping) break;
      const until = Date.now() + intervalSeconds * 1000;
      while (!stopping && Date.now() < until) await delay(Math.min(200, until - Date.now()));
    }
    await persist({ state: 'stopping', worker_pid: null });
  } finally {
    await writeTail.catch(() => {});
    await releaseSupervisorFiles(root, processStart);
  }
}

export async function startManagedSchedulerSupervisor(projectRoot: string, options: { intervalSeconds?: number; staleSeconds?: number; cycleTimeoutSeconds?: number } = {}) {
  const root = await realpath(projectRoot), current = await schedulerSupervisorStatus(root);
  if (current.running) return current;
  if (current.marker || current.reason.startsWith('invalid_marker')) await rm(markerFile(root), { force: true });
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, '_scheduler-supervise', root,
    '--interval-seconds', String(options.intervalSeconds ?? 5),
    '--stale-seconds', String(options.staleSeconds ?? 15),
    '--cycle-timeout-seconds', String(options.cycleTimeoutSeconds ?? 60),
  ], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay(50);
    const status = await schedulerSupervisorStatus(root).catch(() => null);
    if (status?.running) return status;
    try { process.kill(child.pid as number, 0); } catch { break; }
  }
  throw new Error('scheduler Supervisor did not become healthy within 10 seconds');
}

export async function stopManagedSchedulerSupervisor(projectRoot: string) {
  const root = await realpath(projectRoot), status = await schedulerSupervisorStatus(root);
  if (!status.running || !status.marker) {
    if (status.marker) await rm(markerFile(root), { force: true });
    const owner = await readFile(lockOwnerFile(root), 'utf8').then((raw) => JSON.parse(raw) as { pid?: number; process_started_at?: string }).catch(() => null);
    if (!owner?.pid || !owner.process_started_at || !(await matchingProcess(owner.pid, owner.process_started_at))) await rm(lockDir(root), { recursive: true, force: true });
    return { stopped: false, reason: status.reason };
  }
  process.kill(status.marker.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 200; attempt++) {
    await delay(25);
    if (!(await matchingProcess(status.marker.pid, status.marker.process_started_at))) {
      await releaseSupervisorFiles(root, status.marker.process_started_at).catch(() => {});
      return { stopped: true, reason: 'stopped' as const };
    }
  }
  process.kill(status.marker.pid, 'SIGKILL');
  for (let attempt = 0; attempt < 80; attempt++) {
    await delay(25);
    if (!(await matchingProcess(status.marker.pid, status.marker.process_started_at))) {
      await rm(markerFile(root), { force: true }); await rm(lockDir(root), { recursive: true, force: true });
      return { stopped: true, reason: 'killed_after_timeout' as const };
    }
  }
  throw new Error('scheduler Supervisor did not stop safely');
}

function xml(value:string):string{return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;')}
export async function schedulerSupervisorLaunchdPlan(projectRoot:string){
  const root=await realpath(projectRoot),project=await readProject(root),here=path.dirname(fileURLToPath(import.meta.url)),templateFile=path.resolve(here,'..','assets','launchd','com.spec-loop.scheduler-supervisor.plist.template'),cli=fileURLToPath(new URL('./cli.js',import.meta.url)),label=`com.spec-loop.scheduler-supervisor.${project.project_id.toLowerCase().replace(/[^a-z0-9.-]/g,'-')}`,destination=path.join(process.env.HOME??'', 'Library','LaunchAgents',`${label}.plist`),logs=path.join(root,'.spec-loop','logs');
  const template=await readFile(templateFile,'utf8'),plist=template.replaceAll('__LABEL__',xml(label)).replaceAll('__NODE__',xml(process.execPath)).replaceAll('__CLI__',xml(cli)).replaceAll('__PROJECT_ROOT__',xml(root)).replaceAll('__LOG_OUT__',xml(path.join(logs,'supervisor.out.log'))).replaceAll('__LOG_ERR__',xml(path.join(logs,'supervisor.err.log')));
  return{schema_version:1,label,destination,plist,install_commands:[`mkdir -p ${JSON.stringify(logs)} ${JSON.stringify(path.dirname(destination))}`,`# save the returned plist to ${JSON.stringify(destination)}`,`launchctl bootstrap gui/$(id -u) ${JSON.stringify(destination)}`],uninstall_command:`launchctl bootout gui/$(id -u) ${JSON.stringify(destination)}`,installed:false,destructive_action_performed:false};
}
