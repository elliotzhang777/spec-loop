import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type ProcessInspection = { status: 'alive' | 'dead' | 'identity_mismatch' | 'unknown'; started_at: string | null };

export async function inspectProcess(pid: number | null | undefined, expectedStartedAt?: string | null,
  options: { identifyProcess?: typeof processStartedAt; timeoutMs?: number } = {}): Promise<ProcessInspection> {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return { status: 'unknown', started_at: null };
  const actual = await (options.identifyProcess ?? processStartedAt)(pid!, options.timeoutMs ?? 5_000).catch(() => null);
  if (actual) return { status: expectedStartedAt && actual !== expectedStartedAt ? 'identity_mismatch' : 'alive', started_at: actual };
  try { process.kill(pid!, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { status: 'dead', started_at: null };
  }
  return { status: 'unknown', started_at: null };
}

export async function processStartedAt(pid: number, timeoutMs = 5_000): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return `pid:${pid}`; } catch { return null; }
  }
  try {
    const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: Math.max(1, Math.ceil(timeoutMs)), killSignal: 'SIGKILL', maxBuffer: 64_000,
    });
    return result.stdout.trim() || null;
  } catch { return null; }
}

export async function processMatches(pid: number | null | undefined, expectedStartedAt?: string | null): Promise<boolean> {
  if (!pid) return false;
  const actual = await processStartedAt(pid);
  if (!actual) return false;
  return !expectedStartedAt || actual === expectedStartedAt;
}

export function requireProcessIdentity(startedAt:string|null,label:string):string{
  if(!startedAt)throw new Error(`${label}: cannot establish process start identity`);
  return startedAt;
}

export function signalProcessTree(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch { try { process.kill(pid, signal); } catch { /* already stopped */ } }
}

export async function terminateProcessTree(
  pid: number | null | undefined,
  expectedStartedAt?: string | null,
  graceMs = 1_000,
  options: { timeoutMs?: number; identifyProcess?: typeof processStartedAt } = {},
): Promise<{ stopped: boolean; escalated: boolean; reason: 'not_running' | 'identity_mismatch' | 'identity_unavailable' | 'terminated' | 'killed' | 'deadline_exceeded' }> {
  if (!pid) return { stopped: true, escalated: false, reason: 'not_running' };
  const timeoutMs = options.timeoutMs ?? Math.max(3_000, graceMs + 2_500);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(graceMs) || graceMs < 0) throw new Error('process termination deadlines must be finite and positive');
  const deadline = performance.now() + timeoutMs, identify = options.identifyProcess ?? processStartedAt;
  const expired = new Error('process termination deadline exceeded');
  let escalated = false;
  const probe = async () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw expired;
    let timer: NodeJS.Timeout | undefined;
    let identity: string | null;
    try {
      identity = await Promise.race([identify(pid, remaining), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(expired), Math.ceil(remaining));
      })]);
    } finally { if (timer) clearTimeout(timer); }
    if (performance.now() >= deadline) throw expired;
    if (identity) return { identity, gone: false };
    // A failed ps query is not proof of death. ESRCH is; EPERM is not.
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { identity: null, gone: true };
    }
    return { identity: null, gone: false };
  };
  try {
    const initial = await probe();
    if (initial.gone) return { stopped: true, escalated, reason: 'not_running' };
    if (!initial.identity || !expectedStartedAt) return { stopped: false, escalated, reason: 'identity_unavailable' };
    if (initial.identity !== expectedStartedAt) return { stopped: false, escalated, reason: 'identity_mismatch' };
    signalProcessTree(pid, 'SIGTERM');
    const graceDeadline = Math.min(deadline, performance.now() + graceMs);
    for (;;) {
      const current = await probe();
      if (current.gone || (current.identity && current.identity !== initial.identity)) return { stopped: true, escalated, reason: escalated ? 'killed' : 'terminated' };
      if (!current.identity) return { stopped: false, escalated, reason: 'identity_unavailable' };
      if (!escalated && performance.now() >= graceDeadline) {
        // The probe immediately above verified identity before escalation.
        signalProcessTree(pid, 'SIGKILL'); escalated = true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw expired;
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
  } catch (error) {
    if (error !== expired) throw error;
    return { stopped: false, escalated, reason: 'deadline_exceeded' };
  }
}
