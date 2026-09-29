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
  identity_error: string | null;
}

export interface ManagedProcessHandle {
  child: ChildProcess;
  processStartedAt: Promise<string | null>;
  completion: Promise<ManagedProcessResult>;
  terminate(options?: { timedOut?: boolean; graceMs?: number; timeoutMs?: number }): Promise<boolean>;
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
  identifyProcess?: typeof processStartedAt;
  terminationTimeoutMs?: number;
  terminationGraceMs?: number;
  detached?: boolean;
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
    detached: options.detached ?? process.platform !== 'win32',
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const identity = child.pid ? (options.identifyProcess ?? processStartedAt)(child.pid, Math.min(5_000, options.timeoutMs)) : Promise.resolve(null);
  let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0, outputTruncated = false;
  let timedOut = false, settled = false, rootExited = false, terminationVerified = false, pipeDrainTimedOut = false;
  let exitCode: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let identityError: string | null = null;
  let executionTimer: NodeJS.Timeout, drainTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: ManagedProcessResult) => void;
  let terminationWork: Promise<boolean> | null = null;

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
      code: timedOut ? 124 : identityError ? 125 : (exitCode ?? 1), signal: exitSignal, stdout, stderr, timedOut, outputTruncated,
      termination_verified: terminationVerified || rootExited,
      pipe_drain_timed_out: pipeDrainTimedOut,
      identity_error: identityError,
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
  const terminate = async (request: { timedOut?: boolean; graceMs?: number; timeoutMs?: number } = {}) => {
    if (request.timedOut) timedOut = true;
    if (rootExited || terminationVerified) { beginDrainDeadline(); return true; }
    if (terminationWork) return terminationWork;
    terminationWork = (async () => {
      const result = await terminateProcessTree(child.pid, await identity, request.graceMs ?? options.terminationGraceMs ?? 1_000,
        { timeoutMs: request.timeoutMs ?? options.terminationTimeoutMs });
      terminationVerified ||= result.stopped || rootExited;
      beginDrainDeadline();
      return terminationVerified;
    })().finally(() => { terminationWork = null; });
    return terminationWork;
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
  // Fast commands may finish before ps sees them. Only an unidentifiable live
  // child is rejected. Never publish its result as a successful managed run.
  void identity.then(startedAt => {
    if (startedAt || rootExited || settled) return;
    identityError = 'cannot establish managed child process start identity';
    stderr = `${stderr}\n${identityError}`.trim();
    // This ChildProcess is owned by this spawn and has not reported exit. Use
    // its direct handle; do not signal an unverified PID/process group.
    child.kill('SIGKILL');
    beginDrainDeadline();
  }).catch(error => {
    if (rootExited || settled) return;
    identityError = `cannot establish managed child process start identity: ${(error as Error).message}`;
    stderr = `${stderr}\n${identityError}`.trim();
    child.kill('SIGKILL'); beginDrainDeadline();
  });
  return { child, processStartedAt: identity, completion, terminate };
}

export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
  return startManagedProcess(options).completion;
}
