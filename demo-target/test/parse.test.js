'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/parse');

// Pristine coverage is the valid path only. Demo task T6 is to write
// tests for the three error paths (empty input, malformed header,
// truncated body); those tests do not exist yet, on purpose.
test('parse returns version and body for a well-formed input', () => {
  assert.deepEqual(parse('HDR:2\nhello'), { version: 2, body: 'hello' });
});

test('parse keeps multi-line bodies intact', () => {
  assert.deepEqual(parse('HDR:1\nline one\nline two'), {
    version: 1,
    body: 'line one\nline two',
  });
});
