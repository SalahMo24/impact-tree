'use strict';

// Provider commands cannot be cancelled. Bound the wait and observe both eventual
// outcomes; a late result never reaches the caller and a late rejection is handled.
function withDeadline(start, timeoutMs, label) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error(`${label} timed out`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve().then(start).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); });
  });
}

module.exports = { withDeadline };
