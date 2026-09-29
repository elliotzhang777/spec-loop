import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { processStartedAt, inspectProcess } from './process-control.js';

const ownerSchema = z.object({
  schema_version: z.literal(1),
  name: z.string().min(1),
  pid: z.number().int().positive(),
  process_started_at: z.string().min(1),
  nonce: z.string().uuid(),
  created_at: z.iso.datetime(),
}).strict();

export type OwnedLockOwner = z.infer<typeof ownerSchema>;
export type OwnedLockReclaimReason = 'dead_process' | 'pid_reused' | 'missing_owner' | 'invalid_owner';

export interface OwnedDirectoryLockOptions {
  name: string;
  signal?: AbortSignal;
  maxWaitMs?: number;
  pollMs?: number;
  missingOwnerProtectionMs?: number;
  mode?: number;
  telemetryFile?: string;
  busyMessage?: string;
  identifyProcess?: typeof processStartedAt;
}

export interface OwnedDirectoryLock {
  directory: string;
  owner: OwnedLockOwner;
  wait_duration_ms: number;
  reclaimed_reason: OwnedLockReclaimReason | null;
  release(): Promise<boolean>;
}

export interface OwnedLockInspection {
  exists: boolean;
  valid: boolean;
  owner: OwnedLockOwner | null;
  owner_age_ms: number | null;
  process_alive: boolean | null;
  reason: 'absent' | 'owned' | 'legacy_owner' | 'dead_process' | 'pid_reused' | 'missing_owner' | 'invalid_owner' | 'invalid_path' | 'identity_unknown';
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const ownerFile = (directory: string) => path.join(directory, 'owner.json');
const digest = (value: string | null) => createHash('sha256').update(value ?? '<missing>').digest('hex');
let currentProcessStart: string | null = null;
let currentProcessStartWork: Promise<string | null> | null = null;

async function observedProcessStartedAt(pid: number): Promise<string | null> {
  if (pid !== process.pid) return processStartedAt(pid);
  if (currentProcessStart) return currentProcessStart;
  currentProcessStartWork ??= processStartedAt(pid);
  const observed = await currentProcessStartWork;
  currentProcessStartWork = null;
  if (observed) currentProcessStart = observed;
  return observed;
}

type LockFingerprint = { dev: number; ino: number; owner_sha256: string };

async function lockFingerprint(directory: string): Promise<LockFingerprint | null> {
  const info = await lstat(directory).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return null;
  const raw = await readFile(ownerFile(directory), 'utf8').catch(() => null);
  return { dev: info.dev, ino: info.ino, owner_sha256: digest(raw) };
}

function sameFingerprint(left: LockFingerprint | null, right: LockFingerprint | null): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.owner_sha256 === right.owner_sha256);
}

async function readOwner(directory: string): Promise<OwnedLockOwner | null> {
  return readFile(ownerFile(directory), 'utf8').then((raw) => ownerSchema.parse(JSON.parse(raw))).catch(() => null);
}

async function persistTelemetry(file: string | undefined, value: Record<string, unknown>): Promise<void> {
  if (!file) return;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const previous:Record<string,unknown>=await readFile(file,'utf8').then(raw=>JSON.parse(raw) as Record<string,unknown>).catch(()=>({} as Record<string,unknown>));
    const reclaimed=value.state==='owned'&&value.last_reclaim_reason!==null,reclaimCount=(typeof previous.reclaim_count==='number'?previous.reclaim_count:0)+(reclaimed?1:0);
    const acquireFailures=value.state==='timeout'?(typeof previous.consecutive_acquire_failures==='number'?previous.consecutive_acquire_failures:0)+1:value.state==='owned'?0:previous.consecutive_acquire_failures??0;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ...previous,schema_version: 1, ...value,reclaim_count:reclaimCount,consecutive_acquire_failures:acquireFailures }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch { /* telemetry must never compromise lock safety */ }
}

export async function inspectOwnedDirectoryLock(directory: string, identifyProcess = observedProcessStartedAt): Promise<OwnedLockInspection> {
  const info = await lstat(directory).catch(() => null);
  if (!info) return { exists: false, valid: true, owner: null, owner_age_ms: null, process_alive: null, reason: 'absent' };
  if (!info.isDirectory() || info.isSymbolicLink()) return { exists: true, valid: false, owner: null, owner_age_ms: Math.max(0, Date.now() - info.mtimeMs), process_alive: null, reason: 'invalid_path' };
  const raw = await readFile(ownerFile(directory), 'utf8').catch(() => null);
  if (raw === null) return { exists: true, valid: false, owner: null, owner_age_ms: Math.max(0, Date.now() - info.mtimeMs), process_alive: null, reason: 'missing_owner' };
  let parsed:unknown;try{parsed=JSON.parse(raw)}catch{return { exists: true, valid: false, owner: null, owner_age_ms: Math.max(0, Date.now() - info.mtimeMs), process_alive: null, reason: 'invalid_owner' }}
  let owner: OwnedLockOwner;
  try { owner = ownerSchema.parse(parsed); }
  catch {
    const legacy=parsed as {pid?:unknown;process_started_at?:unknown;created_at?:unknown;acquired_at?:unknown};
    if(Number.isInteger(legacy?.pid)&&(legacy.pid as number)>0){
      const expected=typeof legacy.process_started_at==='string'?legacy.process_started_at:null,probe=await inspectProcess(legacy.pid as number,expected,{identifyProcess}),actual=probe.started_at;
      const created=typeof legacy.created_at==='string'?legacy.created_at:typeof legacy.acquired_at==='string'?legacy.acquired_at:null;
      const age=created&&Number.isFinite(Date.parse(created))?Math.max(0,Date.now()-Date.parse(created)):Math.max(0,Date.now()-info.mtimeMs);
      if(probe.status==='unknown')return{exists:true,valid:false,owner:null,owner_age_ms:age,process_alive:null,reason:'identity_unknown'};
      if(probe.status==='dead')return{exists:true,valid:false,owner:null,owner_age_ms:age,process_alive:false,reason:'dead_process'};
      if(expected&&actual!==expected)return{exists:true,valid:false,owner:null,owner_age_ms:age,process_alive:true,reason:'pid_reused'};
      return{exists:true,valid:false,owner:null,owner_age_ms:age,process_alive:true,reason:'legacy_owner'};
    }
    return { exists: true, valid: false, owner: null, owner_age_ms: Math.max(0, Date.now() - info.mtimeMs), process_alive: null, reason: 'invalid_owner' };
  }
  const probe = await inspectProcess(owner.pid,owner.process_started_at,{identifyProcess}), alive = probe.status==='unknown'?null:probe.status!=='dead';
  const reason = probe.status==='unknown'?'identity_unknown':probe.status==='dead'?'dead_process':probe.status==='identity_mismatch'?'pid_reused':'owned';
  return { exists: true, valid: reason === 'owned', owner, owner_age_ms: Math.max(0, Date.now() - Date.parse(owner.created_at)), process_alive: alive, reason };
}

async function quarantine(directory: string): Promise<boolean> {
  const quarantinePath = `${directory}.reclaimed-${process.pid}-${randomUUID()}`;
  try { await rename(directory, quarantinePath); }
  catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  await rm(quarantinePath, { recursive: true, force: true });
  return true;
}

async function acquireRecoveryMutex(directory: string, protectionMs: number, outerDeadline: number, abort?:()=>Promise<boolean>, identifyProcess = observedProcessStartedAt): Promise<(() => Promise<void>) | null> {
  const recovery = `${directory}.recovery`, claimed = `${recovery}.claimed`;
  const processStart = await observedProcessStartedAt(process.pid);
  if (!processStart) throw new Error(`cannot establish recovery owner identity for ${directory}`);
  await mkdir(path.dirname(recovery), { recursive: true });
  const deadline = Math.min(Date.now() + 10_000, outerDeadline);
  for (;;) {
    if(await abort?.())return null;
    const owner = ownerSchema.parse({ schema_version: 1, name: `recovery for ${path.basename(directory)}`, pid: process.pid, process_started_at: processStart, nonce: randomUUID(), created_at: new Date().toISOString() });
    try {
      await writeFile(recovery, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = await readFile(recovery, 'utf8').then(raw => ownerSchema.parse(JSON.parse(raw))).catch(() => null);
        if (current?.nonce === owner.nonce && current.pid === owner.pid && current.process_started_at === owner.process_started_at) await unlink(recovery).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return null;
    const info = await lstat(recovery).catch(() => null);
    if (!info) continue;
    const raw = await readFile(recovery, 'utf8').catch(() => null);
    const existing = raw ? (() => { try { return ownerSchema.parse(JSON.parse(raw)); } catch { return null; } })() : null;
    const age = Math.max(0, Date.now() - (existing ? Date.parse(existing.created_at) : info.mtimeMs));
    const probe = existing ? await inspectProcess(existing.pid,existing.process_started_at,{identifyProcess}) : null;
    const stale = age >= protectionMs && (!existing || probe?.status==='dead' || probe?.status==='identity_mismatch');
    if (stale) {
      let claimedByUs=false;
      try {
        await link(recovery, claimed);
        claimedByUs=true;
        const linked = await lstat(claimed), current = await lstat(recovery).catch(() => null);
        if (current && current.dev === info.dev && current.ino === info.ino && linked.dev === info.dev && linked.ino === info.ino) await unlink(recovery);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code==='EEXIST') {const claimedInfo=await lstat(claimed).catch(()=>null);if(claimedInfo&&Date.now()-claimedInfo.mtimeMs>=Math.max(5_000,protectionMs))await rm(claimed,{force:true}).catch(()=>undefined)}
        else if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      } finally { if(claimedByUs)await rm(claimed, { force: true }).catch(() => undefined); }
      continue;
    }
    if (Date.now() >= deadline) return null;
    await delay(Math.min(10,Math.max(1,deadline-Date.now())));
  }
}

async function reclaimIfUnchanged(directory: string, expected: LockFingerprint | null, reason: OwnedLockReclaimReason, protectionMs: number, outerDeadline: number, identifyProcess = observedProcessStartedAt): Promise<boolean> {
  const releaseRecovery = await acquireRecoveryMutex(directory, protectionMs,outerDeadline,async()=>!sameFingerprint(expected,await lockFingerprint(directory)),identifyProcess);
  if(!releaseRecovery)return false;
  try {
    const currentFingerprint = await lockFingerprint(directory);
    if (!sameFingerprint(expected, currentFingerprint)) return false;
    const inspection = await inspectOwnedDirectoryLock(directory,identifyProcess);
    if (inspection.reason !== reason) return false;
    if ((reason === 'missing_owner' || reason === 'invalid_owner') && (inspection.owner_age_ms ?? 0) < protectionMs) return false;
    return quarantine(directory);
  } finally { await releaseRecovery(); }
}

async function releaseIfOwned(directory: string, owner: OwnedLockOwner, protectionMs: number, outerDeadline: number): Promise<boolean> {
  const expected = await lockFingerprint(directory), releaseRecovery = await acquireRecoveryMutex(directory, protectionMs,outerDeadline,async()=>!sameFingerprint(expected,await lockFingerprint(directory)));
  if(!releaseRecovery)return false;
  try {
    if (!sameFingerprint(expected, await lockFingerprint(directory))) return false;
    const current = await readOwner(directory);
    if (!current || current.nonce !== owner.nonce || current.pid !== owner.pid || current.process_started_at !== owner.process_started_at) return false;
    return quarantine(directory);
  } finally { await releaseRecovery(); }
}

export async function acquireOwnedDirectoryLock(directory: string, options: OwnedDirectoryLockOptions): Promise<OwnedDirectoryLock> {
  options.signal?.throwIfAborted();
  const maxWaitMs = options.maxWaitMs ?? 10_000, pollMs = options.pollMs ?? 10;
  const missingOwnerProtectionMs = options.missingOwnerProtectionMs ?? 5_000;
  if (!options.name.trim()) throw new Error('owned directory lock name is required');
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || !Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(missingOwnerProtectionMs) || missingOwnerProtectionMs < 0) throw new Error(`invalid lock timing for ${options.name}`);
  const processStart = await observedProcessStartedAt(process.pid);
  if (!processStart) throw new Error(`${options.name}: cannot establish lock owner process identity`);
  const started = Date.now(), deadline = started + maxWaitMs;
  let reclaimedReason: OwnedLockReclaimReason | null = null;
  await mkdir(path.dirname(directory), { recursive: true });
  for (;;) {
    options.signal?.throwIfAborted();
    let created = false;
    const owner = ownerSchema.parse({ schema_version: 1, name: options.name, pid: process.pid, process_started_at: processStart, nonce: randomUUID(), created_at: new Date().toISOString() });
    try {
      await mkdir(directory, { mode: options.mode ?? 0o700 }); created = true;
      await writeFile(ownerFile(directory), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      const waitDuration = Math.max(0, Date.now() - started);
      await persistTelemetry(options.telemetryFile, { name: options.name, state: 'owned', directory, owner, wait_duration_ms: waitDuration, last_reclaim_reason: reclaimedReason, updated_at: new Date().toISOString() });
      let released = false;
      return {
        directory, owner, wait_duration_ms: waitDuration, reclaimed_reason: reclaimedReason,
        release: async () => {
          if (released) return true;
          if (!(await releaseIfOwned(directory, owner, missingOwnerProtectionMs,Date.now()+maxWaitMs))) return false;
          released = true;
          await persistTelemetry(options.telemetryFile, { name: options.name, state: 'released', directory, owner: null, wait_duration_ms: waitDuration, last_reclaim_reason: reclaimedReason, updated_at: new Date().toISOString() });
          return true;
        },
      };
    } catch (error) {
      if (created) {
        const fingerprint = await lockFingerprint(directory);
        await reclaimIfUnchanged(directory, fingerprint, 'invalid_owner', 0,deadline).catch(() => false);
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const inspection = await inspectOwnedDirectoryLock(directory,options.identifyProcess);
    const fingerprint = await lockFingerprint(directory);
    let reason: OwnedLockReclaimReason | null = null;
    if (inspection.reason === 'dead_process' || inspection.reason === 'pid_reused') reason = inspection.reason;
    if (inspection.reason === 'invalid_owner' && (inspection.owner_age_ms ?? 0) >= missingOwnerProtectionMs) reason = 'invalid_owner';
    if (inspection.reason === 'missing_owner' && (inspection.owner_age_ms ?? 0) >= missingOwnerProtectionMs) reason = 'missing_owner';
    if (reason && await reclaimIfUnchanged(directory, fingerprint, reason, missingOwnerProtectionMs,deadline,options.identifyProcess)) { reclaimedReason = reason; continue; }
    if (Date.now() >= deadline) {
      const waited = Math.max(0, Date.now() - started);
      await persistTelemetry(options.telemetryFile, { name: options.name, state: 'timeout', directory, owner: inspection.owner, wait_duration_ms: waited, last_reclaim_reason: reclaimedReason, error: `${options.name} lock wait exceeded ${maxWaitMs}ms`, updated_at: new Date().toISOString() });
      throw new Error(options.busyMessage??`${options.name} lock wait exceeded ${maxWaitMs}ms (${inspection.reason})`);
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

export async function withOwnedDirectoryLock<T>(directory: string, options: OwnedDirectoryLockOptions, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireOwnedDirectoryLock(directory, options);
  let primaryError: unknown = null;
  try { return await operation(); }
  catch (error) { primaryError = error; throw error; }
  finally {
    try { if (!(await lock.release())) throw new Error(`${options.name}: lock ownership was lost before release`); }
    catch (releaseError) {
      if (primaryError && typeof primaryError === 'object' && primaryError !== null && !('releaseError' in primaryError)) Object.assign(primaryError, { releaseError });
      else if (!primaryError) throw releaseError;
    }
  }
}
