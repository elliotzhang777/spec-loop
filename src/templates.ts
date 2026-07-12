import path from 'node:path';
import { sha256, stringifyMarkdown } from './files.js';
import type { TaskLevel, TaskState } from './model.js';

export interface InitInput { id: string; title: string; level: TaskLevel; repository: string }

export function initialFiles(input: InitInput): Array<{ file: string; content: string }> {
  const now = new Date().toISOString();
  const state: TaskState = {
    schema_version: 1, task_id: input.id, title: input.title, level: input.level, status: 'draft', current_round: 0,
    state_version: 1, repository: input.repository, code_revision: 'UNSET', updated_at: now, last_command: 'init',
  };
  const files = [
    { file: 'TASK_STATE.md', content: stringifyMarkdown(state, '# Task State\n\nInitialized by spec-loop. Lifecycle fields are CLI-managed.') },
    { file: 'STATE_HISTORY.jsonl', content: `${JSON.stringify({ state_version: 1, status: 'draft', round: 0, command: 'init', state_hash: sha256(JSON.stringify(state)) })}\n` },
    { file: 'SPEC.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id, title: input.title, level: input.level }, '# Goal\n\nTODO\n\n## Scope\n\nTODO\n\n## Non-goals\n\nTODO') },
    { file: 'PLAN.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id, version: 1, ac_coverage: ['AC-1'] }, '# Plan\n\nTODO') },
    { file: 'ACCEPTANCE.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id, criteria: [{ id: 'AC-1', text: 'TODO' }] }, '# Acceptance Contract\n\nEach criterion requires current evidence.') },
    { file: 'VERIFY.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id, round: 0, result: 'pending', verifier: '', independent: false, human_checked: false, signed_round: 0, evidence: [] }, '# Verification\n\nNo verification has run.') },
    { file: 'DELIVERY.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id, round: 0, code_revision: 'UNSET', mappings: [] }, '# Delivery\n\nTODO') },
  ];
  if (input.level === 'heavy') files.push({ file: 'CONTEXT.md', content: stringifyMarkdown({ schema_version: 1, task_id: input.id }, '# Context\n\nTODO') });
  return files.map((f) => ({ file: path.normalize(f.file), content: f.content }));
}

export function roundTemplate(taskId: string, round: number): string {
  return stringifyMarkdown({ schema_version: 1, task_id: taskId, round, status: 'open' }, `# Round ${round}\n\n## Work\n\nTODO\n\n## Changes\n\nTODO\n\n## Outcome\n\nTODO`);
}

export function budgetTemplate(): string {
  return stringifyMarkdown({ schema_version: 1, max_attempts: 12, max_consecutive_failures: 4, max_repeated_error: 3, max_no_progress: 3, max_tokens: 500000, max_work_units: 40 }, '# Runtime Budget\n\nStrict limits enforced by `guard`.');
}
