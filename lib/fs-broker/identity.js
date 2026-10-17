// Module identity in a module worker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2, "The loader"): the module's
// files are loaded as file:///app/... URLs, so __filename, __dirname,
// require.resolve, module.paths, require.cache keys, import.meta and stack
// frames are virtual by construction, and every resolve is bounded (L2).
// Installed at set-options, after part 1's lockdown, in every mode, so its
// hooks run first: it maps virtual specifiers and parents to host paths,
// lets the next hooks (part 1's boundary, Node's resolver) work on host
// paths, and maps the result back.
//
// countinghouse's own code is never under /app: install() refuses when it is
// (codeUnderVroot; spec decision 12), because require.cache and the ESM
// module map are keyed by filename and URL, so a module file loaded as
// /app/lib/x.js and a countinghouse file at host /app/lib/x.js would share
// one entry and the module would be handed countinghouse's own module
// object. With that refused, a parent under /app is the module's. A "/app"
// specifier means the module's /app only from module code; countinghouse
// names module files with MODULE_SPECIFIER ("countinghouse-module:/..."),
// normalised so it never leaves /app.
//
// The loader calls the public fs (realpathSync, readFileSync) at call time;
// those calls are served by the original fs only for paths the patch grants
// (L1): realpath/stat under the roots this parent may reach, during this
// resolve; reads of the one checked target, during its load. Everything else
// goes to the broker with the module's rights.
const Module = require('module');
const path = require('path');
const url = require('url');

const VROOT = '/app';
// What countinghouse's own worker code loads from its install directory: L2's
// roots for countinghouse parents and the boot grant's roots (lib/sandbox.js).
// spec/schema.json: lib/validator.js requires it.
const COUNTINGHOUSE_CODE = ['lib', 'node_modules', 'package.json', 'spec/schema.json'];
const MODULE_SPECIFIER = 'countinghouse-module:';
let installed = false;

function inside(p, root) {
  return p === root || p.startsWith(`${root}/`);
}

// Pure path and URL arithmetic, exported for the collision tests.
function mapper(moduleRoot) {
  const m = {
    isVirtual: (p) => inside(p, VROOT),
    toHost: (v) => moduleRoot + v.slice(VROOT.length),
    toVirtual: (h) => VROOT + h.slice(moduleRoot.length),
    isModuleHost: (h) => inside(h, moduleRoot),
    // A parent under /app is the module's (countinghouse's own code is never
    // there, decision 12); a non-file parent is module code (review M1).
    parent(parentURL) {
      if (typeof(parentURL) !== 'string' || !parentURL.startsWith('file:')) return {host: null, fromModule: true};
      const p = url.fileURLToPath(parentURL);
      if (m.isVirtual(p)) return {host: m.toHost(p), fromModule: true};
      return {host: p, fromModule: m.isModuleHost(p)};
    },
    // What a specifier names, given its parent.
    specifier(s, parent) {
      if (s.startsWith(MODULE_SPECIFIER)) return m.toHost(path.posix.join(VROOT, path.posix.resolve('/', s.slice(MODULE_SPECIFIER.length))));
      let t = s.startsWith('file:') ? url.fileURLToPath(s) : s;
      if (parent.fromModule && m.isVirtual(t)) return m.toHost(t);
      if (parent.host != null && (t === '.' || t === '..' || t.startsWith('./') || t.startsWith('../'))) t = path.resolve(path.dirname(parent.host), t);
      return t;
    }
  };
  return m;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' (countinghouse module sandbox)`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

// The loaded files (require.cache keys) that live under /app, plus the
// install directory itself if it does.
function codeUnderVroot(installDir, loadedFiles) {
  return [installDir].concat(loadedFiles).filter((f) => typeof(f) === 'string' && inside(f, VROOT));
}

// cfg.registerHooks: part 1's lockdown hands over the original
// Module.registerHooks before it locks it (module-lockdown.js, beforeLock);
// under --moduleSandbox off, Module.registerHooks itself.
// The refusal's text, shared with framework.js's start-up check.
function underVrootMessage(clash) {
  return `countinghouse's own code is under ${VROOT} (${clash[0]}), where module workers show each module its ` +
    'own files; install countinghouse elsewhere (for example /opt/countinghouse) or run with --no-workerThread';
}

function install(cfg) {
  const clash = codeUnderVroot(cfg.installDir, Object.keys(require.cache));
  if (clash.length > 0) throw new Error(underVrootMessage(clash));
  const moduleRoot = cfg.moduleRoot;
  const m = mapper(moduleRoot);
  const grant = cfg.grant;
  const originals = grant.originals;
  const enforce = (cfg.mode === 'enforce');
  const reportL2 = (cfg.mode === 'audit' || enforce) ? cfg.report : () => {};
  const countinghouseRoots = COUNTINGHOUSE_CODE.map((p) => path.join(cfg.installDir, p));
  const typeCache = new Map();
  const lasting = new Set();   // module files reached as CommonJS by import (below)
  const createRequire = Module.createRequire;   // before any module code can replace it
  let inner = null;   // the exact (specifier, parentURL) of this hook's own createRequire().resolve

  // L2: from set-options on, every resolve is bounded, whoever the parent is.
  function bound(hostPath, fromModule, specifier) {
    if (m.isModuleHost(hostPath)) return;
    if (!fromModule && countinghouseRoots.some((r) => inside(hostPath, r))) return;
    reportL2('require', String(specifier).slice(0, 200));
    if (enforce) throw notFound(String(specifier).slice(0, 200));
  }

  // "type" from the nearest package.json, as Node decides it: the first one
  // found going up wins, and one without "type" means commonjs (review I1).
  function packageType(hostFile) {
    for (let dir = path.dirname(hostFile); inside(dir, moduleRoot); dir = path.dirname(dir)) {
      if (typeCache.has(dir)) return typeCache.get(dir);
      let raw = null;
      try { raw = originals.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) { raw = null; }
      if (raw != null) {
        let type = 'commonjs';
        try { type = JSON.parse(raw).type === 'module' ? 'module' : 'commonjs'; } catch (e) { type = 'commonjs'; }
        typeCache.set(dir, type);
        return type;
      }
      if (dir === moduleRoot || dir === path.dirname(dir)) break;
    }
    return 'commonjs';
  }

  function formatOf(hostFile) {
    const ext = path.extname(hostFile);
    if (ext === '.json') return 'json';
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    return packageType(hostFile) === 'module' ? 'module' : 'commonjs';
  }

  (cfg.registerHooks || Module.registerHooks).call(Module, {
    resolve(specifier, context, nextResolve) {
      if (inner != null && inner.specifier === specifier && inner.parentURL === context.parentURL) return nextResolve(specifier, context);
      if (Module.isBuiltin(specifier)) return nextResolve(specifier, context);
      const parent = m.parent(context.parentURL);
      const hostParent = parent.host;
      const fromModule = parent.fromModule;
      const s = m.specifier(specifier, parent);
      const roots = fromModule ? [moduleRoot] : [moduleRoot].concat(countinghouseRoots);
      let hostResolved = null;
      let format;
      const release = grant.resolving(roots);
      try {
        if (fromModule && hostParent != null && Array.isArray(context.conditions) && context.conditions.includes('require')) {
          // require.resolve(s, {paths}) is resolved against the parent here;
          // its paths option is not honoured (review M2, documented).
          // Node's CommonJS resolver works from the parent Module object, whose
          // filename is virtual, so module-parent CommonJS requests are
          // resolved here against the host parent.
          inner = {specifier: s, parentURL: url.pathToFileURL(hostParent).href};
          try { hostResolved = createRequire(hostParent).resolve(s); } finally { inner = null; }
          if (Module.isBuiltin(hostResolved)) return nextResolve(hostResolved, context);
        } else {
          // CommonJS requests take a path, ES module requests a URL.
          const isRequire = Array.isArray(context.conditions) && context.conditions.includes('require');
          const r = nextResolve(path.isAbsolute(s) && !isRequire ? url.pathToFileURL(s).href : s,
            Object.assign({}, context, {parentURL: hostParent != null ? url.pathToFileURL(hostParent).href : context.parentURL}));
          if (typeof(r.url) !== 'string' || !r.url.startsWith('file:')) return r;
          hostResolved = url.fileURLToPath(r.url);
          format = r.format;
        }
      } finally {
        release();
      }
      bound(hostResolved, fromModule, specifier);
      // Two kinds of module file keep their host URL, because Node loads them
      // from disk by filename itself:
      // - native addons (part 1 refuses them under enforce, reports under audit);
      // - a CommonJS file reached by import: Node 24 marks a resolve that ran
      //   its default resolver as not resolved by hooks, and its CommonJS
      //   translator then re-resolves the filename with the hooks skipped
      //   (internal/modules/esm/translators.js, loadCJSModuleWithModuleLoad),
      //   so a virtual filename is not found. Only that file's own
      //   __filename shows the host path; what it requires is virtual again.
      const importedCjs = m.isModuleHost(hostResolved) && (format || formatOf(hostResolved)) === 'commonjs' && !(Array.isArray(context.conditions) && context.conditions.includes('require'));
      if (m.isModuleHost(hostResolved) && path.extname(hostResolved) !== '.node' && !importedCjs) {
        return {url: url.pathToFileURL(m.toVirtual(hostResolved)).href, format: format, shortCircuit: true};
      }
      // That translator realpaths and reads the file later, outside this hook
      // and any grant window: a lasting grant for exactly that file, the
      // module's own, which it can read as /app/... anyway.
      if (importedCjs && !lasting.has(hostResolved)) {
        lasting.add(hostResolved);
        grant.resolving([hostResolved]);
        grant.reading(hostResolved);
      }
      return {url: url.pathToFileURL(hostResolved).href, format: format, shortCircuit: true};
    },
    load(hookUrl, context, nextLoad) {
      if (typeof(hookUrl) === 'string' && hookUrl.startsWith('file:')) {
        const p = url.fileURLToPath(hookUrl);
        if (m.isVirtual(p) && path.extname(p) !== '.node') {
          const host = m.toHost(p);
          const format = formatOf(host);
          const source = originals.readFileSync(host, format === 'commonjs' ? undefined : 'utf8');
          return {format: format, source: source, shortCircuit: true};
        }
        const release = grant.reading(p);
        try { return nextLoad(hookUrl, context); } finally { release(); }
      }
      return nextLoad(hookUrl, context);
    }
  });

  // The loader's own disk lookups bypass the broker: Module._stat stats
  // natively, _readPackage and findPackageJSON read package.json natively,
  // and _findPath and _resolveFilename answer differently for a path that
  // exists. Under enforce, where paths outside the namespace are meant to be
  // invisible, they answer "missing" for anything outside the module root and
  // countinghouse's code -- exactly the roots L2 allows, so Node's own loading
  // (which calls them through the same object) is unchanged. Under audit and
  // off a module may read outside paths anyway, so nothing is hidden there.
  if (enforce) {
    const allowed = (p) => {
      if (typeof(p) !== 'string' || !path.isAbsolute(p)) return true;   // relative requests resolve against allowed parents
      const h = path.resolve(p);
      return m.isModuleHost(h) || countinghouseRoots.some((r) => inside(h, r));
    };
    const toPath = (v) => { try { return (v instanceof URL || String(v).startsWith('file:')) ? url.fileURLToPath(v) : String(v); } catch (e) { return String(v); } };
    const replace = (key, fn) => {
      if (typeof(Module[key]) !== 'function') return;
      Object.defineProperty(Module, key, {writable: false, configurable: false, enumerable: true, value: fn(Module[key])});
    };
    replace('_stat', (orig) => function(filename) { return allowed(filename) ? orig.call(this, filename) : -2; });
    replace('_findPath', (orig) => function(request, paths, isMain) {
      if (!allowed(request)) return false;
      let found;
      try { found = orig.call(this, request, paths, isMain); } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
      return (found === false || allowed(found)) ? found : false;
    });
    replace('_resolveFilename', (orig) => function(request, ...rest) {
      if (Module.isBuiltin(request)) return orig.call(this, request, ...rest);
      let found;
      try { found = orig.call(this, request, ...rest); } catch (e) {
        if (e && e.code === 'ENOENT') throw notFound(String(request).slice(0, 200));
        throw e;
      }
      if (typeof(found) === 'string' && !Module.isBuiltin(found) && !allowed(found)) throw notFound(String(request).slice(0, 200));
      return found;
    });
    replace('_readPackage', (orig) => function(dir, ...rest) {
      if (allowed(path.join(String(dir), 'package.json'))) return orig.call(this, dir, ...rest);
      return {type: 'none', exists: false, pjsonPath: path.join(String(dir), 'package.json')};
    });
    replace('findPackageJSON', (orig) => function(specifier, base) {
      if (base != null && !allowed(toPath(base))) return undefined;
      const found = orig.call(this, specifier, base);
      return (found == null || allowed(found)) ? found : undefined;
    });
  }
  installed = true;

  // The module's view of its process: the current directory is /app and the
  // temp directory is /tmp (spec section 1). Workers cannot chdir.
  const os = require('os');
  Object.defineProperty(process, 'cwd', {value: () => VROOT, writable: false, configurable: false});
  Object.defineProperty(os, 'tmpdir', {value: () => '/tmp', writable: false, configurable: false, enumerable: true});
}

// How countinghouse's own worker code names a module file (module-manager,
// handler-map): never a bare "/app", which from countinghouse code is a host path.
function moduleSpecifier(virtualPath) {
  return MODULE_SPECIFIER + String(virtualPath).slice(VROOT.length);
}

// What countinghouse code passes to require() for a path a module gave it
// (CHUtil.loadFile(`${__dirname}/device.js`)): the module specifier once the
// hook is installed, the path itself otherwise (single-thread mode).
function specifierFor(p) {
  return (installed && inside(p, VROOT)) ? moduleSpecifier(p) : p;
}

module.exports = {install, mapper, moduleSpecifier, specifierFor, codeUnderVroot, underVrootMessage, VROOT, MODULE_SPECIFIER, COUNTINGHOUSE_CODE};
