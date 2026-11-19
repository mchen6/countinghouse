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
const STEPS = {
  // resolves a request from a directory, through a Module of its own
  'resolve-from': () => {
    const found = require('resolve-from')(__dirname, '../../lib/target');
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
