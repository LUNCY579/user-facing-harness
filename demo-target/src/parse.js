'use strict';

// Parse a small text format:
//
//   HDR:<number>\n<body>
//
// The first line is the header. Everything after it is the body.
// Error paths, each with its own message:
//   - empty input:          "parse: input must not be empty"
//   - malformed header:     "parse: malformed header: expected HDR:<number> as first line"
//   - truncated body:       "parse: truncated body: header present but body missing"
function parse(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('parse: input must not be empty');
  }
  const lines = input.split('\n');
  const header = lines[0];
  const match = /^HDR:(\d+)$/.exec(header);
  if (!match) {
    throw new Error('parse: malformed header: expected HDR:<number> as first line');
  }
  const body = lines.slice(1).join('\n');
  if (body.length === 0) {
    throw new Error('parse: truncated body: header present but body missing');
  }
  return { version: Number(match[1]), body };
}

module.exports = { parse };
