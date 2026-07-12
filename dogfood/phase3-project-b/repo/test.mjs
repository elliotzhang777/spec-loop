import assert from 'node:assert/strict';
import { status } from './status.mjs';
assert.equal(status(), 'ready');
console.log('project-b tests passed');
