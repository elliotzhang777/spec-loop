import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoSecrets, assertSubstantive, readMarkdown } from './files.js';
import type { Attempt, Budget, GuardResult, TaskState } from './model.js';
import { attemptSchema, budgetSchema } from './schemas.js';

const FINGERPRINT_PLACEHOLDER = /^(?:none|null|n\/a|na|tbd|todo|unknown|error|failed|failure|placeholder)$/i;

export async function readBudget(root: string): Promise<Budget> {
  const doc = await readMarkdown(path.join(root, 'BUDGET.md'));
  return budgetSchema.parse(doc.data);
}

function parseJsonRejectDuplicate(raw: string, line: number): unknown {
  const keys = new Set<string>();
  const keyRe = /"((?:\\.|[^"\\])*)"\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(raw)) !== null) {
    const key = JSON.parse(`"${match[1]}"`) as string;
    if (keys.has(key)) throw new Error(`LOOP_LEDGER.jsonl:${line}: duplicate field ${key}`);
    keys.add(key);
  }
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`LOOP_LEDGER.jsonl:${line}: malformed JSON: ${(error as Error).message}`); }
}

export async function readLedger(root: string, state?: TaskState): Promise<Attempt[]> {
  const raw = await readFile(path.join(root, 'LOOP_LEDGER.jsonl'), 'utf8');
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const attempts = lines.map((line, i) => attemptSchema.parse(parseJsonRejectDuplicate(line, i + 1)));
  validateAttemptSequence(attempts, state);
  return attempts;
}

export function validateAttemptSequence(attempts: Attempt[], state?: TaskState): void {
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i].attempt !== i + 1) throw new Error(`Attempt numbering must be continuous: expected ${i + 1}, got ${attempts[i].attempt}`);
    if (i > 0 && attempts[i].round < attempts[i - 1].round) throw new Error('Attempt round may not move backwards');
    if (state && attempts[i].round > state.current_round) throw new Error(`Attempt ${attempts[i].attempt} exceeds current Round`);
    assertSubstantive(attempts[i].action, `Attempt ${attempts[i].attempt} action`);
    assertNoSecrets(JSON.stringify(attempts[i]), `Attempt ${attempts[i].attempt}`);
    if (attempts[i].outcome !== 'success') {
      const fp = attempts[i].error_fingerprint ?? '';
      assertSubstantive(fp, `Attempt ${attempts[i].attempt} error fingerprint`);
      if (FINGERPRINT_PLACEHOLDER.test(fp.trim())) throw new Error(`Attempt ${attempts[i].attempt}: placeholder error fingerprint`);
    } else if (attempts[i].error_fingerprint !== null) {
      throw new Error(`Attempt ${attempts[i].attempt}: success must use null error_fingerprint`);
    }
  }
}

export function guard(budget: Budget, attempts: Attempt[]): GuardResult {
  const tokens = attempts.reduce((sum, item) => sum + item.tokens, 0);
  const work = attempts.reduce((sum, item) => sum + item.work_units, 0);
  const base = { attempts: attempts.length, tokens, work_units: work };
  if (attempts.length >= budget.max_attempts) return { decision: 'stop', reason: 'maximum attempts reached', ...base };
  if (tokens >= budget.max_tokens) return { decision: 'stop', reason: 'token budget reached', ...base };
  if (work >= budget.max_work_units) return { decision: 'stop', reason: 'work budget reached', ...base };

  let failures = 0;
  let noProgress = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].outcome === 'success') break;
    failures++;
    if (attempts[i].outcome === 'no_progress') noProgress++; else if (noProgress === 0) { /* keep scanning failures */ }
  }
  if (failures >= budget.max_consecutive_failures) return { decision: 'needs_user', reason: 'consecutive failure threshold reached', ...base };
  const tailNoProgress = (() => { let n = 0; for (let i = attempts.length - 1; i >= 0 && attempts[i].outcome === 'no_progress'; i--) n++; return n; })();
  if (tailNoProgress >= budget.max_no_progress) return { decision: 'needs_user', reason: 'no-progress threshold reached', ...base };
  const last = attempts.at(-1)?.error_fingerprint;
  if (last) {
    let repeated = 0;
    for (let i = attempts.length - 1; i >= 0 && attempts[i].error_fingerprint === last; i--) repeated++;
    if (repeated >= budget.max_repeated_error) return { decision: 'needs_user', reason: 'repeated error threshold reached', ...base };
  }
  return { decision: 'continue', reason: 'within runtime limits', ...base };
}

export function renderRunLog(attempts: Attempt[]): string {
  const rows = attempts.map((a) => `| ${a.attempt} | ${a.round} | ${a.outcome} | ${a.tokens} | ${a.work_units} | ${a.action.replaceAll('|', '\\|')} | ${a.error_fingerprint ?? ''} |`);
  return `# Run Log\n\n> Generated from LOOP_LEDGER.jsonl. Do not edit.\n\n| Attempt | Round | Outcome | Tokens | Work | Action | Error fingerprint |\n|---:|---:|---|---:|---:|---|---|\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

export function renderSummary(state: TaskState, budget: Budget, attempts: Attempt[], result: GuardResult): string {
  const successes = attempts.filter((a) => a.outcome === 'success').length;
  const failures = attempts.filter((a) => a.outcome === 'failure').length;
  const noProgress = attempts.filter((a) => a.outcome === 'no_progress').length;
  return `# Run Summary\n\n> Deterministically generated from TASK_STATE.md, BUDGET.md and LOOP_LEDGER.jsonl.\n\n- Task: ${state.task_id}\n- Status: ${state.status}\n- Current Round: ${state.current_round}\n- Attempts: ${attempts.length}/${budget.max_attempts}\n- Successes: ${successes}\n- Failures: ${failures}\n- No progress: ${noProgress}\n- Tokens: ${result.tokens}/${budget.max_tokens}\n- Work units: ${result.work_units}/${budget.max_work_units}\n- Guard: ${result.decision}\n- Guard reason: ${result.reason}\n`;
}
