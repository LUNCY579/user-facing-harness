'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sumRange, formatUser } = require('../src/util');

// This test exposes the planted off-by-one in sumRange (demo task T2):
// it fails on the pristine snapshot and passes once the loop is fixed.
test('sumRange sums start through end, inclusive', () => {
  assert.equal(sumRange(1, 3), 6);
  assert.equal(sumRange(5, 5), 5);
});

test('formatUser formats a name for display', () => {
  assert.equal(formatUser('Ada'), 'User: Ada');
});
