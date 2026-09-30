import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { atomicWriteMany, exists, readMarkdown, sha256, stringifyMarkdown } from './files.js';
import { freezeControlledVerificationCandidate, readGateConfig, readWorkspace, runGates, type GateResult } from './execution.js';
import { readProject, scanTasks, verifyTaskExecutionApproval, verifyExecutionPreflight } from './project.js';
import { readState } from './task.js';
import { finishExecutionStep, startExecutionStep, type ExecutionStepType } from './execution-events.js';

const exec = promisify(execFile);
const control = (root: string) => path.join(root, '.spec-loop');
const taskIdSchema = z.string().regex(/^(?:WEB-)?TASK-[A-Z0-9][A-Z0-9-]*$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const acIdSchema = z.string().regex(/^AC-[1-9]\d*$/);
const riskTagSchema = z.enum(['functional', 'security', 'privacy', 'authorization', 'data_integrity', 'critical_path']);
const protectedRiskTags = new Set(['security', 'privacy', 'authorization', 'data_integrity', 'critical_path']);

const criterionSchema = z.object({
  id: acIdSchema,
  text: z.string().min(3),
  risk_tags: z.array(riskTagSchema).min(1),
  waivable: z.boolean(),
}).strict();

const useCaseSchema = z.object({
  id: z.string().regex(/^UC-[1-9]\d*$/),
  ac: z.array(acIdSchema).min(1),
  scenario: z.string().min(3),
}).strict();

const toolSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(['command', 'unit', 'api', 'playwright']),
  gate_id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  command: z.array(z.string().min(1)).min(1).nullable(),
  playwright: z.object({
    config: z.string().nullable(), tests: z.array(z.string()), projects: z.array(z.string()), grep: z.string().nullable(), require_screenshots: z.boolean(),
  }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'playwright' && (!value.playwright || value.command)) ctx.addIssue({ code: 'custom', message: `${value.id}: Playwright tool requires playwright config and no command` });
  if (value.kind !== 'playwright' && (!value.command || value.playwright)) ctx.addIssue({ code: 'custom', message: `${value.id}: command/unit/api tool requires command and no playwright config` });
});

const assertionSchema = z.object({
  id: z.string().regex(/^AS-[1-9]\d*$/),
  ac: z.array(acIdSchema).min(1),
  tool_id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  operator: z.enum(['exit_code_zero', 'playwright_clean', 'json_match', 'human_judgement']),
  expected: z.string().min(1),
}).strict();

const evidenceRequirementSchema = z.object({
  id: z.string().regex(/^ER-[1-9]\d*$/),
  ac: z.array(acIdSchema).min(1),
  tool_id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(['command_log', 'test_report', 'api_transcript', 'screenshot', 'review_report']),
  required: z.literal(true),
}).strict();

export const acceptanceContractInputSchema = z.object({
  schema_version: z.literal(2),
  task_id: taskIdSchema,
  version: z.number().int().positive(),
  risk: z.enum(['light', 'standard', 'heavy']),
  critical_path: z.boolean(),
  depends_on: z.array(taskIdSchema),
  criteria: z.array(criterionSchema).min(1),
  use_cases: z.array(useCaseSchema).min(1),
  tools: z.array(toolSchema).min(1),
  assertions: z.array(assertionSchema).min(1),
  evidence_requirements: z.array(evidenceRequirementSchema).min(1),
  budgets: z.object({
    max_semantic_reworks: z.literal(2),
    max_infrastructure_retries_per_stage: z.number().int().min(0).max(5),
    repeated_failure_limit: z.number().int().min(1).max(3),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const ac = new Set(value.criteria.map((item) => item.id));
  const tools = new Set(value.tools.map((item) => item.id));
  const checkCoverage = (items: Array<{ id: string; ac: string[] }>, label: string) => {
    for (const item of items) for (const id of item.ac) if (!ac.has(id)) ctx.addIssue({ code: 'custom', message: `${label} ${item.id} references unknown ${id}` });
    for (const id of ac) if (!items.some((item) => item.ac.includes(id))) ctx.addIssue({ code: 'custom', message: `${label} does not cover ${id}` });
  };
  checkCoverage(value.use_cases, 'use_cases');
  checkCoverage(value.assertions, 'assertions');
  checkCoverage(value.evidence_requirements, 'evidence_requirements');
  for (const item of [...value.assertions, ...value.evidence_requirements]) if (!tools.has(item.tool_id)) ctx.addIssue({ code: 'custom', message: `${item.id} references unknown tool ${item.tool_id}` });
  for (const item of value.criteria) if (item.waivable && item.risk_tags.some((tag) => protectedRiskTags.has(tag))) ctx.addIssue({ code: 'custom', message: `${item.id} has a protected risk tag and may not be waivable` });
  const ids = value.criteria.map((item) => item.id);
  const numbers = ids.map((id) => Number(id.slice(3)));
  if (new Set(ids).size !== ids.length || numbers.some((number, index) =>
    value.version === 1 ? number !== index + 1 : index > 0 && number <= numbers[index - 1]
  )) ctx.addIssue({ code: 'custom', message: value.version === 1
    ? 'initial criterion IDs must be unique and continuous from AC-1'
    : 'revised criterion IDs must be unique and remain in ascending order' });
  for (const [label, idsToCheck] of [
    ['use case', value.use_cases.map((item) => item.id)],
    ['assertion', value.assertions.map((item) => item.id)],
    ['evidence requirement', value.evidence_requirements.map((item) => item.id)],
    ['tool', value.tools.map((item) => item.id)],
  ] as const) if (new Set(idsToCheck).size !== idsToCheck.length) ctx.addIssue({ code: 'custom', message: `${label} IDs must be unique` });
});

const approvedContractSchema = z.object({
  ...acceptanceContractInputSchema.shape,
  contract_hash: hashSchema,
  approval: z.object({ approved_by: z.string().min(2), approved_at: z.iso.datetime(), contract_hash: hashSchema }).strict(),
}).strict();

export type AcceptanceContractV2 = z.infer<typeof approvedContractSchema>;
export type AcceptanceStage = z.infer<typeof acceptanceStageSchema>;

const acceptanceStageSchema = z.enum([
  'm_working', 'm_submitted', 'plan_compiled', 'v_passed', 'candidate',
  'waiting_human_review', 'blocked_external', 'cancelled',
]);

const historySchema = z.object({
  sequence: z.number().int().positive(),
  stage: acceptanceStageSchema,
  action: z.string().min(2),
  actor: z.enum(['P', 'M', 'V', 'R', 'controller', 'human']),
  occurred_at: z.iso.datetime(),
  artifact: z.string().nullable(),
}).strict();

const runSchema = z.object({
  schema_version: z.literal(2),
  protocol_version: z.literal(2),
  orchestration_required: z.boolean().default(false),
  task_id: taskIdSchema,
  contract_version: z.number().int().positive(),
  contract_hash: hashSchema,
  stage: acceptanceStageSchema,
  run_id: z.string().regex(/^RUN-[A-Z0-9-]+-\d+$/),
  semantic_reworks_used: z.number().int().nonnegative(),
  infrastructure_retries: z.object({ V: z.number().int().nonnegative(), R: z.number().int().nonnegative() }).strict(),
  current_head: z.string().nullable(),
  stopped_head: z.string().nullable().default(null),
  last_m_head: z.string().nullable(),
  last_m_invocation: z.string().nullable().default(null),
  plan_hash: hashSchema.nullable(),
  last_v_invocation: z.string().nullable(),
  last_v_evidence_set_hash: hashSchema.nullable(),
  last_r_invocation: z.string().nullable(),
  last_r_evidence_set_hash: hashSchema.nullable(),
  last_failure_fingerprint: hashSchema.nullable(),
  repeated_failure_count: z.number().int().nonnegative(),
  active_conflict_id: z.string().nullable(),
  candidate_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  history: z.array(historySchema).min(1),
}).strict();

export type AcceptanceRun = z.infer<typeof runSchema>;

export function approvedAcceptanceContractValue(inputValue: unknown, approvedBy: string, approvedAt = new Date().toISOString()): AcceptanceContractV2 {
  const input = acceptanceContractInputSchema.parse(inputValue), contractHash = sha256(JSON.stringify(input));
  return approvedContractSchema.parse({ ...input, contract_hash: contractHash, approval: { approved_by: approvedBy, approved_at: approvedAt, contract_hash: contractHash } });
}

const evidenceInputSchema = z.object({
  file: z.string().min(1),
  sha256: hashSchema.optional(),
  ac: z.union([acIdSchema, z.array(acIdSchema).min(1)]).transform((value) => Array.isArray(value) ? value : [value]),
  requirement_ids: z.array(z.string().regex(/^ER-[1-9]\d*$/)).min(1),
}).strict();

const vInputSchema = z.object({
  task_id: taskIdSchema,
  contract_hash: hashSchema,
  plan_hash: hashSchema,
  head: z.string().min(7),
  invocation_id: z.string().min(3),
  verdict: z.enum(['pass', 'fail']),
  classification: z.enum(['implementation_problem', 'infrastructure_problem', 'spec_ambiguity', 'high_risk']).nullable(),
  failed_ac: z.array(acIdSchema),
  message: z.string().min(3),
  evidence: z.array(evidenceInputSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === 'pass' && (value.classification !== null || value.failed_ac.length)) ctx.addIssue({ code: 'custom', message: 'V pass may not contain a failure classification or failed AC' });
  if (value.verdict === 'fail' && !value.classification) ctx.addIssue({ code: 'custom', message: 'V fail requires a classification' });
});

const rInputSchema = z.object({
  task_id: taskIdSchema,
  contract_hash: hashSchema,
  plan_hash: hashSchema,
  head: z.string().min(7),
  v_evidence_set_hash: hashSchema,
  invocation_id: z.string().min(3),
  verdict: z.enum(['pass', 'fail']),
  classification: z.enum(['implementation_problem', 'evidence_problem', 'spec_problem']).nullable(),
  failed_ac: z.array(acIdSchema),
  message: z.string().min(3),
  evidence: z.array(evidenceInputSchema).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.verdict === 'pass' && (value.classification !== null || value.failed_ac.length)) ctx.addIssue({ code: 'custom', message: 'R pass may not contain a failure classification or failed AC' });
  if (value.verdict === 'fail' && !value.classification) ctx.addIssue({ code: 'custom', message: 'R fail requires a classification' });
});

const executionPlanSchema = z.object({
  schema_version: z.literal(2),
  task_id: taskIdSchema,
  run_id: z.string(),
  contract_version: z.number().int().positive(),
  contract_hash: hashSchema,
  head: z.string().min(7),
  base_commit: z.string().min(7),
  diff_hash: hashSchema,
  worktree_fingerprint: hashSchema,
  gate_plan_hash: hashSchema,
  toolchain: z.array(z.object({ file: z.string(), sha256: hashSchema }).strict()),
  environment: z.object({ platform: z.string(), arch: z.string(), node: z.string(), ci: z.boolean() }).strict(),
  mappings: z.array(z.object({
    ac: acIdSchema,
    use_cases: z.array(z.string()).min(1),
    tools: z.array(z.string()).min(1),
    assertions: z.array(z.string()).min(1),
    evidence_requirements: z.array(z.string()).min(1),
  }).strict()).min(1),
  compiled_at: z.iso.datetime(),
  plan_hash: hashSchema,
}).strict();

type ExecutionPlan = z.infer<typeof executionPlanSchema>;

const conflictSchema = z.object({
  schema_version: z.literal(2),
  conflict_id: z.string().regex(/^CONFLICT-[A-Z0-9-]+-\d+$/),
  task_id: taskIdSchema,
  run_id: z.string(),
  stage: z.enum(['V', 'R', 'controller']),
  reason: z.string().min(3),
  failure_fingerprint: hashSchema,
  head: z.string().nullable(),
  contract_hash: hashSchema,
  semantic_reworks_used: z.number().int().nonnegative(),
  requires_immediate_attention: z.boolean(),
  status: z.enum(['active', 'resolved']),
  created_at: z.iso.datetime(),
  resolved_at: z.iso.datetime().nullable(),
  resolution: z.string().nullable(),
}).strict();

const humanActionSchema = z.object({
  action: z.enum(['revise_spec_and_reauthorize', 'change_approach', 'split_task', 'waive_noncritical', 'mark_external_block', 'cancel']),
  actor: z.string().min(2),
  note: z.string().min(3),
  ac: z.array(acIdSchema).default([]),
  contract_file: z.string().min(1).nullable().default(null),
  reauthorize_budget: z.boolean().default(false),
}).strict();

function contractFile(taskRoot: string): string { return path.join(taskRoot, 'ACCEPTANCE_CONTRACT_V2.md'); }
function runFile(taskRoot: string): string { return path.join(taskRoot, 'ACCEPTANCE_RUN.json'); }
function outputDir(root: string, taskId: string): string { return path.join(control(root), 'output', `${taskId}-acceptance-v2`); }
function planFile(root: string, taskId: string): string { return path.join(outputDir(root, taskId), 'EXECUTION_PLAN.json'); }

async function findTask(root: string, taskId: string) {
  const task = (await scanTasks(root)).find((item) => item.task_id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return task;
}

async function unfinishedAcceptanceDependencies(root: string, contract: AcceptanceContractV2): Promise<string[]> {
  const tasks = await scanTasks(root), byId = new Map(tasks.map((item) => [item.task_id, item]));
  const unfinished: string[] = [];
  for (const id of contract.depends_on) {
    const task = byId.get(id);
    if (!task) { unfinished.push(id); continue; }
    if (await exists(runFile(task.path))) {
      if ((await readRun(task.path)).stage !== 'candidate') unfinished.push(id);
    } else if (task.status !== 'delivered') unfinished.push(id);
  }
  return unfinished;
}

async function readContract(taskRoot: string): Promise<AcceptanceContractV2> {
  const data = approvedContractSchema.parse((await readMarkdown(contractFile(taskRoot))).data);
  const { contract_hash: _stored, approval: _approval, ...input } = data;
  const expected = sha256(JSON.stringify(acceptanceContractInputSchema.parse(input)));
  if (data.contract_hash !== expected || data.approval.contract_hash !== expected) throw new Error('v2 Acceptance Contract integrity failure');
  return data;
}

export async function readApprovedAcceptanceContract(taskRoot: string): Promise<AcceptanceContractV2> {
  return readContract(taskRoot);
}

async function readRun(taskRoot: string): Promise<AcceptanceRun> {
  return runSchema.parse(JSON.parse(await readFile(runFile(taskRoot), 'utf8')));
}

function history(run: AcceptanceRun, stage: AcceptanceStage, action: string, actor: z.infer<typeof historySchema>['actor'], artifact: string | null): AcceptanceRun {
  const now = new Date().toISOString();
  return runSchema.parse({ ...run, stage, updated_at: now, history: [...run.history, { sequence: run.history.length + 1, stage, action, actor, occurred_at: now, artifact }] });
}

async function writeRun(root: string, taskRoot: string, run: AcceptanceRun, extra: Array<{ file: string; content: string | Buffer }> = []): Promise<void> {
  const previous=await exists(runFile(taskRoot))?runSchema.parse(JSON.parse(await readFile(runFile(taskRoot),'utf8'))):null;
  await atomicWriteMany(root, [{ file: runFile(taskRoot), content: `${JSON.stringify(runSchema.parse(run), null, 2)}\n` }, ...extra]);
  if(previous?.stage!==run.stage){
    const state=await readState(taskRoot),stepType:ExecutionStepType=run.stage==='plan_compiled'?'acceptance.plan':run.stage==='candidate'?'acceptance.candidate':'acceptance.route';
    const label=run.stage==='candidate'?'R Evidence Gate 生成 Candidate':`v2 ${previous?.stage??'not_started'} → ${run.stage}`;
    const ref=path.relative(root,runFile(taskRoot)).split(path.sep).join('/'),started=await startExecutionStep(root,{taskId:run.task_id,round:state.current_round,runId:run.run_id,stepType,label,summary:`P/M/V/R Controller 将权威阶段推进为 ${run.stage}`,refs:[ref],detached:true});
    await finishExecutionStep(root,started,{outcome:run.stage==='waiting_human_review'||run.stage==='blocked_external'||run.stage==='cancelled'?'interrupted':'success',summary:`权威 v2 阶段已写入 ${run.stage}`,refs:[ref]});
  }
}

export async function approveAcceptanceContract(root: string, taskId: string, sourceFile: string, approvedBy: string): Promise<AcceptanceContractV2> {
  const task = await findTask(root, taskId);
  const state = await readState(task.path);
  if (!['draft', 'planned'].includes(state.status)) throw new Error(`P approval is illegal after M starts (${state.status})`);
  const input = acceptanceContractInputSchema.parse(JSON.parse(await readFile(path.resolve(sourceFile), 'utf8')));
  if (input.task_id !== taskId || input.risk !== state.level) throw new Error('v2 contract identity or risk differs from Task');
  if (await exists(runFile(task.path))) throw new Error('an Acceptance Run already exists; revise the contract through human resolution');
  const now = new Date().toISOString();
  const approved = approvedAcceptanceContractValue(input, approvedBy, now);
  await atomicWriteMany(root, [{ file: contractFile(task.path), content: stringifyMarkdown(approved, '# Acceptance Contract v2\n\nP prepared this complete contract and a human approved its exact hash before M started.') }]);
  return approved;
}

export async function reviseUnstartedAcceptanceDependencies(root: string, taskId: string, sourceFile: string, expectedHash: string, approvedBy: string, reason: string): Promise<{ contract: AcceptanceContractV2; run: AcceptanceRun; audit_file: string }> {
  hashSchema.parse(expectedHash);
  if (approvedBy.trim().length < 2 || reason.trim().length < 3) throw new Error('contract revision requires an approving actor and reason');
  const task = await findTask(root, taskId), run = await readRun(task.path), current = await readContract(task.path);
  if (run.stage !== 'm_working' || run.active_conflict_id || run.current_head || run.last_m_head || run.last_m_invocation || run.plan_hash || run.last_v_invocation || run.last_r_invocation || run.candidate_id) throw new Error('dependency correction is legal only before M submission and without an active Conflict');
  if (run.contract_hash !== current.contract_hash || expectedHash !== current.contract_hash) throw new Error('dependency correction expected Contract hash differs from the approved Run');
  const invocationDir = path.join(outputDir(root, taskId), 'invocations');
  if (await exists(invocationDir)) {
    const info = await lstat(invocationDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('role invocation directory is invalid');
    const { readRoleInvocation } = await import('./role-orchestrator.js');
    for (const entry of await readdir(invocationDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('role invocation entry is invalid');
      const invocation = await readRoleInvocation(root, taskId, entry.name);
      if (!['failed', 'timed_out', 'cancelled'].includes(invocation.status)) throw new Error('dependency correction requires every role invocation to be terminal');
    }
  }
  const nextInput = acceptanceContractInputSchema.parse(JSON.parse(await readFile(path.resolve(sourceFile), 'utf8')));
  if (nextInput.task_id !== taskId || nextInput.risk !== current.risk || nextInput.version !== current.version + 1) throw new Error('dependency correction must preserve Task/risk and increment Contract version by one');
  const { contract_hash: _currentHash, approval: _currentApproval, ...currentInput } = current;
  const { version: _oldVersion, depends_on: oldDependencies, ...oldScope } = acceptanceContractInputSchema.parse(currentInput);
  const { version: _newVersion, depends_on: nextDependencies, ...nextScope } = nextInput;
  if (JSON.stringify(oldScope) !== JSON.stringify(nextScope)) throw new Error('dependency correction may not change AC, tools, Evidence or budgets');
  if (!nextDependencies.every((id) => oldDependencies.includes(id)) || nextDependencies.length >= oldDependencies.length) throw new Error('dependency correction may only remove an existing dependency');
  const now = new Date().toISOString(), approved = approvedAcceptanceContractValue(nextInput, approvedBy.trim(), now);
  const archive = path.join(outputDir(root, taskId), `CONTRACT-v${current.version}-${current.contract_hash}.md`);
  const audit = path.join(outputDir(root, taskId), `CONTRACT-REVISION-v${approved.version}-${approved.contract_hash}.json`);
  if (await exists(archive) || await exists(audit)) throw new Error('dependency correction archive already exists');
  const record = { schema_version: 1, task_id: taskId, run_id: run.run_id, prior_version: current.version, prior_hash: current.contract_hash, new_version: approved.version, new_hash: approved.contract_hash, removed_dependencies: oldDependencies.filter((id) => !nextDependencies.includes(id)), approved_by: approvedBy.trim(), approved_at: now, reason: reason.trim(), archived_contract: path.relative(root, archive) };
  const updated = history({ ...run, contract_version: approved.version, contract_hash: approved.contract_hash }, 'm_working', `P approved dependency correction v${approved.version}: ${reason.trim()}`, 'human', path.relative(root, audit));
  await writeRun(root, task.path, updated, [
    { file: archive, content: await readFile(contractFile(task.path), 'utf8') },
    { file: contractFile(task.path), content: stringifyMarkdown(approved, '# Acceptance Contract v2\n\nP-approved dependency correction before M submission.') },
    { file: audit, content: `${JSON.stringify(record, null, 2)}\n` },
  ]);
  return { contract: approved, run: updated, audit_file: path.relative(root, audit) };
}

export async function startAcceptanceRun(root: string, taskId: string): Promise<AcceptanceRun> {
  const task = await findTask(root, taskId);
  if (await exists(runFile(task.path))) throw new Error('v2 Acceptance Run already exists');
  const contract = await readContract(task.path);
  const state = await readState(task.path);
  if(contract.risk!==state.level)throw new Error(`Acceptance Contract risk ${contract.risk} conflicts with Task level ${state.level}`);
  if (state.status === 'delivered') throw new Error('cannot start v2 for a delivered v1 Task');
  const project = await readProject(root);
  await verifyExecutionPreflight(root, taskId, { requireProvider: project.default_task_protocol === 'v2' });
  const now = new Date().toISOString();
  const run = runSchema.parse({
    schema_version: 2, protocol_version: 2, orchestration_required: project.default_task_protocol === 'v2', task_id: taskId, contract_version: contract.version, contract_hash: contract.contract_hash,
    stage: 'm_working', run_id: `RUN-${taskId}-${Date.now()}`, semantic_reworks_used: 0, infrastructure_retries: { V: 0, R: 0 },
    current_head: null, stopped_head: null, last_m_head: null, last_m_invocation: null, plan_hash: null, last_v_invocation: null, last_v_evidence_set_hash: null,
    last_r_invocation: null, last_r_evidence_set_hash: null, last_failure_fingerprint: null, repeated_failure_count: 0,
    active_conflict_id: null, candidate_id: null, created_at: now, updated_at: now,
    history: [{ sequence: 1, stage: 'm_working', action: 'start v2 run from approved P contract', actor: 'controller', occurred_at: now, artifact: path.relative(root, contractFile(task.path)) }],
  });
  await writeRun(root, task.path, run);
  return run;
}

export async function cancelAcceptanceRun(root:string,taskId:string,reason='cancelled by controller',observedHead:string|null=null):Promise<AcceptanceRun>{
  const task=await findTask(root,taskId),run=await readRun(task.path);
  if(run.stage==='cancelled')return run;
  if(run.stage==='candidate')throw new Error('cannot cancel a completed Candidate');
  const updated=history({...run,active_conflict_id:null,stopped_head:observedHead??run.stopped_head},'cancelled',reason,'controller',null);
  const writes=[{file:runFile(task.path),content:`${JSON.stringify(updated,null,2)}\n`}];
  if(run.active_conflict_id){
    const file=path.join(control(root),'conflicts',`${run.active_conflict_id}.json`),conflict=conflictSchema.parse(JSON.parse(await readFile(file,'utf8')));
    if(conflict.conflict_id!==run.active_conflict_id||conflict.task_id!==taskId||conflict.status!=='active')throw new Error('active Acceptance Conflict does not match the cancelled Run');
    const resolved=conflictSchema.parse({...conflict,status:'resolved',resolved_at:new Date().toISOString(),resolution:`cancelled: ${reason}`});
    writes.push({file,content:`${JSON.stringify(resolved,null,2)}\n`});
  }
  await atomicWriteMany(root,writes);
  await rebuildReviewInbox(root);return updated;
}

async function git(cwd: string, args: string[]): Promise<string> { return (await exec('git', args, { cwd, maxBuffer: 20_000_000, timeout: 60_000, killSignal: 'SIGKILL' })).stdout.trim(); }

async function stableCandidate(root: string, taskId: string) {
  const workspace = await readWorkspace(root, taskId);
  const head = await git(workspace.worktree, ['rev-parse', 'HEAD']);
  if ((await git(workspace.worktree, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()) throw new Error('M submission requires a clean, committed worktree');
  const diff = await git(workspace.worktree, ['diff', '--binary', `${workspace.base_commit}...${head}`]);
  const tree = await git(workspace.worktree, ['ls-tree', '-r', '--full-tree', head]);
  return { workspace, head, diff_hash: sha256(diff), worktree_fingerprint: sha256(tree) };
}

async function hashEvidenceFiles(root: string, values: z.infer<typeof evidenceInputSchema>[], contract: AcceptanceContractV2, fallbackDir?: string) {
  const allowedAc = new Set(contract.criteria.map((item) => item.id));
  const requirements = new Map(contract.evidence_requirements.map((item) => [item.id, item]));
  const records = [] as Array<{ file: string; sha256: string; ac: string[]; requirement_ids: string[] }>;
  for (const value of values) {
    if (value.ac.some((id) => !allowedAc.has(id))) throw new Error(`evidence references an unknown AC: ${value.ac.join(', ')}`);
    for (const id of value.requirement_ids) {
      const requirement = requirements.get(id);
      if (!requirement || value.ac.some((ac) => !requirement.ac.includes(ac))) throw new Error(`evidence requirement ${id} does not cover the declared AC`);
    }
    let target = path.isAbsolute(value.file) ? path.resolve(value.file) : path.resolve(root, value.file);
    let info=await lstat(target).catch(()=>null);
    if (!info && fallbackDir && !path.isAbsolute(value.file)) {
      target=path.resolve(fallbackDir,value.file);
      info=await lstat(target).catch(()=>null);
    }
    if(!info?.isFile()||info.isSymbolicLink())throw new Error('Evidence must be a regular non-symbolic file');
    const actual=await realpath(target),actualRoot=await realpath(root);
    if (!(actual === actualRoot || actual.startsWith(actualRoot + path.sep))) throw new Error('Evidence file escapes Project root');
    const content = await readFile(actual);
    if (!content.length) throw new Error('Evidence file is empty');
    const contentHash = sha256(content);
    if (value.sha256 && value.sha256 !== contentHash) throw new Error('Evidence declared SHA-256 does not match the file');
    records.push({ file: path.relative(actualRoot, actual), sha256: contentHash, ac: [...new Set(value.ac)].sort(), requirement_ids: [...new Set(value.requirement_ids)].sort() });
  }
  return records.sort((left, right) => left.file.localeCompare(right.file));
}

function evidenceSetHash(records: Array<{ sha256: string; ac: string[]; requirement_ids: string[] }>): string {
  return sha256(JSON.stringify(records.map(({ sha256: digest, ac, requirement_ids }) => ({ sha256: digest, ac, requirement_ids }))));
}

export async function submitMakerCandidate(root: string, taskId: string, selfTestFiles: string[], invocationId?: string): Promise<AcceptanceRun> {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'm_working') throw new Error(`M submission is illegal from ${run.stage}`);
  if(run.orchestration_required){
    if(!invocationId)throw new Error('M submission requires a managed invocation');
    if(run.last_m_invocation===invocationId)throw new Error('M rework requires a new managed invocation');
    const invocation=await (await import('./role-orchestrator.js')).assertSucceededRoleInvocation(root,taskId,invocationId,'M');
    if(selfTestFiles.some(file=>{const target=path.resolve(file),evidenceRoot=path.resolve(invocation.evidence_root);return target!==evidenceRoot&&!target.startsWith(`${evidenceRoot}${path.sep}`)}))throw new Error('M self-test Evidence must come from the managed invocation Evidence root');
  }
  const blockedBy = await unfinishedAcceptanceDependencies(root, contract);
  if (blockedBy.length) throw new Error(`${taskId}: blocked by unfinished v2 dependencies: ${blockedBy.join(', ')}`);
  if (!selfTestFiles.length) throw new Error('M submission requires self-test Evidence');
  const candidate = await stableCandidate(root, taskId);
  if(run.orchestration_required&&invocationId){const invocation=await (await import('./role-orchestrator.js')).assertSucceededRoleInvocation(root,taskId,invocationId,'M');if(invocation.candidate.head!==candidate.head||invocation.candidate.fingerprint!==candidate.worktree_fingerprint)throw new Error('M invocation does not bind the submitted stable candidate HEAD')}
  if (run.last_m_head === candidate.head) throw new Error('M rework must produce a new HEAD');
  const evidence = await Promise.all(selfTestFiles.map(async (file) => {
    const target = path.resolve(file),info=await lstat(target).catch(()=>null);if(!info?.isFile()||info.isSymbolicLink())throw new Error('M self-test Evidence must be a regular non-symbolic file');
    const actual=await realpath(target),actualRoot=await realpath(root);
    if (!actual.startsWith(actualRoot + path.sep)) throw new Error('M self-test Evidence escapes Project root');
    return { file: path.relative(actualRoot, actual), sha256: sha256(await readFile(actual)) };
  }));
  const artifact = { schema_version: 2, task_id: taskId, run_id: run.run_id, head: candidate.head, base_commit: candidate.workspace.base_commit, diff_hash: candidate.diff_hash, worktree_fingerprint: candidate.worktree_fingerprint, self_test_evidence: evidence, submitted_at: new Date().toISOString() };
  const artifactFile = path.join(outputDir(root, taskId), `M-${candidate.head.slice(0, 12)}.json`);
  let updated = history({ ...run, current_head: candidate.head, last_m_head: candidate.head, last_m_invocation: invocationId??run.last_m_invocation, plan_hash: null }, 'm_submitted', 'M submitted a clean stable HEAD with self-test Evidence', 'M', path.relative(root, artifactFile));
  await writeRun(root, task.path, updated, [{ file: artifactFile, content: `${JSON.stringify(artifact, null, 2)}\n` }]);
  return updated;
}

async function toolchainFacts(worktree: string) {
  const names = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Package.swift', 'Podfile.lock'];
  const facts: Array<{ file: string; sha256: string }> = [];
  for (const name of names) {
    const file = path.join(worktree, name);
    if (await exists(file)) facts.push({ file: name, sha256: sha256(await readFile(file)) });
  }
  return facts;
}

export async function compileAcceptancePlan(root: string, taskId: string): Promise<ExecutionPlan> {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'm_submitted' || !run.current_head) throw new Error(`plan compilation is illegal from ${run.stage}`);
  const candidate = await stableCandidate(root, taskId);
  if (candidate.head !== run.current_head) throw new Error('candidate HEAD changed after M submission');
  const gatePlan = await readGateConfig(root), gates = new Map(gatePlan.gates.map((item) => [item.id, item]));
  for (const tool of contract.tools) {
    const gate = gates.get(tool.gate_id);
    if (!gate) throw new Error(`${tool.id}: Gate ${tool.gate_id} is not configured`);
    if (tool.kind === 'playwright') {
      if (gate.kind !== 'playwright') throw new Error(`${tool.id}: approved Playwright tool differs from Gate kind`);
      const observed = { config: gate.config ?? null, tests: gate.tests, projects: gate.projects, grep: gate.grep ?? null, require_screenshots: gate.require_screenshots };
      if (JSON.stringify(observed) !== JSON.stringify(tool.playwright)) throw new Error(`${tool.id}: Playwright Gate differs from the P-approved tool configuration`);
    } else {
      if (gate.kind === 'playwright' || JSON.stringify(gate.command) !== JSON.stringify(tool.command)) throw new Error(`${tool.id}: Gate command differs from the P-approved tool command`);
    }
  }
  const mappings = contract.criteria.map((criterion) => ({
    ac: criterion.id,
    use_cases: contract.use_cases.filter((item) => item.ac.includes(criterion.id)).map((item) => item.id),
    tools: [...new Set(contract.assertions.filter((item) => item.ac.includes(criterion.id)).map((item) => item.tool_id))],
    assertions: contract.assertions.filter((item) => item.ac.includes(criterion.id)).map((item) => item.id),
    evidence_requirements: contract.evidence_requirements.filter((item) => item.ac.includes(criterion.id)).map((item) => item.id),
  }));
  if (mappings.some((item) => !item.use_cases.length || !item.tools.length || !item.assertions.length || !item.evidence_requirements.length)) throw new Error('compiled plan would shrink Acceptance Contract coverage');
  const withoutHash = {
    schema_version: 2 as const, task_id: taskId, run_id: run.run_id, contract_version: contract.version, contract_hash: contract.contract_hash,
    head: candidate.head, base_commit: candidate.workspace.base_commit, diff_hash: candidate.diff_hash, worktree_fingerprint: candidate.worktree_fingerprint,
    gate_plan_hash: sha256(JSON.stringify(gatePlan)), toolchain: await toolchainFacts(candidate.workspace.worktree),
    environment: { platform: process.platform, arch: process.arch, node: process.version, ci: Boolean(process.env.CI) }, mappings, compiled_at: new Date().toISOString(),
  };
  const plan = executionPlanSchema.parse({ ...withoutHash, plan_hash: sha256(JSON.stringify(withoutHash)) });
  const updated = history({ ...run, plan_hash: plan.plan_hash }, 'plan_compiled', 'compiled immutable V execution plan', 'controller', path.relative(root, planFile(root, taskId)));
  await writeRun(root, task.path, updated, [{ file: planFile(root, taskId), content: `${JSON.stringify(plan, null, 2)}\n` }]);
  return plan;
}

async function readPlan(root: string, taskId: string, run: AcceptanceRun): Promise<ExecutionPlan> {
  const raw = await readFile(planFile(root, taskId), 'utf8'), plan = executionPlanSchema.parse(JSON.parse(raw));
  const { plan_hash: _hash, ...withoutHash } = plan;
  if (plan.plan_hash !== sha256(JSON.stringify(withoutHash)) || run.plan_hash !== plan.plan_hash || run.current_head !== plan.head || run.contract_hash !== plan.contract_hash) throw new Error('Execution Plan integrity or binding failure');
  return plan;
}

function failureFingerprint(stage: 'V' | 'R', classification: string, failedAc: string[], message: string, _evidenceSetHash: string): string {
  const normalized = message.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  return sha256(JSON.stringify({ stage, classification, failed_ac: [...failedAc].sort(), message: normalized }));
}

export async function describeControlledGateFailures(root: string, gates: GateResult[]): Promise<string> {
  const failed = gates.filter((gate) => gate.exit_code !== 0 || gate.timed_out);
  const details = await Promise.all(failed.map(async (gate) => {
    const output = await readFile(path.resolve(root, gate.artifact), 'utf8').catch(() => '');
    const testNames = [...output.matchAll(/^not ok\s+(?:\d+\s+-\s+)?(.+)$/gm)]
      .map((match) => match[1].trim().replace(/\s+/g, ' ')).filter(Boolean);
    const identity = testNames.length ? `tests ${[...new Set(testNames)].slice(0, 8).join(' | ')}`
      : `exit ${gate.exit_code}${gate.timed_out ? ' timeout' : ''}`;
    return `${gate.id}: ${identity}`;
  }));
  return `one or more controlled Gates failed: ${details.join('; ')}`;
}

function applyFailure(run: AcceptanceRun, fingerprint: string): AcceptanceRun {
  return { ...run, last_failure_fingerprint: fingerprint, repeated_failure_count: run.last_failure_fingerprint === fingerprint ? run.repeated_failure_count + 1 : 1 };
}

async function createConflict(root: string, taskRoot: string, run: AcceptanceRun, contract: AcceptanceContractV2, stage: 'V' | 'R' | 'controller', reason: string, fingerprint: string): Promise<AcceptanceRun> {
  const now = new Date(), id = `CONFLICT-${run.task_id}-${now.getTime()}`;
  const conflict = conflictSchema.parse({
    schema_version: 2, conflict_id: id, task_id: run.task_id, run_id: run.run_id, stage, reason, failure_fingerprint: fingerprint,
    head: run.current_head, contract_hash: run.contract_hash, semantic_reworks_used: run.semantic_reworks_used,
    requires_immediate_attention: contract.risk === 'heavy' || contract.critical_path || stage === 'controller', status: 'active',
    created_at: now.toISOString(), resolved_at: null, resolution: null,
  });
  const file = path.join(control(root), 'conflicts', `${id}.json`);
  const updated = history({ ...run, active_conflict_id: id }, 'waiting_human_review', reason, 'controller', path.relative(root, file));
  await writeRun(root, taskRoot, updated, [{ file, content: `${JSON.stringify(conflict, null, 2)}\n` }]);
  await rebuildReviewInbox(root);
  return updated;
}

async function consumeSemanticRework(root: string, taskRoot: string, run: AcceptanceRun, contract: AcceptanceContractV2, destination: 'm_working' | 'plan_compiled', reason: string, fingerprint: string, actor: 'V' | 'R'): Promise<AcceptanceRun> {
  const failed = applyFailure(run, fingerprint), next = failed.semantic_reworks_used + 1;
  if (failed.repeated_failure_count >= contract.budgets.repeated_failure_limit) return createConflict(root, taskRoot, failed, contract, actor, `repeated failure fingerprint: ${reason}`, fingerprint);
  if (next > contract.budgets.max_semantic_reworks) return createConflict(root, taskRoot, failed, contract, actor, `semantic rework budget exhausted: ${reason}`, fingerprint);
  const updated = history({ ...failed, semantic_reworks_used: next }, destination, reason, actor, null);
  await writeRun(root, taskRoot, updated);
  return updated;
}

async function assertCandidateStillCurrent(root: string, taskId: string, plan: ExecutionPlan): Promise<void> {
  const candidate = await stableCandidate(root, taskId);
  if (candidate.head !== plan.head || candidate.diff_hash !== plan.diff_hash || candidate.worktree_fingerprint !== plan.worktree_fingerprint) throw new Error('candidate changed after execution plan compilation');
  const gatePlan = await readGateConfig(root);
  if (sha256(JSON.stringify(gatePlan)) !== plan.gate_plan_hash) throw new Error('Gate Plan changed after execution plan compilation');
  if (JSON.stringify(await toolchainFacts(candidate.workspace.worktree)) !== JSON.stringify(plan.toolchain)) throw new Error('toolchain changed after execution plan compilation');
  const environment = { platform: process.platform, arch: process.arch, node: process.version, ci: Boolean(process.env.CI) };
  if (JSON.stringify(environment) !== JSON.stringify(plan.environment)) throw new Error('verification environment changed after execution plan compilation');
}

export async function recordVResult(root: string, taskId: string, sourceFile: string): Promise<AcceptanceRun> {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'plan_compiled') throw new Error(`V is illegal from ${run.stage}`);
  const plan = await readPlan(root, taskId, run); await assertCandidateStillCurrent(root, taskId, plan);
  const input = vInputSchema.parse(JSON.parse(await readFile(path.resolve(sourceFile), 'utf8')));
  if (input.task_id !== taskId || input.contract_hash !== contract.contract_hash || input.plan_hash !== plan.plan_hash || input.head !== plan.head) throw new Error('V result is not bound to the current Task, Contract, Plan and HEAD');
  if(run.orchestration_required){const invocation=await (await import('./role-orchestrator.js')).assertSucceededRoleInvocation(root,taskId,input.invocation_id,'V');if(invocation.candidate.head!==plan.head)throw new Error('V invocation targets a different candidate HEAD')}
  if (input.invocation_id === run.last_r_invocation) throw new Error('V invocation must be independent from R');
  const evidence = await hashEvidenceFiles(root, input.evidence, contract, path.dirname(sourceFile)), currentEvidenceSetHash = evidenceSetHash(evidence);
  if (run.last_v_evidence_set_hash === currentEvidenceSetHash) throw new Error('V retry must produce new Evidence content');
  if (input.verdict === 'pass') {
    const covered = new Set(evidence.flatMap((item) => item.ac));
    const requirements = new Set(evidence.flatMap((item) => item.requirement_ids));
    if (contract.criteria.some((item) => !covered.has(item.id)) || contract.evidence_requirements.some((item) => !requirements.has(item.id))) throw new Error('V PASS Evidence does not cover the complete contract');
  }
  const record = { schema_version: 2, role: 'V', run_id: run.run_id, ...input, evidence, evidence_set_hash: currentEvidenceSetHash, recorded_at: new Date().toISOString() };
  const file = path.join(outputDir(root, taskId), 'V', `${Date.now()}-${input.invocation_id.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
  let base = { ...run, last_v_invocation: input.invocation_id, last_v_evidence_set_hash: currentEvidenceSetHash };
  if (input.verdict === 'pass') {
    const updated = history({ ...base, last_failure_fingerprint: null, repeated_failure_count: 0 }, 'v_passed', 'V independently passed the complete Acceptance Contract', 'V', path.relative(root, file));
    await writeRun(root, task.path, updated, [{ file, content: `${JSON.stringify(record, null, 2)}\n` }]);
    return updated;
  }
  const fingerprint = failureFingerprint('V', input.classification!, input.failed_ac, input.message, currentEvidenceSetHash);
  await atomicWriteMany(root, [{ file, content: `${JSON.stringify(record, null, 2)}\n` }]);
  if (input.classification === 'implementation_problem') return consumeSemanticRework(root, task.path, base, contract, 'm_working', input.message, fingerprint, 'V');
  if (input.classification === 'infrastructure_problem') {
    const failed = applyFailure(base, fingerprint), retries = failed.infrastructure_retries.V + 1;
    if (failed.repeated_failure_count >= contract.budgets.repeated_failure_limit || retries > contract.budgets.max_infrastructure_retries_per_stage) return createConflict(root, task.path, failed, contract, 'V', `V infrastructure retry exhausted: ${input.message}`, fingerprint);
    const updated = history({ ...failed, infrastructure_retries: { ...failed.infrastructure_retries, V: retries } }, 'plan_compiled', input.message, 'V', path.relative(root, file));
    await writeRun(root, task.path, updated); return updated;
  }
  return createConflict(root, task.path, applyFailure(base, fingerprint), contract, 'V', input.message, fingerprint);
}

export async function runControlledV(root: string, taskId: string, invocationId: string, providerResultFile?: string): Promise<{ gates: GateResult[]; run: AcceptanceRun }> {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'plan_compiled') throw new Error(`V is illegal from ${run.stage}`);
  const plan = await readPlan(root, taskId, run); await assertCandidateStillCurrent(root, taskId, plan);await freezeControlledVerificationCandidate(root,taskId);
  const providerResult = providerResultFile ? vInputSchema.parse(JSON.parse(await readFile(providerResultFile, 'utf8'))) : null;
  if (providerResult && (providerResult.task_id !== taskId || providerResult.invocation_id !== invocationId || providerResult.head !== plan.head || providerResult.plan_hash !== plan.plan_hash || providerResult.contract_hash !== contract.contract_hash)) throw new Error('Provider V result is not bound to the controlled candidate');
  const gates = await runGates(root, taskId);
  const passed = gates.every((item) => item.exit_code === 0 && !item.timed_out);
  const failureMessage = passed ? 'all controlled Gates passed' : await describeControlledGateFailures(root, gates);
  const gateFile = path.resolve(control(root), 'output', `${taskId}-gates.json`);
  const input = vInputSchema.parse({
    task_id: taskId, contract_hash: contract.contract_hash, plan_hash: plan.plan_hash, head: plan.head,
    invocation_id: invocationId,
    verdict: passed ? 'pass' : 'fail',
    classification: passed ? null : 'implementation_problem',
    failed_ac: [...new Set(gates.filter((item) => item.exit_code !== 0 || item.timed_out).flatMap((item) => item.ac ?? []))],
    message: failureMessage,
    evidence: contract.evidence_requirements.map((item) => ({ file: gateFile, ac: item.ac, requirement_ids: [item.id] })),
  });
  if (providerResult) {
    for (const item of providerResult.evidence) {
      if (!path.isAbsolute(item.file)) {
        const projectPath=path.resolve(root,item.file);
        if (!(await lstat(projectPath).catch(()=>null))) {
          input.evidence.push({ ...item, file:path.resolve(path.dirname(providerResultFile!),item.file) });
          continue;
        }
      }
      input.evidence.push(item);
    }
    if (providerResult.verdict === 'fail') {
      input.verdict = 'fail'; input.classification = providerResult.classification;
      input.failed_ac = [...new Set([...input.failed_ac, ...providerResult.failed_ac])];
      input.message = `${input.message}; Provider V: ${providerResult.message}`;
    }
  }
  const temp = path.join(outputDir(root, taskId), 'V', `controlled-input-${Date.now()}.json`);
  await atomicWriteMany(root, [{ file: temp, content: `${JSON.stringify(input, null, 2)}\n` }]);
  return { gates, run: await recordVResult(root, taskId, temp) };
}

export async function recordRResult(root: string, taskId: string, sourceFile: string): Promise<AcceptanceRun> {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'v_passed') throw new Error(`R is illegal from ${run.stage}`);
  const plan = await readPlan(root, taskId, run); await assertCandidateStillCurrent(root, taskId, plan);
  const input = rInputSchema.parse(JSON.parse(await readFile(path.resolve(sourceFile), 'utf8')));
  if (input.task_id !== taskId || input.contract_hash !== contract.contract_hash || input.plan_hash !== plan.plan_hash || input.head !== plan.head || input.v_evidence_set_hash !== run.last_v_evidence_set_hash) throw new Error('R result is not bound to the current Task, Contract, Plan, HEAD and V Evidence');
  if(run.orchestration_required){const invocation=await (await import('./role-orchestrator.js')).assertSucceededRoleInvocation(root,taskId,input.invocation_id,'R');if(invocation.candidate.head!==plan.head)throw new Error('R invocation targets a different candidate HEAD')}
  if (input.invocation_id === run.last_v_invocation) throw new Error('R invocation must differ from V invocation');
  const evidence = await hashEvidenceFiles(root, input.evidence, contract, path.dirname(sourceFile)), currentEvidenceSetHash = evidenceSetHash(evidence);
  if (run.last_r_evidence_set_hash === currentEvidenceSetHash) throw new Error('R retry must produce new Evidence content');
  const record = { schema_version: 2, role: 'R', run_id: run.run_id, ...input, evidence, evidence_set_hash: currentEvidenceSetHash, recorded_at: new Date().toISOString() };
  const file = path.join(outputDir(root, taskId), 'R', `${Date.now()}-${input.invocation_id.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
  let base = { ...run, last_r_invocation: input.invocation_id, last_r_evidence_set_hash: currentEvidenceSetHash };
  await atomicWriteMany(root, [{ file, content: `${JSON.stringify(record, null, 2)}\n` }]);
  if (input.verdict === 'pass') {
    if (!run.last_v_evidence_set_hash) throw new Error('R PASS requires current V Evidence');
    const reviewedAc = new Set(evidence.flatMap((item) => item.ac));
    if (contract.criteria.some((item) => !reviewedAc.has(item.id))) throw new Error('R PASS Evidence does not review every AC');
    const currentV = await newestRoleRecord(root, taskId, 'V');
    if (!currentV || currentV.evidence_set_hash !== run.last_v_evidence_set_hash || currentV.head !== plan.head || currentV.verdict !== 'pass') throw new Error('R evidence gate rejected stale or failing V result');
    for (const item of currentV.evidence as Array<{ file: string; sha256: string }>) if (sha256(await readFile(path.join(root, item.file))) !== item.sha256) throw new Error('R evidence gate detected tampered V Evidence');
    const candidateId = `CANDIDATE-${taskId}-${Date.now()}`;
    const candidate = { schema_version: 2, candidate_id: candidateId, task_id: taskId, run_id: run.run_id, contract_hash: run.contract_hash, plan_hash: plan.plan_hash, head: plan.head, v_evidence_set_hash: run.last_v_evidence_set_hash, r_evidence_set_hash: currentEvidenceSetHash, created_at: new Date().toISOString() };
    const candidateFile = path.join(outputDir(root, taskId), 'CANDIDATE.json');
    const updated = history({ ...base, candidate_id: candidateId, last_failure_fingerprint: null, repeated_failure_count: 0 }, 'candidate', 'R passed and Evidence Gate created Candidate', 'R', path.relative(root, candidateFile));
    await writeRun(root, task.path, updated, [{ file: candidateFile, content: `${JSON.stringify(candidate, null, 2)}\n` }]);
    return updated;
  }
  const fingerprint = failureFingerprint('R', input.classification!, input.failed_ac, input.message, currentEvidenceSetHash);
  if (input.classification === 'implementation_problem') return consumeSemanticRework(root, task.path, base, contract, 'm_working', input.message, fingerprint, 'R');
  if (input.classification === 'evidence_problem') return consumeSemanticRework(root, task.path, base, contract, 'plan_compiled', input.message, fingerprint, 'R');
  return createConflict(root, task.path, applyFailure(base, fingerprint), contract, 'R', input.message, fingerprint);
}

async function newestRoleRecord(root: string, taskId: string, role: 'V' | 'R'): Promise<Record<string, any> | null> {
  const dir = path.join(outputDir(root, taskId), role);
  if (!(await exists(dir))) return null;
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.startsWith('controlled-input-')).sort();
  if (!files.length) return null;
  const file = path.join(dir, files.at(-1)!), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576 || !(await realpath(file)).startsWith(await realpath(root) + path.sep)) throw new Error('invalid acceptance role record');
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function rebuildReviewInbox(root: string) {
  const dir = path.join(control(root), 'conflicts'), conflicts: Array<z.infer<typeof conflictSchema>> = [];
  if (await exists(dir)) for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json')).sort()) {
    const conflict = conflictSchema.parse(JSON.parse(await readFile(path.join(dir, name), 'utf8')));
    if (conflict.status === 'active') conflicts.push(conflict);
  }
  const inbox = { schema_version: 2, rebuilt_at: new Date().toISOString(), items: conflicts.map((item) => ({ conflict_id: item.conflict_id, task_id: item.task_id, reason: item.reason, requires_immediate_attention: item.requires_immediate_attention, created_at: item.created_at })) };
  await atomicWriteMany(root, [{ file: path.join(control(root), 'REVIEW_INBOX.json'), content: `${JSON.stringify(inbox, null, 2)}\n` }]);
  return inbox;
}

export async function resolveAcceptanceConflict(root: string, taskId: string, inputValue: unknown): Promise<AcceptanceRun> {
  const input = humanActionSchema.parse(inputValue), task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path);
  if (run.stage !== 'waiting_human_review' || !run.active_conflict_id) throw new Error('Task has no active Acceptance Conflict');
  if (input.action === 'waive_noncritical') {
    if (!input.ac.length) throw new Error('waive_noncritical requires AC IDs');
    for (const id of input.ac) {
      const criterion = contract.criteria.find((item) => item.id === id);
      if (!criterion || !criterion.waivable || criterion.risk_tags.some((tag) => protectedRiskTags.has(tag))) throw new Error(`${id} may not be waived`);
    }
    if (!input.contract_file) throw new Error('waive_noncritical requires a replacement contract_file');
  } else if (input.ac.length) throw new Error(`${input.action} may not contain AC IDs`);
  if (input.action === 'revise_spec_and_reauthorize' && (!input.contract_file || !input.reauthorize_budget)) throw new Error('revise_spec_and_reauthorize requires contract_file and reauthorize_budget=true');
  if (!['revise_spec_and_reauthorize', 'waive_noncritical'].includes(input.action) && input.contract_file) throw new Error(`${input.action} may not contain contract_file`);
  const conflictFile = path.join(control(root), 'conflicts', `${run.active_conflict_id}.json`), conflict = conflictSchema.parse(JSON.parse(await readFile(conflictFile, 'utf8')));
  const now = new Date().toISOString(), resolved = conflictSchema.parse({ ...conflict, status: 'resolved', resolved_at: now, resolution: `${input.action}: ${input.note}` });
  let destination: AcceptanceStage, replacement: AcceptanceContractV2 | null = null;
  if (input.contract_file) {
    const nextInput = acceptanceContractInputSchema.parse(JSON.parse(await readFile(path.resolve(input.contract_file), 'utf8')));
    if (nextInput.task_id !== taskId || nextInput.risk !== contract.risk || nextInput.version <= contract.version) throw new Error('replacement contract must preserve Task/risk and increase version');
    if (input.action === 'waive_noncritical') {
      const waived = new Set(input.ac);
      if (waived.size !== input.ac.length) throw new Error('waive_noncritical contains duplicate AC IDs');
      const withoutWaived = <T extends { ac: string[] }>(items: T[]) => items.map((item) => ({ ...item, ac: item.ac.filter((id) => !waived.has(id)) })).filter((item) => item.ac.length);
      const { contract_hash: _hash, approval: _approval, ...currentInput } = contract;
      const expected = {
        ...currentInput,
        version: nextInput.version,
        criteria: contract.criteria.filter((item) => !waived.has(item.id)),
        use_cases: withoutWaived(contract.use_cases),
        assertions: withoutWaived(contract.assertions),
        evidence_requirements: withoutWaived(contract.evidence_requirements),
      };
      if (JSON.stringify(nextInput) !== JSON.stringify(expected)) throw new Error('waiver replacement may only remove the specified AC and its coverage');
    }
    const contractHash = sha256(JSON.stringify(nextInput));
    replacement = approvedContractSchema.parse({ ...nextInput, contract_hash: contractHash, approval: { approved_by: input.actor, approved_at: now, contract_hash: contractHash } });
  }
  if (input.action === 'mark_external_block') destination = 'blocked_external';
  else if (input.action === 'cancel' || input.action === 'split_task') destination = 'cancelled';
  else destination = 'm_working';
  let updated = history({
    ...run, active_conflict_id: null,
    ...(replacement ? { contract_version: replacement.version, contract_hash: replacement.contract_hash, current_head: null, stopped_head: null, last_m_head: null, last_m_invocation: null, plan_hash: null, last_v_invocation: null, last_v_evidence_set_hash: null, last_r_invocation: null, last_r_evidence_set_hash: null } : {}),
    ...(input.reauthorize_budget ? { semantic_reworks_used: 0, infrastructure_retries: { V: 0, R: 0 }, last_failure_fingerprint: null, repeated_failure_count: 0 } : {}),
  }, destination, `${input.action}: ${input.note}`, 'human', path.relative(root, conflictFile));
  await writeRun(root, task.path, updated, [
    { file: conflictFile, content: `${JSON.stringify(resolved, null, 2)}\n` },
    ...(replacement ? [{ file: contractFile(task.path), content: stringifyMarkdown(replacement, '# Acceptance Contract v2\n\nHuman-approved replacement created while resolving an Acceptance Conflict.') }] : []),
  ]);
  await rebuildReviewInbox(root);
  return updated;
}

export async function buildAcceptanceSchedule(root: string) {
  const tasks = await scanTasks(root), entries = [] as Array<{ task_id: string; stage: string; action: 'start_m'|'start_v'|'start_r'|null; ready: boolean; blocked_by: string[]; suspended: boolean; immediate: boolean }>;
  const runs = new Map<string, AcceptanceRun>(), contracts = new Map<string, AcceptanceContractV2>();
  for (const task of tasks) if (await exists(runFile(task.path))) { runs.set(task.task_id, await readRun(task.path)); contracts.set(task.task_id, await readContract(task.path)); }
  for (const task of tasks) {
    const run = runs.get(task.task_id), contract = contracts.get(task.task_id);
    if (!run || !contract) continue;
    const blockedBy = contract.depends_on.filter((id) => {
      const dependencyRun = runs.get(id), dependencyTask = tasks.find((item) => item.task_id === id);
      return dependencyRun ? dependencyRun.stage !== 'candidate' : dependencyTask?.status !== 'delivered';
    });
    const waiting = run.stage === 'waiting_human_review', immediate = waiting && (contract.critical_path || contract.risk === 'heavy');
    const action = run.stage==='m_working'?'start_m':run.stage==='plan_compiled'?'start_v':run.stage==='v_passed'?'start_r':null;
    entries.push({ task_id: task.task_id, stage: run.stage, action, ready: action!==null && !blockedBy.length && !immediate, blocked_by: blockedBy, suspended: waiting && !immediate, immediate });
  }
  return { project_id: (await readProject(root)).project_id, ready: entries.filter((item) => item.ready).map((item) => item.task_id), suspended: entries.filter((item) => item.suspended).map((item) => item.task_id), immediate_attention: entries.filter((item) => item.immediate).map((item) => item.task_id), tasks: entries };
}

export async function readAcceptanceRun(root: string, taskId: string): Promise<AcceptanceRun> {
  return readRun((await findTask(root, taskId)).path);
}

// Shared by the wave review reader and its final freshness check. A bundle
// never substitutes its cached facts for the authoritative acceptance state.
export async function acceptanceReviewFacts(root: string, taskId: string) {
  const task = await findTask(root, taskId), run = await readRun(task.path), contract = await readContract(task.path), state = await readState(task.path);
  let actualHead: string | null = null, clean = false;
  const diagnostics: string[] = [];
  try { const candidate = await stableCandidate(root, taskId); actualHead = candidate.head; clean = true; }
  catch (error) { diagnostics.push((error as Error).message); }
  const records = [] as Array<{role:string;record_hash:string;verdict:string;invocation_id:string;evidence_set_hash:string;evidence:Array<{file:string;sha256:string;ac:string[];requirement_ids:string[]}>}>;
  for (const role of ['V','R'] as const) {
    const record = await newestRoleRecord(root, taskId, role);
    if (!record) continue;
    if(['candidate','v_passed'].includes(run.stage)&&(record.run_id!==run.run_id||record.contract_hash!==run.contract_hash||record.plan_hash!==run.plan_hash||record.head!==run.current_head))diagnostics.push(`${role}: record is not bound to the current run`);
    const evidence = record.evidence as Array<{file:string;sha256:string;ac:string[];requirement_ids:string[]}>;
    for (const item of evidence) {
      try {
        const file = path.resolve(root, item.file), info = await lstat(file), actual = await realpath(file), project = await realpath(root);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 20 * 1024 * 1024 || !actual.startsWith(project + path.sep) || sha256(await readFile(actual)) !== item.sha256) throw new Error('Evidence changed or escaped the project');
      } catch (error) { diagnostics.push(`${role}: ${(error as Error).message}`); }
    }
    if(evidenceSetHash(evidence)!==record.evidence_set_hash)diagnostics.push(`${role}: Evidence set hash mismatch`);
    const expected=role==='V'?run.last_v_evidence_set_hash:run.last_r_evidence_set_hash;if(['candidate','v_passed'].includes(run.stage)&&expected!==record.evidence_set_hash)diagnostics.push(`${role}: authoritative Evidence binding mismatch`);
    records.push({role,record_hash:sha256(JSON.stringify(record)),verdict:String(record.verdict),invocation_id:String(record.invocation_id),evidence_set_hash:String(record.evidence_set_hash),evidence});
  }
  if (run.plan_hash && ['plan_compiled','v_passed','candidate'].includes(run.stage)) {
    try { await assertCandidateStillCurrent(root, taskId, await readPlan(root, taskId, run)); }
    catch (error) { diagnostics.push((error as Error).message); }
  }
  if (run.stage === 'candidate') {
    const candidate = JSON.parse(await readFile(path.join(outputDir(root,taskId),'CANDIDATE.json'),'utf8'));
    if (candidate.head !== actualHead || candidate.candidate_id !== run.candidate_id || candidate.plan_hash !== run.plan_hash || candidate.contract_hash !== contract.contract_hash || candidate.v_evidence_set_hash !== run.last_v_evidence_set_hash || candidate.r_evidence_set_hash !== run.last_r_evidence_set_hash || records.find(item=>item.role==='V')?.verdict !== 'pass' || records.find(item=>item.role==='R')?.verdict !== 'pass') diagnostics.push('Candidate or independent V/R binding is stale');
  }
  const visual = await (await import('./review.js')).readVisualReviews(task.path);
  const invocations = [] as Array<{role:string;invocation_id:string;status:string;result_status:string;manifest_hash:string}>;
  for (const role of ['M','V','R'] as const) {
    const latest = await (await import('./role-orchestrator.js')).latestRoleInvocation(root, taskId, role);
    if (!latest) continue;
    invocations.push({role,invocation_id:latest.invocation_id,status:latest.status,result_status:latest.result_status,manifest_hash:sha256(JSON.stringify(latest))});
    if (['prepared','running','interrupted'].includes(latest.status)) diagnostics.push(`${role}: invocation has not reached a reconciled terminal state`);
  }
  return {task_id:taskId,title:String(((await readMarkdown(path.join(task.path,'SPEC.md'))).data as {title?:unknown}).title??taskId),round:state.current_round,stage:run.stage,run_id:run.run_id,run_hash:sha256(JSON.stringify(run)),contract_hash:contract.contract_hash,plan_hash:run.plan_hash,head:actualHead,candidate_id:run.candidate_id,clean,risk:contract.risk,critical_path:contract.critical_path,criteria:contract.criteria.map(item=>({id:item.id,text:item.text})),budgets:contract.budgets,semantic_reworks_used:run.semantic_reworks_used,conflict_id:run.active_conflict_id,records,invocations,visual,diagnostics,task_root:path.relative(root,task.path)};
}

export async function returnAcceptanceToMaker(root: string, taskId: string, actor: string, note: string, commandId: string, reauthorizeBudget = false) {
  const task = await findTask(root,taskId), run = await readRun(task.path), contract = await readContract(task.path), ref = `wave-review:${commandId}`;
  if (run.history.some(item=>item.artifact===ref)) return run;
  if (!['candidate','waiting_human_review','plan_compiled','v_passed','m_working'].includes(run.stage)) throw new Error(`cannot return ${run.stage} to M`);
  if (!reauthorizeBudget && run.semantic_reworks_used >= contract.budgets.max_semantic_reworks) throw new Error('rework budget exhausted; explicit budget reauthorization is required');
  const updated = history({...run,active_conflict_id:null,candidate_id:null,current_head:null,plan_hash:null,last_v_invocation:null,last_r_invocation:null,last_v_evidence_set_hash:null,last_r_evidence_set_hash:null,
    semantic_reworks_used:reauthorizeBudget?0:run.semantic_reworks_used+1,...(reauthorizeBudget?{infrastructure_retries:{V:0,R:0},last_failure_fingerprint:null,repeated_failure_count:0}:{})},'m_working',`${actor}: ${note}`,'human',ref);
  const extra: Array<{file:string;content:string}> = [];
  if (run.active_conflict_id) { const file = path.join(control(root),'conflicts',`${run.active_conflict_id}.json`), conflict = conflictSchema.parse(JSON.parse(await readFile(file,'utf8'))); extra.push({file,content:`${JSON.stringify({...conflict,status:'resolved',resolved_at:new Date().toISOString(),resolution:`wave review: ${actor}: ${note}`},null,2)}\n`}); }
  await writeRun(root,task.path,updated,extra);
  if(run.active_conflict_id)await rebuildReviewInbox(root);
  return updated;
}

export async function reconcileCandidateBaseline(root: string, taskId: string, apply = false) {
  const task = await findTask(root, taskId), run = await readRun(task.path);
  if (run.stage !== 'candidate' || !run.candidate_id || !run.current_head) throw new Error('Candidate baseline reconciliation requires a completed Candidate');
  const project = await readProject(root), workspace = await readWorkspace(root, taskId);
  const candidateHead = await git(workspace.worktree, ['rev-parse', '--verify', `${run.current_head}^{commit}`]);
  const baselineHead = await git(project.repository, ['rev-parse', '--verify', `refs/heads/${project.default_branch}^{commit}`]);
  let fastForward = false;
  try { await exec('git', ['merge-base', '--is-ancestor', baselineHead, candidateHead], { cwd: project.repository, maxBuffer: 1_000_000, timeout: 60_000, killSignal: 'SIGKILL' }); fastForward = true; } catch {}
  const status = fastForward ? 'ready_ff' : 'baseline_drift';
  const checkedAt = new Date().toISOString();
  const result = {
    schema_version: 1 as const, task_id: taskId, run_id: run.run_id, candidate_id: run.candidate_id,
    candidate_head: candidateHead, workspace_base_head: workspace.base_commit, default_branch: project.default_branch,
    baseline_head: baselineHead, status, checked_at: checkedAt, applied: false,
    next_action: fastForward ? 'request separately authorized ff-only delivery' : 're-enter M, rebase onto the current baseline, then rerun V and R',
  };
  if (!apply) return result;
  if (fastForward) throw new Error('Candidate is already ff-ready; merge/delivery requires separate authorization');
  const artifact = path.join(outputDir(root, taskId), `REBASELINE-${checkedAt.replace(/[:.]/g, '-')}.json`);
  const updated = history({
    ...run, current_head: null, stopped_head: candidateHead, last_m_head: null, last_m_invocation: null,
    plan_hash: null, last_v_invocation: null, last_v_evidence_set_hash: null, last_r_invocation: null,
    last_r_evidence_set_hash: null, last_failure_fingerprint: null, repeated_failure_count: 0,
    active_conflict_id: null, candidate_id: null,
  }, 'm_working', `baseline drift ${workspace.base_commit.slice(0, 12)} → ${baselineHead.slice(0, 12)}; rebaseline and reverify required`, 'controller', path.relative(root, artifact));
  const applied = { ...result, applied: true, queued_stage: updated.stage, preserved_candidate_id: run.candidate_id };
  await writeRun(root, task.path, updated, [{ file: artifact, content: `${JSON.stringify(applied, null, 2)}\n` }]);
  return applied;
}
