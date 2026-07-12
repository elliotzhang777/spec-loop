import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

export const CLI = path.resolve('dist/cli.js');

export async function tempRoot(name = 'spec-loop-') { return mkdtemp(path.join(tmpdir(), name)); }

export function cli(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...options });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

export async function writeMd(file, data, body) {
  await writeFile(file, `---\n${YAML.stringify(data).trimEnd()}\n---\n\n${body.trim()}\n`);
}

export async function readMd(file) {
  const raw = await readFile(file, 'utf8'); const end = raw.indexOf('\n---\n', 4);
  return { data: YAML.parse(raw.slice(4, end)), body: raw.slice(end + 5).trim() };
}

export async function fillContracts(root, { id, title, level, criteria = ['first result works', 'regression checks pass'] }) {
  await writeMd(path.join(root, 'SPEC.md'), { schema_version: 1, task_id: id, title, level }, '# Goal\n\nImplement a real, observable behavior.\n\n## Scope\n\nChange the requested fixture.\n\n## Non-goals\n\nDo not change unrelated behavior.');
  const ac = criteria.map((text, i) => ({ id: `AC-${i + 1}`, text }));
  await writeMd(path.join(root, 'ACCEPTANCE.md'), { schema_version: 1, task_id: id, criteria: ac }, '# Acceptance Contract\n\nEvery criterion requires current evidence.');
  await writeMd(path.join(root, 'PLAN.md'), { schema_version: 1, task_id: id, version: 1, ac_coverage: ac.map((x) => x.id) }, '# Plan\n\n1. Inspect the fixture.\n2. Implement the smallest change.\n3. Run verification and map evidence.');
  if (level === 'heavy') await writeMd(path.join(root, 'CONTEXT.md'), { schema_version: 1, task_id: id }, '# Context\n\nThis high-risk fixture requires independent verification and explicit human inspection.');
}

export async function fillRound(root, round) {
  const file = path.join(root, 'ROUNDS', `ROUND-${String(round).padStart(4, '0')}.md`);
  await writeMd(file, { schema_version: 1, task_id: (await readMd(path.join(root, 'TASK_STATE.md'))).data.task_id, round, status: 'open' }, `# Round ${round}\n\n## Work\n\nImplemented the scoped change.\n\n## Changes\n\nUpdated fixture behavior and checks.\n\n## Outcome\n\nReady for independent verification.`);
}

export async function fillDelivery(root, { id, round, revision, evidenceId, criteriaCount = 2 }) {
  await writeMd(path.join(root, 'DELIVERY.md'), {
    schema_version: 1, task_id: id, round, code_revision: revision,
    mappings: Array.from({ length: criteriaCount }, (_, i) => ({ ac: `AC-${i + 1}`, evidence: [evidenceId] })),
  }, '# Delivery\n\nAll acceptance criteria are mapped to current, hash-verified evidence.');
}

export async function artifact(root, name, content = 'all verification checks passed\n') {
  const file = path.join(root, name); await writeFile(file, content); return file;
}

