import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cli, tempRoot, fillContracts, fillRound, fillDelivery, artifact } from './helpers.mjs';

test('Standard dogfood reaches delivered with runtime evidence', async () => {
  const root = await tempRoot('standard-dogfood-'); const id = 'TASK-STANDARD';
  assert.equal(cli(['init', root, '--level', 'standard', '--id', id, '--title', 'Standard dogfood']).code, 0);
  await fillContracts(root, { id, title: 'Standard dogfood', level: 'standard' });
  assert.equal(cli(['plan', root]).code, 0);
  assert.equal(cli(['runtime-init', root]).code, 0);
  assert.equal(cli(['round', root]).code, 0);
  await fillRound(root, 1);
  assert.equal(cli(['attempt', root, '--action', 'implemented standard fixture', '--outcome', 'success', '--tokens', '1200', '--work', '2']).code, 0);
  const proof = await artifact(root, 'standard-proof.txt');
  assert.equal(cli(['verify', root, '--result', 'pass', '--evidence', proof, '--verifier', 'standard-verifier', '--independent', '--revision', 'standard-r1']).code, 0);
  await fillDelivery(root, { id, round: 1, revision: 'standard-r1', evidenceId: 'EV-1' });
  assert.equal(cli(['deliver', root]).code, 0);
  const status = cli(['status', root, '--json']); assert.equal(status.code, 0); assert.equal(JSON.parse(status.stdout).status, 'delivered');
  const check = cli(['check', root, '--json']); assert.equal(check.code, 0, check.stderr + check.stdout); assert.equal(JSON.parse(check.stdout).ok, true);
});

test('Heavy dogfood performs two rounds and independent human acceptance', async () => {
  const root = await tempRoot('heavy-dogfood-'); const id = 'TASK-HEAVY';
  assert.equal(cli(['init', root, '--level', 'heavy', '--id', id, '--title', 'Heavy dogfood']).code, 0);
  await fillContracts(root, { id, title: 'Heavy dogfood', level: 'heavy' });
  assert.equal(cli(['plan', root]).code, 0); assert.equal(cli(['runtime-init', root]).code, 0); assert.equal(cli(['round', root]).code, 0);
  await fillRound(root, 1);
  assert.equal(cli(['attempt', root, '--action', 'first heavy implementation', '--outcome', 'failure', '--error', 'missing-boundary-case', '--tokens', '1800', '--work', '3']).code, 0);
  const failed = await artifact(root, 'heavy-fail.txt', 'boundary case failed\n');
  assert.equal(cli(['verify', root, '--result', 'fail', '--evidence', failed, '--verifier', 'independent-heavy-verifier', '--independent', '--human-check', '--revision', 'heavy-r1']).code, 0);
  assert.equal(cli(['guard', root]).code, 0);
  assert.equal(cli(['round', root]).code, 0);
  await fillRound(root, 2);
  assert.equal(cli(['attempt', root, '--action', 'fixed boundary case from independent review', '--outcome', 'success', '--tokens', '1600', '--work', '2']).code, 0);
  const passed = await artifact(root, 'heavy-pass.txt');
  assert.equal(cli(['verify', root, '--result', 'pass', '--evidence', passed, '--verifier', 'independent-heavy-verifier', '--independent', '--human-check', '--revision', 'heavy-r2']).code, 0);
  await fillDelivery(root, { id, round: 2, revision: 'heavy-r2', evidenceId: 'EV-2' });
  assert.equal(cli(['deliver', root]).code, 0);
  const check = cli(['check', root, '--json']); assert.equal(check.code, 0, check.stderr + check.stdout); assert.equal(JSON.parse(check.stdout).ok, true);
});

test('Heavy pass rejects missing human check', async () => {
  const root = await tempRoot(); const id = 'TASK-HUMAN';
  cli(['init', root, '--level', 'heavy', '--id', id, '--title', 'Human gate']); await fillContracts(root, { id, title: 'Human gate', level: 'heavy' });
  cli(['plan', root]); cli(['round', root]); await fillRound(root, 1); const proof = await artifact(root, 'proof.txt');
  const result = cli(['verify', root, '--result', 'pass', '--evidence', proof, '--verifier', 'other-agent', '--independent', '--revision', 'r1']);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /human check/);
});

test('Delivery rejects incomplete AC mapping', async () => {
  const root = await tempRoot(); const id = 'TASK-INCOMPLETE';
  cli(['init', root, '--level', 'standard', '--id', id, '--title', 'Incomplete delivery']); await fillContracts(root, { id, title: 'Incomplete delivery', level: 'standard' });
  cli(['plan', root]); cli(['round', root]); await fillRound(root, 1); const proof = await artifact(root, 'proof.txt');
  cli(['verify', root, '--result', 'pass', '--evidence', proof, '--verifier', 'reviewer', '--independent', '--revision', 'r1']);
  await fillDelivery(root, { id, round: 1, revision: 'r1', evidenceId: 'EV-1', criteriaCount: 1 });
  const result = cli(['deliver', root]); assert.notEqual(result.code, 0); assert.match(result.stderr, /AC-2: missing/);
});
