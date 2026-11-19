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
// Node's own CommonJS resolver and lookup paths, taken at this file's load,
// before anything wraps them (lib/resolve-shim.js installs its wrapper when
// hooks are first registered, later, and identity's enforce wrapper is
// below), and kept in this closure only: module code can reach a file's
// exports through the require cache, so they are never exported (F4-1's
// review: an original resolver handed out would skip the enforce wrapper)
const nodeResolveFilename = Module._resolveFilename;
const nodeModulePaths = Module._nodeModulePaths;
const path = require('path');
// path's functions as they were at load (#425's review): the hooks below
// are boundary checks that run after the lockdown, where module code can
// replace path's own functions (path.posix.join, resolve...); every call
// here goes through these, never a lookup on path then. (Node's join calls
// normalize through the path object itself, so this is a second line: the
// lockdown fixes path, path.posix and path.win32 before module code runs,
// in both modes, lib/module-lockdown.js step 0.) PATH.posix and
// PATH.win32 are the same for each flavour; pathFor hands out one of them.
const PathApply = Reflect.apply;
const PATH_FUNCTIONS = ['join', 'resolve', 'dirname', 'extname', 'isAbsolute', 'normalize', 'relative', 'basename', 'toNamespacedPath'];
const capturePath = (lib) => {
  const out = {__proto__: null, sep: lib.sep, delimiter: lib.delimiter};
  for (let i = 0; i < PATH_FUNCTIONS.length; i++) {
    const fn = lib[PATH_FUNCTIONS[i]];
    out[PATH_FUNCTIONS[i]] = (...args) => PathApply(fn, lib, args);
  }
  return Object.freeze(out);
};
const PATH_POSIX = capturePath(path.posix);
const PATH_WIN32 = capturePath(path.win32);
const PATH = Object.freeze({__proto__: null, ...capturePath(path), posix: PATH_POSIX, win32: PATH_WIN32});
const url = require('url');
// (read at load: libNamesOf lists lib/ only in a worker)
const isMainThreadAtLoad = require('worker_threads').isMainThread;

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
const StringReplaceAll = uncurry(String.prototype.replaceAll);
const StringSlice = uncurry(String.prototype.slice);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringCharCodeAt = uncurry(String.prototype.charCodeAt);
const StringToUpperCase = uncurry(String.prototype.toUpperCase);
const StringToLowerCase = uncurry(String.prototype.toLowerCase);
const RegExpExec = uncurry(RegExp.prototype.exec);
const matches = (re, str) => RegExpExec(re, str) !== null;
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const MapHas = uncurry(Map.prototype.has);
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const WeakMapCtor = WeakMap;
const WeakMapGet = uncurry(WeakMap.prototype.get);
const WeakMapSet = uncurry(WeakMap.prototype.set);
const JSONParse = JSON.parse;
const ArrayIsArray = Array.isArray;
const ArrayCtor = Array;
const ArrayFrom = Array.from;
const ReflectGet = Reflect.get;
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const TypeErrorProto = TypeError.prototype;
const RangeErrorProto = RangeError.prototype;
const SyntaxErrorProto = SyntaxError.prototype;

const URLProto = URL.prototype;
const URLHref = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'href').get);
const ModuleIsBuiltin = Module.isBuiltin;
const isBuiltin = (id) => ReflectApply(ModuleIsBuiltin, Module, [id]);
const PathResolve = PATH.resolve;
const resolvedPath = (p) => ReflectApply(PathResolve, path, [p]);
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
  const own = COUNTINGHOUSE_OWN.map((p) => PATH.join(installDir, p));
  if (realpath == null) return own.concat([PATH.join(installDir, 'node_modules')]);
  if (!closures.has(installDir)) closures.set(installDir, dependencyClosure(installDir, own, realpath));
  const modules = (exclude || []).map((p) => { try { return realpath(p); } catch (e) { return PATH.resolve(p); } });
  const {roots, realOf} = closures.get(installDir);
  return withoutModuleRoots(roots, realOf, modules, process.platform);
}

// The roots of the one late load the lockdown lets through under audit
// (lazy-require's postman-request, a module with no net's first request):
// postman-request's own package and its dependency closure, never the
// install's whole node_modules, where other packages sit beside them (the
// review of #434's round 4, E3). Module roots taken out, as for the code
// roots. [] when it isn't installed.
// (found as lazy-require, in lib/, finds it: Node's lookup paths from
// there, by the spelling Node looks it up by, the real one added by the
// walk (#272); its closure walked once per package directory, as the code
// roots' is per install. fsLib: the caller's fs, on the main thread.)
function lateRootsFor(installDir, realpath, exclude, fsLib) {
  let dir = null;
  for (const nm of Module._nodeModulePaths(PATH.join(installDir, 'lib'))) {
    let found = false;
    try { found = fsLib.existsSync(PATH.join(nm, 'postman-request', 'package.json')); } catch (e) { found = false; }   // --permission throws outside its grants
    if (found) { dir = PATH.join(nm, 'postman-request'); break; }
  }
  if (dir == null) return [];
  const key = `late\0${dir}`;
  if (!closures.has(key)) closures.set(key, dependencyClosure(dir, [dir], realpath));
  const {roots, realOf} = closures.get(key);
  const modules = (exclude || []).map((p) => { try { return realpath(p); } catch (e) { return PATH.resolve(p); } });
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
    try { pkg = JSON.parse(fs.readFileSync(PATH.join(dir, 'package.json'), 'utf8')); } catch (e) { return []; }
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
      try { found = fs.existsSync(PATH.join(nm, name, 'package.json')); } catch (e) { found = false; }   // --permission throws outside its grants
      if (found) { dir = PATH.join(nm, name); break; }
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
    // Its own dependencies are looked up from where it was loaded: its real
    // path, and, run with --preserve-symlinks, the spelling it was found by
    // (install/node_modules/once -> install/node_modules/wrappy, through a
    // linked node_modules: #272, the review of #370). Each walked once.
    const froms = [real, dir].filter((f, i, all) => all.indexOf(f) === i && !seen.has(f));
    if (froms.length === 0) continue;
    const deps = readDeps(real);
    froms.forEach((f) => {
      seen.add(f);
      deps.forEach((dep) => queue.push({name: dep, from: f}));
    });
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
  return (typeof(p) === 'string' && inside(p, VROOT)) ? PATH.posix : PATH;
}

// A module file's name made absolute, with the path functions of the base
// it resolves against: itself when absolute (win32's isAbsolute takes
// '/app/x' too), else the process's cwd, which in a module worker is VROOT
// (install(), below). So a relative './device.js' in a worker is
// '/app/device.js' on every OS (issue #40).
function resolveModulePath(name) {
  const base = PATH.isAbsolute(name) ? name : process.cwd();
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
        const host = m.toHost(PATH.posix.join(VROOT, PATH.posix.resolve('/', rest)));
        const hp = WIN32_HOST ? PATH.win32 : PATH.posix;
        const fold = (p) => (WIN32_HOST && matches(DRIVE, p) ? StringToUpperCase(p[0]) + StringSlice(p, 1) : p);
        const norm = fold(hp.resolve(host));
        const root = fold(hp.resolve(moduleRoot));
        if (norm !== root && !StringStartsWith(norm, StringEndsWith(root, hp.sep) ? root : root + hp.sep)) throw notFound(s);
        return host;
      }
      let t = fromWin(StringStartsWith(s, 'file:') ? fileURLToPath(s) : s);
      if (parent.fromModule && m.isVirtual(t)) return m.toHost(t);
      if (parent.host != null && (t === '.' || t === '..' || StringStartsWith(t, './') || StringStartsWith(t, '../'))) t = PATH.resolve(PATH.dirname(parent.host), t);
      return t;
    }
  };
  return m;
}

// The bare names that would resolve to a file in countinghouse's lib/ were
// lib/ a lookup path (the route NODE_PATH=lib would open: lib/module-
// lockdown.js reachesLib): "x" and "x.js" for lib/x.js, "dir/x" for
// lib/dir/x.js, and "dir" only where lib/dir has an index. Listed once when
// this file loads in a worker, at boot, before the file broker's patch
// (which answers a later runtime read outside a grant ENOENT), so a refusal
// is judged without resolving anything later (#194's revision 5); none on
// the main thread, which never installs the hooks. Compared in lower case
// where the platform's file names are (Windows, macOS).
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin';
const caseOf = (name) => (FOLDS_CASE ? StringToLowerCase(name) : name);
function libNamesOf(installDir) {
  const names = new Set();
  if (typeof(installDir) !== 'string' || isMainThreadAtLoad) return names;
  const fs = require('fs');
  const walk = (dir, rel, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch (e) { return; }
    for (const e of entries) {
      const name = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (fs.existsSync(PATH.join(dir, e.name, 'index.js')) || fs.existsSync(PATH.join(dir, e.name, 'index.json'))) SetAdd(names, caseOf(name));
        walk(PATH.join(dir, e.name), name, depth + 1);
        continue;
      }
      SetAdd(names, caseOf(name));
      if (StringEndsWith(name, '.js')) SetAdd(names, caseOf(StringSlice(name, 0, -3)));
      else if (StringEndsWith(name, '.json')) SetAdd(names, caseOf(StringSlice(name, 0, -5)));
    }
  };
  walk(PATH.join(installDir, 'lib'), '', 0);
  return names;
}

const LIB_NAMES = libNamesOf(PATH.resolve(__dirname, '..', '..'));

// True when a bare request names a file in lib/ (as written, with either
// separator, a trailing / or ./ steps), by the names listed at load: it
// resolves nothing, so it runs after the lockdown with no load (#194's PR
// 1). The file broker's resolve hook and the lockdown's refusal both use it.
function reachesLib(specifier) {
  if (typeof(specifier) !== 'string' || specifier === '' || StringStartsWith(specifier, '.') || StringStartsWith(specifier, '/')) return false;
  let name = PATH.posix.normalize(StringReplaceAll(specifier, '\\', '/'));
  while (StringEndsWith(name, '/')) name = StringSlice(name, 0, -1);
  return name !== '' && !StringStartsWith(name, '..') && SetHas(LIB_NAMES, caseOf(name));
}

// a request Node's resolver found nothing for, as Node words it, with the
// empty require stack Node gives one it has none for
function missing(specifier) {
  const err = new Error(`Cannot find module '${specifier}'`);
  ObjectDefineProperty(err, 'code', {__proto__: null, value: 'MODULE_NOT_FOUND', writable: true, enumerable: true, configurable: true});
  ObjectDefineProperty(err, 'requireStack', {__proto__: null, value: [], writable: true, enumerable: true, configurable: true});
  return err;
}

// An import's refusal (F4, #194's PR 3): the code Node gives a missing
// import, and one wording whether the target is missing or outside the
// module's root, so neither tells the other.
function importNotFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' (countinghouse module sandbox)`);
  ObjectDefineProperty(err, 'code', {__proto__: null, value: 'ERR_MODULE_NOT_FOUND', writable: true, enumerable: true, configurable: true});
  return err;
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
  // Sealed once the lockdown has sealed the runtime's modules away (#194's
  // PR 2, lib/module-lockdown.js seal, through the handle this returns):
  // from then on no resolution is the runtime's own, so countinghouse's code
  // roots are emptied (every site that grants them, the load's one-shot
  // grant of a file the runtime resolved among them, grants none) and every
  // parent is filtered as module code's is (the reviewer's item 7: what
  // exists in the runtime's tree is no answer module code can get). Before
  // it, the lockdown's own boot-time resolutions are unaffected. This
  // install's own, never a process-wide flag.
  let sealed = false;
  // (countinghouse's code roots as they were, for the one late load the
  // lockdown reports under audit: its library's files are among them; never
  // emptied, and never used outside that window)
  // (postman-request's own package and dependency closure, as the main
  // thread worked it out, fs-broker's lateRootsFor; none without it)
  const lateRoots = Array.isArray(cfg.lateRoots) ? cfg.lateRoots.slice() : [];
  // An error Node's resolver raised for the module's own request names the
  // host module root (a package.json, an "imported from" parent): named by
  // the module's own /app form instead, with no require stack (F4-1's
  // review; #194's revision 6, item 9)
  // (each own string of the error, its url too, as a path and as a file
  // URL, in the form the module sees its own files: /app, or <V>:\app on
  // Windows; its stack is never read, which could run what module code
  // put in Error.prepareStackTrace, and is its message line only, with no
  // frame naming a host file)
  const seenRoot = VDRIVE != null ? `${VDRIVE}:\\app` : m.toVirtual(moduleRoot);
  const rootHref = pathToFileHref(moduleRoot);
  const seenHref = pathToFileHref(seenRoot);
  // (the root only where no name goes on after it: a sibling /srv/mods/ab
  // is no /srv/mods/a, but '/srv/mods/a' quoted, at the end, or before a
  // separator is; by index, with no RegExp, whose replace module code
  // could hook)
  // (a boundary is any character that can't go on with a path segment: a
  // letter, digit or one of _-~+@ goes on, and so does a '.' followed by
  // one; anything else ends it, a newline or a sentence's closing '.' too)
  const goesOn = (c) => {
    if (c === '') return false;
    const n = StringCharCodeAt(c, 0);
    return (n >= 48 && n <= 57) || (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || c === '_' || c === '-' || c === '~' || c === '+' || c === '@' || n > 127;
  };
  const endsAt = (t, at) => {
    const c = StringSlice(t, at, at + 1);
    if (c === '.') return !goesOn(StringSlice(t, at + 1, at + 2));
    return !goesOn(c);
  };
  const replaceRoot = (t, from, to) => {
    let out = '';
    let at = 0;
    for (let i = StringIndexOf(t, from, 0); i !== -1; i = StringIndexOf(t, from, i + from.length)) {
      // (the next character by slice: an index past the end would be read
      // from String.prototype)
      if (!endsAt(t, i + from.length)) continue;
      out += StringSlice(t, at, i) + to;
      at = i + from.length;
    }
    return out + StringSlice(t, at);
  };
  const seenText = (t) => replaceRoot(replaceRoot(t, rootHref, seenHref), moduleRoot, seenRoot);
  // (the stack line's class, by the error's own prototype, as Node writes it)
  const classOf = (e) => (ObjectIsPrototypeOf(TypeErrorProto, e) ? 'TypeError' : ObjectIsPrototypeOf(RangeErrorProto, e) ? 'RangeError'
    : ObjectIsPrototypeOf(SyntaxErrorProto, e) ? 'SyntaxError' : 'Error');
  const asSeen = (e) => {
    if (e == null || typeof(e) !== 'object') return e;
    const own = (key, value, enumerable) => {
      try { ObjectDefineProperty(e, key, {__proto__: null, value, writable: true, enumerable, configurable: true}); } catch (x) { /* as it is */ }
    };
    const keys = ObjectKeys(e);
    for (let i = 0; i < keys.length; i++) {
      const d = ObjectGetOwnPropertyDescriptor(e, keys[i]);
      if (d != null && typeof(d.value) === 'string') own(keys[i], seenText(d.value), d.enumerable);
    }
    const md = ObjectGetOwnPropertyDescriptor(e, 'message');
    const message = (md != null && typeof(md.value) === 'string') ? seenText(md.value) : '';
    own('message', message, false);
    // (its code, by own data, as Node's own stack line gives it)
    const cd = ObjectGetOwnPropertyDescriptor(e, 'code');
    own('stack', `${classOf(e)}${cd != null && typeof(cd.value) === 'string' ? ` [${cd.value}]` : ''}: ${message}`, false);
    if (ObjectGetOwnPropertyDescriptor(e, 'requireStack') != null) own('requireStack', [], true);
    return e;
  };
  // The file this hook last resolved for countinghouse's own code: the load
  // hook grants Node's read of that one, for the load that comes right
  // after (a CommonJS require resolves and loads in one turn, so no module
  // code runs between), and of no other: a path in the code roots handed to
  // an extension handler by module code is no runtime read, and a
  // resolution that no load follows (require.resolve, a cached file) leaves
  // nothing standing (F4-1's reviews). Any other resolve clears it.
  let answered = null;
  let resolvingOwn = false;
  // the cache as the runtime holds it (taken at install, before module code)
  const realCache = Module._cache;
  const typeCache = new Map();
  const lasting = new Set();   // module files reached as CommonJS by import (below)

  // L2: from set-options on, every resolve is bounded, whoever the parent is.
  // (hostPath as resolved: a lexical `<root>/x/../../..` is judged where it
  // leads, F4-1)
  // (audit only: inside lazy-require's own late load, which the lockdown's
  // net reported, how deep; the library's own resolutions pass unsaid, as
  // the lockdown's hook passes them)
  let lateDepth = 0;
  function bound(hostPath, fromModule, specifier, asImport = false) {
    if (m.isModuleHost(hostPath)) return;
    if (!fromModule && anyOf(countinghouseRoots, (r) => insideHost(hostPath, r))) return;
    if (!fromModule && !enforce && sealed && lateDepth > 0 && anyOf(lateRoots, (r) => insideHost(hostPath, r))) return;
    const shown = StringSlice(StringCtor(specifier), 0, 200);
    reportL2('require', shown);
    if (enforce) throw (asImport ? importNotFound(shown) : notFound(shown));
  }

  // "type" from the nearest package.json, as Node decides it: the first one
  // found going up wins, and one without "type" means commonjs (review I1).
  function packageType(hostFile) {
    for (let dir = PATH.dirname(hostFile); m.isModuleHost(dir); dir = PATH.dirname(dir)) {
      if (MapHas(typeCache, dir)) return MapGet(typeCache, dir);
      let raw = null;
      try { raw = originals.readFileSync(PATH.join(dir, 'package.json'), 'utf8'); } catch (e) { raw = null; }
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
      if (dir === moduleRoot || dir === PATH.dirname(dir)) break;
    }
    return 'commonjs';
  }

  function formatOf(hostFile) {
    const ext = PATH.extname(hostFile);
    if (ext === '.json') return 'json';
    if (ext === '.mjs') return 'module';
    if (ext === '.cjs') return 'commonjs';
    return packageType(hostFile) === 'module' ? 'module' : 'commonjs';
  }

  // A parent URL's format, as Node decides it (its extension, then the
  // nearest package.json's "type"; a virtual path as its host file):
  // 'module', 'commonjs', or null for none to tell
  function formatOfParent(u) {
    if (typeof(u) !== 'string' || !StringStartsWith(u, 'file:')) return null;
    let p;
    try { p = fromWin(fileURLToPath(u)); } catch (e) { return null; }
    if (m.isVirtual(p)) p = m.toHost(p);
    // (TypeScript's own extensions as Node's type stripping takes them)
    const ext = PATH.extname(p);
    if (ext === '.mts') return 'module';
    if (ext === '.cts') return 'commonjs';
    return formatOf(p);
  }

  // Whether a resolution is a require: the one test this file's hook and
  // the lockdown's (its reduced module) both use (the review of e0f39de9).
  // Its conditions say so; or, said as an import, it comes from a CommonJS
  // parent in the shape Node up to 24.15 gives a require in CommonJS whose
  // source a load hook gave, resolved a second time with the import
  // conditions: a built-in, or a file: URL Node's CommonJS resolver has
  // already found. A CommonJS file's own import() of a file: URL has that
  // shape too and is taken as a require: a file: URL names one file, which
  // either resolver finds alike (no "exports" applies to it). A relative or
  // bare name from a CommonJS file's import() stays an import: as a require
  // it would lose an ES-only package's "import" export.
  function isRequire(specifier, context) {
    if (hasCondition(context, 'require')) return true;
    if (!hasCondition(context, 'import')) return false;
    if (typeof(specifier) !== 'string' || !(isBuiltin(specifier) || StringStartsWith(specifier, 'file:'))) return false;
    return formatOfParent(context != null ? context.parentURL : undefined) === 'commonjs';
  }

  // Through the resolve shim: below Node 24.15 it also runs this hook for
  // require.resolve and createRequire().resolve (lib/resolve-shim.js).
  // How deep inside this hook a resolution is: Module._resolveFilename,
  // called by Node's own default step from here, answers a host path, as
  // Node needs; called directly by module code, its virtual name (below)
  let hookDepth = 0;
  function resolveInHook(specifier, context, nextResolve) {
    answered = null;
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    // A CommonJS file reached by import keeps its host filename (below).
    // Node then loads it with Module._load(that filename), and on every
    // line that runs this hook with no parent: the lockdown's _load
    // forwards no internal argument, so Node 24's skip of the hooks there
    // is dropped (lib/module-lockdown.js, #406). Mapping it to /app again
    // would load a second copy under the virtual name and leave the
    // importer the first's empty exports: `lasting` is what stops that.
    if (typeof(specifier) === 'string' && SetHas(lasting, specifier)) {
      return {url: pathToFileHref(specifier), format: 'commonjs', shortCircuit: true};
    }
    const parent = m.parent(context.parentURL);
    const hostParent = parent.host;
    const fromModule = parent.fromModule;
    const s = m.specifier(specifier, parent);
    const asRequire = isRequire(specifier, context);
    const roots = [moduleRoot];
    if (!fromModule) for (let i = 0; i < countinghouseRoots.length; i++) put(roots, roots.length, countinghouseRoots[i]);
    // (and inside the one late load the lockdown reports under audit, its
    // library's own lookups: the code roots as they were; the review of
    // e0f39de9)
    // (after the seal only: before it the code roots above are those)
    if (!fromModule && !enforce && sealed && lateDepth > 0) for (let i = 0; i < lateRoots.length; i++) put(roots, roots.length, lateRoots[i]);
    let hostResolved = null;
    let format;
    const release = grant.resolving(roots);
    try {
      if (fromModule && hostParent != null && asRequire) {
        // require.resolve(s, {paths}) is resolved against the parent here;
        // its paths option is not honoured (review M2, documented).
        // Node's CommonJS resolver works from the parent Module object, whose
        // filename is virtual, so module-parent CommonJS requests are
        // resolved here against the host parent.
        // Node's own resolver, as taken before anything wraps it, with a
        // parent of plain own data (F4-1 (b): createRequire(...).resolve
        // was read through an assignment an accessor on
        // Function.prototype could swallow and answer). No hook runs inside
        // it; only a string is taken.
        // (under enforce, only lookup paths inside the module's root: one
        // above it is refused anyway, and its errors would name it)
        let lookup = ReflectApply(nodeModulePaths, Module, [PATH.dirname(hostParent)]);
        if (enforce) {
          const inside = [];
          for (let i = 0; i < lookup.length; i++) if (m.isModuleHost(lookup[i])) ObjectDefineProperty(inside, inside.length, {__proto__: null, value: lookup[i], writable: true, enumerable: true, configurable: true});
          lookup = inside;
        }
        const parentModule = {__proto__: null, id: hostParent, filename: hostParent, paths: lookup};
        // (not found: Node's own wording for the request alone, never its
        // message, which lists the host parent as its require stack; and
        // not the sandbox's refusal, since nothing was refused)
        let found;
        // (a guard: below Node 24.15, were the resolver taken here ever the
        // shim's wrapper, it would run this hook again for this request)
        // (fail closed, and said: it trips only when what Node's resolver
        // calls has been replaced, and requires again)
        if (resolvingOwn) {
          reportL2('require', StringSlice(StringCtor(specifier), 0, 200));
          throw notFound(StringSlice(StringCtor(specifier), 0, 200));
        }
        resolvingOwn = true;
        try { found = ReflectApply(nodeResolveFilename, Module, [s, parentModule, false]); } catch (e) {
          if (e != null && (e.code === 'MODULE_NOT_FOUND' || e.code === 'ENOENT')) {
            // one that names a file in countinghouse's lib/ is the
            // sandbox's refusal: reported, and under enforce said so. This
            // hook runs ahead of the lockdown's, whose catch said it when
            // the resolution ran its chain again (before F4-1).
            const shown = StringSlice(StringCtor(specifier), 0, 200);
            if (reachesLib(specifier)) {
              reportL2('require', shown);
              if (enforce) throw notFound(shown);
            }
            throw missing(StringCtor(specifier));
          }
          throw asSeen(e);
        } finally {
          resolvingOwn = false;
        }
        if (typeof(found) !== 'string') throw notFound(StringSlice(StringCtor(specifier), 0, 200));
        if (isBuiltin(found)) return nextResolve(found, context);
        hostResolved = found;
      } else {
        // CommonJS requests take a path, ES module requests a URL.
        const isRequire = asRequire;
        // the context as Node gave it, with the host parent
        const next = mergedContext(context, {parentURL: hostParent != null ? pathToFileHref(hostParent) : context.parentURL});
        // (F4, #194's PR 3: under enforce, module code's import is no
        // existence oracle. A path or URL outside the root is refused before
        // Node's resolver reads anything for it; a bare or '#' name, which
        // Node looks up in every node_modules above the root, answers one
        // refusal for anything it can't resolve, as bound() answers one it
        // finds outside: missing, outside, or an exports error alike.)
        const guarded = enforce && fromModule && !isRequire;
        if (guarded && PATH.isAbsolute(s) && !m.isModuleHost(resolvedPath(s))) {
          const shown = StringSlice(StringCtor(specifier), 0, 200);
          reportL2('require', shown);
          throw importNotFound(shown);
        }
        const bareName = typeof(specifier) === 'string' && !PATH.isAbsolute(s) && !StringStartsWith(specifier, '.') &&
          !StringStartsWith(specifier, '/') && !(StringIndexOf(specifier, ':') !== -1 && !StringStartsWith(specifier, '#'));
        let r;
        try { r = nextResolve(PATH.isAbsolute(s) && !isRequire ? pathToFileHref(s) : s, next); } catch (e) {
          if (guarded && bareName) throw importNotFound(StringSlice(StringCtor(specifier), 0, 200));
          throw fromModule ? asSeen(e) : e;
        }
        if (typeof(r.url) !== 'string' || !StringStartsWith(r.url, 'file:')) return r;
        hostResolved = fileURLToPath(r.url);
        format = r.format;
      }
    } finally {
      release();
    }
    // judged, and answered, as resolved: the URL below is built from the
    // very path bound() checked (F4-1)
    hostResolved = resolvedPath(hostResolved);
    bound(hostResolved, fromModule, specifier, enforce && fromModule && !asRequire);
    // Two kinds of module file keep their host URL, because Node loads them
    // from disk by filename itself:
    // - native addons (part 1 refuses them under enforce, reports under audit);
    // - a CommonJS file reached by import: Node 24 marks a resolve that ran
    //   its default resolver as not resolved by hooks, and its CommonJS
    //   translator then re-resolves the filename with the hooks skipped
    //   (internal/modules/esm/translators.js, loadCJSModuleWithModuleLoad),
    //   so a virtual filename is not found. Only that file's own
    //   __filename shows the host path; what it requires is virtual again.
    const importedCjs = m.isModuleHost(hostResolved) && (format || formatOf(hostResolved)) === 'commonjs' && !asRequire;
    if (m.isModuleHost(hostResolved) && PATH.extname(hostResolved) !== '.node' && !importedCjs) {
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
    // (countinghouse's own files only, read once each: CHUtil.loadFile
    // resolves a path the module picked from a countinghouse parent)
    // (not for a file Node's cache will answer: no load follows that)
    // (and under audit, inside lazy-require's late load the lockdown's net
    // reported, the library's own file: read as the runtime's, never
    // logged as the module's read)
    answered = (!fromModule && realCache[hostResolved] === undefined &&
      (anyOf(countinghouseRoots, (r) => insideHost(hostResolved, r)) ||
       (!enforce && sealed && lateDepth > 0 && anyOf(lateRoots, (r) => insideHost(hostResolved, r))))) ? hostResolved : null;
    return {url: pathToFileHref(hostResolved), format: format, shortCircuit: true};
  }
  resolveShim.registerHooks(cfg.registerHooks || Module.registerHooks, {
    resolve(specifier, context, nextResolve) {
      hookDepth++;
      try { return resolveInHook(specifier, context, nextResolve); } finally { hookDepth--; }
    },
    load(hookUrl, context, nextLoad) {
      const granted = answered;
      answered = null;
      if (typeof(hookUrl) === 'string' && StringStartsWith(hookUrl, 'file:')) {
        const p = fromWin(fileURLToPath(hookUrl));
        if (m.isVirtual(p) && PATH.extname(p) !== '.node') {
          // normalised, and still the module's own once it is
          const virtual = PATH.posix.resolve(p);
          if (!m.isVirtual(virtual)) throw notFound(StringSlice(StringCtor(hookUrl), 0, 200));
          const host = m.toHost(virtual);
          if (!m.isModuleHost(host)) throw notFound(StringSlice(StringCtor(hookUrl), 0, 200));
          const format = formatOf(host);
          const source = originals.readFileSync(host, format === 'commonjs' ? undefined : 'utf8');
          return {format: format, source: source, shortCircuit: true};
        }
        // F4-1: a grant only for what the runtime may read for itself: a
        // file this hook resolved for countinghouse's own code, a module file
        // reached as CommonJS by import (granted in resolve). Any other path
        // is the module's
        // request, whoever passed it here (Node's extension handlers, a
        // Module of its own), a path in countinghouse's code included: Node's
        // read then meets the broker with the module's own rights, refused
        // under enforce outside its grants and reported under audit.
        const h = resolvedPath(p);
        // (an answered file once: a grant left standing would let module
        // code read it again through an extension handler. Node runs no load
        // hook for a CommonJS .node, which it opens natively: none is
        // granted here)
        const wasAnswered = granted !== null && granted === h;
        const runtimes = wasAnswered || SetHas(lasting, h);
        if (!runtimes) return nextLoad(hookUrl, context);
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
      if (typeof(p) !== 'string' || !PATH.isAbsolute(p)) return true;   // relative requests resolve against allowed parents
      const h = PATH.resolve(p);
      // (after the seal no caller is the runtime's: the code roots are no
      // answer, a runtime file's stat or package read as missing, item 7)
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
    // A path as Node takes it: an absolute one, or a file: URL in any case
    // (parsed as Node parses it, File:///x included); anything else none
    // (null), so nothing unchecked reaches Node's own read (#434's Fable
    // pass, F2)
    const pathOf = (g) => {
      if (typeof(g) !== 'string') return null;
      let p = g;
      if (!PATH.isAbsolute(p)) {
        try { p = fileURLToPath(g); } catch (e) { return null; }
      }
      // (a trailing separator kept: Node reads it as a directory)
      const last = StringSlice(p, -1);
      const slash = last === '/' || (VDRIVE != null && last === '\\');
      // (a virtual /app/... name, the module's own as module code spells
      // it, in its host form: Node would read it as the literal host /app)
      const v = fromWin(p);
      let r;
      if (PATH_POSIX.isAbsolute(v) && m.isVirtual(PATH_POSIX.resolve(v))) {
        if (StringIndexOf(v, '\\') !== -1) return null;
        r = m.toHost(PATH_POSIX.resolve(v));
      }
      else r = PATH.resolve(p);
      return slash && StringSlice(r, -1) !== PATH.sep ? r + PATH.sep : r;
    };
    // An array-like of lookup paths as a fresh array, read once by Array.from
    // as this file took it (Node walks any array-like; F3)
    // (a string is no list: never split into its characters)
    const listOf = (v) => {
      if (v == null || typeof(v) !== 'object') return [];
      try { return ReflectApply(ArrayFrom, ArrayCtor, [v]); } catch (e) { return []; }
    };
    // After the seal a parent is the module's or none: a primitive (whose
    // filename Node would read off its prototype, which module code can set)
    // or one whose filename is outside the module's root is refused before
    // Node sees it (Node reads the package.json above parent.filename
    // natively, for a self-reference or a '#' import, before any lookup this
    // file filters), and an own one is handed on as a copy, its filename, id
    // and lookup paths each read once, so what Node reads is what was
    // checked (#434's Fable pass, F1).
    // A filename is the module's as already resolved (a genuine Module's
    // is; /app/../<host path> is not, however it starts), and is handed to
    // Node in its host form: Node reads a virtual /app/... name as the
    // literal host /app, which is no part of the module (the review of
    // e0f39de9). -> the host file, or null
    // a module file's host path by its virtual name, as module code knows it
    // (the <V>:\\app form on Windows, #195)
    const virtualName = (h) => {
      const v = m.toVirtual(h);
      return VDRIVE != null ? `${VDRIVE}:${swapped(v, '/', '\\')}` : v;
    };
    // (a FILE inside the root, never the root itself: Node's package.json
    // walk starts at a parent's directory, the root's own parent for the
    // root (E2); and a virtual name with a backslash refused on every OS:
    // toHost makes each one a separator on Windows, so /app/x\\..\\f
    // would leave the root there after this check (E1); the review of
    // #434's round 4)
    const ownHost = (f) => {
      const v = fromWin(f);
      if (PATH_POSIX.isAbsolute(v) && PATH_POSIX.resolve(v) === v && m.isVirtual(v)) {
        if (StringIndexOf(v, '\\') !== -1 || v === VROOT) return null;
        return m.toHost(v);
      }
      // (the root by the host's own rules: the drive letter in either case
      // on Windows, as isModuleHost reads it)
      const isRoot = insideHost(f, moduleRoot) && insideHost(moduleRoot, f);
      return (PATH.isAbsolute(f) && PATH.resolve(f) === f && m.isModuleHost(f) && !isRoot) ? f : null;
    };
    // (one copy per parent object, reused while its filename and lookup
    // paths read as they did when it was made: a Module's paths a module
    // changes later, app-module-path's way, are taken then; a refusal is
    // judged again each time)
    const copies = new WeakMapCtor();
    const sameList = (a, b) => {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
      return true;
    };
    const parentAfterSeal = (parent, request) => {
      if (parent == null) return parent;
      const refused = () => notFound(StringSlice(StringCtor(request), 0, 200));
      if (typeof(parent) !== 'object' && typeof(parent) !== 'function') throw refused();
      let filename;
      let lookups;
      try { filename = ReflectGet(parent, 'filename'); lookups = ReflectGet(parent, 'paths'); } catch (e) { throw refused(); }
      const list = listOf(lookups);
      const made = WeakMapGet(copies, parent);
      if (made !== undefined && made.given === filename && sameList(made.list, list)) return made.copy;
      const copy = {__proto__: null};
      if (typeof(filename) === 'string') {
        const host = ownHost(filename);
        if (host == null) throw refused();
        copy.id = host;
        copy.filename = host;
      }
      // (each lookup path in its host form too: a virtual one is the
      // module's own, read by Node as the literal host /app otherwise)
      const paths = [];
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (typeof(p) !== 'string') continue;
        const v = fromWin(p);
        if (PATH_POSIX.isAbsolute(v) && PATH_POSIX.resolve(v) === v && m.isVirtual(v)) {
          // (no virtual one with a backslash: a separator on Windows, E1)
          if (StringIndexOf(v, '\\') === -1) put(paths, paths.length, m.toHost(v));
          continue;
        }
        put(paths, paths.length, p);
      }
      copy.paths = paths;
      WeakMapSet(copies, parent, {__proto__: null, given: filename, list, copy});
      return copy;
    };
    const replace = (key, fn) => {
      if (typeof(Module[key]) !== 'function') return;
      Object.defineProperty(Module, key, {writable: false, configurable: false, enumerable: true, value: fn(Module[key])});
    };
    // (a stat or a package read is of a path, never a request: after the
    // seal anything but an absolute path answers missing, Node's own loader
    // passing only those, so what is checked is what the original is given;
    // item 7)
    const statAllowed = (p) => {
      if (!sealed) return allowed(p);
      return typeof(p) === 'string' && PATH.isAbsolute(p) && allowed(p);
    };
    replace('_stat', (orig) => function(filename) { return statAllowed(filename) ? ReflectApply(orig, this, [filename]) : -2; });
    replace('_findPath', (orig) => function(request, paths, isMain) {
      if (!allowed(request)) return false;
      // (after the seal the lookup paths given are filtered as
      // _resolveLookupPaths' are: a runtime package is never looked into,
      // so none of its errors is an answer about it)
      if (sealed && paths != null) {
        const given = listOf(paths);
        const kept = [];
        for (let i = 0; i < given.length; i++) {
          const p = given[i];
          // (a virtual one with a backslash dropped, as a parent's are, E1)
          if (typeof(p) === 'string' && ((m.isVirtual(fromWin(p)) && StringIndexOf(fromWin(p), '\\') === -1) || (PATH.isAbsolute(p) && allowed(p)))) put(kept, kept.length, p);
        }
        paths = kept;
      }
      let found;
      try { found = ReflectApply(orig, this, [request, paths, isMain]); } catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
      return (found === false || allowed(found)) ? found : false;
    });
    replace('_resolveFilename', (orig) => function(...args) {
      const request = args[0];
      if (isBuiltin(request)) return ReflectApply(orig, this, args);
      if (sealed) args = [request, parentAfterSeal(args[1], request), args[2], args[3]];
      let found;
      try { found = ReflectApply(orig, this, args); } catch (e) {
        if (e && e.code === 'ENOENT') throw notFound(StringSlice(StringCtor(request), 0, 200));
        // (after the seal as module code sees it: the host parent the copy
        // carries never named in its require stack or a package path)
        throw sealed ? asSeen(e) : e;
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
      const virtualOwn = isHookAnswer(found) && typeof(own) === 'string' && PATH.posix.isAbsolute(own) &&
        m.isVirtual(PATH.posix.resolve(own)) && m.isModuleHost(m.toHost(PATH.posix.resolve(own)));
      if (typeof(found) === 'string' && !isBuiltin(found) && !virtualOwn && !allowed(found)) throw notFound(StringSlice(StringCtor(request), 0, 200));
      // (after the seal a module file Node found from a host-form copy is
      // answered by its virtual name, as module code knows its files: to a
      // direct call only, never Node's own default step inside this file's
      // hook, which needs the host path)
      if (sealed && hookDepth === 0 && typeof(found) === 'string' && !virtualOwn && !isBuiltin(found) && m.isModuleHost(found)) return virtualName(found);
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
      if (!ArrayIsArray(found) || (!fromModule && !sealed)) return found;
      const vNodeModules = VDRIVE != null ? `${VDRIVE}:\\node_modules` : null;
      const kept = [];
      for (let i = 0; i < found.length; i++) {
        const p = found[i];
        // (after the seal, a parent of any shape: the module's own paths
        // only, its root's host node_modules among them)
        if (typeof(p) === 'string' && (p === '/node_modules' || p === vNodeModules || m.isVirtual(fromWin(p)) || (sealed && m.isModuleHost(p)))) put(kept, kept.length, p);
      }
      return kept;
    });
    replace('_readPackage', (orig) => function(...args) {
      // read once, as a string, and that string handed on in an array of
      // its own (an index write would run a setter a module put on
      // Array.prototype, which could hand on another directory)
      const dir = StringCtor(args[0]);
      if (statAllowed(PATH.join(dir, 'package.json'))) return ReflectApply(orig, this, [dir]);
      return {type: 'none', exists: false, pjsonPath: PATH.join(dir, 'package.json')};
    });
    replace('findPackageJSON', (orig) => function(specifier, given) {
      // (the base as a path, checked, and that path what Node is given: a
      // base that is no path or URL Node takes is answered as nothing)
      let base = asGiven(given);
      if (base != null) {
        base = pathOf(base);
        if (base == null || !allowed(base)) return undefined;
      }
      // (after the seal the specifier too: an absolute one, a path or a
      // file: URL in any case, or a relative one resolved against the base,
      // is judged as the base is, never one of the runtime's walked, and is
      // handed on as the path judged)
      let spec = specifier;
      if (sealed) {
        spec = asGiven(specifier);
        if (typeof(spec) === 'string') {
          const relative = spec === '.' || spec === '..' || StringStartsWith(spec, './') || StringStartsWith(spec, '../') ||
            (VDRIVE != null && (StringStartsWith(spec, '.\\') || StringStartsWith(spec, '..\\')));
          // (against the base's directory: the base itself when it names
          // one, with its trailing separator, as Node's URL resolution has it)
          const baseDir = base == null ? null : ((StringSlice(base, -1) === '/' || (VDRIVE != null && StringSlice(base, -1) === '\\')) ? base : PATH.dirname(base));
          const slash = StringSlice(spec, -1) === '/' || (VDRIVE != null && StringSlice(spec, -1) === '\\');
          let judged = relative ? (baseDir != null ? PATH.resolve(baseDir, spec) : null) : pathOf(spec);
          if (relative && judged == null) return undefined;
          if (judged != null) {
            if (!allowed(judged)) return undefined;
            // (handed on as a file URL: Node parses the specifier as a URL,
            // so a native path is a drive-letter scheme on Windows, and its
            // %-escapes would be decoded after this check; a directory kept
            // as one; the review of e0f39de9)
            if (relative && slash && StringSlice(judged, -1) !== PATH.sep) judged += PATH.sep;
            spec = pathToFileHref(judged);
          }
        }
      }
      // (after the seal a bare specifier makes Node walk each node_modules
      // above the base natively: whether it finds one outside the module's
      // root, or throws for none, is one answer, nothing)
      let found;
      try { found = ReflectApply(orig, this, [spec, base]); } catch (e) { if (sealed) return undefined; throw e; }
      if (found == null || !allowed(found)) return undefined;
      // (a module file by its virtual name, as module code knows its files)
      if (typeof(found) === 'string' && m.isModuleHost(found)) return virtualName(found);
      return found;
    });
  }
  installed = true;

  // The module's view of its process: the current directory is /app and the
  // temp directory is /tmp (spec section 1). Workers cannot chdir.
  const os = require('os');
  const cwd = VDRIVE != null ? `${VDRIVE}:\\app` : VROOT;
  Object.defineProperty(process, 'cwd', {value: () => cwd, writable: false, configurable: false});
  Object.defineProperty(os, 'tmpdir', {value: () => '/tmp', writable: false, configurable: false, enumerable: true});
  // the lockdown's hold on this install: seal() at its last step (#194's
  // PR 2), never module code's (a frozen object only the lockdown is handed)
  return Object.freeze({__proto__: null,
    seal() {
      sealed = true;
      countinghouseRoots.length = 0;
    },
    // the lockdown's mark of lazy-require's late load under audit: +1 as it
    // starts, -1 as it ends
    lateLoad(delta) {
      if (!enforce && (delta === 1 || delta === -1)) lateDepth = lateDepth + delta < 0 ? 0 : lateDepth + delta;
    },
    // a parent URL's format, as Node decides it (its extension, then the
    // nearest package.json's "type"; a virtual path as its host file):
    // 'module', 'commonjs', or null for none to tell (the lockdown's
    // reduced module, served as a CommonJS parent can take it)
    formatOfParent,
    isRequire
  });
}

// How countinghouse's own worker code names a module file (module-manager,
// handler-map): never a bare "/app", which from countinghouse code is a host path.
// The runtime's loads of a module's own files (its handlers, CHUtil.loadFile):
// by Node's _load as this file took it at boot, with the module's own anchor
// as their parent (#194's PR 1; the review of #425). Never a runtime Module,
// so module.parent can't hand one to module code; and never null, which
// would run a module's entry-point code (`if (!module.parent) main()`, the
// CLI idiom) inside the worker on every load. The anchor is a Module made
// afresh for each load, its file inside the module root
// (.countinghouse-entry, no file on disk): its require is the module's own,
// so it hands module code nothing it hadn't; and since none is used twice,
// module code that rewrites the one it holds (its children, filename, paths)
// shapes no later load of the runtime's, and none keeps an unloaded graph
// alive. In a worker the root is /app (X:\app on Windows); a load without
// the hooks (single-thread mode's CHUtil.loadFile, a host path) is anchored
// in the file's own directory, inside its module too.
const NodeLoad = Module._load;
const ModuleCtor = Module;
const ANCHOR_NAME = '.countinghouse-entry';
function anchorIn(dir, file) {
  const anchor = new ModuleCtor(file, null);
  anchor.filename = file;
  // worked out for each anchor by Node's own (primordial) function: a copy
  // made here would go through Array's species, which module code can set
  anchor.paths = ReflectApply(nodeModulePaths, ModuleCtor, [dir]);
  anchor.loaded = true;
  return anchor;
}
// Once the hooks are installed (a module's worker, a validation worker) only
// a module file is loaded here, anchored at the module root: any other path
// (countinghouse's lib/, its node_modules, anything outside /app) is
// refused, never anchored where it names, which would load it as the
// runtime's and hand its exports back (#425's final review). Without the
// hooks (single-thread mode: no sandbox) a file is anchored in its own
// directory.
function loadModuleFile(specifier) {
  const s = StringCtor(specifier);
  let anchor;
  if (StringStartsWith(s, MODULE_SPECIFIER)) {
    anchor = VDRIVE != null ? anchorIn(`${VDRIVE}:\\app`, `${VDRIVE}:\\app\\${ANCHOR_NAME}`) : anchorIn(VROOT, `${VROOT}/${ANCHOR_NAME}`);
  } else if (installed) {
    throw notFound(s);
  } else {
    const dir = PATH.dirname(s);
    anchor = anchorIn(dir, PATH.join(dir, ANCHOR_NAME));
  }
  return ReflectApply(NodeLoad, ModuleCtor, [s, anchor, false]);
}

function moduleSpecifier(virtualPath) {
  return MODULE_SPECIFIER + StringSlice(fromWin(StringCtor(virtualPath)), VROOT.length);
}

// What countinghouse code passes to require() for a path a module gave it
// (CHUtil.loadFile(`${__dirname}/device.js`)): the module specifier once the
// hook is installed, the path itself otherwise (single-thread mode).
function specifierFor(p) {
  return (installed && inside(fromWin(p), VROOT)) ? moduleSpecifier(p) : p;
}

module.exports = {install, mapper, fromWinFor, loadModuleFile, reachesLib, insideHostFor, withoutModuleRoots, moduleSpecifier, specifierFor, codeUnderVroot, underVrootMessage, codeRootsFor, lateRootsFor, pathFor, resolveModulePath, VROOT, MODULE_SPECIFIER};
