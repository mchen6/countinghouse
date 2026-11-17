'use strict';
// Identity checks on big objects: a validator pool, its slots, workers,
// requests. assert.strictEqual (and its kin) on two objects renders and
// diffs both when it fails (util.inspect, then a Myers diff of the whole
// graph). On a pool's slot, which holds its requests and so a check's
// 20,000-item input, one such failure took 3+ GB and the main thread for
// minutes, and lost CI runners (#344). These compare by reference and,
// failing, name what they saw in a few words; test/validation/22 keeps the
// big-object forms out of the pool's tests.
const assert = require('assert');

// a few words for an object: its kind and, where it has one, its worker's id
function label(x) {
  if (x == null || (typeof(x) !== 'object' && typeof(x) !== 'function')) return String(x);
  const kind = (x.constructor != null && x.constructor.name) ? x.constructor.name : typeof(x);
  const worker = (x.worker != null && x.worker.threadId != null) ? ` with worker ${x.worker.threadId}` : (x.threadId != null ? ` ${x.threadId}` : '');
  return `${kind}${worker}`;
}

function sameRef(actual, expected, message) {
  assert.ok(actual === expected, `${message} (got ${label(actual)}, not ${label(expected)})`);
}

function notSameRef(actual, other, message) {
  assert.ok(actual !== other, `${message} (still the same ${label(actual)})`);
}

module.exports = {sameRef, notSameRef, label};
