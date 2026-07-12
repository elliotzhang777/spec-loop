import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cli, tempRoot, fillContracts, fillRound, readMd, writeMd } from './helpers.mjs';

async function workingTask(id = 'TASK-ADV') {
  const root = await tempRoot('adversarial-'); cli(['init', root, '--level', 'standard', '--id', id, '--title', 'Adversarial task']);
  await fillContracts(root, { id, title: 'Adversarial task', level: 'standard' }); cli(['plan', root]); cli(['runtime-init', root]); cli(['round', root]); await fillRound(root, 1);
  return root;
}

test('empty templates and placeholders fail', async () => {
  const root = await tempRoot(); cli(['init', root, '--level', 'light', '--id', 'TASK-EMPTY', '--title', 'Empty task']);
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /placeholder/);
});

test('fabricated TASK_STATE lifecycle fails state history check', async () => {
  const root = await workingTask(); const state = await readMd(path.join(root, 'TASK_STATE.md')); state.data.status = 'delivered';
  await writeMd(path.join(root, 'TASK_STATE.md'), state.data, state.body);
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /state history/i);
});

test('Attempt is rejected in draft state', async () => {
  const root = await tempRoot(); cli(['init', root, '--level', 'light', '--id', 'TASK-DRAFT', '--title', 'Draft task']);
  const result = cli(['attempt', root, '--action', 'illegal draft attempt', '--outcome', 'success', '--tokens', '1', '--work', '1']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /illegal in draft|BUDGET/);
});

test('failed Attempt rejects missing or placeholder fingerprint before append', async () => {
  const root = await workingTask();
  let result = cli(['attempt', root, '--action', 'record a real failed check', '--outcome', 'failure', '--tokens', '1', '--work', '1']);
  assert.notEqual(result.code, 0);
  result = cli(['attempt', root, '--action', 'record a real failed check', '--outcome', 'failure', '--error', 'unknown', '--tokens', '1', '--work', '1']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /placeholder/);
  assert.equal(await readFile(path.join(root, 'LOOP_LEDGER.jsonl'), 'utf8'), '');
});

test('Attempt rejects secret-like content', async () => {
  const root = await workingTask();
  const result = cli(['attempt', root, '--action', 'password=super-secret-value', '--outcome', 'success', '--tokens', '1', '--work', '1']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /secret is forbidden/);
});

test('malformed Ledger JSON fails', async () => {
  const root = await workingTask(); await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), '{bad json}\n');
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /malformed JSON/);
});

test('duplicate and unknown Ledger fields fail', async () => {
  const root = await workingTask();
  await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), '{"schema_version":1,"attempt":1,"attempt":2,"round":1,"timestamp":"2026-07-12T00:00:00.000Z","action":"valid action","outcome":"success","error_fingerprint":null,"tokens":1,"work_units":1}\n');
  let result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /duplicate field/);
  await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), '{"schema_version":1,"attempt":1,"round":1,"timestamp":"2026-07-12T00:00:00.000Z","action":"valid action","outcome":"success","error_fingerprint":null,"tokens":1,"work_units":1,"extra":true}\n');
  result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /Unrecognized key|unrecognized/i);
});

test('non-continuous Attempt and placeholder fingerprint fail', async () => {
  const root = await workingTask();
  await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), '{"schema_version":1,"attempt":2,"round":1,"timestamp":"2026-07-12T00:00:00.000Z","action":"valid action","outcome":"failure","error_fingerprint":"TBD","tokens":1,"work_units":1}\n');
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /continuous|placeholder/);
});

test('unknown Budget field fails', async () => {
  const root = await workingTask(); const budget = await readMd(path.join(root, 'BUDGET.md')); budget.data.mystery_limit = 1;
  await writeMd(path.join(root, 'BUDGET.md'), budget.data, budget.body);
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /Unrecognized key|unrecognized/i);
});

test('Run Log divergence fails', async () => {
  const root = await workingTask(); await writeFile(path.join(root, 'RUN_LOG.md'), '# forged log\n');
  const result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /diverges/);
});

test('Round may not move backwards or exceed current Round', async () => {
  const root = await workingTask();
  const base = (attempt, round) => ({ schema_version: 1, attempt, round, timestamp: '2026-07-12T00:00:00.000Z', action: `valid action ${attempt}`, outcome: 'success', error_fingerprint: null, tokens: 1, work_units: 1 });
  await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), `${JSON.stringify(base(1, 1))}\n${JSON.stringify(base(2, 2))}\n`);
  let result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /exceeds current Round/);
  await writeFile(path.join(root, 'LOOP_LEDGER.jsonl'), `${JSON.stringify(base(1, 1))}\n${JSON.stringify(base(2, 1))}\n${JSON.stringify(base(3, 0))}\n`);
  result = cli(['check', root]); assert.notEqual(result.code, 0); assert.match(result.stdout, /greater than|move backwards|Too small/i);
});

test('prepared multi-file transaction recovers before check', async () => {
  const root = await workingTask(); const tx = path.join(root, '.spec-loop-tx'); await mkdir(tx, { recursive: true });
  const writes = [];
  for (const [i, content] of ['first recovered file\n', 'second recovered file\n'].entries()) {
    const temp = path.join(tx, `manual-${i}.tmp`); const target = path.join(root, `RECOVERED-${i}.txt`); await writeFile(temp, content);
    writes.push({ target, temp, hash: createHash('sha256').update(content).digest('hex') });
  }
  await writeFile(path.join(tx, 'manual.json'), JSON.stringify({ id: 'manual', status: 'prepared', writes }));
  // check recovers the transaction first; later divergence is unrelated, so refresh derived projections.
  assert.equal(cli(['summary', root]).code, 0);
  const result = cli(['check', root]); assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(path.join(root, 'RECOVERED-0.txt'), 'utf8'), 'first recovered file\n');
  assert.equal(await readFile(path.join(root, 'RECOVERED-1.txt'), 'utf8'), 'second recovered file\n');
});
