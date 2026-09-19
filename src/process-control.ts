import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function processStartedAt(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return `pid:${pid}`; } catch { return null; }
  }
  try {
    const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 64_000,
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
): Promise<{ stopped: boolean; escalated: boolean; reason: 'not_running' | 'identity_mismatch' | 'terminated' | 'killed' | 'still_running' }> {
  if (!pid) return { stopped: true, escalated: false, reason: 'not_running' };
  const actual = await processStartedAt(pid);
  if (!actual) return { stopped: true, escalated: false, reason: 'not_running' };
  if (expectedStartedAt && actual !== expectedStartedAt) return { stopped: false, escalated: false, reason: 'identity_mismatch' };
  signalProcessTree(pid, 'SIGTERM');
  const until = Date.now() + Math.max(100, graceMs);
  while (Date.now() < until) {
    if (!(await processMatches(pid, actual))) return { stopped: true, escalated: false, reason: 'terminated' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  signalProcessTree(pid, 'SIGKILL');
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await processMatches(pid, actual))) return { stopped: true, escalated: true, reason: 'killed' };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { stopped: false, escalated: true, reason: 'still_running' };
}
