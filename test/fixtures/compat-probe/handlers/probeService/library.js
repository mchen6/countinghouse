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
  // (diagnostic, the throwaway Windows branch only: what resolve-from hands
  // Node from a Windows worker, and what Node answers)
  'win-diag': () => {
    const M = module.constructor;
    const out = {dirname: __dirname, filename: __filename, cwd: process.cwd()};
    const fromFile = path.join(__dirname, 'noop.js');
    out.fromFile = fromFile;
    const at = (k, fn) => { try { out[k] = fn(); } catch (e) { out[k] = `threw ${e.code || e.name}: ${String(e.message).slice(0, 300)}`; } };
    at('nodeModulePaths', () => M._nodeModulePaths(__dirname).slice(0, 4));
    at('targetExists', () => require('fs').existsSync(path.join(__dirname, '..', '..', 'lib', 'target.js')));
    at('resolveFilename', () => M._resolveFilename('../../lib/target', {id: fromFile, filename: fromFile, paths: M._nodeModulePaths(__dirname)}));
    at('resolveFrom', () => require('resolve-from')(__dirname, '../../lib/target'));
    at('createRequire', () => M.createRequire(fromFile).resolve('../../lib/target'));
    at('requireResolve', () => require.resolve('../../lib/target'));
    at('pathResolve', () => path.resolve(__dirname, '../../lib/target'));
    const fs = require('fs');
    at('realpathSync', () => fs.realpathSync(__dirname));
    at('realpathSyncNative', () => fs.realpathSync.native(__dirname));
    at('realpathSyncFile', () => fs.realpathSync(__filename));
    at('realpathSyncSlash', () => fs.realpathSync(__dirname.replace(/\\/g, '/')));
    return JSON.stringify(out);
  },
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
    if (typeof(find) !== 'function') return 'not in module';
    const found = find('../../lib/target.js', path.join(__dirname, 'library.js'));
    // (the module's own package.json exactly as the module names it, by its
    // __dirname; its host path is told apart, as single-thread mode
    // answers; never the one planted beside the module -- not read back:
    // single-thread mode's fs maps /tmp, where the test's directory may be)
    if (found === path.join(path.dirname(path.dirname(__dirname)), 'package.json')) return 'works';
    if (typeof(found) === 'string' && /[\\/]ch-sb-69-[^\\/]+[\\/]compat-probe[\\/]package\.json$/.test(found)) return 'works (host path)';
    return `answered ${typeof(found) === 'string' ? 'another file' : String(found)}`;
  },
  // (the module's own directory as the base, with its trailing separator,
  // and the module's root itself)
  'findPackageJSON directory base': () => {
    const find = require('module').findPackageJSON;
    if (typeof(find) !== 'function') return 'not in module';
    const own = (f) => typeof(f) === 'string' && path.basename(f) === 'package.json';
    const a = find('./', `${__dirname}${path.sep}`);
    const b = find('./', `${path.dirname(path.dirname(__dirname))}${path.sep}`);
    return own(a) && own(b) && a === b ? 'works' : `answered ${String(a)} ${String(b)}`;
  },
  // (an absolute request built from __dirname, as import-fresh and
  // resolve-from's callers often pass one)
  'import-fresh absolute': () => {
    const fresh = require('import-fresh');
    const a = fresh(path.join(__dirname, '..', '..', 'lib', 'counter.js'));
    a();
    const b = fresh(path.join(__dirname, '..', '..', 'lib', 'counter.js'));
    return a !== b && b() === 1 ? 'works' : 'a cached copy';
  },
  // (answered by the virtual name in a worker, a host path only in
  // single-thread mode; and a missing one named as it was asked, never by
  // a host path)
  'resolve-from absolute': () => {
    const found = require('resolve-from')(__dirname, path.join(__dirname, '..', '..', 'lib', 'target'));
    if (found === path.join(__dirname, '..', '..', 'lib', 'target.js')) return 'works';
    return /[\\/]target\.js$/.test(found) && !found.startsWith(path.join(__dirname, '..', '..')) ? 'works (host path)' : 'answered another file';
  },
  // (#480's high, round 1: what a library's resolution from __dirname
  // answers or throws names no host path of the module's -- a missing
  // relative request, a findPackageJSON base climbing out of /app -- in a
  // worker in any mode)
  'resolve-from missing, every path in its error virtual': () => {
    try { require('resolve-from')(__dirname, './no-such-compat-file'); return 'found'; } catch (e) {
      const text = [String(e && e.message), String(e && e.stack), JSON.stringify((e && e.requireStack) || [])].join('\n');
      return /[\\/]compat-probe([\\/]|$)/.test(text) ? 'names a host path' : 'clean';
    }
  },
  'findPackageJSON, a base climbing out of /app': () => {
    const find = require('module').findPackageJSON;
    if (typeof(find) !== 'function') return 'not in module';
    let got;
    // (one level up: mapped raw, it would be the directory beside the
    // module's, where the test plants a package.json)
    try { got = String(find('./', '/app/../')); } catch (e) { got = `${e.code} ${e.message}`; }
    return /[\\/]compat-probe([\\/]|$)|ch-sb-69-/.test(got) ? 'names a host path' : 'clean';
  },
  // (a lookup path climbing out of /app is no lookup path of the module's:
  // a package planted beside the module's directory is not found by it)
  'a lookup path climbing out of /app': () => {
    try {
      require('module')._resolveFilename('outside-compat-dep', {id: __filename, filename: __filename, paths: ['/app/../node_modules']});
      return 'found';
    } catch (e) { return said(e); }
  },
  // (Node's own lookup paths for the module's own directory, given with
  // its trailing separator)
  '_nodeModulePaths, a trailing separator': () => {
    const list = require('module')._nodeModulePaths(`${__dirname}${path.sep}`);
    return Array.isArray(list) && list.length > 0 ? 'works' : 'none';
  },
  // (a module that made Error.stackTraceLimit non-writable: a library's
  // resolution from __dirname still works)
  'resolve-from, stackTraceLimit not writable': () => {
    const was = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    try { Object.defineProperty(Error, 'stackTraceLimit', {value: 10, writable: false, configurable: true}); } catch (e) { /* held (enforce) */ }
    try {
      const found = require('resolve-from')(__dirname, '../../lib/target');
      return /[\\/]target\.js$/.test(found) ? 'works' : 'answered another file';
    } finally {
      try { Object.defineProperty(Error, 'stackTraceLimit', was); } catch (e) { /* held */ }
    }
  },
  // (a module that made Error.prepareStackTrace non-writable: no
  // TypeError from the runtime's own code -- single-thread mode then finds
  // no caller and maps nothing, so the literal /app is not found on POSIX)
  'resolve-from, prepareStackTrace not writable': () => {
    const was = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    try { Object.defineProperty(Error, 'prepareStackTrace', {value: undefined, writable: false, configurable: true}); } catch (e) { /* held (enforce) */ }
    try {
      const found = require('resolve-from')(__dirname, '../../lib/target');
      return /[\\/]target\.js$/.test(found) ? 'works' : 'answered another file';
    } catch (e) { return said(e); } finally {
      try { if (was != null) Object.defineProperty(Error, 'prepareStackTrace', was); else delete Error.prepareStackTrace; } catch (e) { /* held */ }
    }
  },
  // (a direct relative request from the module's own file climbing out of
  // the module, to the package.json planted beside it: not found, never its
  // host path -- ruled: a mapped call answers nothing outside the module)
  'a direct request climbing out of the module': () => {
    try {
      const found = require('module')._resolveFilename('../../../package.json', {id: __filename, filename: __filename, paths: []});
      return /[\\/]compat-probe([\\/]|$)|ch-sb-69-/.test(found) ? 'found a host path' : `found ${path.basename(found)}`;
    } catch (e) {
      const text = [String(e && e.message), String(e && e.stack)].join('\n');
      return /[\\/]compat-probe([\\/]|$)|ch-sb-69-/.test(text) ? `${said(e)}, naming a host path` : said(e);
    }
  },
  // (findPackageJSON of a bare name from the module's own file: Node's
  // walk climbs past the module's node_modules to the package planted
  // beside it, whose host path is never the answer -- ruled: a mapped
  // call's answer outside the module is nothing)
  'findPackageJSON, a bare name found beside the module': () => {
    const find = require('module').findPackageJSON;
    if (typeof(find) !== 'function') return 'not in module';
    let got;
    try { got = String(find('outside-compat-dep', __filename)); } catch (e) { got = `${e.code} ${e.message}`; }
    return /[\\/]compat-probe([\\/]|$)|ch-sb-69-/.test(got) ? 'names a host path' : 'clean';
  },
  // (findPackageJSON with the module's root itself as its base, a file:
  // never the directory beside the module's)
  'findPackageJSON, the root as its base': () => {
    const find = require('module').findPackageJSON;
    if (typeof(find) !== 'function') return 'not in module';
    let got;
    try { got = String(find('./', path.dirname(path.dirname(__dirname)))); } catch (e) { got = `${e.code} ${e.message}`; }
    return /[\\/]compat-probe([\\/]|$)|ch-sb-69-/.test(got) ? 'names a host path' : 'clean';
  },
  'resolve-from absolute, missing': () => {
    const asked = path.join(__dirname, 'no-such-compat-file');
    try { require('resolve-from')(__dirname, asked); return 'found'; } catch (e) {
      return String(e.message).split('\n')[0].includes(asked) ? `${said(e)}, as asked` : `${said(e)}, named otherwise`;
    }
  },
  // (the whole error -- message, stack, requireStack -- of a direct call
  // with an absolute /app request names none of the module's own files by
  // its host path, with the module's own parent, one outside the module and
  // a Proxy parent: below Node 24.15 by the route identity's hook maps it
  // on, through the resolve shim; from 24.15 on, unmapped. The runtime's
  // own frames in a stack are another matter, C-lows'.)
  'absolute request, every path in its error virtual': () => {
    const asked = path.join(__dirname, 'no-such-compat-file');
    const R = require('module');
    const host = [];
    const look = (e) => {
      const text = [String(e && e.message), String(e && e.stack), JSON.stringify((e && e.requireStack) || [])].join('\n');
      for (const m of text.matchAll(/(?:^|[\s'"(\[,])((?:[A-Za-z]:)?[\\/][^\s'"():,\]]*)/g)) {
        const own = /[\\/](handlers[\\/]probeService|compat-probe)([\\/]|$)/.test(m[1]);
        if (own && !/^([\\/]app([\\/]|$)|[A-Z]:\\app(\\|$))/.test(m[1])) host.push(m[1]);
      }
    };
    const tries = [
      () => R._resolveFilename(asked, {id: __filename, filename: __filename, paths: []}),
      () => R._resolveFilename(asked, {id: '/etc/x.js', filename: '/etc/x.js', paths: []}),
      () => R._resolveFilename(asked, new Proxy({filename: __filename, paths: []}, {}))
    ];
    let threw = 0;
    let unnamed = 0;
    for (const t of tries) {
      try { t(); } catch (e) {
        threw++;
        look(e);
        if (!String(e && e.message).split('\n')[0].includes(`'${asked}'`)) unnamed++;
      }
    }
    if (threw !== tries.length) return `${tries.length - threw} answered`;
    return host.length === 0 && unnamed === 0 ? 'clean' : `named ${host.length} other, ${unnamed} not as asked`;
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
