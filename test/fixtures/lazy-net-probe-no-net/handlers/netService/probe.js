// CHUtil's HTTP helper (test/sandbox/40 and 09): whether its
// library is in this worker yet, and one call through it.
// (the runtime's modules as require.cache held them before the lockdown,
// from the test's probe: since #194's PR 2 module code's own require.cache
// holds its own files only, lib/lean-worker.js)
const runtimeCache = (globalThis[Symbol.for('countinghouse.test.runtime')] || {}).modules || require.cache;
const loaded = () => ({
  // (loaded before the lockdown: in the probe's list; after it, under
  // audit: in require.cache, where Node puts it)
  request: [...Object.keys(runtimeCache), ...Object.keys(require.cache)].some((k) => /[\\/]node_modules[\\/]postman-request[\\/]/.test(k))
});
const failed = (err) => ({outcome: 'error', code: err.code != null ? String(err.code) : null, message: String(err.message).slice(0, 300)});

// what of the runtime's module code's require.cache holds: any entry
// outside the module's own root (/app; X:\app on Windows) after a late
// load the runtime made under audit (the review of e0f39de9: moved out, so
// no Module of it is a parent module code can load through)
const outside = () => Object.keys(require.cache).filter((k) => !/^(\/app\/|[A-Z]:\\app\\)/.test(k));

module.exports = (input) => new Promise((resolve) => {
  if (input.what === 'loaded') return resolve({output: {loaded: loaded()}});
  if (input.what === 'outside') return resolve({output: {outside: outside().slice(0, 5), count: outside().length}});
  // Node's wrapper of a file's source, set by module code before the
  // runtime's late load: the lockdown opens no window for that load then
  if (input.what === 'patchWrap') {
    const M = module.constructor;
    const original = M.wrap;
    M.wrap = function(script) { globalThis.__chWrapRan = (globalThis.__chWrapRan || 0) + 1; return original(script); };
    return resolve({output: {patched: M.wrap !== original}});
  }
  return CHUtil.request({url: input.url, timeout: 5000}, (err, res, body) => resolve({output: Object.assign(
    err != null ? failed(err) : {outcome: 'ok', status: res.statusCode, body: String(body)}, {loaded: loaded()})}));
});
