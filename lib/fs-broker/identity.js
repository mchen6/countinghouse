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
// (below Node 24.15 the resolve shim runs this file's hook for a direct
// call too, which answers a module file by its virtual name)
const {NEEDS_RESOLVE_SHIM} = require('../node-version');
// taken now: resolve-shim's exports object is reachable from module code
// through the require cache
const {hasCondition, isHookAnswer, mergedContext} = resolveShim;
const {createResolver: createInsideResolver} = require('./resolve-inside');
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
const StringLastIndexOf = uncurry(String.prototype.lastIndexOf);
const StringCharCodeAt = uncurry(String.prototype.charCodeAt);
const StringToUpperCase = uncurry(String.prototype.toUpperCase);
const StringToLowerCase = uncurry(String.prototype.toLowerCase);
const RegExpExec = uncurry(RegExp.prototype.exec);
const matches = (re, str) => RegExpExec(re, str) !== null;
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const SetForEach = uncurry(Set.prototype.forEach);
const MapHas = uncurry(Map.prototype.has);
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const WeakMapCtor = WeakMap;
const WeakMapGet = uncurry(WeakMap.prototype.get);
const WeakMapSet = uncurry(WeakMap.prototype.set);
const JSONParse = JSON.parse;
const ArrayIsArray = Array.isArray;
const isProxy = require('util').types.isProxy;
const ArrayCtor = Array;
const ArrayFrom = Array.from;
const ReflectGet = Reflect.get;
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;
const ObjectFreeze = Object.freeze;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const TypeErrorProto = TypeError.prototype;
const TypeErrorCtor = TypeError;
// (C-lows: stack frames, held at the seal -- taken at load, before module
// code runs)
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
const ObjectCreate = Object.create;
const ObjectPrototype = Object.prototype;
const ErrorCaptureStackTrace = Error.captureStackTrace;
const ErrorPrototypeToString = uncurry(Error.prototype.toString);
// (Node's own errors' mark, taken at load from one of them: its stack
// header is `name [code]: message`, as Node's default writes it)
const IS_NODE_ERROR = (() => {
  let e = null;
  try { Buffer.alloc(-1); } catch (x) { e = x; }
  for (let o = e; o != null; o = Object.getPrototypeOf(o)) {
    const found = Object.getOwnPropertySymbols(o).find((sym) => sym.description === 'kIsNodeError');
    if (found !== undefined) return found;
  }
  return null;
})();
const MathFloor = Math.floor;
// (util, for its getCallSites, held at the seal: taken at load)
const UTIL = require('util');
const RangeErrorProto = RangeError.prototype;
const SyntaxErrorProto = SyntaxError.prototype;

const URLHref = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'href').get);
const URLProtocol = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get);
const URLPathname = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'pathname').get);
const URLSearch = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'search').get);
const URLHash = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'hash').get);
const URLCtor = URL;
const URLCanParse = URL.canParse;
const WeakMapHas = uncurry(WeakMap.prototype.has);
// (the refusals this file made, each to the name it refused: one passing
// back through another of its layers is answered as it is, never remade)
const refusals = new WeakMapCtor();
const ownRefusal = (e) => e != null && (typeof(e) === 'object' || typeof(e) === 'function') && WeakMapHas(refusals, e);
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
// Whether a '/'-absolute import names the virtual root on Windows (its path
// before any query or fragment)
const virtualAbsolute = (spec) => {
  if (VDRIVE == null) return false;
  let end = spec.length;
  const q = StringIndexOf(spec, '?');
  const h = StringIndexOf(spec, '#');
  if (q !== -1) end = q;
  if (h !== -1 && h < end) end = h;
  const pathPart = StringSlice(spec, 0, end);
  return pathPart === VROOT || StringStartsWith(pathPart, `${VROOT}/`);
};
// A Windows namespaced path in its plain form: \\?\D:\x as D:\x, and
// \\?\UNC\server\share\x as \\server\share\x. A device or volume name
// (\\?\Volume{...}\, \\?\GLOBALROOT\...) or a drive-relative one
// (\\?\D:x) stays as it is, absolute, and is judged as it is (refused).
// A plain path means something else where a component (not '.' or '..'
// itself) ends in '.' or a space, which Win32 trims ('.. ' is the parent
// there, never in the namespaced form, and never to path.resolve): such a
// path, stripped or given plain, either separator, is null, no path, and
// refused. On any other OS, everything as it is. fromNamespacedFor(win) for
// a given platform (the tests, on any OS); fromNamespaced, this host's,
// fixed at load.
const NAMESPACED_DRIVE = /^\\\\\?\\[a-zA-Z]:\\/;
const NAMESPACED_UNC = /^\\\\\?\\UNC\\/i;
const TRIMMED_COMPONENT = /(?:^|[\\/])(?!\.{1,2}(?:[\\/]|$))[^\\/]*[. ](?:[\\/]|$)/;
const fromNamespacedFor = (win) => (p) => {
  if (!win || typeof(p) !== 'string') return p;
  let plain = p;
  if (matches(NAMESPACED_DRIVE, p)) plain = StringSlice(p, 4);
  else if (matches(NAMESPACED_UNC, p)) plain = `\\\\${StringSlice(p, 8)}`;
  else if (StringStartsWith(p, '\\\\?\\')) return p;
  // (stripped once: one still namespaced after it, \\?\UNC\?\D:\..., is
  // no path)
  if (plain !== p && StringStartsWith(plain, '\\\\?\\')) return null;
  return matches(TRIMMED_COMPONENT, plain) ? null : plain;
};
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
const fromNamespaced = fromNamespacedFor(WIN32_HOST);
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

// The sandbox's refusal, one factory for each kind: a require's
// (MODULE_NOT_FOUND) or an import's (ERR_MODULE_NOT_FOUND, the code Node
// gives a missing import), one wording whether the target is missing or
// outside the module's root, so neither tells the other; with a
// requireStack, of virtual names only, where one is given (the high review
// of #440).
// Whether a URL's pathname holds an encoded '/' or '\', as Node's ES
// resolver tests it (either case)
const encodedSeparator = (pathname) => {
  for (let i = StringIndexOf(pathname, '%', 0); i !== -1; i = StringIndexOf(pathname, '%', i + 1)) {
    const e = StringToUpperCase(StringSlice(pathname, i + 1, i + 3));
    if (e === '2F' || e === '5C') return true;
  }
  return false;
};

// Node's refusal of such a URL, by the name module code gave: Node's own
// wording, its code and class
function invalidSpecifier(specifier) {
  const err = new TypeErrorCtor(`Invalid module "${StringSlice(StringCtor(specifier), 0, 200)}" must not include encoded "/" or "\\" characters`);
  ObjectDefineProperty(err, 'code', {__proto__: null, value: 'ERR_INVALID_MODULE_SPECIFIER', writable: true, enumerable: true, configurable: true});
  return err;
}

function notFound(specifier, code = 'MODULE_NOT_FOUND', requireStack = null) {
  const err = new Error(`Cannot find module '${specifier}' (countinghouse module sandbox)`);
  ObjectDefineProperty(err, 'code', {__proto__: null, value: code, writable: true, enumerable: true, configurable: true});
  // (a require's always has one, as Node's has: the given virtual names, or
  // none; an import's has none, as Node's hasn't)
  if (code === 'MODULE_NOT_FOUND') ObjectDefineProperty(err, 'requireStack', {__proto__: null, value: requireStack != null ? requireStack : [], writable: true, enumerable: true, configurable: true});
  WeakMapSet(refusals, err, specifier);
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
  // (in a URL form a '%' goes on too, an escape inside the name, but for
  // an encoded '/' or '\', which ends it)
  const endsAt = (t, at, encoded = false) => {
    const c = StringSlice(t, at, at + 1);
    if (encoded && c === '%') return encodedSeparator(StringSlice(t, at, at + 3));
    if (c === '.') return !goesOn(StringSlice(t, at + 1, at + 2));
    return !goesOn(c);
  };
  const replaceRoot = (t, from, to, encoded = false) => {
    let out = '';
    let at = 0;
    for (let i = StringIndexOf(t, from, 0); i !== -1; i = StringIndexOf(t, from, i + from.length)) {
      // (the next character by slice: an index past the end would be read
      // from String.prototype)
      if (!endsAt(t, i + from.length, encoded)) continue;
      out += StringSlice(t, at, i) + to;
      at = i + from.length;
    }
    return out + StringSlice(t, at);
  };
  // (and the URL's pathname, percent-encoded, which Node quotes alone in
  // an invalid specifier's message: '/srv/my%20mods', '/C:/mods')
  const rootPathname = URLPathname(new URLCtor(rootHref));
  const seenPathname = URLPathname(new URLCtor(seenHref));
  const seenText = (t) => replaceRoot(replaceRoot(replaceRoot(t, rootHref, seenHref, true), rootPathname, seenPathname, true), moduleRoot, seenRoot);

  // C-lows (ruled): every stack module code can read names the runtime's own
  // files by a virtual name, countinghouse:/<its path in the install>, never
  // the install directory. V8's CallSite methods can't be replaced (they are
  // non-writable and non-configurable on every Node line), so the seal holds
  // Error.prepareStackTrace as an accessor, as process.emitWarning is held:
  // the getter is this file's formatter, or a view of module code's function
  // when it set one (below), the setter keeps what module
  // code assigns. The formatter runs only intrinsics taken at load -- and the
  // module's own function, with frame wrappers: one prototype made here at
  // load from the captured CallSite methods, frozen, never CallSite's own,
  // whose names it carries all (source-map-support copies them), whose
  // file names are virtual, and whose getThis and getFunction answer
  // nothing for a runtime frame, as a strict frame's do.
  const installDirOf = typeof(cfg.installDir) === 'string' ? cfg.installDir : null;
  const runtimeRenames = [];
  {
    // (the install by its real path too, and each of its own entries by
    // theirs -- a linked or symlinked install runs its files by real paths:
    // still countinghouse:/lib/..., never a node_modules name; read on the
    // main thread, installSpellingsFor, and handed in: the worker reads
    // nothing for them)
    const spellings = Array.isArray(cfg.installSpellings) ? cfg.installSpellings : [];
    // (a target is spelled with the host's own separator, as the rest of the
    // path it heads keeps its own: countinghouse:\lib\x.js on Windows; a file
    // URL's with '/', as the URL's rest is)
    const renames = [];
    const SEP = PATH.sep;
    const add = (from, to) => { if (typeof(from) === 'string' && from !== '') put(renames, renames.length, {__proto__: null, from, to}); };
    for (let i = 0; i < spellings.length; i++) {
      const sp = spellings[i];
      if (sp != null && typeof(sp.from) === 'string' && typeof(sp.to) === 'string' && StringStartsWith(sp.to, 'countinghouse:') && sp.from !== installDirOf) add(sp.from, sp.to);
    }
    if (installDirOf != null) add(installDirOf, 'countinghouse:');
    for (let i = 0; i < countinghouseRoots.length; i++) {
      const r = countinghouseRoots[i];
      // (by its path from its nearest node_modules: @scope/name, never a
      // basename two packages could share)
      if (typeof(r) === 'string' && (installDirOf == null || !insideHost(r, installDirOf))) {
        const mark = `${PATH.sep}node_modules${PATH.sep}`;
        const at = StringLastIndexOf(r, mark);
        const name = at === -1 ? PATH.basename(r) : StringReplaceAll(StringSlice(r, at + mark.length), PATH.sep, '/');
        add(r, `countinghouse:/node_modules/${name}`);
      }
    }
    for (let i = 0; i < renames.length; i++) {
      const to = renames[i].to;
      put(runtimeRenames, runtimeRenames.length, {__proto__: null, from: renames[i].from, href: pathToFileHref(renames[i].from),
        to: SEP === '/' ? to : StringReplaceAll(to, '/', SEP), toHref: to});
    }
  }
  const runtimeText = (t) => {
    if (typeof(t) !== 'string') return t;
    let out = t;
    for (let i = 0; i < runtimeRenames.length; i++) {
      out = replaceRoot(out, runtimeRenames[i].href, runtimeRenames[i].toHref, true);
      // (on Windows the rest of a renamed path keeps its '\': stacks and
      // messages read countinghouse:\lib\x.js there -- no rewriting inside
      // free text, ruled M-win)
      out = replaceRoot(out, runtimeRenames[i].from, runtimeRenames[i].to);
    }
    return out;
  };
  // (a frame of the module's own files: its virtual names, or its root's host
  // form -- only such a frame answers getThis and getFunction)
  const isModuleFile = (name) => {
    if (typeof(name) !== 'string') return false;
    let p = name;
    if (StringStartsWith(p, 'file:')) { try { p = fileURLToPath(p); } catch (e) { return false; } }
    return insideHost(p, seenRoot) || insideHost(p, moduleRoot);
  };

  const holdStackFrames = () => {
    // (a real CallSite's toString, read once; Error.stackTraceLimit raised
    // to 10 meanwhile: at 0 no frame is made)
    let callSiteToString = null;
    let callSiteProto = null;
    {
      const prev = ErrorCtor.prepareStackTrace;
      const limitDesc = ObjectGetOwnPropertyDescriptor(ErrorCtor, 'stackTraceLimit');
      const holder = {};
      try {
        ErrorCtor.prepareStackTrace = (e, frames) => frames;
        ErrorCtor.stackTraceLimit = 10;
        ReflectApply(ErrorCaptureStackTrace, ErrorCtor, [holder]);
        callSiteProto = ObjectGetPrototypeOf(holder.stack[0]);
        callSiteToString = ObjectGetOwnPropertyDescriptor(callSiteProto, 'toString').value;
      } finally {
        ErrorCtor.prepareStackTrace = prev;
        if (limitDesc != null) ObjectDefineProperty(ErrorCtor, 'stackTraceLimit', limitDesc);
        else delete ErrorCtor.stackTraceLimit;
      }
    }
    // The runtime's default stack text, as Node's own default writes it --
    // its header `name [code]: message` for Node's own errors
    // (kIsNodeError, taken at load), else Error.prototype.toString's -- with
    // the runtime's files named countinghouse:. A plain data property, as on
    // master: module code that assigns or redefines its own replaces it, and
    // its function sees V8's frames as on master (a listed limit; ruled on
    // #493, function over a Low).
    const formatter = function prepareStackTrace(error, frames) {
      let head;
      try {
        head = (IS_NODE_ERROR != null && error != null && typeof(error) === 'object' && IS_NODE_ERROR in error)
          ? `${error.name} [${error.code}]: ${error.message}` : ErrorPrototypeToString(error);
      } catch (e) { head = 'Error'; }
      let out = runtimeText(head);
      const n = (frames != null && typeof(frames.length) === 'number') ? frames.length : 0;
      for (let i = 0; i < n; i++) {
        const f = frames[i];
        let line;
        try { line = ObjectGetPrototypeOf(f) === callSiteProto ? ReflectApply(callSiteToString, f, []) : StringCtor(f); } catch (e) { continue; }
        out += `\n    at ${runtimeText(line)}`;
      }
      return out;
    };
    ObjectDefineProperty(ErrorCtor, 'prepareStackTrace', {__proto__: null, value: formatter, writable: true, enumerable: false, configurable: true});
  };
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
  const lasting = new Set();   // module files reached as CommonJS by import (below)

  // L2: from set-options on, every resolve is bounded, whoever the parent is.
  // (hostPath as resolved: a lexical `<root>/x/../../..` is judged where it
  // leads, F4-1)
  // (audit only: inside lazy-require's own late load, which the lockdown's
  // net reported, how deep; the library's own resolutions pass unsaid, as
  // the lockdown's hook passes them)
  let lateDepth = 0;
  function bound(hostPath, fromModule, specifier, asImport = false, hostParent = null) {
    if (m.isModuleHost(hostPath)) return;
    if (!fromModule && anyOf(countinghouseRoots, (r) => insideHost(hostPath, r))) return;
    if (!fromModule && !enforce && sealed && lateDepth > 0 && anyOf(lateRoots, (r) => insideHost(hostPath, r))) return;
    if (!enforce) {
      reportL2('require', StringSlice(StringCtor(specifier), 0, 200));
      return;
    }
    throw refusal(specifier, asImport, true, hostParent);
  }

  // "type" from the nearest package.json, as Node decides it: the first one
  // found going up wins, and one without "type" means commonjs (review I1).
  function packageType(hostFile) {
    for (let dir = PATH.dirname(hostFile); m.isModuleHost(dir); dir = PATH.dirname(dir)) {
      // (the resolver's own parse of it: one read, one cache; the high
      // review of #465, 7)
      const found = insideResolver().manifest(dir);
      if (found != null) {
        const pkg = found.pkg;
        // (its own "type" only: never one an Object.prototype getter answers)
        const type = (pkg != null && ObjectHasOwn(pkg, 'type') && pkg.type === 'module') ? 'module' : 'commonjs';
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

  // A virtual path as a lookup path may name it: already resolved (no
  // /app/../x, which Node reads as the literal host path it leads to) and
  // no backslash (a separator on Windows, E1). PR 3.
  // -> the path resolved (a trailing slash, a '.' segment gone) and still
  // inside the root, in the form it was given (X:\\app on Windows), or null
  // (the high review of #440: normalised, not dropped)
  function virtualLookup(p) {
    const v = fromWin(p);
    if (typeof(v) !== 'string' || !PATH_POSIX.isAbsolute(v) || StringIndexOf(v, '\\') !== -1) return null;
    const n = PATH_POSIX.resolve(v);
    if (!m.isVirtual(n)) return null;
    if (n === v && typeof(p) === 'string') return p;
    return VDRIVE != null ? `${VDRIVE}:${swapped(n, '/', '\\')}` : n;
  }

  // A relative request: '.', '..', './', '../' -- and, where backslash, on
  // Windows (a virtual drive) '.\\' and '..\\' too, as CommonJS and a
  // path take them (an import's URL does not). One classifier for every
  // route (the high review of #465, 10).
  function isRelative(s, backslash) {
    if (typeof(s) !== 'string') return false;
    if (s === '.' || s === '..' || StringStartsWith(s, './') || StringStartsWith(s, '../')) return true;
    return backslash === true && VDRIVE != null && (StringStartsWith(s, '.\\') || StringStartsWith(s, '..\\'));
  }

  // A bare or '#' name, which Node looks up in every node_modules above the
  // parent (a '#' import's bare target too), by Node's own test: not a
  // relative or absolute path, and no URL -- a name with a ':' the URL
  // parser rejects ('my_pkg:x') is bare to Node, and so here (the medium
  // review of d3ad5863)
  function bareName(specifier) {
    if (typeof(specifier) !== 'string' || specifier === '') return false;
    if (StringStartsWith(specifier, '#')) return true;
    if (isRelative(specifier, true) || StringStartsWith(specifier, '/')) return false;
    // (a host path: a drive or a UNC one on Windows)
    if (PATH.isAbsolute(specifier)) return false;
    return !ReflectApply(URLCanParse, URLCtor, [specifier]);
  }

  // The same for a require, by CommonJS's own test, which differs: a name
  // is relative when it is '.' or starts '.' then '.', '/' (or '\\' on
  // Windows) -- '..foo' is relative, '.foo' bare -- and one the URL parser
  // takes ('a:b') is bare to it, looked up in node_modules (the medium
  // review of 880bd1ae)
  function requireBare(specifier) {
    if (typeof(specifier) !== 'string' || specifier === '') return false;
    if (StringStartsWith(specifier, '#')) return true;
    if (StringStartsWith(specifier, '/') || PATH.isAbsolute(specifier)) return false;
    if (StringCharCodeAt(specifier, 0) !== 0x2E) return true;
    if (specifier.length === 1) return false;
    const c = StringCharCodeAt(specifier, 1);
    return !(c === 0x2E || c === 0x2F || (VDRIVE != null && c === 0x5C));
  }

  // Module code's refusal of a name it can't have, one for each kind of
  // request (a require's, an import's): the name cut as bound() cuts it,
  // reported when it names the runtime's lib/
  // (its requireStack the parent's virtual name, a module file's, never a
  // host path; empty without one)
  const refusal = (specifier, asImport, always = false, hostParent = null) => {
    const shown = StringSlice(StringCtor(specifier), 0, 200);
    if (always || reachesLib(specifier)) reportL2('require', shown);
    const stack = [];
    if (typeof(hostParent) === 'string' && m.isModuleHost(hostParent)) {
      const v = m.toVirtual(hostParent);
      put(stack, 0, VDRIVE != null ? `${VDRIVE}:${swapped(v, '/', '\\')}` : v);
    }
    return notFound(shown, asImport ? 'ERR_MODULE_NOT_FOUND' : 'MODULE_NOT_FOUND', stack);
  };

  // Where a request module code made was headed, judged before Node's
  // answer: inside the module's root (an absolute or virtual path, or a
  // relative one against its parent's file), or not (a bare or '#' name,
  // a URL, anything else). Under enforce a resolution error for a target
  // inside the root is the module's own and kept, as module code sees it;
  // any other is the one refusal, by the name given, whatever Node said
  // (the third round on #440: the class, not each route).
  const hostForm = (given) => {
    // (a Windows namespaced path in its plain form, or none)
    const p = fromNamespaced(given);
    if (typeof(p) !== 'string') return null;
    const v = fromWin(p);
    if (PATH_POSIX.isAbsolute(v) && m.isVirtual(PATH_POSIX.resolve(v))) return m.toHost(PATH_POSIX.resolve(v));
    return PATH.isAbsolute(p) ? p : null;
  };
  // (the host path a request headed inside the root names, or null)
  const headedTarget = (request, parentFile) => {
    if (typeof(request) !== 'string') return null;
    let target = hostForm(request);
    if (target == null) {
      // (relative by CommonJS's own test, a require's: '..foo/x' is, a
      // directory named '..foo' beside the parent; '.foo' is a bare name --
      // every caller judges a require; C-compat, item 6)
      const relative = request !== '' && !requireBare(request);
      const parent = hostForm(parentFile);
      if (!relative || parent == null) return null;
      target = PATH.resolve(PATH.dirname(parent), request);
    }
    target = resolvedPath(target);
    return m.isModuleHost(target) ? target : null;
  };

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
    // (a file: URL only from the module's own CommonJS parent: one that
    // claims a parent outside the root is an import, judged as one; the
    // third round on #440)
    if (!isBuiltin(specifier) && !m.parent(context != null ? context.parentURL : undefined).fromModule) return false;
    return formatOfParent(context != null ? context.parentURL : undefined) === 'commonjs';
  }

  // Through the resolve shim: below Node 24.15 it also runs this hook for
  // require.resolve and createRequire().resolve (lib/resolve-shim.js).
  // How deep inside this hook a resolution is: Module._resolveFilename,
  // called by Node's own default step from here, answers a host path, as
  // Node needs; called directly by module code, its virtual name (below)
  let hookDepth = 0;
  // How deep inside one of Node's own resolution steps this file's hook
  // started (nextResolve, Node's resolver on a parent of plain own data):
  // nothing of module code's runs there, so a loader static called while
  // it is above 0 is Node's; anything else after the seal is module
  // code's, a getter the hook reads included (the review of 1ed50454).
  let nodeStep = 0;
  // How often the _stat wrapper was called: Node's own walk calls it only
  // when it went in through Node's setter (the _stat PR); the lockdown's
  // test hand-over reads it (--testLateLoads), nothing else.
  let statCalls = cfg.countStats === true ? 0 : -1;
  // (Node's own _stat, as it was when this file's wrapper replaced it: the
  // bare-name lookup below stats with it, inside the root only)
  let judgedStat = null;
  // (each static to install through Node's setter at the seal)
  const viaSetters = [];
  // C-bare (Fable's pass on #452, F1 and F2; the reviewer's ruling): under
  // enforce, module code's bare or '#' request is resolved here, inside the
  // root, as Node's own ES resolver resolves it (lib/fs-broker/resolve-
  // inside.js: "exports" and "imports" with their conditions and patterns,
  // a package's legacy "main"), every stat and package.json read this
  // file's own, of the root's files only; Node is handed only the file URL
  // found, or a built-in's name, so it never walks, stats or reads above
  // the root, and nothing about a path outside reaches module code by any
  // channel (the module root's own package.json, which every module has
  // and which is read-only under enforce, bounds the scope reads Node makes
  // for the file it is handed). What the resolver doesn't understand is
  // the one refusal. A
  // require of a package with no "exports" keeps CommonJS's own lookup,
  // the lookup paths filtered to the root and each stat judged by the _stat
  // wrapper, a subpath climbing out of the package refused.
  // (the judged stat -- the _stat wrapper -- and the original read, each of
  // the root's files alone: a package directory that is a link out of the
  // root is refused at load under enforce (sandbox 72), and the root is
  // read-only then; the high review of #465, 4, and its round 3, item 1)
  // (where the _stat wrapper isn't in place -- before it, and under audit
  // and off, where it never is; the module's "type" is read from install on
  // -- Node's own _stat, as it was at install, before any module code)
  const installStat = Module._stat;
  const statKind = (p) => {
    if (!m.isModuleHost(p)) return -2;
    if (judgedStat != null) return ReflectApply(judgedStat, Module, [p]);
    try { return ReflectApply(installStat, Module, [p]); } catch (e) { return -2; }
  };
  // (built at first use: only an enforce worker's resolution after the seal
  // asks it; the high review of #465, 9)
  let insideResolverMade = null;
  const insideResolver = () => insideResolverMade || (insideResolverMade = createInsideResolver({root: moduleRoot, insideRoot: (p) => m.isModuleHost(p), stat: statKind,
    // (a directory with no package.json kept as having none only where the
    // root is read-only: under enforce, after the seal)
    keepMisses: () => enforce && sealed,
    // (the original read, captured at load, of a file inside the root alone:
    // the broker's patched one calls Buffer and Object methods at call
    // time, module code's to replace, while the grant is open; a link out
    // of the root is refused at load and the root is read-only under
    // enforce -- the high review of #465, round 3, item 1)
    readText: (p) => {
      if (!m.isModuleHost(p)) return null;
      try { return originals.readFileSync(p, 'utf8'); } catch (e) { return null; }
    }, isBuiltin}));
  // (a bare request whose subpath, read as a path, leaves its package: a
  // backslash read as a separator too, as on Windows -- on any platform,
  // fail closed)
  // (hashToo: a '#' name falling through to CommonJS's lookup, judged as a
  // bare one is)
  const climbsOut = (spec, hashToo) => {
    if (typeof(spec) !== 'string' || !requireBare(spec) || (StringStartsWith(spec, '#') && hashToo !== true)) return false;
    const plain = swapped(spec, '\\', '/');
    let slash = StringIndexOf(plain, '/');
    if (StringStartsWith(plain, '@')) slash = slash === -1 ? -1 : StringIndexOf(plain, '/', slash + 1);
    if (slash === -1) return false;
    const sub = PATH_POSIX.normalize(`./${StringSlice(plain, slash + 1)}`);
    return sub === '..' || StringStartsWith(sub, '../');
  };
  // (CommonJS's conditions as Node has them: a require's own resolve
  // context, captured at the first one the hook sees -- an array, or a Set
  // as some lines hand it -- never the shim's fixed list below 24.15, and
  // never a re-parse of NODE_OPTIONS and the arguments, which a changed
  // environment or --no-experimental-require-module would mislead; before
  // any is seen, Node's default list (requireConditions); the high review
  // of #465, 5, and its medium)
  let cjsConditions = null;
  const noteConditions = (context) => {
    if (cjsConditions != null || context == null || typeof(context) !== 'object') return;
    const d = ObjectGetOwnPropertyDescriptor(context, 'conditions');
    const list = d != null && ObjectHasOwn(d, 'value') ? d.value : null;
    if (list == null || list === resolveShim.shimConditions) return;
    const copy = [];
    let isRequireList = false;
    const take = (v) => {
      if (typeof(v) !== 'string') return;
      if (v === 'require') isRequireList = true;
      put(copy, copy.length, v);
    };
    // (a Set by its own slot -- Node's SafeSet included, whose prototype is
    // not Set.prototype -- never by instanceof, which reads Set's
    // Symbol.hasInstance, module code's to replace)
    // (an array by its own data alone: no Proxy, no getter run here)
    if (ArrayIsArray(list)) {
      if (isProxy(list)) return;
      const ld = ObjectGetOwnPropertyDescriptor(list, 'length');
      const n = ld != null && ObjectHasOwn(ld, 'value') ? ld.value : 0;
      for (let i = 0; i < n; i++) {
        const ed = ObjectGetOwnPropertyDescriptor(list, i);
        if (ed != null && ObjectHasOwn(ed, 'value')) take(ed.value);
      }
    } else {
      try { SetForEach(list, take); } catch (e) { return; }
    }
    if (isRequireList) cjsConditions = ObjectFreeze(copy);
  };
  // (for a call that meets this file's _resolveFilename wrapper before any
  // hook: below 24.15 a require.resolve, and on every line a direct
  // Module._resolveFilename -- a plain require, and from 24.15 a
  // require.resolve, resolve in the hook with their own context. Until a
  // require's context has reached the hook and been taken -- the shim's own
  // never is -- Node's default CommonJS list, the shim's own: require,
  // node, node-addons, module-sync)
  const requireConditions = (c) => {
    const list = cjsConditions != null ? cjsConditions : resolveShim.shimConditions;
    for (let i = 0; i < list.length; i++) if (list[i] === c) return true;
    return false;
  };
  // A bare require, and why it is CommonJS's own lookup while an import or
  // a '#' name is resolved here (C-bare, R0). Under enforce, on Node
  // 22.16 / 24.21 / 26.13 (lib/internal/modules/cjs/loader.js, and
  // helpers.js on 26), every disk access on a bare require's path is one
  // this file judges, but one native read, which the root bounds:
  //   stat         tryFile, _findPath: `_stat(...)` (539, 744, 758 /
  //                588, 816, 830 / 599, 827, 841); `_stat` is the `let`
  //                behind the Module._stat setter (266 / 289 / 305), the
  //                judged wrapper below; Node's internalModuleStat is
  //                reached only through the stat() it replaced
  //   package.json resolveExports' and tryPackage's `_readPackage(...)`
  //                (653, 497 / 750, 545 / 761, 556), the `let` behind the
  //                Module._readPackage setter (477 / 524 / 535), wrapped
  //                below; its path is path.resolve(nmPath, name), name by
  //                EXPORTS_PATTERN (no '/', '\\' or '%' beyond a scope's
  //                one '/'), nmPath a root-filtered lookup path
  //   realpath     22, 24: tryFile's toRealPath -> fs.realpathSync, read
  //                from fs at call time (the broker's); 26:
  //                loaderMethods.realpathSync (604, 848, 861), helpers.js's
  //                `(p) => fs.realpathSync(p, ...)`, read at call time too;
  //                after a judged _stat said a file
  //   "exports"    finalizeEsmResolution (1415 / 1589 / 1628):
  //                fileURLToPath(resolved), then tryFile -- the judged
  //                _stat -- so a target leaving the root by '%2e' reads as
  //                missing, as any outside path; packageExportsResolve only
  //                builds URLs (an "exports" target starts './', never
  //                packageResolve's native walk)
  //   the one native read: trySelf's getNearestParentPackageJSON(
  //                parentPath) (608 / 662 / 673), up from the parent's own
  //                file: every parent Node is handed is inside the root
  //                (parentAfterSeal/ownHost, below), every module root has
  //                a package.json (module-manager: none is
  //                INVALID_MODULE_PATH), read-only under enforce, so the
  //                walk ends there at the latest
  // A '#' name is not CommonJS's alone: its branch (1358-1363 / 1529-1534 /
  // 1568-1573) calls the ES packageImportsResolve, and an "imports" target
  // that is a bare name runs the ES packageResolve's native node_modules
  // walk -- so a '#' name, by require too, is resolved here.
  // test/sandbox/71 fails if Module._stat or Module._readPackage stops
  // being an accessor with a setter; installation below refuses to start
  // under enforce then.
  // (a require's '#' name resolved here, a file's path handed on, which
  // must be there, as Node's finalizeEsmResolution has it -> the request
  // for Node's CommonJS resolver, or null to refuse; undefined: CommonJS's
  // own lookup, a bare name's -- its subpath climbing out of its package,
  // read as a path, refused)
  const requireRequest = (spec, parentFile, has) => {
    if (!StringStartsWith(spec, '#')) return climbsOut(spec) ? null : undefined;
    const from = parentFile != null && m.isModuleHost(parentFile) ? parentFile : PATH.join(moduleRoot, 'index.js');
    // (a scope with no "imports": CommonJS's own lookup, as Node's)
    if (insideResolver().noImports(from)) return climbsOut(spec, true) ? null : undefined;
    const r = insideResolver().resolve(spec, from, has);
    if (r.refuse === true) return null;
    if (typeof(r.builtin) === 'string') return r.builtin;
    let file;
    try { file = fileURLToPath(r.url); } catch (e) { return null; }
    return statKind(file) === 0 ? file : null;
  };
  function resolveInHook(specifier, context, nextResolve) {
    answered = null;
    noteConditions(context);
    if (isBuiltin(specifier)) return nextResolve(specifier, context);
    // (an empty specifier refused before Node, by every route alike; #465's
    // Fable pass, F3)
    if (enforce && specifier === '') throw refusal(specifier, !isRequire(specifier, context), false, null);
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
    const asRequire = isRequire(specifier, context);
    // (an import's file: URL that is no path is left as it is, for the
    // import branch to judge as Node's URL parser reads it, as it does
    // any other spelling; a require's error as it was)
    let s;
    try { s = m.specifier(specifier, parent); } catch (e) {
      if (asRequire || typeof(specifier) !== 'string' || !StringStartsWith(specifier, 'file:') || e == null ||
        (e.code !== 'ERR_INVALID_FILE_URL_PATH' && e.code !== 'ERR_INVALID_FILE_URL_HOST')) throw e;
      s = specifier;
    }
    const roots = [moduleRoot];
    if (!fromModule) for (let i = 0; i < countinghouseRoots.length; i++) put(roots, roots.length, countinghouseRoots[i]);
    // (and inside the one late load the lockdown reports under audit, its
    // library's own lookups: the code roots as they were; the review of
    // e0f39de9)
    // (after the seal only: before it the code roots above are those)
    if (!fromModule && !enforce && sealed && lateDepth > 0) for (let i = 0; i < lateRoots.length; i++) put(roots, roots.length, lateRoots[i]);
    let hostResolved = null;
    // (the resolved URL's query and fragment, kept in the answer: two
    // queries are two instances, as Node has them)
    let answerSuffix = '';
    let format;
    const release = grant.resolving(roots);
    try {
      if (fromModule && hostParent != null && asRequire) {
        // (under enforce a parent that is the root itself -- a forged one,
        // createRequire('/app') -- is refused, as ownHost refuses it for a
        // direct call: Node's self-reference walk, getNearestParentPackageJSON,
        // starts at a parent's directory, the root's own parent for the root;
        // #465's Fable pass, F2)
        if (enforce && insideHost(hostParent, moduleRoot) && insideHost(moduleRoot, hostParent)) throw refusal(specifier, false, false, null);
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
        // (where the request is headed, judged once: inside the root or not)
        // (Node's own walk from here stats through this file's _stat, so a
        // package.json "main" leading outside, or the root tried with each
        // extension beside it, finds nothing there, whether anything is: the
        // _stat PR, which took #440's checks for those out)
        const headed = enforce ? headedTarget(s, hostParent) : null;
        // (C-bare: a bare or '#' name located inside the root first, and
        // Node's lookup started where it is)
        let request = s;
        // (a require keeps CommonJS's own lookup -- a file or a directory,
        // at every node_modules inside the root, above already filtered out,
        // each stat judged by the _stat wrapper -- and only a subpath that
        // climbs out of its package is refused here; a '#' name is resolved
        // here, as Node's CommonJS resolver would hand it to its ES one:
        // to a file, a built-in, or a bare target looked up as above)
        if (enforce && headed == null && typeof(s) === 'string' && requireBare(s)) {
          const has = (c) => c === 'require' || c === 'node' || hasCondition(context, c);
          const asked = requireRequest(s, hostParent, has);
          if (asked === null) throw refusal(specifier, false, false, hostParent);
          if (asked !== undefined) request = asked;
        }
        resolvingOwn = true;
        nodeStep++;
        try { found = ReflectApply(nodeResolveFilename, Module, [request, parentModule, false]); } catch (e) {
          // (PR 3: under enforce any bare or '#' name module code can't
          // resolve gets the one refusal bound() gives a target it finds
          // outside, whatever the error: Node's self-reference walks the
          // package scope above the root, and a '#' import's bare target
          // the node_modules above it, past the lookup paths above, so no
          // name's own error is safely the module's alone. An own
          // package's exports error then reads as not found.)
          if (enforce && headed == null) throw refusal(specifier, false, false, hostParent);
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
          nodeStep--;
        }
        if (typeof(found) !== 'string') throw notFound(StringSlice(StringCtor(specifier), 0, 200));
        if (isBuiltin(found)) return nextResolve(found, context);
        // (a request headed inside the root that Node's package walk took
        // outside it (a directory's package.json "main"): Node's own not-
        // found, as when that target is missing, so neither tells the
        // other; the review of the third round on #440)
        if (headed != null && !m.isModuleHost(resolvedPath(found))) throw missing(StringCtor(specifier));
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
        // (module code's by the lockdown's own rule after the seal, every
        // resolution, not by the parent's place: a vm script given a runtime
        // filename and Node's main-context loader names a runtime file as
        // its parent; the high review of #440)
        const guarded = enforce && (fromModule || sealed) && !isRequire;
        // (what the import names, as Node's URL parser reads it, judged
        // before Node's resolver reads anything for it, and that very path
        // what Node is given, its search and hash kept: a relative name
        // against its parent, or with none (a vm script with no filename)
        // against the module's root, which Node would take as the working
        // directory, the literal host /app; a file: URL in any spelling the
        // parser takes (FILE:///, a leading space); a virtual path in its
        // host form. The second round on #440 and its review.)
        let target = PATH.isAbsolute(s) ? s : null;
        let suffix = '';
        let handOver = null;
        if (!isRequire && typeof(specifier) === 'string') {
          const relative = isRelative(specifier, false);
          let u = null;
          try {
            // (an absolute path is a URL path to Node's ES resolver: its
            // query, fragment and escapes read as a URL's, a virtual one
            // mapped below; a relative name with no parent against the
            // module's root under enforce only, else handed on as Node takes
            // it)
            // (against the parent's URL, or the root's, which keeps a
            // Windows drive)
            const base = () => pathToFileHref(parent.host != null ? parent.host : PATH.join(moduleRoot, 'index.js'));
            // (a virtual /app/... name against the virtual drive on Windows,
            // never the host parent's: the module's own file)
            if (StringStartsWith(specifier, '/') && !StringStartsWith(specifier, '//')) u = new URLCtor(specifier, virtualAbsolute(specifier) ? `file:///${VDRIVE}:/` : base());
            else if (relative && (parent.host != null || guarded)) u = new URLCtor(specifier, base());
            else if (!StringStartsWith(specifier, '#') && !PATH.isAbsolute(specifier) && StringIndexOf(specifier, ':') !== -1) u = new URLCtor(specifier);
          } catch (e) { u = null; }
          if (u != null && URLProtocol(u) === 'file:') {
            // (a URL that is no path is refused for module code here, as
            // Node refuses it, the same for any file, before anything is
            // read; never handed on, since Node's message would quote the
            // host path it resolved it against: an encoded '/' or '\'
            // (as Node's resolver tests the pathname, so '%5C' on POSIX
            // too) by the name module code gave, anything else by
            // fileURLToPath's own error, whose message names no path;
            // the runtime's own import handed to Node as the URL)
            if ((fromModule || guarded) && encodedSeparator(URLPathname(u))) throw invalidSpecifier(specifier);
            try {
              target = fileURLToPath(URLHref(u));
              suffix = `${URLSearch(u)}${URLHash(u)}`;
            } catch (e) {
              if (guarded) throw e;
              target = null;
              handOver = URLHref(u);
            }
          }
        }
        if (target != null) {
          const v = fromWin(target);
          if (PATH_POSIX.isAbsolute(v) && m.isVirtual(PATH_POSIX.resolve(v))) target = m.toHost(PATH_POSIX.resolve(v));
          if (guarded && !m.isModuleHost(resolvedPath(target))) throw refusal(specifier, true, true, hostParent);
        }
        let r;
        let given = target != null && !isRequire ? `${pathToFileHref(target)}${suffix}` : (handOver != null ? handOver : s);
        // (C-bare: a bare or '#' name resolved inside the root, Node handed
        // only the file or built-in found; every guarded resolution is module
        // code's -- after the seal by the lockdown's own rule, whatever parent
        // it names -- so a parent outside the root, a countinghouse file's
        // included, is judged from the root)
        if (guarded && target == null && handOver == null && typeof(specifier) === 'string' && bareName(specifier)) {
          const from = hostParent != null && m.isModuleHost(hostParent) ? hostParent : PATH.join(moduleRoot, 'index.js');
          const answer = insideResolver().resolve(specifier, from, (c) => hasCondition(context, c));
          if (answer.refuse === true) throw refusal(specifier, true, false, hostParent);
          given = typeof(answer.builtin) === 'string' ? answer.builtin : answer.url;
        }
        try { r = nextResolve(given, next); } catch (e) {
          if (guarded && !(target != null && m.isModuleHost(resolvedPath(target)))) throw refusal(specifier, true, false, hostParent);
          // (guarded, as module code sees it too: a parentless name judged
          // against the host root never names it back)
          throw (fromModule || guarded) ? asSeen(e) : e;
        }
        if (typeof(r.url) !== 'string' || !StringStartsWith(r.url, 'file:')) return r;
        hostResolved = fileURLToPath(r.url);
        try {
          const ru = new URLCtor(r.url);
          answerSuffix = `${URLSearch(ru)}${URLHash(ru)}`;
        } catch (e) { answerSuffix = ''; }
        format = r.format;
      }
    } finally {
      release();
    }
    // judged, and answered, as resolved: the URL below is built from the
    // very path bound() checked (F4-1)
    hostResolved = resolvedPath(hostResolved);
    bound(hostResolved, fromModule, specifier, enforce && (fromModule || sealed) && !asRequire, hostParent);
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
      return {url: `${virtualUrl(m.toVirtual(hostResolved))}${answerSuffix}`, format: format, shortCircuit: true};
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
    return {url: `${pathToFileHref(hostResolved)}${answerSuffix}`, format: format, shortCircuit: true};
  }
  resolveShim.registerHooks(cfg.registerHooks || Module.registerHooks, {
    resolve(specifier, context, nextResolve) {
      hookDepth++;
      const stepped = (s, c) => {
        nodeStep++;
        try { return nextResolve(s, c); } finally { nodeStep--; }
      };
      try { return resolveInHook(specifier, context, stepped); } finally { hookDepth--; }
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
  // countinghouse's code -- exactly the roots L2 allows. Node's own walk
  // calls _findPath and _resolveFilename through the Module object, but
  // _stat and _readPackage through its own internal copies, which only
  // their setters change: those two go in through the setters (replace(),
  // below), so Node's walk judges every path it stats or reads (the _stat
  // PR; before it, they answered module code's direct calls only). Under
  // audit and off a module may read outside paths anyway, so nothing is
  // hidden there.
  // An array-like of lookup paths as a fresh array, read once by Array.from
  // as this file took it (Node walks any array-like; F3). Every mode's,
  // through parentAfterSeal and parentMapped (C-compat), not enforce's
  // alone.
  // (a string is no list: never split into its characters)
  // (a real array copied by index, its own data elements only, never
  // through its iterator, which module code can replace; a Proxy is no
  // list: its traps would be module code)
  const listOf = (v) => {
    if (v == null || typeof(v) !== 'object' || isProxy(v)) return [];
    if (ArrayIsArray(v)) {
      const out = [];
      const ld = ObjectGetOwnPropertyDescriptor(v, 'length');
      const n = ld != null && typeof(ld.value) === 'number' ? ld.value : 0;
      for (let i = 0; i < n; i++) {
        const d = ObjectGetOwnPropertyDescriptor(v, i);
        put(out, out.length, d != null && ObjectHasOwn(d, 'value') ? d.value : undefined);
      }
      return out;
    }
    // (anything but a real array is no list after the seal: reading an
    // array-like would run its getters, module code's; Node passes
    // arrays. Before it, as given.)
    if (sealed) return [];
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
  // (every mode's: under enforce after the seal, judged and refused as
  // enforce has it; outside it, through parentMapped, whose caller takes a
  // refusal here as "hand the parent on as it is" -- C-compat)
  const parentAfterSeal = (parent, request) => {
    if (parent == null) return parent;
    const refused = () => notFound(StringSlice(StringCtor(request), 0, 200));
    if (typeof(parent) !== 'object' && typeof(parent) !== 'function') throw refused();
    let filename;
    let lookups;
    // (own data only, read without running anything of module code's: a
    // Proxy's traps or a getter would run inside this file's hook)
    if (isProxy(parent)) throw refused();
    const dataOf = (key) => {
      const d = ObjectGetOwnPropertyDescriptor(parent, key);
      return d != null && ObjectHasOwn(d, 'value') ? d.value : undefined;
    };
    try { filename = dataOf('filename'); lookups = dataOf('paths'); } catch (e) { throw refused(); }
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
      // (a virtual one in its host form; one not already resolved, or with
      // a backslash, dropped, never handed on as a literal host path)
      if (m.isVirtual(v)) {
        const n = virtualLookup(p);
        if (n != null) put(paths, paths.length, m.toHost(fromWin(n)));
        continue;
      }
      put(paths, paths.length, p);
    }
    copy.paths = paths;
    WeakMapSet(copies, parent, {__proto__: null, given: filename, list, copy});
    return copy;
  };
  // A path as Node takes it: an absolute one, or a file: URL in any case;
  // a virtual /app/... name, normalised, in its host form; anything else
  // none (null). The one mapping of a findPackageJSON base or specifier, in
  // every mode (#434's Fable pass, F2; #480's high, round 1, item 2). A
  // backslash inside a virtual name is refused (E1) -- but with
  // `nameChar`, outside enforce, it is a character of the name on a host
  // whose separator is '/', as identity's hook takes a request there. With
  // `virtualOnly`, a path that names no virtual one is none too (outside
  // enforce, where any other is handed on as it is).
  const pathOf = (g, nameChar = false, virtualOnly = false) => {
    if (typeof(g) !== 'string') return null;
    let p = g;
    if (!PATH.isAbsolute(p)) {
      try { p = fileURLToPath(g); } catch (e) { return null; }
    }
    // (a Windows namespaced path in its plain form, as allowed() judges)
    p = fromNamespaced(p);
    if (p === null) return null;
    // (a trailing separator kept: Node reads it as a directory)
    const last = StringSlice(p, -1);
    const slash = last === '/' || (VDRIVE != null && last === '\\');
    // (a virtual /app/... name, the module's own as module code spells
    // it, in its host form: Node would read it as the literal host /app)
    const v = fromWin(p);
    let r;
    if (PATH_POSIX.isAbsolute(v) && m.isVirtual(PATH_POSIX.resolve(v))) {
      if (StringIndexOf(v, '\\') !== -1 && !(nameChar && PATH.sep === '/')) return null;
      r = m.toHost(PATH_POSIX.resolve(v));
    }
    else if (virtualOnly) return null;
    else r = PATH.resolve(p);
    return slash && StringSlice(r, -1) !== PATH.sep ? r + PATH.sep : r;
  };
  // Outside enforce's seal (off and audit, every worker; and before the
  // seal): a parent whose filename is the module's own virtual name, as a
  // library resolving from __dirname makes one (resolve-from, import-fresh),
  // handed to Node as its host copy by the one mapping above, so Node reads
  // the module's own files, not the literal host /app; anything else is
  // handed on as it is, with no refusal (C-compat).
  const parentMapped = (parent, request) => {
    if (parent == null || (typeof(parent) !== 'object' && typeof(parent) !== 'function') || isProxy(parent)) return parent;
    let filename;
    try {
      const d = ObjectGetOwnPropertyDescriptor(parent, 'filename');
      filename = d != null && ObjectHasOwn(d, 'value') ? d.value : undefined;
    } catch (e) { return parent; }
    if (typeof(filename) !== 'string' || !m.isVirtual(fromWin(filename))) return parent;
    try { return parentAfterSeal(parent, request); } catch (e) { return parent; }
  };
  if (enforce) {
    // (every hook judges the same plain path: a Windows namespaced answer in
    // its plain form, or none, refused)
    const allowed = (given) => {
      const p = fromNamespaced(given);
      if (p === null) return false;
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
    const notAString = () => {
      const e = new TypeErrorCtor('The "request" argument must be of type string');
      ObjectDefineProperty(e, 'code', {__proto__: null, value: 'ERR_INVALID_ARG_TYPE', writable: true, enumerable: false, configurable: true});
      return e;
    };
    // A specifier or base: after the seal a primitive string alone, told by
    // typeof, which runs no module code -- any object, a real URL included,
    // is none (a URL's href getter calls its searchParams' toString, module
    // code's to replace; and Node takes an object by its own toString, so a
    // URL's href could answer otherwise than Node; ruled K1 after #465's
    // round 3: pass url.href). Before the seal, the runtime's own, as Node
    // takes it.
    const stringOf = (v) => {
      if (v == null || typeof(v) === 'string') return v;
      return sealed ? null : StringCtor(v);
    };
    // (whether a string is a file: URL as Node's URL parser reads it)
    const isFileUrl = (g) => {
      if (typeof(g) !== 'string') return false;
      try { return URLProtocol(new URLCtor(g)) === 'file:'; } catch (e) { return false; }
    };
    // A direct call's options after the seal: its lookup paths, the one
    // field Node reads, as a fresh list of own data, read without running
    // anything of module code's (a Proxy's traps, a getter); anything else
    // none.
    const optionsAfterSeal = (options) => {
      if (options == null || typeof(options) !== 'object' || isProxy(options)) return undefined;
      const d = ObjectGetOwnPropertyDescriptor(options, 'paths');
      if (d == null || !ObjectHasOwn(d, 'value')) return {__proto__: null};
      return {__proto__: null, paths: listOf(d.value)};
    };
    // (a static Node keeps as an accessor pair -- Module._stat and
    // Module._readPackage on every Node line we support -- reaches Node's
    // own walk only through its setter, which changes the loader's internal
    // copy; a value defined over the pair alone is never called by Node.
    // The property is locked as the wrapper's value now, for direct calls;
    // the wrapper goes in through the setter at the seal (viaSetters), so
    // the runtime's own loads before it walk natively, as they always have,
    // and every walk after it -- module code's -- is judged. The _stat PR.)
    const replace = (key, fn) => {
      const d = ObjectGetOwnPropertyDescriptor(Module, key);
      const current = d == null ? undefined : (ObjectHasOwn(d, 'value') ? d.value : (typeof(d.get) === 'function' ? ReflectApply(d.get, Module, []) : undefined));
      if (typeof(current) !== 'function') return;
      const wrapped = fn(current);
      if (d != null && typeof(d.set) === 'function') put(viaSetters, viaSetters.length, {__proto__: null, key, set: d.set, wrapped});
      Object.defineProperty(Module, key, {writable: false, configurable: false, enumerable: true, value: wrapped});
    };
    // (a stat or a package read is of a path, never a request: after the
    // seal anything but an absolute path answers missing, Node's own loader
    // passing only those, so what is checked is what the original is given;
    // item 7)
    const statAllowed = (p) => {
      if (!sealed) return allowed(p);
      return typeof(p) === 'string' && PATH.isAbsolute(p) && allowed(p);
    };
    // (each hook judges, and hands Node, the one plain form)
    replace('_stat', (orig) => {
      // (the resolver's: judged as Node's walk is, not counted -- the count
      // is of Node's own walk, sandbox 68's statWalk)
      judgedStat = function(filename) {
        const plain = fromNamespaced(filename);
        return plain !== null && statAllowed(plain) ? ReflectApply(orig, this, [plain]) : -2;
      };
      return function(filename) {
        if (statCalls >= 0) statCalls++;
        return ReflectApply(judgedStat, this, [filename]);
      };
    });
    replace('_findPath', (orig) => function(request, paths, isMain) {
      if (!allowed(request)) return false;
      // (the plain form of a Windows namespaced request, judged and handed
      // on alike)
      if (typeof(request) === 'string') request = fromNamespaced(request);
      if (request === null) return false;
      // (after the seal the lookup paths given are filtered as
      // _resolveLookupPaths' are: a runtime package is never looked into,
      // so none of its errors is an answer about it)
      if (sealed && paths != null) {
        const given = listOf(paths);
        const kept = [];
        for (let i = 0; i < given.length; i++) {
          const p = given[i];
          // (a virtual one with a backslash dropped, as a parent's are, E1)
          if (typeof(p) !== 'string') continue;
          // (a virtual one in its host form, as a parent's are: what Node
          // walks is what is judged below)
          const n = virtualLookup(p);
          if (n != null) put(kept, kept.length, m.toHost(fromWin(n)));
          else if (!m.isVirtual(fromWin(p)) && PATH.isAbsolute(p) && allowed(p)) put(kept, kept.length, fromNamespaced(p));
        }
        paths = kept;
      }
      // (module code's own call after the seal -- never Node's, for a
      // require, which runs inside this file's hook: any error Node raises
      // is nothing, never its message, which can name a host path; a hit is
      // answered by its virtual name. Node's walk itself stats through this
      // file's _stat, the _stat PR.)
      const direct = sealed && nodeStep === 0;
      let found;
      try { found = ReflectApply(orig, this, [request, paths, isMain]); } catch (e) {
        if (direct || (e && e.code === 'ENOENT')) return false;
        throw e;
      }
      if (found === false) return false;
      // (the plain form of a Windows namespaced answer, judged; module
      // code's own call answered by the virtual name, as it knows its files)
      const plain = fromNamespaced(found);
      if (plain === null || !allowed(plain)) return false;
      return (direct && typeof(plain) === 'string' && m.isModuleHost(plain)) ? virtualName(plain) : plain;
    });
    // (a parent's filename as its own data property, never a getter run:
    // the copy parentAfterSeal made, after the seal)
    const ownFilename = (parent) => {
      if (parent == null || typeof(parent) !== 'object') return null;
      const fd = ObjectGetOwnPropertyDescriptor(parent, 'filename');
      return fd != null && ObjectHasOwn(fd, 'value') && typeof(fd.value) === 'string' ? fd.value : null;
    };
    replace('_resolveFilename', (orig) => function(...args) {
      // (after the seal a request that is no string -- a String object, an
      // object with its own toString -- is refused, as Node's require
      // refuses one: never made a string here, which would run module code
      // inside this hook and could answer differently each time it is
      // asked, and never handed to Node, whose '#' branch reads request[0]
      // of whatever it is given; #465's Fable pass, F1)
      if (sealed && typeof(args[0]) !== 'string') throw notAString();
      if (isBuiltin(args[0])) return ReflectApply(orig, this, args);
      // (after the seal the plain form of a Windows namespaced request,
      // judged and handed on alike; one that is no path, refused)
      if (sealed && typeof(args[0]) === 'string') {
        const plain = fromNamespaced(args[0]);
        if (plain === null) throw refusal(args[0], false);
        args = [plain, args[1], args[2], args[3]];
      }
      const request = args[0];
      if (sealed) args = [request, parentAfterSeal(args[1], request), args[2], optionsAfterSeal(args[3])];
      // (where the request is headed, judged once: inside the root or not)
      const headed = (enforce && sealed) ? headedTarget(request, ownFilename(args[1])) : null;
      // (C-bare: a bare or '#' name called for directly, as the hook's
      // require branch judges one -- Node 24.15 and later run no hook for
      // a direct call: a '#' name resolved here, inside the root, to a
      // file, a built-in or a bare target looked up from its scope; a
      // subpath climbing out of its package refused)
      // (a bare name by CommonJS's own test, once for this call)
      const bareRequest = typeof(request) === 'string' && requireBare(request);
      if (enforce && sealed && headed == null && bareRequest) {
        // (a '#' name from the parent; a bare one, options.paths and all,
        // CommonJS's own judged lookup, its climbing subpath refused)
        const asked = requireRequest(request, ownFilename(args[1]), requireConditions);
        if (asked === null) throw refusal(request, false, false, ownFilename(args[1]));
        if (asked !== undefined) args = [asked, args[1], args[2], undefined];
      }
      let found;
      // (Node's own step from here: its walk calls the loader's statics
      // with what this wrapper copied, of plain own data, so nothing of
      // module code's runs inside it)
      nodeStep++;
      // (the module root's files granted to Node's own step, as the require
      // hook grants them: its realpath of a file there -- the one a '#' name
      // resolved to, handed on above -- reads the root, not the broker's
      // view of module code's paths, where a host path is no file; each stat
      // still judged by the _stat wrapper)
      const release = sealed ? grant.resolving([moduleRoot]) : null;
      try { found = ReflectApply(orig, this, args); } catch (e) {
        // (after the seal a bare or '#' name a direct call can't resolve
        // gets the one refusal identity's hook gives it, whatever Node's
        // error: the same name by either route answers the same; the second
        // round on #440)
        // (a bare or '#' name first, made here for this very request, its
        // requireStack the parent's virtual name; then a refusal this file
        // made, coming back from the resolve shim below Node 24.15, kept as
        // it is)
        if (ownRefusal(e) && WeakMapGet(refusals, e) === StringSlice(StringCtor(request), 0, 200)) throw e;
        if (enforce && sealed && headed == null) throw refusal(request, false, false, ownFilename(args[1]));
        // (headed inside: a not-found is Node's own wording for the request
        // alone, never its message, which can name where a package.json's
        // "main" led outside the root)
        if (enforce && sealed && e != null && (e.code === 'MODULE_NOT_FOUND' || e.code === 'ENOENT')) throw missing(StringCtor(request));
        if (ownRefusal(e)) throw e;
        if (e && e.code === 'ENOENT') throw notFound(StringSlice(StringCtor(request), 0, 200));
        // (after the seal as module code sees it: the host parent the copy
        // carries never named in its require stack or a package path)
        throw sealed ? asSeen(e) : e;
      } finally {
        nodeStep--;
        if (release != null) release();
      }
      // (the plain form of a Windows namespaced answer, judged and mapped)
      if (typeof(found) === 'string') {
        const plain = fromNamespaced(found);
        if (plain === null) throw notFound(StringSlice(StringCtor(request), 0, 200));
        found = plain;
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
      if (typeof(found) === 'string' && !isBuiltin(found) && !virtualOwn && !allowed(found)) {
        // (headed inside but led outside: as missing, above)
        if (headed != null) throw missing(StringCtor(request));
        throw (enforce && sealed && bareRequest) ? refusal(request, false, false, ownFilename(args[1])) : notFound(StringSlice(StringCtor(request), 0, 200));
      }
      // (after the seal a module file Node found from a host-form copy is
      // answered by its virtual name, as module code knows its files: to a
      // direct call only, never Node's own default step inside this file's
      // hook, which needs the host path)
      if (sealed && nodeStep === 0 && typeof(found) === 'string' && !virtualOwn && !isBuiltin(found) && m.isModuleHost(found)) return virtualName(found);
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
        if (typeof(p) !== 'string') continue;
        const n = virtualLookup(p);
        if (n != null) put(kept, kept.length, n);
        else if (p === '/node_modules' || p === vNodeModules || (sealed && m.isModuleHost(p))) put(kept, kept.length, p);
      }
      return kept;
    });
    replace('_readPackage', (orig) => function(...args) {
      // read once, as a string, and that string handed on in an array of
      // its own (an index write would run a setter a module put on
      // Array.prototype, which could hand on another directory)
      const dir = fromNamespaced(StringCtor(args[0]));
      // (a null prototype: Node's own walk reads it now, and a field it
      // lacks is never looked up through Object.prototype)
      if (dir === null) return {__proto__: null, type: 'none', exists: false, pjsonPath: PATH.join(StringCtor(args[0]), 'package.json')};
      if (statAllowed(PATH.join(dir, 'package.json'))) return ReflectApply(orig, this, [dir]);
      return {__proto__: null, type: 'none', exists: false, pjsonPath: PATH.join(dir, 'package.json')};
    });
    replace('findPackageJSON', (orig) => function(specifier, given) {
      // (after the seal a specifier or base that is no primitive string, a
      // URL object included, answers nothing, never made a string here: that
      // would run module code inside this hook; #465's Fable pass, F1, and
      // K1)
      if (sealed && (stringOf(specifier) == null || (given != null && stringOf(given) == null))) return undefined;
      // (an empty specifier: bare to Node, whose walk would start at the
      // base -- nothing, before Node; #465's Fable pass, F3)
      if (enforce && sealed && specifier === '') return undefined;
      // (the base as a path, checked, and that path what Node is given: a
      // base that is no path or URL Node takes is answered as nothing)
      let base = stringOf(given);
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
        spec = stringOf(specifier);
        if (typeof(spec) === 'string') {
          const relative = isRelative(spec, true);
          // (against the base's directory: the base itself when it names
          // one, with its trailing separator, as Node's URL resolution has it)
          const baseDir = base == null ? null : ((StringSlice(base, -1) === '/' || (VDRIVE != null && StringSlice(base, -1) === '\\')) ? base : PATH.dirname(base));
          const slash = StringSlice(spec, -1) === '/' || (VDRIVE != null && StringSlice(spec, -1) === '\\');
          let judged = relative ? (baseDir != null ? PATH.resolve(baseDir, spec) : null) : pathOf(spec);
          if (relative && judged == null) return undefined;
          // (an absolute path or a file: URL in any case that pathOf takes as
          // no path, a trimmed component percent-encoded say: nothing, never
          // handed on unjudged)
          if (judged == null && (PATH.isAbsolute(spec) || fromNamespaced(spec) === null || isFileUrl(spec))) return undefined;
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
      // (C-bare: under enforce, after the seal, a bare name is looked up
      // here, inside the root, never handed to Node, whose walk stats each
      // node_modules above the base natively; a '#' name is nothing)
      // (located as the hook locates it, and handed to Node from where it
      // is: Node's own subpath, "exports" and nearest-package.json answers,
      // its walk starting at the package's level, never above the root)
      // (a '#' name is nothing: plain Node resolves no imports here; with no
      // base Node throws for a bare name before it looks anywhere)
      if (enforce && sealed && typeof(spec) === 'string' && StringStartsWith(spec, '#')) return undefined;
      // (ESM's bare test, not findPackageJSON's own, which sends a name
      // beginning with '.' to its ES resolver instead: every such name that
      // isn't relative is no valid package name, which Node's packageResolve
      // refuses before any walk, and a throw after the seal is nothing --
      // so either test answers alike, and this one is the wider; C-compat,
      // item 6)
      if (enforce && sealed && base != null && typeof(spec) === 'string' && bareName(spec)) {
        const baseDir = (StringSlice(base, -1) === '/' || (VDRIVE != null && StringSlice(base, -1) === '\\')) ? StringSlice(base, 0, -1) : PATH.dirname(base);
        if (!m.isModuleHost(baseDir)) return undefined;
        const found = insideResolver().packageDir(spec, PATH.join(baseDir, '.ch-bare-base.js'));
        if (found == null) return undefined;
        // (a self-reference: its own package.json, answered here -- Node
        // asked again reads it with its own reader, which can take a file
        // the resolver's parse took otherwise; #465's Fable pass, F4)
        if (found.self === true) return virtualName(PATH.join(found.pkgDir, 'package.json'));
        base = pathToFileHref(found.base);
      }
      // (after the seal a bare specifier makes Node walk each node_modules
      // above the base natively: whether it finds one outside the module's
      // root, or throws for none, is one answer, nothing)
      let found;
      try { found = ReflectApply(orig, this, [spec, base]); } catch (e) { if (sealed) return undefined; throw e; }
      // (Node on Windows answers a namespaced long path, \\?\D:\... or
      // \\?\UNC\server\...: judged, and answered, in the plain form it
      // names)
      found = fromNamespaced(found);
      if (found == null || !allowed(found)) return undefined;
      // (a module file by its virtual name, as module code knows its files)
      if (typeof(found) === 'string' && m.isModuleHost(found)) return virtualName(found);
      return found;
    });
  }
  // At the seal, under enforce: Node's own walk is judged from here on
  // (each static in viaSetters installed through its setter), and a
  // warning Node emits on it reaches module code as module code sees its
  // files. process.emitWarning is held as a wrapper, its own and Node's
  // (Node calls it at call time, from inside its walk: an invalid
  // package.json "main" names the host package.json, DEP0128 and DEP0151):
  // a message, a detail, an Error's message, each with the module root's
  // host forms rewritten as /app (seenText), never replaceable after. Node's
  // once-only "experimental" warning for the setters themselves is not
  // emitted. (The _stat PR; "process warnings carry no host path" for
  // what Node's walk emits.)
  const ProcessEmitWarning = process.emitWarning;
  const ErrorCtor = Error;
  let quietSetters = false;
  // (Node's warnings for a package's "main" -- DEP0128, an invalid one,
  // DEP0151, a fallback to its index -- are not emitted to module code at
  // all under enforce: whether one fires would say whether the "main"
  // named anything)
  const WALK_WARNINGS = ['DEP0128', 'DEP0151'];
  const codeOf = (type, code) => {
    if (typeof(code) === 'string') return code;
    if (type != null && typeof(type) === 'object') {
      const cd = ObjectGetOwnPropertyDescriptor(type, 'code');
      if (cd != null && typeof(cd.value) === 'string') return cd.value;
    }
    return null;
  };
  // (an options object with its detail as module code sees it, a copy of
  // own data; anything else as it is)
  const seenOptions = (type) => {
    if (type == null || typeof(type) !== 'object') return type;
    const dd = ObjectGetOwnPropertyDescriptor(type, 'detail');
    if (dd == null || typeof(dd.value) !== 'string') return type;
    const copy = {__proto__: null};
    const keys = ObjectKeys(type);
    for (let i = 0; i < keys.length; i++) {
      const kd = ObjectGetOwnPropertyDescriptor(type, keys[i]);
      if (kd != null && ObjectHasOwn(kd, 'value')) copy[keys[i]] = kd.value;
    }
    copy.detail = seenText(dd.value);
    return copy;
  };
  const sealWalk = () => {
    // (module code may still set process.emitWarning, a common idiom: what
    // it sets is what a warning goes to; Node's own calls keep reaching
    // this wrapper; one set function that calls the wrapper it saved
    // reaches Node's original, never a loop)
    let inner = ProcessEmitWarning;
    let depth = 0;
    const emitWarning = function emitWarning(warning, type, code, ctor) {
      const text = typeof(warning) === 'string' ? warning : '';
      if (quietSetters && (StringIndexOf(text, 'Module._stat') !== -1 || StringIndexOf(text, 'Module._readPackage') !== -1)) return undefined;
      const c = codeOf(type, code);
      for (let i = 0; i < WALK_WARNINGS.length; i++) if (c === WALK_WARNINGS[i]) return undefined;
      if (inner === null && depth === 0) return undefined;
      const to = depth > 0 ? ProcessEmitWarning : inner;
      // Inside Node's own step (a warning Node gives from its walk, above
      // the root too, for a bare or '#' name): not emitted to module code at
      // all. Whether one fires would say what Node found there, and its
      // text can name a host package.json. (The reviews of e98ac2be and
      // aadd7cc7.)
      if (nodeStep > 0) return undefined;
      // Module code's own call: as Node takes it, at once, its arguments
      // as given (a string's text and an options detail as module code sees
      // them; an Error of its own untouched), Node trimming its frames from
      // this wrapper up
      depth++;
      try {
        return ReflectApply(to, process, [typeof(warning) === 'string' ? seenText(warning) : warning, seenOptions(type), code, ctor === undefined ? emitWarning : ctor]);
      } finally { depth--; }
    };
    // (and what Node's walk reads as it decides, and as it makes an error,
    // held as plain values, writable, never redefinable: no getter of module
    // code's runs inside Node's step. Error.stackTraceLimit stays a data
    // property: V8 reads it only as one.)
    const heldValues = [[ErrorCtor, 'stackTraceLimit'], [process, 'noDeprecation'], [process, 'throwDeprecation'], [process, 'traceDeprecation']];
    for (let i = 0; i < heldValues.length; i++) {
      const target = heldValues[i][0];
      const key = heldValues[i][1];
      const hd = ObjectGetOwnPropertyDescriptor(target, key);
      const value = hd != null && ObjectHasOwn(hd, 'value') ? hd.value : undefined;
      ObjectDefineProperty(target, key, {__proto__: null, value, writable: true, enumerable: hd != null ? hd.enumerable === true : false, configurable: false});
    }
    // (and what Node's walk calls on a target it doesn't find, with its host
    // path, when WATCH_REPORT_DEPENDENCIES is set: process.send, held as it
    // is, absent in a worker; and process.env, held as the object it is, so
    // no Proxy of module code's answers Node's read of it there. Their keys
    // and values module code may still set. Fable's pass on #451, F2: the
    // two are the only process reads Node's resolvers make during a
    // resolution on 22.16, 24.21 and 26.13, beyond what is held already.)
    const lockedValues = [[process, 'send'], [process, 'env']];
    for (let i = 0; i < lockedValues.length; i++) {
      const target = lockedValues[i][0];
      const key = lockedValues[i][1];
      const ld = ObjectGetOwnPropertyDescriptor(target, key);
      const value = ld != null && ObjectHasOwn(ld, 'value') ? ld.value : undefined;
      ObjectDefineProperty(target, key, {__proto__: null, value, writable: false, enumerable: ld != null ? ld.enumerable === true : false, configurable: false});
    }
    holdStackFrames();
    // (C-lows: Node's global lookup directories -- the install's prefix and
    // $HOME's -- as Module exposes them, a copy its resolver never reads
    // again: none, frozen, for module code that reaches Module through
    // module.constructor)
    ObjectDefineProperty(Module, 'globalPaths', {__proto__: null, value: [], writable: true, enumerable: true, configurable: true});
    // (Module._initPaths, which would write them again, is a no-op under
    // enforce: lib/module-lockdown.js's STATICS)
    // (C-lows, R2: util.getCallSites reads V8's frames with no
    // prepareStackTrace: its answers' script names renamed as a stack's are)
    {
      const utilMod = UTIL;
      const GetCallSites = utilMod.getCallSites;
      {
        // (this wrapper's own frame is not one of the caller's: one more asked
        // for, and the first dropped; plain objects, as Node's are)
        // (Node's count, 1 to 200, else its default 10: one more asked for,
        // at most 200, and at most the count given back; a count Node
        // refuses is passed as it was given)
        const heldOf = (orig) => function getCallSites(...args) {
          // (the arguments split as Node splits them: an object first is the
          // options, the count then 10; else the count, 10 when undefined,
          // then the options -- a count Node refuses goes to Node as given)
          // (as Node's own: the count 10 when undefined; with no options, a
          // count of type object -- null too -- is the options, the count 10)
          let want = args[0] === undefined ? 10 : args[0];
          let options = args[1];
          if (options === undefined && typeof(want) === 'object') { options = want; want = 10; }
          // (Node takes 1 to 200, a fraction too, and gives its whole part)
          const whole = typeof(want) === 'number' && want >= 1 && want <= 200 ? MathFloor(want) : null;
          const ask = whole != null ? (whole < 200 ? whole + 1 : 200) : want;
          const sites = ReflectApply(orig, utilMod, options === undefined ? [ask] : [ask, options]);
          const out = [];
          const n = (sites != null && typeof(sites.length) === 'number') ? sites.length : 0;
          const most = whole != null ? whole : 10;
          for (let i = 1; i < n && out.length < most; i++) {
            const site = sites[i];
            const copy = {};
            const keys = ObjectKeys(site);
            for (let k = 0; k < keys.length; k++) {
              const d = ObjectGetOwnPropertyDescriptor(site, keys[k]);
              if (d != null && ObjectHasOwn(d, 'value')) {
                ObjectDefineProperty(copy, keys[k], {__proto__: null, value: typeof(d.value) === 'string' ? runtimeText(d.value) : d.value, writable: true, enumerable: true, configurable: true});
              }
            }
            put(out, out.length, copy);
          }
          return out;
        };
        if (typeof(GetCallSites) === 'function') {
          ObjectDefineProperty(utilMod, 'getCallSites', {__proto__: null, value: heldOf(GetCallSites), writable: true, enumerable: true, configurable: true});
        }
        // (and Node 22's deprecated alias, util.getCallSite: the same hold, of
        // getCallSites itself -- its own deprecation wrapper would be a frame
        // more -- enumerable as Node's)
        const aliasDesc = ObjectGetOwnPropertyDescriptor(utilMod, 'getCallSite');
        if (typeof(GetCallSites) === 'function' && aliasDesc != null && typeof(aliasDesc.value) === 'function') {
          ObjectDefineProperty(utilMod, 'getCallSite', {__proto__: null, value: heldOf(GetCallSites), writable: true, enumerable: aliasDesc.enumerable === true, configurable: true});
        }
      }
    }
    // (C-lows d: process.argv named the Node binary's install path and the
    // runtime's worker file, its install directory: a frozen copy, 'node'
    // and the worker by its virtual name, any argument after with the
    // runtime's paths virtual. Nothing reads process.argv in a worker after
    // the seal -- the runtime's options read it at load, Node at startup.
    // process.execPath stays, Node's own spawns read it: a documented limit.)
    {
      const argvNow = process.argv;
      const seenArgv = [];
      const n = (argvNow != null && typeof(argvNow.length) === 'number') ? argvNow.length : 0;
      // (each argument a whole path: a renamed one spelled with '/' on
      // Windows too)
      const whole = (t) => (PATH.sep !== '/' && StringStartsWith(t, 'countinghouse:') ? StringReplaceAll(t, '\\', '/') : t);
      for (let i = 0; i < n; i++) put(seenArgv, i, i === 0 ? 'node' : whole(runtimeText(StringCtor(argvNow[i]))));
      ObjectDefineProperty(process, 'argv', {__proto__: null, value: seenArgv, writable: true, enumerable: true, configurable: true});
      // (and process.execArgv, which under --hardened carries every
      // --allow-fs-read and --allow-fs-write grant -- the install, each
      // dependency's real path, the modules path: a frozen copy without
      // them, #493's high; nothing in a worker reads it after the seal)
      const execNow = process.execArgv;
      const seenExec = [];
      const m = (execNow != null && typeof(execNow.length) === 'number') ? execNow.length : 0;
      for (let i = 0; i < m; i++) {
        const a = StringCtor(execNow[i]);
        if (StringStartsWith(a, '--allow-fs-')) {
          // (its value in the next argument when not after '=')
          if (StringIndexOf(a, '=', 0) === -1) i++;
          continue;
        }
        put(seenExec, seenExec.length, whole(runtimeText(a)));
      }
      ObjectDefineProperty(process, 'execArgv', {__proto__: null, value: seenExec, writable: true, enumerable: true, configurable: true});
    }
    ObjectDefineProperty(process, 'emitWarning', {__proto__: null, enumerable: true, configurable: false,
      get: () => emitWarning,
      // (the wrapper itself set back restores Node's own; null or undefined
      // turns the module's warnings off, never Node's step's into a throw;
      // the high review of #451, item 8)
      set: (fn) => {
        if (typeof(fn) === 'function') inner = fn === emitWarning ? ProcessEmitWarning : fn;
        else if (fn == null) inner = null;
      }});
    // (fail closed: on a Node whose _stat or _readPackage has no setter, the
    // wrapper would answer only direct calls, and nothing stands in for
    // Node's walk any more)
    // (index loops only: an array iterator is module code's to replace by
    // the seal; the high review of #451)
    const mustSet = ['_stat', '_readPackage'];
    for (let k = 0; k < mustSet.length; k++) {
      const key = mustSet[k];
      let found = false;
      for (let i = 0; i < viaSetters.length; i++) if (viaSetters[i].key === key) found = true;
      if (!found) throw new ErrorCtor(`module sandbox: cannot route Node's own walk through Module.${key} on Node ${process.version}; not starting under enforce`);
    }
    quietSetters = true;
    try {
      for (let i = 0; i < viaSetters.length; i++) ReflectApply(viaSetters[i].set, Module, [viaSetters[i].wrapped]);
    } finally { quietSetters = false; }
  };
  if (!enforce) {
    // (by construction, ruled on #480's high, round 1 and its mediums: what
    // a direct call this file mapped -- a virtual parent, base or specifier
    // handed to Node as its host copy -- answers or throws holds nothing of
    // that copy: every error out of it, whatever its kind, is one not-found
    // naming the request as module code asked it (missing), and an answer
    // outside the module's root none at all -- not found, or
    // findPackageJSON's undefined -- as enforce answers; a call not mapped
    // is Node's own, untouched. Off and audit have no isolation otherwise:
    // Node's own statics a module may replace there (_findPath,
    // _resolveLookupPaths) and its _pathCache see host paths for every
    // resolution, a plain require's too, as on master.)
    // (the mapping alone: a module file found from an own parent's copy is
    // answered by its virtual name to a direct call, never Node's own
    // default step inside this file's hook; nothing is refused here)
    const orig = Module._resolveFilename;
    if (typeof(orig) === 'function') {
      ObjectDefineProperty(Module, '_resolveFilename', {writable: true, configurable: true, enumerable: true, value: function(...args) {
        const request = args[0];
        if (isBuiltin(request)) return ReflectApply(orig, this, args);
        const mapped = parentMapped(args[1], request);
        if (mapped === args[1]) return ReflectApply(orig, this, args);
        // (the module's root granted for the call, as identity's hook does:
        // Node realpaths what it finds through the patched fs)
        const release = grant.resolving([moduleRoot]);
        let found;
        // (a direct call's error, any kind, one not-found as asked; inside
        // identity's hook -- a plain require's Node step -- the hook's own
        // handling stands, Node's error kind kept as audit and off keep it)
        const direct = hookDepth === 0;
        try { found = ReflectApply(orig, this, [request, mapped, args[2], args[3]]); } catch (e) { throw direct ? missing(StringCtor(request)) : e; } finally { release(); }
        if (direct && typeof(found) === 'string' && !isBuiltin(found)) {
          if (m.isModuleHost(found)) return virtualName(found);
          // (already the module's own virtual name -- below 24.15 the resolve
          // shim runs identity's hook for the call, which answers so; from
          // 24.15 on no answer is virtual, and a host /app is outside)
          const v = fromWin(found);
          if (NEEDS_RESOLVE_SHIM && typeof(v) === 'string' && PATH_POSIX.isAbsolute(v) && PATH_POSIX.resolve(v) === v && m.isVirtual(v)) return found;
          throw missing(StringCtor(request));
        }
        return found;
      }});
    }
    // (findPackageJSON the same way: a base, or an absolute specifier, that
    // names the module's own virtual file, as a path or a file: URL string,
    // reaches Node as its host copy, confined to the root; a relative
    // specifier Node resolves against that; the answer, a module file, by
    // its virtual name; anything else handed on as it is -- C-compat, item 4)
    const find = Module.findPackageJSON;
    if (typeof(find) === 'function') {
      // (a string naming a virtual path -- a path or a file: URL, normalised
      // -- by the one mapping, pathOf; any other argument, a URL object
      // included, handed on as it is: strings only, pass url.href; #480's
      // high, round 1, items 2 and 5)
      // (a virtual name only -- any other string, a host path in whatever
      // spelling, handed on as given; the root itself as a file too: its
      // walk starts at the root's parent, and what it finds there is outside
      // the module, so not found below -- #480's high, round 1, mediums)
      const hostOf = (v) => pathOf(v, true, true);
      ObjectDefineProperty(Module, 'findPackageJSON', {writable: true, configurable: true, enumerable: true, value: function findPackageJSON(specifier, base) {
        // (a mapped specifier handed on as a file URL: Node parses the
        // specifier as one, so a host path would be a drive-letter scheme
        // on Windows, and its %-escapes decoded -- as enforce's wrapper does)
        const specHost = hostOf(specifier);
        const spec = specHost != null ? pathToFileHref(specHost) : specifier;
        const baseHost = hostOf(base);
        const at = baseHost != null ? baseHost : base;
        if (spec === specifier && at === base) return ReflectApply(find, this, [specifier, base]);
        const release = grant.resolving([moduleRoot]);
        let found;
        try { found = ReflectApply(find, this, [spec, at]); } catch (e) { return undefined; } finally { release(); }
        if (typeof(found) !== 'string') return found;
        return m.isModuleHost(found) ? virtualName(found) : undefined;
      }});
    }
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
    statCalls: () => statCalls,
    seal() {
      sealed = true;
      countinghouseRoots.length = 0;
      if (enforce) sealWalk();
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

// The install's own spellings for a worker's stack names (C-lows): each own
// entry, and the install, by the spelling it runs by (an 8.3 short name on
// Windows, #272) and by its real path, where the two differ -> [{from,
// to}], the targets with '/' (the host's separator made in the worker).
// Main thread only; once per install.
const spellingsOf = new Map();
function installSpellingsFor(installDir, realpath) {
  if (spellingsOf.has(installDir)) return spellingsOf.get(installDir);
  const out = [];
  const realOf = (p) => { try { return realpath(p); } catch (e) { return p; } };
  const both = (host, to) => {
    const real = realOf(host);
    if (real !== host) out.push({from: real, to}, {from: host, to});
  };
  for (const own of COUNTINGHOUSE_OWN) both(PATH.join(installDir, own), `countinghouse:/${own}`);
  both(installDir, 'countinghouse:');
  spellingsOf.set(installDir, out);
  return out;
}

module.exports = {install, installSpellingsFor, mapper, fromWinFor, fromNamespacedFor, loadModuleFile, reachesLib, insideHostFor, withoutModuleRoots, moduleSpecifier, specifierFor, codeUnderVroot, underVrootMessage, codeRootsFor, lateRootsFor, pathFor, resolveModulePath, VROOT, MODULE_SPECIFIER};
