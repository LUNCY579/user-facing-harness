'use strict';

// Fetch data through `getData`, retrying until it succeeds or until
// maxAttempts attempts have been made. This loop is a verbatim duplicate
// of the retry loop in src/retry.js (demo task T5 extracts it into a
// shared helper both modules use, with no behaviour change).
function fetchWithRetry(getData, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return getData(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = { fetchWithRetry };
