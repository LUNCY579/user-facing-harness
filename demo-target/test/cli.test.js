'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { greet, helpText } = require('../src/cli');

test('greet formats a normal name', () => {
  assert.equal(greet('Ada'), 'User: Ada');
});

// Pristine help mentions no --json flag (demo task T3 adds it) and no
// name validation (demo task T4 adds it); those behaviours are
// deliberately untested here so the tasks have something to add.
test('help lists the greet command', () => {
  assert.match(helpText(), /greet <name>/);
});
