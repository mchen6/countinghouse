'use strict';
// One deadline for an operation that calls back: lib/redis-resilient.js's
// clients and rate limiter, the nonce store, and the blob store use it. It
// makes no Redis client, so a part that bounds its calls takes it from here
// without naming a Redis module (test/store/02: one place makes clients).

// A promise of start(done)'s answer, or of onTimeout()'s error once ms have
// passed with none: exactly one, the other dropped. start may throw: that
// is its answer.
function withDeadline(ms, start, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, ms);
    if (typeof(timer.unref) === 'function') timer.unref();
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err != null) reject(err); else resolve(value);
    };
    try { start(done); } catch (e) { done(e); }
  });
}

module.exports = withDeadline;
