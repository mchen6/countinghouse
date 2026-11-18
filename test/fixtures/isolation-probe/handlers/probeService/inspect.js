// inspect.js -- one thing module code can see of the runtime, after the
// worker's lockdown (#194's PR 2, test/sandbox/68). Each step returns what it
// found, as text, so the test asserts it in both modes.
const path = require('path');
const util = require('util');
const ROOT = path.resolve(__dirname, '..', '..');
const insideRoot = (f) => typeof(f) === 'string' && (f === ROOT || f.startsWith(ROOT + path.sep));
const M = module.constructor;

// a runtime Module, from the test's probe (module code reaches none: A)
const handle = () => globalThis[Symbol.for('countinghouse.test.runtime')] || null;
const outcome = (fn) => { try { fn(); return 'loaded'; } catch (e) { return String(e.code || e.message); } };

const STEPS = {
  // P alone, and the net: a load with one of the runtime's Modules as its
  // parent, by every route module code has, and one with no parent at all
  netLoad: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => M._load('./settings-tool.js', h.module)); },
  netRequire: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => h.module.require('./settings-tool.js')); },
  netModuleLoad: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const file = path.join(path.dirname(h.module.filename), 'settings-tool.js');
    return outcome(() => { const m = new M(file, h.module); m.load(file); });
  },
  noParent: () => { const h = handle(); return h == null ? 'no handle' : outcome(() => M._load(path.join(path.dirname(h.module.filename), 'settings-tool.js'))); },
  // item 7: after the seal, what exists in the runtime's tree is no answer:
  // a runtime lib path, or a package only the runtime has, resolved from a
  // genuine runtime parent, a forged one, or createRequire on a runtime
  // file, fails as a missing file does
  resolveOracle: () => {
    const h = handle();
    if (h == null) return 'no handle';
    const lib = path.dirname(h.module.filename);
    const code = (fn) => { try { fn(); return 'found'; } catch (e) { return String(e.code); } };
    const forged = {__proto__: null, id: path.join(lib, 'logger.js'), filename: path.join(lib, 'logger.js'), paths: M._nodeModulePaths(lib)};
    return [
      code(() => M._resolveFilename('./no-such-isolation-file.js', h.module)),
      code(() => M._resolveFilename('./settings-tool.js', h.module)),
      code(() => M._resolveFilename('json-stringify-safe', h.module)),
      code(() => M._resolveFilename('json-stringify-safe', forged)),
      code(() => M.createRequire(path.join(lib, 'logger.js')).resolve('json-stringify-safe'))
    ].join(' ');
  },
  // interop, in both modes: the module's own files by every form
  interop: async () => {
    const out = [];
    out.push((await import('../../lib/own.cjs')).default.own);
    out.push(require('../../lib/own.mjs').own);
    out.push(require('module').createRequire(__filename)('../../lib/data.json').own);
    out.push(insideRoot(require.resolve('../../lib/data.json')) ? 'resolved' : 'outside');
    return out.join(' ');
  },
  // The window (Revision 4, test 4): while the runtime's late paths run (a
  // log line, a request, redis), every function object module code can
  // reach from a frame of the runtime's (a getter's .caller and its
  // .arguments, a thenable's, each CallSite's getFunction()), and a
  // Module.wrap set first: none yields a loader (a require, Module._load,
  // or anything with a resolve and a cache)
  window: async () => {
    const found = new Set();
    const loaderLike = (f) => typeof(f) === 'function' && (f === M._load || f === M.prototype.require
      || (typeof(f.resolve) === 'function' && f.cache != null) || f.name === 'require' || f.name === '_load');
    const look = (fn) => {
      try {
        const c = fn.caller;
        if (c != null) { found.add(`caller ${c.name}`); if (loaderLike(c)) found.add('LOADER via caller'); }
        const a = c != null ? c.arguments : null;
        if (a != null) for (const x of Array.from(a)) if (loaderLike(x)) found.add('LOADER via arguments');
      } catch (e) { /* strict: none */ }
      const prepare = Error.prepareStackTrace;
      try {
        Error.prepareStackTrace = (e, frames) => frames.map((f) => { try { return f.getFunction(); } catch (x) { return undefined; } });
        const fns = new Error().stack;
        if (Array.isArray(fns)) for (const f of fns) if (loaderLike(f)) found.add('LOADER via getFunction');
      } finally { Error.prepareStackTrace = prepare; }
    };
    const leaked = [];
    const wrapWas = M.wrap;
    try { M.wrap = (src) => `globalThis.__isolationLeak && globalThis.__isolationLeak(require, module);${wrapWas(src)}`; } catch (e) { /* refused */ }
    globalThis.__isolationLeak = (req, mod) => { if (mod != null && typeof(mod.filename) === 'string' && !insideRoot(mod.filename)) leaked.push(mod.filename); };
    const keys = ['isolationWindow', 'then'];
    for (const key of keys) {
      Object.defineProperty(Object.prototype, key, {configurable: true, get: function windowGetter() { look(windowGetter); return undefined; }});
    }
    try {
      await new Promise((resolve) => CHUtil.recordUsage('isolation-probe', 'window', 0, () => resolve()));
      await new Promise((resolve) => { try { CHUtil.request({url: 'http://isolation.example.invalid/', timeout: 500}, () => resolve()); } catch (e) { resolve(); } });
      await new Promise((resolve) => { try { CHUtil.redis.get('isolation-window', () => resolve()); } catch (e) { resolve(); } });
    } finally {
      for (const key of keys) delete Object.prototype[key];
      try { M.wrap = wrapWas; } catch (e) { /* refused */ }
      delete globalThis.__isolationLeak;
    }
    const loaders = [...found].filter((x) => x.startsWith('LOADER'));
    return `${loaders.length === 0 ? 'no loader' : loaders.join(' ')}, ${leaked.length === 0 ? 'nothing compiled' : `compiled: ${leaked.length}`}`;
  },
  // BroadcastChannel: gone under enforce, by either route; under audit it
  // stays (a message crosses to the peer module's worker) and is reported
  broadcast: () => {
    const global = typeof(globalThis.BroadcastChannel);
    let viaRequire;
    try { viaRequire = typeof(require('worker_threads').BroadcastChannel); } catch (e) { viaRequire = String(e.code); }
    if (global === 'function') {
      const c = new globalThis.BroadcastChannel('isolation-68');
      c.postMessage('hello');
      c.close();
    }
    return `${global} ${viaRequire}`;
  },
  // A: the require cache lists the module's own files only
  cacheFiles: () => {
    const outside = Object.keys(require.cache).filter((k) => !insideRoot(k));
    return outside.length === 0 ? 'module files only' : `outside: ${outside.length} ${outside.slice(0, 4).join(' ')}`;
  },
  // A: one cache, the module's and module.constructor's alike
  sameCache: () => (M._cache === require.cache ? 'same' : 'different'),
  // A: util.inspect reads the cache past anything a view could show: it
  // names no runtime file, and no Module of the runtime's reaches
  // inspect.custom (Revision 6, blocking 1)
  inspect: () => {
    const seen = [];
    const key = util.inspect.custom;
    Object.defineProperty(Object.prototype, key, {configurable: true, get() {
      if (this != null && typeof(this.filename) === 'string' && !insideRoot(this.filename)) seen.push(this.filename);
      return undefined;
    }});
    let text;
    try { text = util.inspect(require.cache, {depth: 1}); } finally { delete Object.prototype[key]; }
    const runtimeNamed = /[\\/]lib[\\/][a-z-]+\.js|node_modules/.test(text.replace(ROOT, ''));
    return `${runtimeNamed ? 'runtime named' : 'none named'}, ${seen.length === 0 ? 'no runtime Module' : `runtime Modules: ${seen.length}`}`;
  },
  // C: no main module, in either form
  main: () => `${require.main === undefined ? 'no require.main' : 'require.main'}, ${process.mainModule === undefined ? 'no mainModule' : 'mainModule'}`,
  // S: each loader static stays as it was (a replacement doesn't stick);
  // the ones the lockdown leaves to audit as reported accessors aside
  statics: () => {
    const keys = ['_cache', '_pathCache', '_nodeModulePaths', '_initPaths', '_findPath', '_resolveLookupPaths', '_stat', '_readPackage', 'findPackageJSON'];
    const stuck = [];
    for (const k of keys) {
      const was = M[k];
      const mark = typeof(was) === 'function' ? function() {} : {};
      try { M[k] = mark; } catch (e) { /* locked */ }
      try { Object.defineProperty(M, k, {value: mark}); } catch (e) { /* locked */ }
      if (M[k] === mark) stuck.push(k);
    }
    for (const k of ['require', '_compile']) {
      const mark = function() {};
      try { M.prototype[k] = mark; } catch (e) { /* locked */ }
      if (M.prototype[k] === mark) stuck.push(`prototype.${k}`);
    }
    const proto = M.prototype;
    try { M.prototype = {}; } catch (e) { /* locked */ }
    if (M.prototype !== proto) stuck.push('prototype');
    try { M._extensions['.isolation'] = function() {}; } catch (e) { /* locked */ }
    if (typeof(M._extensions['.isolation']) === 'function') stuck.push("_extensions['.isolation']");
    return stuck.length === 0 ? 'none replaced' : `replaced: ${stuck.join(' ')}`;
  },
  // S: an entry planted in Node's path cache reads as never there
  pathCache: () => {
    const key = `planted\0${ROOT}`;
    try { M._pathCache[key] = '/nowhere/planted.js'; } catch (e) { /* refused */ }
    return M._pathCache[key] === undefined ? 'empty' : 'planted';
  }
};

module.exports = async (input) => {
  const step = STEPS[input.step];
  if (step == null) return {output: {step: input.step, detail: 'no such step'}};
  let detail;
  try { detail = String(await step()); } catch (e) { detail = `threw: ${e.code || e.message}`; }
  return {output: {step: input.step, detail}};
};
