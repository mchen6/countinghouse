'use strict';
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
const resolveShim = require('../resolve-shim');
// taken now: resolve-shim's exports object is reachable from module code
// through the require cache
const {hasCondition, isHookAnswer, mergedContext} = resolveShim;
const path = require('path');
const url = require('url');

// The loader hook, the enforce-time wrappers and the path arithmetic below
// decide what a module may load and see after its code has run: each calls
// only what was taken here, when this file loads (a module shares the
// worker's realm and can replace a method of String, Array, Set, Map,
// RegExp, JSON or Function). An original is called with ReflectApply,
// never its own call, which would hand it to a replaced
// Function.prototype.call. (path, url and module.isBuiltin are fixed at the
// lockdown, lib/module-lockdown.js, under audit and enforce.)
const ReflectApply = Reflect.apply;
const uncurry = (fn) => Function.prototype.call.bind(fn);
const StringCtor = String;
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringEndsWith = uncurry(String.prototype.endsWith);
const StringSlice = uncurry(String.prototype.slice);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringToUpperCase = uncurry(String.prototype.toUpperCase);
const RegExpExec = uncurry(RegExp.prototype.exec);
const matches = (re, str) => RegExpExec(re, str) !== null;
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const MapHas = uncurry(Map.prototype.has);
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const JSONParse = JSON.parse;
const ArrayIsArray = Array.isArray;
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const URLProto = URL.prototype;
const URLHref = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'href').get);
const ModuleIsBuiltin = Module.isBuiltin;
const isBuiltin = (id) => ReflectApply(ModuleIsBuiltin, Module, [id]);
const FileURLToPath = url.fileURLToPath;
const PathToFileURL = url.pathToFileURL;
const fileURLToPath = (u) => ReflectApply(FileURLToPath, url, [u]);
const pathToFileHref = (p) => URLHref(ReflectApply(PathToFileURL, url, [p]));
// every `from` character of str as `to` (one character each), by index
const swapped = (str, from, to) => {
  let out = '';
  for (let i = 0; i < str.length; i++) out += (str[i] === from ? to : str[i]);
  return out;
};
// whether any of list answers test, by index
// arr[i] = v as a definition (an assignment runs a setter a module put on
// Array.prototype, with arr as `this`)
const put = (arr, i, v) => ObjectDefineProperty(arr, i, {__proto__: null, value: v, writable: true, enumerable: true, configurable: true});
const anyOf = (list, test) => {
  for (let i = 0; i < list.length; i++) if (test(list[i])) return true;
  return false;
};

const VROOT = '/app';

// #195: on Windows a module's files carry a drive, <V>:\app\... (V picked by
// lib/fs-broker/virtual-drive.js and given to the worker), because Node there
// takes a file URL only with one. countinghouse's own code keeps naming them
// /app/...; the edges convert: a virtual path's URL is file:///<V>:/app/...,
// and a <V>:\app path coming back (a URL, a module's __dirname) is /app
// again. null off Windows (and before install()).
let VDRIVE = null;
// A <V>:\app path (either separator, the drive in either case) as the
// virtual /app path countinghouse uses; anything else as it is. fromWinFor(V)
// for a given drive (the tests, on any OS); fromWin for this worker's.
const V_APP = /^[a-zA-Z]:[\\/]app(?:[\\/]|$)/;
const fromWinFor = (drive) => (p) => ((drive != null && typeof(p) === 'string' && p.length >= 6 &&
  StringToUpperCase(p[0]) === drive && matches(V_APP, p)) ? VROOT + swapped(StringSlice(p, 6), '\\', '/') : p);
const fromWin = (p) => fromWinFor(VDRIVE)(p);
// A virtual /app path's file URL.
const virtualUrl = (v) => pathToFileHref(VDRIVE != null ? `${VDRIVE}:${v}` : v);
// What countinghouse's own worker code loads from its install directory
// (spec/schema.json: lib/validator.js requires it).
const COUNTINGHOUSE_OWN = ['lib', 'package.json', 'spec/schema.json'];

// Where countinghouse's code lives: its own entries, and the package
// directory of every package in its dependency closure (dependencies,
// optionalDependencies, peerDependencies, transitively), found the way Node
// finds them, so an npm install that hoists them into the project's
// node_modules works (review, plan 3). Not that whole node_modules: modules
// are npm packages too and may sit beside countinghouse's dependencies, and
// no module may borrow countinghouse's rights to reach another (spec,
// "What this can and cannot promise"). A package reached through a symlink
// (pnpm, a linked node_modules) is listed under the name Node looks it up by
// and under its real path, and so are countinghouse's own entries, from the
// install as it runs from it (#272). Every module root in `exclude` is subtracted, with
// any root that contains one, from both spellings. The one list for the boot
// grant (lib/lean-worker.js), L2's countinghouse roots, the loader lookups under
// enforce, and --hardened's read grants. Computed on the main thread with
// the real fs (realpath = the native fs.realpathSync); without it -- test harnesses --
// countinghouse's own entries and <installDir>/node_modules, as spelled.
// The closure is computed once per install directory and process: the
// install does not change while countinghouse runs, and walking it costs
// about 80 ms per spawn (perf/spawn-time-perf.js). Exclusions apply per call.
const closures = new Map();

function codeRootsFor(installDir, realpath, exclude) {
  const own = COUNTINGHOUSE_OWN.map((p) => path.join(installDir, p));
  if (realpath == null) return own.concat([path.join(installDir, 'node_modules')]);
  if (!closures.has(installDir)) closures.set(installDir, dependencyClosure(installDir, own, realpath));
  const modules = (exclude || []).map((p) => { try { return realpath(p); } catch (e) { return path.resolve(p); } });
  const {roots, realOf} = closures.get(installDir);
  return withoutModuleRoots(roots, realOf, modules, process.platform);
}

// The code roots with every module root taken out: one inside a module
// root, or holding one, is not countinghouse's code. A looked-up spelling
// goes with its real path: excluded if either is. This is the refusing
// side, so on win32 it folds case (a module root that differs only in case
// from a code root is still taken out; not folding would leave the module's
// files as countinghouse's code). The grants themselves never fold.
function withoutModuleRoots(roots, realOf, modules, platform) {
  const fold = (p) => (platform === 'win32' ? p.toLowerCase() : p);
  const inside = insideHostFor(platform);
  const touches = (p, m) => inside(fold(p), fold(m)) || inside(fold(m), fold(p));
  return roots.filter((r) => [r, realOf.get(r) || r].every((p) => !modules.some((m) => touches(p, m))));
}

function dependencyClosure(installDir, own, realpath) {
  const fs = require('fs');
  const readDeps = (dir) => {
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (e) { return []; }
    return [].concat(...['dependencies', 'optionalDependencies', 'peerDependencies'].map((k) => Object.keys((pkg && pkg[k]) || {})));
  };
  const roots = [];
  const realOf = new Map();   // looked-up spelling -> its real path, where they differ
  const add = (p) => { if (!roots.includes(p)) roots.push(p); };
  // a root under the spelling it is reached by and under its real path
  const addBoth = (spelled, real) => {
    add(spelled);
    if (spelled !== real) realOf.set(spelled, real);
    add(real);
  };
  // countinghouse's own entries, under the spelling it runs from too (the
  // caller passes the install as run, not resolved): on Windows an install
  // under an 8.3 short name (C:\Users\RUNNER~1\..., from os.tmpdir()) runs
  // its files by that spelling while realpath gives the long one (#272)
  own.forEach((p) => {
    let real;
    try { real = realpath(p); } catch (e) { return; }   // not installed
    addBoth(p, real);
  });
  const seen = new Set();
  const queue = readDeps(installDir).map((name) => ({name: name, from: installDir}));
  while (queue.length > 0) {
    const {name, from} = queue.shift();
    let dir = null;
    for (const nm of Module._nodeModulePaths(from)) {
      let found = false;
      try { found = fs.existsSync(path.join(nm, name, 'package.json')); } catch (e) { found = false; }   // --permission throws outside its grants
      if (found) { dir = path.join(nm, name); break; }
    }
    if (dir == null) continue;   // an optional or peer dependency that is not installed
    let real;
    try { real = realpath(dir); } catch (e) { continue; }
    // Node looks a dependency up by this name before it resolves it, so a
    // package reached through a symlink (pnpm's store, a linked
    // node_modules) is a root under both spellings -- and under each
    // parent's, before the seen check: pnpm links one package beside every
    // package that depends on it.
    addBoth(dir, real);
    if (seen.has(real)) continue;
    seen.add(real);
    readDeps(real).forEach((dep) => queue.push({name: dep, from: real}));
  }
  return {roots, realOf};
}

const MODULE_SPECIFIER = 'countinghouse-module:';
const DRIVE = /^[a-zA-Z]:/;
const WIN32_HOST = process.platform === 'win32';
let installed = false;

// A virtual path (/app, POSIX on every OS) under a virtual root.
function inside(p, root) {
  return p === root || StringStartsWith(p, `${root}/`);
}

// A host path under a host root, by the host's rules (lib/fs-broker/roots.js
// underFor, as the boot grant uses): a backslash on win32, where "/" alone
// left every host path outside countinghouse's code roots, so under enforce
// its own lazily required files were refused there. No case folding. For
// countinghouse's code roots and their exclusion; a module's own root keeps
// inside() (see isModuleHost).
const insideHostFor = (platform) => {
  const under = require('./roots').underFor(platform);
  return (p, root) => under(p, [root]);
};
const insideHost = insideHostFor(process.platform);

// The path functions for a path that may be the module's: one under the
// module's virtual root (VROOT and below) is POSIX on every OS, as the file
// broker's namespace is; any other (a host path, single-thread mode's) takes
// the platform's. Issue #40: on Windows path.join('/app', ...) gave
// '\app\...', and path.resolve('/app/...') gave the drive's D:\app\....
function pathFor(p) {
  return (typeof(p) === 'string' && inside(p, VROOT)) ? path.posix : path;
}

// A module file's name made absolute, with the path functions of the base
// it resolves against: itself when absolute (win32's isAbsolute takes
// '/app/x' too), else the process's cwd, which in a module worker is VROOT
// (install(), below). So a relative './device.js' in a worker is
// '/app/device.js' on every OS (issue #40).
function resolveModulePath(name) {
  const base = path.isAbsolute(name) ? name : process.cwd();
  return pathFor(base).resolve(name);
}

// Pure path and URL arithmetic, exported for the collision tests.
function mapper(moduleRoot) {
  const m = {
    isVirtual: (p) => inside(p, VROOT),
    // with the host's separators on win32 (#195: a mixed C:\m/handlers/x.js
    // stopped the package.json walk, so "type": "module" was missed)
    toHost: (v) => moduleRoot + (VDRIVE != null ? swapped(StringSlice(v, VROOT.length), '/', '\\') : StringSlice(v, VROOT.length)),
    // on win32 the host's "\\" become the namespace's "/"
    toVirtual: (h) => VROOT + (VDRIVE != null ? swapped(StringSlice(h, moduleRoot.length), '\\', '/') : StringSlice(h, moduleRoot.length)),
    // By the host's rules once a module's files carry a drive on win32 (#195);
    // "/" only as spelled elsewhere.
    isModuleHost: (h) => (VDRIVE != null ? insideHost(h, moduleRoot) : inside(h, moduleRoot)),
    // A parent under /app is the module's (countinghouse's own code is never
    // there, decision 12); a non-file parent is module code (review M1).
    parent(parentURL) {
      if (typeof(parentURL) !== 'string' || !StringStartsWith(parentURL, 'file:')) return {host: null, fromModule: true};
      const p = fromWin(fileURLToPath(parentURL));
      if (m.isVirtual(p)) return {host: m.toHost(p), fromModule: true};
      return {host: p, fromModule: m.isModuleHost(p)};
    },
    // What a specifier names, given its parent.
    specifier(s, parent) {
      if (StringStartsWith(s, MODULE_SPECIFIER)) {
        // On Windows "\\" is a separator too and a ":" names a drive or a
        // stream: "..\\" left the module root once Windows resolved the host
        // path (the review of #197 round 6). A ":" is refused; the path is
        // then normalised, and what the host makes of it must still be inside
        // the module's root, on every OS.
        let rest = StringSlice(s, MODULE_SPECIFIER.length);
        if (WIN32_HOST) {
          if (StringIndexOf(rest, ':') !== -1) throw notFound(s);
          rest = swapped(rest, '\\', '/');
        }
        const host = m.toHost(path.posix.join(VROOT, path.posix.resolve('/', rest)));
        const hp = WIN32_HOST ? path.win32 : path.posix;
        const fold = (p) => (WIN32_HOST && matches(DRIVE, p) ? StringToUpperCase(p[0]) + StringSlice(p, 1) : p);
        const norm = fold(hp.resolve(host));
        const root = fold(hp.resolve(moduleRoot));
        if (norm !== root && !StringStartsWith(norm, StringEndsWith(root, hp.sep) ? root : root + hp.sep)) throw notFound(s);
        return host;
      }
      let t = fromWin(StringStartsWith(s, 'file:') ? fileURLToPath(s) : s);
      if (parent.fromModule && m.isVirtual(t)) return m.toHost(t);
      if (parent.host != null && (t === '.' || t === '..' || StringStartsWith(t, './') || StringStartsWith(t, '../'))) t = path.resolve(path.dirname(parent.host), t);
      return t;
    }
  };
  return m;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' (countinghouse module sandbox)`);
  ObjectDefineProperty(err, 'code', {__proto__: null, value: 'MODULE_NOT_FOUND', writable: true, enumerable: true, configurable: true});
  return err;
}

// The loaded files (require.cache keys) that live under /app, plus the
// install directory itself if it does.
function codeUnderVroot(installDir, loadedFiles) {
  // (on Windows in the <V>:\\app form too, #195)
  return [installDir].concat(loadedFiles).filter((f) => typeof(f) === 'string' && inside(fromWin(f), VROOT));
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
  VDRIVE = (process.platform === 'win32' && typeof(cfg.virtualDrive) === 'string' && /^[A-Z]$/.test(cfg.virtualDrive)) ? cfg.virtualDrive : null;
  const clash = codeUnderVroot(cfg.installDir, Object.keys(require.cache));
  if (clash.length > 0) throw new Error(underVrootMessage(clash));
  const moduleRoot = cfg.moduleRoot;
  const m = mapper(moduleRoot);
  const grant = cfg.grant;
  const originals = grant.originals;
  const enforce = (cfg.mode === 'enforce');
  const reportL2 = (cfg.mode === 'audit' || enforce) ? cfg.report : () => {};
  const countinghouseRoots = Array.isArray(cfg.codeRoots) ? cfg.codeRoots.slice() : codeRootsFor(cfg.installDir);
  const typeCache = new Map();
  const lasting = new Set();   // module files reached as CommonJS by import (below)
  const createRequire = Module.createRequire;   // before any module code can replace it
  let inner = null;   // the exact (specifier, parentURL) of this hook's own createRequire().resolve

  // L2: from set-options on, every resolve is bounded, whoever the parent is.
  function bound(hostPath, fromModule, specifier) {
    if (m.isModuleHost(hostPath)) return;
    if (!fromModule && anyOf(countinghouseRoots, (r) => insideHost(hostPath, r))) return;
    const shown = StringSlice(StringCtor(specifier), 0, 200);
    reportL2('require', shown);
    if (enforce) throw notFound(shown);
  }

  // "type" from the nearest package.json, as Node decides it: the first one
  // found going up wins, and one without "type" means commonjs (review I1).
  function packageType(hostFile) {
    for (let dir = path.dirname(hostFile); m.isModuleHost(dir); dir = path.dirname(dir)) {
      if (MapHas(typeCache, dir)) return MapGet(typeCache, dir);
      let raw = null;
      try { raw = originals.readFileSync(path.join(dir, 'package.json'), 'utf8'); } catch (e) { raw = null; }
      if (raw != null) {
        let type = 'commonjs';
        // (its own "type" only: never one an Object.prototype getter answers)
        try {
          const pkg = ReflectApply(JSONParse, JSON, [raw]);
          type = (pkg != null && typeof(pkg) === 'object' && ObjectHasOwn(pkg, 'type') && pkg.type === 'module') ? 'module' : 'commonjs';
        } catch (e) { type = 'commonjs'; }
        MapSet(typeCache, dir, type);
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

  // Through the resolve shim: below Node 24.15 it also runs this hook for
  // require.resolve and createRequire().resolve (lib/resolve-shim.js).
  resolveShim.registerHooks(cfg.registerHooks || Module.registerHooks, {
    resolve(specifier, context, nextResolve) {
      if (inner != null && inner.specifier === specifier && inner.parentURL === context.parentURL) return nextResolve(specifier, context);
      if (isBuiltin(specifier)) return nextResolve(specifier, context);
      // A CommonJS file reached by import keeps its host filename (below).
      // Node 22 then loads it with Module._load(that filename), which runs
      // this hook with no parent; mapping it to /app again would load a
      // second copy under the virtual name and leave the importer the
      // first's empty exports. Node 24 skips the hooks there.
      if (typeof(specifier) === 'string' && SetHas(lasting, specifier)) {
        return {url: pathToFileHref(specifier), format: 'commonjs', shortCircuit: true};
      }
      const parent = m.parent(context.parentURL);
      const hostParent = parent.host;
      const fromModule = parent.fromModule;
      const s = m.specifier(specifier, parent);
      const roots = [moduleRoot];
      if (!fromModule) for (let i = 0; i < countinghouseRoots.length; i++) put(roots, roots.length, countinghouseRoots[i]);
      let hostResolved = null;
      let format;
      const release = grant.resolving(roots);
      try {
        if (fromModule && hostParent != null && hasCondition(context, 'require')) {
          // require.resolve(s, {paths}) is resolved against the parent here;
          // its paths option is not honoured (review M2, documented).
          // Node's CommonJS resolver works from the parent Module object, whose
          // filename is virtual, so module-parent CommonJS requests are
          // resolved here against the host parent.
          inner = {specifier: s, parentURL: pathToFileHref(hostParent)};
          try { hostResolved = ReflectApply(createRequire, Module, [hostParent]).resolve(s); } finally { inner = null; }
          if (isBuiltin(hostResolved)) return nextResolve(hostResolved, context);
        } else {
          // CommonJS requests take a path, ES module requests a URL.
          const isRequire = hasCondition(context, 'require');
          // the context as Node gave it, with the host parent
          const next = mergedContext(context, {parentURL: hostParent != null ? pathToFileHref(hostParent) : context.parentURL});
          const r = nextResolve(path.isAbsolute(s) && !isRequire ? pathToFileHref(s) : s, next);
          if (typeof(r.url) !== 'string' || !StringStartsWith(r.url, 'file:')) return r;
          hostResolved = fileURLToPath(r.url);
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
      const importedCjs = m.isModuleHost(hostResolved) && (format || formatOf(hostResolved)) === 'commonjs' && !hasCondition(context, 'require');
      if (m.isModuleHost(hostResolved) && path.extname(hostResolved) !== '.node' && !importedCjs) {
        return {url: virtualUrl(m.toVirtual(hostResolved)), format: format, shortCircuit: true};
      }
      // That translator realpaths and reads the file later, outside this hook
      // and any grant window: a lasting grant for exactly that file, the
      // module's own, which it can read as /app/... anyway.
      if (importedCjs && !SetHas(lasting, hostResolved)) {
        SetAdd(lasting, hostResolved);
        grant.resolving([hostResolved]);
        grant.reading(hostResolved);
      }
      return {url: pathToFileHref(hostResolved), format: format, shortCircuit: true};
    },
    load(hookUrl, context, nextLoad) {
      if (typeof(hookUrl) === 'string' && StringStartsWith(hookUrl, 'file:')) {
        const p = fromWin(fileURLToPath(hookUrl));
        if (m.isVirtual(p) && path.extname(p) !== '.node') {
          // normalised, and still the module's own once it is
          const virtual = path.posix.resolve(p);
          if (!m.isVirtual(virtual)) throw notFound(StringSlice(StringCtor(hookUrl), 0, 200));
          const host = m.toHost(virtual);
          if (!m.isModuleHost(host)) throw notFound(StringSlice(StringCtor(hookUrl), 0, 200));
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
      return m.isModuleHost(h) || anyOf(countinghouseRoots, (r) => insideHost(h, r));
    };
    // a URL as its href (read through URL.prototype's own getter): what is
    // checked is what the original is given
    // a URL as its href, anything else as one string, read once: what is
    // checked is what the original is given
    const asGiven = (v) => {
      if (v == null) return v;
      if (typeof(v) === 'object' && ObjectIsPrototypeOf(URLProto, v)) {
        try { return URLHref(v); } catch (e) { return StringCtor(v); }
      }
      return StringCtor(v);
    };
    const toPath = (g) => { try { return StringStartsWith(g, 'file:') ? fileURLToPath(g) : g; } catch (e) { return g; } };
    const replace = (key, fn) => {
      if (typeof(Module[key]) !== 'function') return;
      Object.defineProperty(Module, key, {writable: false, configurable: false, enumerable: true, value: fn(Module[key])});
    };
    replace('_stat', (orig) => function(filename) { return allowed(filename) ? ReflectApply(orig, this, [filename]) : -2; });
    replace('_findPath', (orig) => function(request, paths, isMain) {
      if (!allowed(request)) return false;
      let found;
      try { found = ReflectApply(orig, this, [request, paths, isMain]); } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
      return (found === false || allowed(found)) ? found : false;
    });
    replace('_resolveFilename', (orig) => function(...args) {
      const request = args[0];
      if (isBuiltin(request)) return ReflectApply(orig, this, args);
      let found;
      try { found = ReflectApply(orig, this, args); } catch (e) {
        if (e && e.code === 'ENOENT') throw notFound(StringSlice(StringCtor(request), 0, 200));
        throw e;
      }
      // Below Node 24.15 this wraps the resolve shim (lib/resolve-shim.js),
      // whose answer to a require.resolve is the hook chain's, this hook's
      // virtual path for a module file; on 24.15 Node's require.resolve
      // returns that answer without coming through here. Allowed only when
      // the shim says a hook gave it (never a host /app path Node's
      // resolver found, a Docker WORKDIR, say), and it names a file inside
      // the module's own root.
      // (on Windows the answer may be in the <V>:\\app form, #195)
      const own = typeof(found) === 'string' ? fromWin(found) : found;
      const virtualOwn = isHookAnswer(found) && typeof(own) === 'string' && path.posix.isAbsolute(own) &&
        m.isVirtual(path.posix.resolve(own)) && m.isModuleHost(m.toHost(path.posix.resolve(own)));
      if (typeof(found) === 'string' && !isBuiltin(found) && !virtualOwn && !allowed(found)) throw notFound(StringSlice(StringCtor(request), 0, 200));
      return found;
    });
    // require.resolve.paths: Node appends its global lookup directories
    // (<prefix>/lib/node, and $HOME's when set) to a parent's own, a host
    // path naming the install and the home directory, on every version.
    // For module code only its virtual lookup paths are left; they are the
    // only ones its requires can reach under enforce anyway.
    replace('_resolveLookupPaths', (orig) => function(...args) {
      const parent = args[1];
      const found = ReflectApply(orig, this, args);
      // (on Windows in the <V>:\app form, #195, whose parent's is <V>:\node_modules)
      const fromModule = parent != null && typeof(parent.filename) === 'string' && m.isVirtual(fromWin(parent.filename));
      if (!fromModule || !ArrayIsArray(found)) return found;
      const vNodeModules = VDRIVE != null ? `${VDRIVE}:\\node_modules` : null;
      const kept = [];
      for (let i = 0; i < found.length; i++) {
        const p = found[i];
        if (typeof(p) === 'string' && (p === '/node_modules' || p === vNodeModules || m.isVirtual(fromWin(p)))) put(kept, kept.length, p);
      }
      return kept;
    });
    replace('_readPackage', (orig) => function(...args) {
      // read once, as a string, and that string handed on in an array of
      // its own (an index write would run a setter a module put on
      // Array.prototype, which could hand on another directory)
      const dir = StringCtor(args[0]);
      if (allowed(path.join(dir, 'package.json'))) return ReflectApply(orig, this, [dir]);
      return {type: 'none', exists: false, pjsonPath: path.join(dir, 'package.json')};
    });
    replace('findPackageJSON', (orig) => function(specifier, given) {
      const base = asGiven(given);
      if (base != null && !allowed(toPath(base))) return undefined;
      const found = ReflectApply(orig, this, [specifier, base != null ? toPath(base) : base]);
      return (found == null || allowed(found)) ? found : undefined;
    });
  }
  installed = true;

  // The module's view of its process: the current directory is /app and the
  // temp directory is /tmp (spec section 1). Workers cannot chdir.
  const os = require('os');
  const cwd = VDRIVE != null ? `${VDRIVE}:\\app` : VROOT;
  Object.defineProperty(process, 'cwd', {value: () => cwd, writable: false, configurable: false});
  Object.defineProperty(os, 'tmpdir', {value: () => '/tmp', writable: false, configurable: false, enumerable: true});
}

// How countinghouse's own worker code names a module file (module-manager,
// handler-map): never a bare "/app", which from countinghouse code is a host path.
function moduleSpecifier(virtualPath) {
  return MODULE_SPECIFIER + StringSlice(fromWin(StringCtor(virtualPath)), VROOT.length);
}

// What countinghouse code passes to require() for a path a module gave it
// (CHUtil.loadFile(`${__dirname}/device.js`)): the module specifier once the
// hook is installed, the path itself otherwise (single-thread mode).
function specifierFor(p) {
  return (installed && inside(fromWin(p), VROOT)) ? moduleSpecifier(p) : p;
}

module.exports = {install, mapper, fromWinFor, insideHostFor, withoutModuleRoots, moduleSpecifier, specifierFor, codeUnderVroot, underVrootMessage, codeRootsFor, pathFor, resolveModulePath, VROOT, MODULE_SPECIFIER};
