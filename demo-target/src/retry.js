'use strict';

// Call `fn` until it succeeds, or until maxAttempts attempts have been
// made. Returns the first successful result; if every attempt throws,
// rethrows the last error. The retry loop in this file is deliberately
// duplicated in src/fetch.js (demo task T5 extracts it into a shared
// helper both modules use).
function retry(fn, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return fn(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { retry };
