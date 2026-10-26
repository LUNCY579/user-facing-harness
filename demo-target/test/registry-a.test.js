'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { record } = require('../src/registry');

// First half of the demo task T7 pair: this file writes registry state
// to disk (via src/registry.js) and never cleans it up. It passes on
// its own and in the full suite; the failure it causes lands in
// registry-b.test.js, which runs after it.
test('registry records an event', () => {
  const state = record('alpha');
  assert.ok(state.seen.includes('alpha'));
});
