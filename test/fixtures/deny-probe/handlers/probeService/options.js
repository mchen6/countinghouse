// options.js -- what the worker's cli-options holds, through require.cache
// (module code shares the worker's realm): never the values, only whether
// redisUrl and dbUrl are there.
// (the runtime's modules as require.cache held them before the lockdown,
// from the test's probe: since #194's PR 2 module code's own require.cache
// holds its own files only, lib/lean-worker.js)
const runtimeCache = (globalThis[Symbol.for('countinghouse.test.runtime')] || {}).modules || require.cache;
module.exports = async () => {
  const key = Object.keys(runtimeCache).find((f) => /[\\/]cli-options\.js$/.test(f));
  const o = key != null ? runtimeCache[key].exports : null;
  return {output: {found: o != null, hasRedisUrl: o != null && o.redisUrl != null, hasDbUrl: o != null && o.dbUrl != null}};
};
