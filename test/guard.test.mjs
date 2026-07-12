import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../dist/runtime.js';

const budget = { schema_version: 1, max_attempts: 4, max_consecutive_failures: 3, max_repeated_error: 2, max_no_progress: 2, max_tokens: 100, max_work_units: 10 };
const attempt = (n, outcome, fp = null, tokens = 1) => ({ schema_version: 1, attempt: n, round: 1, timestamp: new Date().toISOString(), action: `action ${n}`, outcome, error_fingerprint: fp, tokens, work_units: 1 });

test('guard continues within limits', () => assert.equal(guard(budget, [attempt(1, 'success')]).decision, 'continue'));
test('guard stops on absolute attempt budget', () => assert.equal(guard(budget, [1,2,3,4].map((n) => attempt(n, 'success'))).decision, 'stop'));
test('guard requests user on repeated error', () => assert.equal(guard(budget, [attempt(1, 'failure', 'compile-error'), attempt(2, 'failure', 'compile-error')]).decision, 'needs_user'));
test('guard requests user on no progress', () => assert.equal(guard(budget, [attempt(1, 'no_progress', 'blocked-one'), attempt(2, 'no_progress', 'blocked-two')]).decision, 'needs_user'));
test('guard stops on token budget', () => assert.equal(guard(budget, [attempt(1, 'success', null, 100)]).decision, 'stop'));

