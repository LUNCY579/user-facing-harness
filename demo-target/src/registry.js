'use strict';

const fs = require('node:fs');
const path = require('node:path');

// A tiny event registry backed by a file on disk. This is the shared
// state behind demo task T7: `record` appends to a JSON file in the
// project root, and nothing ever clears that file. A test that assumes
// a fresh registry therefore passes on its own (after a reset, when no
// state file exists) and fails when the full suite runs, because an
// earlier test file has already written state to the same file.
// The state file is intentionally NOT gitignored: the demo reset rule
// (`git checkout -- . && git clean -fd`) must be able to remove it.
const STATE_FILE = path.join(__dirname, '..', '.demo-registry.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seen: [] };
  }
}

function record(name) {
  const state = load();
  state.seen.push(name);
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state)}\n`);
  return state;
}

function current() {
  return load();
}

module.exports = { record, current, STATE_FILE };
