// Requires one builtin the sandbox's allowlist refuses, either directly or
// through the require of a countinghouse lib/ Module object taken from
// require.cache, and reports what happened. test/auth/44 compares the two.
module.exports = async (input) => {
  let owner = null;
  let req = require;
  if (input.via === 'cache') {
    owner = Object.keys(require.cache).find((k) => /\/lib\/cli-options\.js$/.test(k)) || null;
    if (owner == null) return {output: {outcome: 'no-owner', code: null, owner: null, fsBridge: null}};
    req = (name) => require.cache[owner].require(name);
  }
  try {
    const m = req(input.what);
    const fsBridge = input.what === 'worker_threads' ? (m.workerData != null && m.workerData.fsBridge != null) : null;
    return {output: {outcome: 'loaded', code: null, owner: owner == null ? null : 'lib/cli-options.js', fsBridge}};
  } catch (e) {
    return {output: {outcome: 'refused', code: (e && e.code != null) ? String(e.code) : null,
      owner: owner == null ? null : 'lib/cli-options.js', fsBridge: null}};
  }
};
