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

module.exports = (input) => new Promise((resolve) => {
  if (input.what === 'loaded') return resolve({output: {loaded: loaded()}});
  return CHUtil.request({url: input.url, timeout: 5000}, (err, res, body) => resolve({output: Object.assign(
    err != null ? failed(err) : {outcome: 'ok', status: res.statusCode, body: String(body)}, {loaded: loaded()})}));
});
