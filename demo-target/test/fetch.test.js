'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithRetry } = require('../src/fetch');

test('fetchWithRetry succeeds after transient failures', () => {
  let calls = 0;
  const result = fetchWithRetry(() => {
    calls += 1;
    if (calls < 2) throw new Error('not yet');
    return 'data';
  });
  assert.equal(result, 'data');
  assert.equal(calls, 2);
});

test('fetchWithRetry rethrows after all attempts are exhausted', () => {
  assert.throws(
    () => fetchWithRetry(() => { throw new Error('always'); }, 2),
    /always/,
  );
});
