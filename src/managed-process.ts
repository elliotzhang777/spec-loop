import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { processStartedAt, terminateProcessTree } from './process-control.js';

export interface ManagedProcessResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
  termination_verified: boolean;
  pipe_drain_timed_out: boolean;
}

export interface ManagedProcessHandle {
  child: ChildProcess;
  processStartedAt: Promise<string | null>;
  completion: Promise<ManagedProcessResult>;
  terminate(options?: { timedOut?: boolean; graceMs?: number }): Promise<boolean>;
}

export interface ManagedProcessOptions {
  bin: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  pipeDrainTimeoutMs?: number;
  maxCaptureBytes?: number;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
  spawnOptions?: Omit<SpawnOptions, 'cwd' | 'env' | 'stdio' | 'detached'>;
}

export function startManagedProcess(options: ManagedProcessOptions): ManagedProcessHandle {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error('managed process timeout must be positive');
  const drainMs = options.pipeDrainTimeoutMs ?? 1_000, captureLimit = options.maxCaptureBytes ?? 1_048_576;
  if (!Number.isFinite(drainMs) || drainMs < 1) throw new Error('managed process pipe drain timeout must be positive');
  const child = spawn(options.bin, options.args, {
    ...options.spawnOptions,
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== 'win32',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const identity = child.pid ? processStartedAt(child.pid) : Promise.resolve(null);
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, outputTruncated = false;
  let timedOut = false, settled = false, rootExited = false, terminationVerified = false, pipeDrainTimedOut = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let executionTimer: NodeJS.Timeout, drainTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: ManagedProcessResult) => void;

  const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
    const used = target === 'stdout' ? stdoutBytes : stderrBytes, remaining = Math.max(0, captureLimit - used);
    if (remaining < chunk.length) outputTruncated = true;
    const value = chunk.subarray(0, remaining).toString();
    if (target === 'stdout') { stdout += value; stdoutBytes += Math.min(remaining, chunk.length); options.onStdout?.(chunk); }
    else { stderr += value; stderrBytes += Math.min(remaining, chunk.length); options.onStderr?.(chunk); }
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(executionTimer); if (drainTimer) clearTimeout(drainTimer);
    resolveCompletion({
      code: timedOut ? 124 : (exitCode ?? 1), signal: exitSignal, stdout, stderr, timedOut, outputTruncated,
      termination_verified: terminationVerified || rootExited,
      pipe_drain_timed_out: pipeDrainTimedOut,
    });
  };
  const beginDrainDeadline = () => {
    if (settled || drainTimer) return;
    drainTimer = setTimeout(() => {
      if (settled) return;
      pipeDrainTimedOut = true;
      child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
      finish();
    }, drainMs);
  };
  const terminate = async (request: { timedOut?: boolean; graceMs?: number } = {}) => {
    if (request.timedOut) timedOut = true;
    if (settled || rootExited) { terminationVerified = true; beginDrainDeadline(); return true; }
    const result = await terminateProcessTree(child.pid, await identity, request.graceMs ?? 1_000);
    terminationVerified = result.stopped;
    beginDrainDeadline();
    return result.stopped;
  };

  const completion = new Promise<ManagedProcessResult>((resolve) => {
    resolveCompletion = resolve;
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', (error) => { stderr = `${stderr}\n${error.message}`.trim(); exitCode = 127; rootExited = true; finish(); });
    child.on('exit', (code, signal) => { rootExited = true; terminationVerified = true; exitCode = code; exitSignal = signal; beginDrainDeadline(); });
    child.on('close', (code, signal) => { rootExited = true; terminationVerified = true; exitCode ??= code; exitSignal ??= signal; finish(); });
    executionTimer = setTimeout(() => { void terminate({ timedOut: true }); }, options.timeoutMs);
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
  return { child, processStartedAt: identity, completion, terminate };
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
  return startManagedProcess(options).completion;
}
