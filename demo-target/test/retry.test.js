'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { retry } = require('../src/retry');

test('retry succeeds after transient failures', () => {
  let calls = 0;
  const result = retry(() => {
    calls += 1;
    if (calls < 3) throw new Error('not yet');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retry rethrows after all attempts are exhausted', () => {
  assert.throws(() => retry(() => { throw new Error('always'); }, 2), /always/);
});
