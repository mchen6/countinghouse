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
  // a refused request with no callback answers a Request-like object: its
  // 'error' listener gets the refusal, and .pipe() does not throw (the
  // register's "post-rel request refusal shape", from #425)
  if (input.what === 'streamRefused') {
    let req;
    try { req = CHUtil.request({url: input.url, timeout: 5000}); } catch (e) { return resolve({output: {outcome: 'threw', message: String(e.message).slice(0, 200)}}); }
    const shape = {object: req != null && typeof(req) === 'object', on: req != null && typeof(req.on) === 'function', pipe: req != null && typeof(req.pipe) === 'function'};
    if (!shape.object || !shape.on || !shape.pipe) return resolve({output: {outcome: 'no-request', shape}});
    let piped = null;
    try { piped = req.pipe({}) != null; } catch (e) { return resolve({output: {outcome: 'pipe-threw', message: String(e.message).slice(0, 200), shape}}); }
    const timer = setTimeout(() => resolve({output: {outcome: 'no-error', shape, piped}}), 3000);
    req.on('error', (err) => { clearTimeout(timer); resolve({output: {outcome: 'error', code: err.code != null ? String(err.code) : null, shape, piped}}); });
    return undefined;
  }
  return CHUtil.request({url: input.url, timeout: 5000}, (err, res, body) => resolve({output: Object.assign(
    err != null ? failed(err) : {outcome: 'ok', status: res.statusCode, body: String(body)}, {loaded: loaded()})}));
});
