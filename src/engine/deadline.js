'use strict';
const { realClock } = require('./clock');

// Provider commands cannot be cancelled. Bound the wait and observe both eventual
// outcomes; a late result never reaches the caller and a late rejection is handled.
// `clock` (src/engine/clock.js) times the deadline.
function withDeadline(start, timeoutMs, label, clock = realClock) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error(`${label} timed out`));
  return new Promise((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    Promise.resolve().then(start).then(
      value => { clock.clearTimeout(timer); resolve(value); },
      error => { clock.clearTimeout(timer); reject(error); });
  });
}

module.exports = { withDeadline };
