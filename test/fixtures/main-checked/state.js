// Shared by the handler files (one require cache per worker): how many times
// take ran, and whether this worker's own validation has been turned off.
//
// tamper() turns it off where module code can reach it: in a worker whose
// require.cache holds the runtime's Service and validator, it replaces
// Service.prototype.validateActionCall and the validator's validate with
// ones that accept anything. A lean worker holds neither (lean worker step
// 3: its input and output are checked on the main thread), so it finds
// nothing and says so. On the main thread (single-thread mode) it does
// nothing: it would turn off the whole server's validation.
// (the runtime's modules as require.cache held them before the lockdown,
// from the test's probe: since #194's PR 2 module code's own require.cache
// holds its own files only, lib/lean-worker.js)
const runtimeCache = (globalThis[Symbol.for('countinghouse.test.runtime')] || {}).modules || require.cache;
const path = require('path');
const state = {takes: 0, tampered: false};

state.tamper = function() {
  if (require('worker_threads').isMainThread) return false;
  const find = (tail) => Object.keys(runtimeCache).find((p) => p.endsWith(`${path.sep}lib${path.sep}${tail}`));
  const service = find('service.js');
  const validator = find('validator.js');
  if (service == null || validator == null) return false;
  runtimeCache[service].exports.prototype.validateActionCall = function(action, args, isInput, callback) {
    return callback(null, null);
  };
  runtimeCache[validator].exports.validate = function(name, schemaObj, data, callback) {
    return callback(null, null);
  };
  state.tampered = true;
  return true;
};

module.exports = state;
