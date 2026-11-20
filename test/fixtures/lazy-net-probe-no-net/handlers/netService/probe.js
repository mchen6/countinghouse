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
  // a file outside its root the module requires itself under audit (one of
  // the runtime's, as the test's hand-over lists them): a late load the
  // runtime makes after it leaves it where it is
  if (input.what === 'requireOutside') {
    const files = (globalThis[Symbol.for('countinghouse.test.runtime')] || {}).files || [];
    const file = files.find((f) => /[\\/]lib[\\/]node-version\.js$/.test(f));
    try { require(file); } catch (e) { return resolve({output: {outside: [String(e.code)], count: -1}}); }
    return resolve({output: {outside: outside().slice(0, 5), count: outside().length}});
  }
  // Node's wrapper of a file's source, set by module code before the
  // runtime's late load: the lockdown opens no window for that load then
  if (input.what === 'patchWrap') {
    const M = module.constructor;
    const original = M.wrap;
    M.wrap = function(script) { globalThis.__chWrapRan = (globalThis.__chWrapRan || 0) + 1; return original(script); };
    return resolve({output: {patched: M.wrap !== original}});
  }
  // ... a Proxy in Module.wrapper's place, answering Node's own strings
  if (input.what === 'wrapperProxy') {
    const M = module.constructor;
    const original = M.wrapper;
    M.wrapper = new Proxy(original, {});
    return resolve({output: {patched: M.wrapper !== original}});
  }
  // ... or Module.wrap set from inside the runtime's late load, by a
  // module.require tracing subscriber, once the library's load has begun
  if (input.what === 'traceWrap') {
    const M = module.constructor;
    const original = M.wrap;
    let started = false;
    require('diagnostics_channel').tracingChannel('module.require').subscribe({
      start(msg) {
        if (msg != null && msg.id === 'postman-request') { started = true; return; }
        if (started && M.wrap === original) M.wrap = function(script) { return original(script); };
      },
      end() {}, asyncStart() {}, asyncEnd() {}, error() {}
    });
    return resolve({output: {patched: true}});
  }
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
