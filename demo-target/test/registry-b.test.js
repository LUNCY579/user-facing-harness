'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { current } = require('../src/registry');

// Second half of the demo task T7 pair: this file assumes a fresh
// registry. It passes on its own (after a reset, when no state file
// exists) and fails in the full suite, because registry-a.test.js has
// already written state to the same on-disk file. The full suite runs
// with --test-concurrency=1 (see package.json) so file order is
// deterministic: registry-a before registry-b.
test('registry starts empty', () => {
  assert.deepEqual(current().seen, []);
});
