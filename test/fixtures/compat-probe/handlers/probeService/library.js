// library.js -- uses one loader-related library the way its dependents do,
// and says whether it works (test/sandbox/69, the compatibility table in
// docs/security-model.md). Each library is in the module's own
// node_modules, copied there by the test from the repo's devDependencies.
// (each as its dependents call it: from __dirname, or a name relative to
// the calling file; a module's __dirname is virtual, /app/..., in every
// mode)
const path = require('path');
// (a throw is said by its code, or its name: never a message)
const said = (e) => `threw ${e != null && e.code != null ? String(e.code) : (e != null && e.name != null ? String(e.name) : typeof(e))}`;
// (what a module's own code does to the process-wide warning and error
// switches: under enforce some are held, the high review of #451, items 8
// and 9; each step puts back what it changed where it could)
const process_ = process;
const swap = (target, key, fn) => {
  const was = Object.getOwnPropertyDescriptor(target, key);
  const value = target[key];
  try { return fn(); } finally {
    // (redefined where it can be; otherwise assigned back -- the held
    // emitWarning's setter takes its own wrapper, restoring Node's)
    if (was != null && was.configurable) Object.defineProperty(target, key, was);
    else { try { target[key] = value; } catch (e) { /* fixed */ } }
  }
};
const STEPS = {
  'emitWarning assigned': () => swap(process_, 'emitWarning', () => {
    let heard = null;
    process_.emitWarning = (w) => { heard = String(w); };
    process_.emitWarning('probe');
    return heard === 'probe' ? 'works' : `heard ${heard}`;
  }),
  'emitWarning = null': () => swap(process_, 'emitWarning', () => {
    process_.emitWarning = null;
    try { process_.emitWarning('probe'); return 'warnings off'; } catch (e) { return said(e); }
  }),
  'emitWarning redefined': () => swap(process_, 'emitWarning', () => {
    try { Object.defineProperty(process_, 'emitWarning', {value: () => {}, configurable: true, writable: true}); return 'works'; } catch (e) { return said(e); }
  }),
  'Error.stackTraceLimit redefined': () => swap(Error, 'stackTraceLimit', () => {
    try { Object.defineProperty(Error, 'stackTraceLimit', {value: 5, configurable: true, writable: true}); return 'works'; } catch (e) { return said(e); }
  }),
  'Error.stackTraceLimit assigned': () => swap(Error, 'stackTraceLimit', () => {
    Error.stackTraceLimit = 3;
    return Error.stackTraceLimit === 3 ? 'works' : 'not set';
  }),
  'process.noDeprecation getter': () => swap(process_, 'noDeprecation', () => {
    try { Object.defineProperty(process_, 'noDeprecation', {get: () => false, configurable: true}); return 'works'; } catch (e) { return said(e); }
  }),
  'process.env replaced': () => swap(process_, 'env', () => {
    const was = process_.env;
    try { process_.env = Object.assign({}, was); } catch (e) { return said(e); }
    return process_.env !== was ? 'works' : 'not replaced';
  }),
  'process.send set': () => swap(process_, 'send', () => {
    try { process_.send = () => {}; } catch (e) { return said(e); }
    return typeof(process_.send) === 'function' ? 'works' : 'not set';
  }),
  // resolves a request from a directory, through a Module of its own
  'resolve-from': () => {
    const found = require('resolve-from')(__dirname, '../../lib/target');
    return /[\\/]target\.js$/.test(found) ? 'works' : 'answered another file';
  },
  // (C-compat, items 4 and 5: Node's own entry points, asked directly with
  // a relative request from the module's own, virtual, file -- the nearest
  // package.json, and the file a relative require names)
  'findPackageJSON relative': () => {
    const find = require('module').findPackageJSON;
    if (typeof(find) !== 'function') return 'works';
    const found = find('../../lib/target.js', path.join(__dirname, 'library.js'));
    return typeof(found) === 'string' && path.basename(found) === 'package.json' ? 'works' : `answered ${typeof(found) === 'string' ? 'another file' : String(found)}`;
  },
  '_resolveFilename relative': () => {
    const file = path.join(__dirname, 'library.js');
    const found = require('module')._resolveFilename('../../lib/target', {id: file, filename: file, paths: []});
    return /[\\/]target\.js$/.test(found) ? 'works' : 'answered another file';
  },
  // deletes a file's require.cache entry and requires it again
  'import-fresh': () => {
    const fresh = require('import-fresh');
    const a = fresh('../../lib/counter.js');
    a();
    const b = fresh('../../lib/counter.js');
    return a !== b && b() === 1 ? 'works' : 'a cached copy';
  },
  // stack traces through source maps: Error.prepareStackTrace only
  'source-map-support': () => {
    require('source-map-support').install({hookRequire: false});
    return typeof(Error.prepareStackTrace) === 'function' ? 'works' : 'not installed';
  },
  // ... and its hook of every compiled file (Module.prototype._compile)
  'source-map-support hookRequire': () => {
    const M = module.constructor;
    const was = M.prototype._compile;
    require('source-map-support').install({hookRequire: true});
    return M.prototype._compile !== was ? 'works' : 'no hook';
  },
  // an alias of a directory, by replacing Module._resolveFilename
  'module-alias': () => {
    require('module-alias').addAlias('@compat', path.join(__dirname, '..', '..', 'lib'));
    try { return require('@compat/target').name === 'target' ? 'works' : 'answered another file'; } catch (e) { return `no alias (${said(e)})`; }
  },
  // a hook on what each require returns, by replacing Module.prototype.require
  'require-in-the-middle': () => {
    const {Hook} = require('require-in-the-middle');
    let seen = false;
    const hook = new Hook(['os'], (exports) => { seen = true; return exports; });
    try {
      require('os');
      return seen ? 'works' : 'no hook';
    } finally {
      try { hook.unhook(); } catch (e) { /* as it is */ }
    }
  }
};

module.exports = async (input) => {
  let outcome;
  try { outcome = STEPS[input.name](); } catch (e) { outcome = said(e); }
  return {output: {name: input.name, outcome}};
};
