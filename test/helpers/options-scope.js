'use strict';
// A test file's own cli-options, set in its before() and the process's put
// back in its after() (B-loadopts): never at load time. A folder run
// (CI's per-folder mocha, the master walk over test/mcp-contract/*.js)
// requires every file before any test, so options set at load were whatever
// the last file loaded asked for, in every other file's tests -- mcp-contract
// 09 saw workerThread on from 21's setOptions (B-golden09).
//
// snapshot() in a describe's before(), before its setOptions; restore(kept)
// at the end of its after(): every option back as it was (one setOptions
// gave, one it didn't).
const options = require('../../lib/cli-options');

const snapshot = () => {
  const kept = {};
  for (const k of Object.keys(options)) if (typeof(options[k]) !== 'function') kept[k] = options[k];
  return kept;
};
function restore(kept) {
  for (const k of Object.keys(options)) if (typeof(options[k]) !== 'function' && !(k in kept)) delete options[k];
  Object.assign(options, kept);
}

module.exports = {snapshot, restore};
