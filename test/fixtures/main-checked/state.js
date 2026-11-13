// Shared by the handler files (one require cache per worker): how many times
// take ran, and whether this worker's own validation has been turned off.
//
// tamper() turns it off where module code can reach it: in a worker, under
// the default module sandbox (audit) and with none (off), the runtime's own
// files are in require.cache, and this replaces the worker's
// Service.prototype.validateActionCall and the validator's validate with
// ones that accept anything. On the main thread (single-thread mode) it does
// nothing: it would turn off the whole server's validation.
const path = require('path');
const state = {takes: 0, tampered: false};

state.tamper = function() {
  if (require('worker_threads').isMainThread) return false;
  const find = (tail) => Object.keys(require.cache).find((p) => p.endsWith(`${path.sep}lib${path.sep}${tail}`));
  const service = find('service.js');
  const validator = find('validator.js');
  if (service == null || validator == null) return false;
  require.cache[service].exports.prototype.validateActionCall = function(action, args, isInput, callback) {
    return callback(null, null);
  };
  require.cache[validator].exports.validate = function(name, schemaObj, data, callback) {
    return callback(null, null);
  };
  state.tampered = true;
  return true;
};

module.exports = state;
