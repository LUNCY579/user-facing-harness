'use strict';

// Sum the integers from start to end, inclusive.
// NOTE: the loop below is the planted bug for demo task T2. It stops
// one short of `end`, so sumRange(1, 3) returns 3 instead of 6.
function sumRange(start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += i;
  }
  return total;
}

// Format a user-supplied name for display. This function performs no
// validation of its own: whatever string it is given is formatted as-is.
// (Demo task T4 adds validation around names; task T8 renames this
// function everywhere, including docs and tests.)
function formatUser(name) {
  return `User: ${name}`;
}

module.exports = { sumRange, formatUser };
