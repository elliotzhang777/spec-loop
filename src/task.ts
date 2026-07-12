import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteMany, assertSubstantive, exists, readMarkdown, recoverTransactions, sha256, stringifyMarkdown } from './files.js';
import type { Attempt, Criterion, DeliveryMapping, EvidenceRecord, TaskLevel, TaskState } from './model.js';
import { LEGAL_TRANSITIONS } from './model.js';
import { acceptanceSchema, deliverySchema, evidenceSchema, planSchema, roundSchema, specSchema, stateSchema, verifySchema } from './schemas.js';
import { budgetTemplate, initialFiles, roundTemplate } from './templates.js';
import { guard, readBudget, readLedger, renderRunLog, renderSummary, validateAttemptSequence } from './runtime.js';
import { attemptSchema } from './schemas.js';

async function runtimeProjectionWrites(root: string, state: TaskState): Promise<Array<{ file: string; content: string }>> {
  if (!(await exists(path.join(root, 'BUDGET.md')))) return [];
  const budget = await readBudget(root);
  const attempts = await readLedger(root, state);
  return [{ file: path.join(root, 'RUN_SUMMARY.md'), content: renderSummary(state, budget, attempts, guard(budget, attempts)) }];
}

async function stateHistoryWrite(root: string, state: TaskState): Promise<{ file: string; content: string }> {
  const file = path.join(root, 'STATE_HISTORY.jsonl');
  const existing = await readFile(file, 'utf8');
  const record = { state_version: state.state_version, status: state.status, round: state.current_round, command: state.last_command, state_hash: sha256(JSON.stringify(state)) };
  return { file, content: `${existing.trimEnd()}\n${JSON.stringify(record)}\n` };
}

export async function readState(root: string): Promise<TaskState> {
  await recoverTransactions(root);
  return stateSchema.parse((await readMarkdown(path.join(root, 'TASK_STATE.md'))).data);
}

function nextState(state: TaskState, command: keyof typeof LEGAL_TRANSITIONS): TaskState {
  const [from, to] = LEGAL_TRANSITIONS[command];
  if (!from.includes(state.status)) throw new Error(`${command} is illegal from ${state.status}`);
  return { ...state, status: to, state_version: state.state_version + 1, updated_at: new Date().toISOString(), last_command: command };
}

export async function initTask(root: string, input: { id: string; title: string; level: TaskLevel; repository: string }): Promise<void> {
  await mkdir(root, { recursive: true });
  await recoverTransactions(root);
  if (await exists(path.join(root, 'TASK_STATE.md'))) throw new Error('task already initialized');
  await mkdir(path.join(root, 'ROUNDS'), { recursive: true });
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await atomicWriteMany(root, initialFiles(input).map((item) => ({ file: path.join(root, item.file), content: item.content })));
}

async function contracts(root: string): Promise<{ state: TaskState; criteria: Criterion[] }> {
  const state = await readState(root);
  const spec = await readMarkdown(path.join(root, 'SPEC.md'));
  const specData = specSchema.parse(spec.data);
  assertSubstantive(spec.body, 'SPEC.md body');
  if (specData.task_id !== state.task_id || specData.level !== state.level) throw new Error('SPEC.md identity differs from TASK_STATE.md');
  const acceptance = await readMarkdown(path.join(root, 'ACCEPTANCE.md'));
  const acc = acceptanceSchema.parse(acceptance.data);
  const ids = acc.criteria.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('Acceptance criterion IDs must be unique');
  for (let i = 0; i < ids.length; i++) if (ids[i] !== `AC-${i + 1}`) throw new Error('Acceptance criterion IDs must be continuous from AC-1');
  acc.criteria.forEach((c) => assertSubstantive(c.text, c.id));
  if (state.level === 'heavy') {
    const context = await readMarkdown(path.join(root, 'CONTEXT.md'));
    assertSubstantive(context.body, 'CONTEXT.md body');
  }
  return { state, criteria: acc.criteria };
}

export async function planTask(root: string): Promise<TaskState> {
  const { state, criteria } = await contracts(root);
  const plan = await readMarkdown(path.join(root, 'PLAN.md'));
  const data = planSchema.parse(plan.data);
  assertSubstantive(plan.body, 'PLAN.md body');
  const expected = new Set(criteria.map((c) => c.id));
  const coverage = new Set(data.ac_coverage);
  if (coverage.size !== data.ac_coverage.length || expected.size !== coverage.size || [...expected].some((id) => !coverage.has(id))) throw new Error('PLAN.md must cover every AC exactly once');
  const updated = nextState(state, 'plan');
  await atomicWriteMany(root, [{ file: path.join(root, 'TASK_STATE.md'), content: stringifyMarkdown(updated, '# Task State\n\nLifecycle fields are CLI-managed.') }, await stateHistoryWrite(root, updated), ...await runtimeProjectionWrites(root, updated)]);
  return updated;
}

export async function startRound(root: string): Promise<TaskState> {
  const state = await readState(root);
  if (state.status === 'iterating' && await exists(path.join(root, 'BUDGET.md'))) {
    const decision = guard(await readBudget(root), await readLedger(root, state));
    if (decision.decision !== 'continue') throw new Error(`Guard ${decision.decision}: ${decision.reason}`);
  }
  const updated = { ...nextState(state, 'round'), current_round: state.current_round + 1 };
  const roundFile = path.join(root, 'ROUNDS', `ROUND-${String(updated.current_round).padStart(4, '0')}.md`);
  if (await exists(roundFile)) throw new Error(`Round ${updated.current_round} already exists`);
  await atomicWriteMany(root, [
    { file: roundFile, content: roundTemplate(state.task_id, updated.current_round) },
    { file: path.join(root, 'TASK_STATE.md'), content: stringifyMarkdown(updated, '# Task State\n\nLifecycle fields are CLI-managed.') },
    await stateHistoryWrite(root, updated),
    ...await runtimeProjectionWrites(root, updated),
  ]);
  return updated;
}

async function currentRound(root: string, state: TaskState) {
  const file = path.join(root, 'ROUNDS', `ROUND-${String(state.current_round).padStart(4, '0')}.md`);
  const doc = await readMarkdown(file);
  const data = roundSchema.parse(doc.data);
  if (data.round !== state.current_round || data.task_id !== state.task_id) throw new Error('current Round identity mismatch');
  assertSubstantive(doc.body, `Round ${state.current_round} body`);
  return { file, doc, data };
}

export async function verifyTask(root: string, options: { result: 'pass' | 'fail'; artifact: string; verifier: string; independent: boolean; human: boolean; revision?: string }): Promise<TaskState> {
  let state = await readState(root);
  const round = await currentRound(root, state);
  assertSubstantive(options.verifier, 'verifier');
  const artifactSource = path.resolve(options.artifact);
  const artifact = await readFile(artifactSource);
  if (!artifact.length) throw new Error('evidence artifact is empty');
  const existing = await evidenceRecords(root);
  const evidenceId = `EV-${existing.length + 1}`;
  const artifactRel = `evidence/${evidenceId}.artifact`;
  const metadataRel = `evidence/${evidenceId}.json`;
  const revision = options.revision ?? state.code_revision;
  if (!revision || revision === 'UNSET') throw new Error('verification requires --revision');
  const record: EvidenceRecord = { schema_version: 1, id: evidenceId, task_id: state.task_id, round: state.current_round, code_revision: revision, type: 'test', artifact: artifactRel, sha256: sha256(artifact), exit_code: options.result === 'pass' ? 0 : 1, created_at: new Date().toISOString() };
  if (state.level === 'heavy' && options.result === 'pass' && (!options.independent || !options.human)) throw new Error('Heavy pass requires independent verifier and human check');
  const command = options.result === 'pass' ? 'verify-pass' : 'verify-fail';
  state = { ...nextState({ ...state, code_revision: revision }, command), code_revision: revision };
  const verify = { schema_version: 1 as const, task_id: state.task_id, round: state.current_round, result: options.result, verifier: options.verifier, independent: options.independent, human_checked: options.human, signed_round: state.current_round, evidence: [...existing.map((e) => e.id), evidenceId] };
  const roundData = { ...round.data, status: options.result === 'pass' ? 'verified_pass' as const : 'verified_fail' as const };
  await atomicWriteMany(root, [
    { file: path.join(root, artifactRel), content: artifact },
    { file: path.join(root, metadataRel), content: `${JSON.stringify(record, null, 2)}\n` },
    { file: round.file, content: stringifyMarkdown(roundData, round.doc.body) },
    { file: path.join(root, 'VERIFY.md'), content: stringifyMarkdown(verify, `# Verification\n\nRound ${state.current_round} ${options.result}. Evidence: ${evidenceId}.`) },
    { file: path.join(root, 'TASK_STATE.md'), content: stringifyMarkdown(state, '# Task State\n\nLifecycle fields are CLI-managed.') },
    await stateHistoryWrite(root, state),
    ...await runtimeProjectionWrites(root, state),
  ]);
  return state;
}

export async function evidenceRecords(root: string): Promise<EvidenceRecord[]> {
  const dir = path.join(root, 'evidence');
  if (!(await exists(dir))) return [];
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => /^EV-[1-9]\d*\.json$/.test(f)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
  const records: EvidenceRecord[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), 'utf8');
    let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error(`${file}: malformed evidence JSON`); }
    const record = evidenceSchema.parse(value);
    const artifact = await readFile(path.join(root, record.artifact));
    if (sha256(artifact) !== record.sha256) throw new Error(`${record.id}: artifact hash mismatch`);
    records.push(record);
  }
  for (let i = 0; i < records.length; i++) if (records[i].id !== `EV-${i + 1}`) throw new Error('Evidence IDs must be continuous');
  return records;
}

async function validateDelivery(root: string, state: TaskState, criteria: Criterion[]): Promise<void> {
  const verification = verifySchema.parse((await readMarkdown(path.join(root, 'VERIFY.md'))).data);
  if (verification.result !== 'pass' || verification.round !== state.current_round || verification.signed_round !== state.current_round) throw new Error('current Round is not signed with a passing verification');
  if (state.level === 'heavy' && (!verification.independent || !verification.human_checked)) throw new Error('Heavy delivery requires independent verifier and human check');
  const deliveryDoc = await readMarkdown(path.join(root, 'DELIVERY.md'));
  const delivery = deliverySchema.parse(deliveryDoc.data);
  assertSubstantive(deliveryDoc.body, 'DELIVERY.md body');
  if (delivery.round !== state.current_round || delivery.code_revision !== state.code_revision) throw new Error('Delivery must target current Round and code revision');
  const evidence = await evidenceRecords(root);
  const valid = new Map(evidence.filter((e) => e.round === state.current_round && e.code_revision === state.code_revision && e.exit_code === 0).map((e) => [e.id, e]));
  const mapping = new Map<string, string[]>();
  for (const item of delivery.mappings as DeliveryMapping[]) {
    if (mapping.has(item.ac)) throw new Error(`duplicate Delivery mapping for ${item.ac}`);
    if (item.evidence.some((id) => !valid.has(id))) throw new Error(`${item.ac}: invalid or stale Evidence`);
    mapping.set(item.ac, item.evidence);
  }
  for (const criterion of criteria) if (!mapping.has(criterion.id)) throw new Error(`${criterion.id}: missing Delivery mapping`);
  if (mapping.size !== criteria.length) throw new Error('Delivery contains unknown AC mapping');
}

export async function deliverTask(root: string): Promise<TaskState> {
  const { state, criteria } = await contracts(root);
  await validateDelivery(root, state, criteria);
  const updated = nextState(state, 'deliver');
  await atomicWriteMany(root, [{ file: path.join(root, 'TASK_STATE.md'), content: stringifyMarkdown(updated, '# Task State\n\nLifecycle fields are CLI-managed.') }, await stateHistoryWrite(root, updated), ...await runtimeProjectionWrites(root, updated)]);
  return updated;
}

export async function runtimeInit(root: string): Promise<void> {
  const state = await readState(root);
  if (await exists(path.join(root, 'BUDGET.md'))) throw new Error('runtime already initialized');
  const empty: Attempt[] = [];
  const budgetDoc = budgetTemplate();
  const budget = (await import('./schemas.js')).budgetSchema.parse((await import('yaml')).default.parse(budgetDoc.split('---\n')[1]));
  const result = guard(budget, empty);
  await atomicWriteMany(root, [
    { file: path.join(root, 'BUDGET.md'), content: budgetDoc },
    { file: path.join(root, 'LOOP_LEDGER.jsonl'), content: '' },
    { file: path.join(root, 'RUN_LOG.md'), content: renderRunLog(empty) },
    { file: path.join(root, 'RUN_SUMMARY.md'), content: renderSummary(state, budget, empty, result) },
  ]);
}

export async function appendAttempt(root: string, input: Omit<Attempt, 'schema_version' | 'attempt' | 'timestamp' | 'round'> & { round?: number }): Promise<Attempt> {
  const state = await readState(root);
  if (!['working', 'verifying', 'iterating'].includes(state.status)) throw new Error(`Attempts are illegal in ${state.status}`);
  const attempts = await readLedger(root, state);
  const attempt = attemptSchema.parse({ schema_version: 1, attempt: attempts.length + 1, round: input.round ?? state.current_round, timestamp: new Date().toISOString(), ...input }) as Attempt;
  const all = [...attempts, attempt];
  validateAttemptSequence(all, state);
  const ledger = all.map((a) => JSON.stringify(a)).join('\n') + '\n';
  const budget = await readBudget(root);
  const result = guard(budget, all);
  await atomicWriteMany(root, [
    { file: path.join(root, 'LOOP_LEDGER.jsonl'), content: ledger },
    { file: path.join(root, 'RUN_LOG.md'), content: renderRunLog(all) },
    { file: path.join(root, 'RUN_SUMMARY.md'), content: renderSummary(state, budget, all, result) },
  ]);
  return attempt;
}

export async function checkTask(root: string): Promise<string[]> {
  const errors: string[] = [];
  try {
    const { state, criteria } = await contracts(root);
    const historyLines = (await readFile(path.join(root, 'STATE_HISTORY.jsonl'), 'utf8')).trim().split(/\r?\n/);
    const history = historyLines.map((line, i) => { try { return JSON.parse(line) as { state_version: number; status: string; round: number; command: string; state_hash: string }; } catch { throw new Error(`STATE_HISTORY.jsonl:${i + 1}: malformed JSON`); } });
    for (let i = 0; i < history.length; i++) {
      if (history[i].state_version !== i + 1) throw new Error('State history versions must be continuous');
      if (i > 0) {
        const transition = Object.values(LEGAL_TRANSITIONS).find(([from, to]) => from.includes(history[i - 1].status as never) && to === history[i].status);
        if (!transition) throw new Error(`Illegal state history transition ${history[i - 1].status} -> ${history[i].status}`);
      }
    }
    const tail = history.at(-1);
    if (!tail || tail.state_version !== state.state_version || tail.status !== state.status || tail.round !== state.current_round || tail.state_hash !== sha256(JSON.stringify(state))) throw new Error('TASK_STATE.md does not match CLI state history');
    if (state.status !== 'draft') {
      const plan = planSchema.parse((await readMarkdown(path.join(root, 'PLAN.md'))).data);
      const ids = new Set(criteria.map((c) => c.id));
      if (plan.ac_coverage.some((id) => !ids.has(id)) || new Set(plan.ac_coverage).size !== ids.size) throw new Error('Plan coverage mismatch');
    }
    if (state.current_round > 0) {
      for (let i = 1; i <= state.current_round; i++) {
        const file = path.join(root, 'ROUNDS', `ROUND-${String(i).padStart(4, '0')}.md`);
        const round = roundSchema.parse((await readMarkdown(file)).data);
        if (round.round !== i) throw new Error('Round numbering is not continuous');
      }
    }
    await evidenceRecords(root);
    if (state.status === 'delivered') await validateDelivery(root, state, criteria);
    if (await exists(path.join(root, 'BUDGET.md'))) {
      const budget = await readBudget(root);
      const attempts = await readLedger(root, state);
      const expected = renderRunLog(attempts);
      const actual = await readFile(path.join(root, 'RUN_LOG.md'), 'utf8');
      if (actual !== expected) throw new Error('RUN_LOG.md diverges from LOOP_LEDGER.jsonl');
      const expectedSummary = renderSummary(state, budget, attempts, guard(budget, attempts));
      const summary = await readFile(path.join(root, 'RUN_SUMMARY.md'), 'utf8');
      if (summary !== expectedSummary) throw new Error('RUN_SUMMARY.md is stale or divergent');
    }
  } catch (error) { errors.push((error as Error).message); }
  return errors;
}
