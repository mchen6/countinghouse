'use strict';
// A test file's own cli-options, set in its before() and the process's put
// back in its after() (B-loadopts): never at load time. A folder run
// (CI's per-folder mocha, the master walk over test/mcp-contract/*.js)
// requires every file before any test, so options set at load were whatever
// the last file loaded asked for, in every other file's tests -- mcp-contract
// 09 saw workerThread on from 21's setOptions (B-golden09).
//
// snapshot() in a describe's before(), before its setOptions; restore(kept)
// at the end of its after(): every option back as it was, by its property
// descriptor (apiKey, which setOptions defines read-only and unlisted in the
// single-identity profile, included): one setOptions gave goes, one it
// changed or removed comes back.
const options = require('../../lib/cli-options');

const isOption = (d) => !('value' in d) || typeof(d.value) !== 'function';
const snapshot = () => {
  const kept = {};
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(options))) if (isOption(d)) kept[k] = d;
  return kept;
};
function restore(kept) {
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(options))) {
    if (isOption(d) && !(k in kept) && d.configurable) delete options[k];
  }
  for (const [k, d] of Object.entries(kept)) {
    const now = Object.getOwnPropertyDescriptor(options, k);
    if (now != null && !now.configurable) continue;
    Object.defineProperty(options, k, d);
  }
}

module.exports = {snapshot, restore};
