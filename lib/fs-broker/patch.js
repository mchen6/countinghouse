'use strict';
// Module worker side of the file broker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2): replaces every method of
// the shared fs, fs/promises and FileHandle objects, before any countinghouse
// or dependency code loads, with versions that ask the main thread's broker.
// Sync calls go over the blocking bridge, callback and promise calls over the
// async channel (lib/fs-broker/client.js). Anything not handled here throws,
// so a method a later Node adds fails closed: install() ends by sweeping fs
// and fs/promises and locking every function it handled nowhere, and knows
// as no data or class, to one that throws (F4-6; test/fs-broker/07-patch.js
// fakes such a method). Node's own FileHandle never reaches module code:
// fs.promises.open answers the broker's own, every method of which is
// handled.
//
// Grants (plan 3, L1): install() returns a grant controller, which
// lib/lean-worker.js keeps and hands to the loader hook (lib/fs-broker/identity.js)
// and never exports. While a grant is active, the original fs serves the sync
// stat calls for absolute paths under the granted roots (a resolve), reads of
// exactly the granted file (a load), or both under the boot roots
// (countinghouse's own boot requires, until set-options). By path, never by
// time: anything else in the same window still goes to the broker.
const fs = require('fs');
const fsp = require('fs/promises');
const pathMod = require('path');
const url = require('url');
// the built-ins a broker-made handle or helper uses, taken at load, before
// the lockdown, never on first use (#194's PR 1)
const readline = require('readline');
const streamLib = require('stream');
const utilLib = require('util');
const http2Lib = require('http2');
const {EventEmitter} = require('events');

// What the routing decision, the grants and the descriptor set call at call
// time: taken here, when this file loads, before any module code (a module
// shares the worker's realm and can replace a method of Array, Set, String or
// Function, or a function of a shared built-in module). An original fs
// function is called with ReflectApply, never its own apply, which would
// hand it to a replaced Function.prototype.apply.
const ReflectApply = Reflect.apply;
const uncurry = (fn) => Function.prototype.call.bind(fn);
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const SetDelete = uncurry(Set.prototype.delete);
const WeakMapGet = uncurry(WeakMap.prototype.get);
const WeakMapSet = uncurry(WeakMap.prototype.set);
const StreamOnce = uncurry(EventEmitter.prototype.once);
const ReadableDestroy = uncurry(streamLib.Readable.prototype.destroy);
const WritableDestroy = uncurry(streamLib.Writable.prototype.destroy);
const ReadableStreamCtor = globalThis.ReadableStream;
const ByteControllerClose = uncurry(globalThis.ReadableByteStreamController.prototype.close);
const ByteControllerError = uncurry(globalThis.ReadableByteStreamController.prototype.error);
const ByteControllerRequest = uncurry(Object.getOwnPropertyDescriptor(globalThis.ReadableByteStreamController.prototype, 'byobRequest').get);
const RequestRespond = uncurry(globalThis.ReadableStreamBYOBRequest.prototype.respond);
const RequestView = uncurry(Object.getOwnPropertyDescriptor(globalThis.ReadableStreamBYOBRequest.prototype, 'view').get);
const RegistryRegister = uncurry(FinalizationRegistry.prototype.register);
const RegistryUnregister = uncurry(FinalizationRegistry.prototype.unregister);
const invalidState = (what) => withCode(new Error(`Invalid state: The FileHandle is ${what}`), 'ERR_INVALID_STATE');
const WriteStreamClose = uncurry(fs.WriteStream.prototype.close);
const ReadableDestroyed = uncurry(Object.getOwnPropertyDescriptor(streamLib.Readable.prototype, 'destroyed').get);
const WritableDestroyed = uncurry(Object.getOwnPropertyDescriptor(streamLib.Writable.prototype, 'destroyed').get);
const WritableFinished = uncurry(Object.getOwnPropertyDescriptor(streamLib.Writable.prototype, 'writableFinished').get);
const WritableErrored = uncurry(Object.getOwnPropertyDescriptor(streamLib.Writable.prototype, 'errored').get);
const ObjectFreeze = Object.freeze;
const PromiseCtor = Promise;
const PromiseThen = Promise.prototype.then;
const ArrayPush = uncurry(Array.prototype.push);
const PromiseResolveFn = Promise.resolve;
const PromiseResolve = (v) => ReflectApply(PromiseResolveFn, PromiseCtor, [v]);
const ObjectAssign = Object.assign;
const StringCtor = String;
const StringStartsWith = uncurry(String.prototype.startsWith);
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const URLProto = URL.prototype;
const URLHref = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'href').get);
const URLProtocol = uncurry(Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get);
const FileURLToPath = url.fileURLToPath;
const fileURLToPath = (u) => ReflectApply(FileURLToPath, url, [u]);
const PathIsAbsolute = pathMod.isAbsolute;
const PathResolve = pathMod.resolve;
const pathIsAbsolute = (p) => ReflectApply(PathIsAbsolute, pathMod, [p]);
const pathResolve = (p) => ReflectApply(PathResolve, pathMod, [p]);
const PrependListener = uncurry(EventEmitter.prototype.prependListener);
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectHasOwn = Object.hasOwn;
const ObjectKeys = Object.keys;
const ReflectOwnKeys = Reflect.ownKeys;
// arr[i] = v as a definition: an assignment to an index (or a key) walks the
// prototype chain and runs a setter a module put there, with arr as `this`
const put = (arr, i, v) => ObjectDefineProperty(arr, i, {__proto__: null, value: v, writable: true, enumerable: true, configurable: true});
// err[key] = value for each own key of fields, as definitions (an assignment
// would run a setter a module put on Object.prototype or Error.prototype)
const withFields = (err, fields) => {
  const keys = ObjectKeys(fields);
  for (let i = 0; i < keys.length; i++) put(err, keys[i], fields[keys[i]]);
  return err;
};
const withCode = (err, code) => withFields(err, {__proto__: null, code});
const O_RDONLY = fs.constants.O_RDONLY;
const MapCtor = Map;
const MapGetP = uncurry(Map.prototype.get);
const MapSetP = uncurry(Map.prototype.set);
const MapDeleteP = uncurry(Map.prototype.delete);
const MapForEachP = uncurry(Map.prototype.forEach);

const MAX_IO = 16 * 1024 * 1024;
// what a real descriptor (the original fs's, opened read-only for a grant)
// may be given to: stat, read, close
const REAL_FD_KEYS = new Set(['fstat', 'fstatSync', 'read', 'readSync', 'readv', 'readvSync',
  'readFile', 'readFileSync', 'close', 'closeSync']);
// Broker descriptors are shown to module code above FD_BASE, so they never
// collide with real descriptors from the original fs (the loader's grants).
const FD_BASE = 0x10000000;
const STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename));
const BIGINT_STATS_PROTO = Object.getPrototypeOf(fs.statSync(__filename, {bigint: true}));
const DIRENT_TYPE = {file: fs.constants.UV_DIRENT_FILE, dir: fs.constants.UV_DIRENT_DIR,
  symlink: fs.constants.UV_DIRENT_LINK, other: fs.constants.UV_DIRENT_UNKNOWN};
const toUnixTimestamp = fs._toUnixTimestamp;
const GLOB_CHARS = /[*?[\]{}!]/;

let consoleSilenced = false;
function setConsoleSilenced(v) { consoleSilenced = (v === true); }

function unavailable(what) {
  return withCode(new Error(`${what} is not available to modules (countinghouse module sandbox)`), 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
}

function argType(name, value) {
  return withCode(new TypeError(`The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${typeof(value)}`), 'ERR_INVALID_ARG_TYPE');
}

function outOfRange(name, value) {
  return withCode(new RangeError(`The value of "${name}" is out of range. Received ${value}`), 'ERR_OUT_OF_RANGE');
}

// Paths cross the bridge as strings (a Buffer arrives as a Uint8Array and a
// URL does not clone).
// On Windows a path in the "/" form the broker's namespace uses, a Buffer's
// too; unchanged on POSIX (lib/fs-broker/roots.js).
// the virtual drive a module's files carry on win32 (#195), given by the main thread
const virtualForm = require('./roots').virtualFormFor(process.platform, (require('worker_threads').workerData || {}).virtualDrive);
const grantRoots = require('./roots').assertGrantRoots(process.platform);

// On Windows with a virtual drive (#195) a file URL a module builds from its
// own (new URL('./x', import.meta.url)) names file:///<V>:/app/...: read as
// its path, then as the namespace's. Elsewhere as before.
const WIN_V = process.platform === 'win32' && /^[A-Z]$/.test(String((require('worker_threads').workerData || {}).virtualDrive));
const fileUrlPath = (u) => { try { return url.fileURLToPath(u); } catch (e) { return null; } };
function p(v, name) {
  if (typeof(v) === 'string') {
    if (WIN_V && v.startsWith('file:')) { const q = fileUrlPath(v); if (q != null) return virtualForm(q); }
    return virtualForm(v);
  }
  if (v instanceof URL) {
    if (WIN_V && v.protocol === 'file:') { const q = fileUrlPath(v); if (q != null) return virtualForm(q); }
    return v.href;
  }
  if (v instanceof Uint8Array) return virtualForm(Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('utf8'));
  throw argType(name || 'path', v);
}

function opts(o, def) {
  if (typeof(o) === 'string') return Object.assign({}, def, {encoding: o});
  return Object.assign({}, def, o || {});
}

function enc(buf, encoding) {
  const b = Buffer.from(buf);
  return (encoding && encoding !== 'buffer') ? b.toString(encoding) : b;
}

function str(s, encoding) {
  return encoding === 'buffer' ? Buffer.from(s) : s;
}

function stats(r) {
  const s = Object.create(r.bigint ? BIGINT_STATS_PROTO : STATS_PROTO);
  return Object.assign(s, r.fields);
}

function dirent(e) {
  return new fs.Dirent(e.name, DIRENT_TYPE[e.type] != null ? DIRENT_TYPE[e.type] : DIRENT_TYPE.other, e.parentPath);
}

function mode(m, def) {
  if (m == null) return def;
  return typeof(m) === 'string' ? parseInt(m, 8) : m;
}

function toBuffer(data, encoding) {
  if (typeof(data) === 'string') return Buffer.from(data, encoding || 'utf8');
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw withCode(new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.'), 'ERR_INVALID_ARG_TYPE');
}

function splitCb(args) {
  const cb = args[args.length - 1];
  if (typeof(cb) !== 'function') {
    throw withCode(new TypeError('The "cb" argument must be of type function.'), 'ERR_INVALID_ARG_TYPE');
  }
  return {args: Array.prototype.slice.call(args, 0, -1), cb: cb};
}

function cpError(code, message) {
  return withCode(new Error(message), code);
}

function install(client, settings) {
  settings = settings || {};
  const sync = client.sync;
  const call = client.async;
  const consoleWrite = settings.consoleWrite || ((fd, buf) => (fd === 1 ? process.stdout : process.stderr).write(buf));
  const origFs = Object.assign({}, fs);
  const origFsp = Object.assign({}, fsp);
  const realFds = new Set();
  const handled = {fs: new Set(), promises: new Set(), fileHandle: new Set()};
  const grants = {roots: [], files: [], bootRoots: []};

  const toBroker = (fd) => (typeof(fd) === 'number' && fd >= FD_BASE ? fd - FD_BASE : -1);
  const fromBroker = (fd) => fd + FD_BASE;

  const STAT_KEYS = new Set(['realpathSync', 'statSync', 'lstatSync', 'existsSync']);
  const READ_KEYS = new Set(['readFileSync', 'openSync']);
  // Boot also lists directories: dependencies probe for optional native
  // addons (node-gyp-build), as the interim host routing used to allow.
  const BOOT_KEYS = new Set([...STAT_KEYS, ...READ_KEYS, 'readdirSync']);
  // A granted root or inside one; Windows' rule is its own (lib/fs-broker/roots.js).
  const under = require('./roots').underFor(process.platform);
  const bootOutside = [];   // the first 20 distinct paths
  let bootDropped = 0;

  // A file: URL argument as the path it names (its href read through
  // URL.prototype's own getter, never one of the object's), anything else as
  // it is (the original refuses a URL of another scheme itself): what the
  // check reads, and what the original is then given.
  const fileArg = (v) => {
    if (v == null || typeof(v) !== 'object' || !ObjectIsPrototypeOf(URLProto, v)) return v;
    try {
      return URLProtocol(v) === 'file:' ? fileURLToPath(URLHref(v)) : v;
    } catch (e) {
      return v;
    }
  };
  function absolutePath(v) {
    if (typeof(v) !== 'string') return null;
    let s = v;
    if (StringStartsWith(s, 'file:')) { try { s = fileURLToPath(s); } catch (e) { return null; } }
    return pathIsAbsolute(s) ? pathResolve(s) : null;
  }
  // (by index: no Array method a module could have replaced)
  const listed = (list, s) => {
    for (let i = 0; i < list.length; i++) if (list[i] === s) return true;
    return false;
  };

  // A grant is for reading: openSync's flags, read once, must open read-only
  // (absent, 'r', 'rs' or O_RDONLY); anything else goes to the broker.
  function readOnly(key, a) {
    if (key !== 'openSync') return true;
    const flags = a[1];
    return flags === undefined || flags === 'r' || flags === 'rs' || flags === O_RDONLY;
  }
  // The arguments a granted read hands the original: readFileSync gets a
  // fresh options object of its own (the encoding read once, the flag 'r'),
  // never the module's, whose flag could truncate or write.
  function granteds(key, a) {
    if (key !== 'readFileSync') return a;
    const given = a[1];
    let encoding;
    if (typeof(given) === 'string') encoding = given;
    else if (given != null && typeof(given) === 'object') {
      const d = ObjectGetOwnPropertyDescriptor(given, 'encoding');
      encoding = (d != null && ObjectHasOwn(d, 'value')) ? d.value : undefined;
    }
    const options = {__proto__: null, flag: 'r'};
    if (typeof(encoding) === 'string') put(options, 'encoding', encoding);
    const out = [];
    put(out, 0, a[0]);
    put(out, 1, options);
    return out;
  }

  // Only the sync forms on fs: the loader is synchronous.
  function granted(obj, key, v) {
    if (obj !== fs || !SetHas(BOOT_KEYS, key)) return false;
    if (grants.roots.length === 0 && grants.files.length === 0 && grants.bootRoots.length === 0) return false;
    const s = absolutePath(v);
    if (s == null) return false;
    if (under(s, grants.bootRoots)) return true;
    if (SetHas(STAT_KEYS, key)) return under(s, grants.roots);
    return SetHas(READ_KEYS, key) && listed(grants.files, s);
  }

  // During boot only countinghouse's own code runs, so anything else it
  // touches (a dependency probing /proc/self/exe for the libc, say) is
  // answered ENOENT here, not by the broker, which would report it in the
  // module's name. lib/lean-worker.js logs these once as countinghouse's own.
  // Reached only from routed() for path-routed calls (its route's paths
  // non-empty), so paths[0] always names a path argument.
  function bootRefusal(obj, key, a, paths) {
    const v = a[paths[0]];
    const shown = absolutePath(v) || StringCtor(v);
    if (!bootOutside.includes(shown)) {
      if (bootOutside.length < 20) bootOutside.push(shown);
      else bootDropped++;
    }
    const e = new Error(`ENOENT: no such file or directory, ${key.replace(/Sync$/, '')} '${shown}'`);
    withFields(e, {__proto__: null, code: 'ENOENT', errno: -2, syscall: key.replace(/Sync$/, ''), path: shown});
    if (obj === fsp) return Promise.reject(e);
    if (key === 'existsSync') return false;
    // fs.exists calls back with one boolean, not an error (review, Task 4).
    if (key === 'exists') { if (typeof(a[1]) === 'function') process.nextTick(a[1], false); return undefined; }
    if (key.endsWith('Sync')) throw e;
    const cb = a[a.length - 1];
    if (typeof(cb) === 'function') return process.nextTick(cb, e);
    throw e;
  }

  function callOrig(key, orig, a) {
    if (key === 'openSync') { const fd = ReflectApply(orig, fs, a); SetAdd(realFds, fd); return fd; }
    if (key === 'open' && typeof(a[a.length - 1]) === 'function') {
      const cb = a[a.length - 1];
      a[a.length - 1] = (e, fd) => { if (!e) SetAdd(realFds, fd); cb(e, fd); };
    }
    if (key === 'closeSync' || key === 'close') SetDelete(realFds, a[0]);
    return ReflectApply(orig, fs, a);
  }

  // route: {paths: [argIndex...], fd: argIndex} -- when every listed path is
  // granted, or the descriptor came from the original fs and the call only
  // stats, reads or closes it, call the original.  Such a descriptor was
  // opened read-only for a grant: anything else asked of it (fchmod, fchown,
  // futimes, fsync, a write or a truncate) goes to the broker, which does
  // not know it (EBADF).
  function routed(obj, key, value, route) {
    if (route == null) return value;
    // A granted realpathSync is the native one, plain or .native: the loader
    // decides on its answer, and Node's JS form resolves x -> "." / y -> "x/.."
    // to x's directory where the kernel opens its parent (FB3).
    const orig = (obj === fs && key === 'realpathSync') ? origFs.realpathSync.native : (obj === fs ? origFs : origFsp)[key];
    if (typeof(orig) !== 'function') return value;
    // (a route's own fields, read once here: never at call time, and never
    // inherited -- a route is prototype-less, and Object.prototype.fd or
    // .paths set by module code answers nothing; F4-5)
    const paths = ObjectHasOwn(route, 'paths') ? route.paths : null;
    const fdAt = ObjectHasOwn(route, 'fd') ? route.fd : null;
    const wrapped = function(...a) {
      // Windows: a namespace path in "\" form gets its POSIX form before
      // anything else sees it (virtualForm; unchanged on POSIX). A URL is
      // its href from here on, so what is checked is what the original gets.
      if (paths != null) {
        for (let n = 0; n < paths.length; n++) put(a, paths[n], virtualForm(fileArg(a[paths[n]])));
      }
      if (fdAt != null && obj === fs && SetHas(REAL_FD_KEYS, key) && typeof(a[fdAt]) === 'number' && SetHas(realFds, a[fdAt])) return callOrig(key, orig, a);
      if (paths != null && paths.length > 0) {
        let all = readOnly(key, a);
        for (let n = 0; n < paths.length && all; n++) {
          const v = a[paths[n]];
          all = v != null && typeof(v) !== 'number' && granted(obj, key, v);
          // the original is given the path that was checked
          if (all) put(a, paths[n], absolutePath(v));
        }
        if (all) return obj === fs ? callOrig(key, orig, granteds(key, a)) : ReflectApply(orig, fsp, a);
      }
      if (grants.bootRoots.length > 0 && paths != null && paths.length > 0) return bootRefusal(obj, key, a, paths);
      return ReflectApply(value, this, a);
    };
    // realpath.native and realpathSync.native: the wrapper is its own native form
    if (value.native === value) wrapped.native = wrapped;
    return wrapped;
  }

  function lock(obj, key, value, set, route) {
    Object.defineProperty(obj, key, {value: routed(obj, key, value, route), writable: false, configurable: false, enumerable: true});
    set.add(key);
  }

  // One operation, three forms. spec: {args(...a) -> [op, args], out(result, ...a) -> value,
  // route, noEntry (index of an options argument honouring throwIfNoEntry), consoleNoop}
  function define(name, spec) {
    const syncName = `${name}Sync`;
    const syncFn = function(...a) {
      if (spec.consoleNoop && (a[0] === 1 || a[0] === 2)) return undefined;
      try {
        return spec.out(sync(...spec.args(...a)), ...a);
      } catch (e) {
        if (spec.noEntry != null && e.code === 'ENOENT' && a[spec.noEntry] != null && a[spec.noEntry].throwIfNoEntry === false) return undefined;
        throw e;
      }
    };
    const cbFn = function(...all) {
      const {args, cb} = splitCb(all);
      if (spec.consoleNoop && (args[0] === 1 || args[0] === 2)) return process.nextTick(cb, null);
      let req;
      try { req = spec.args(...args); } catch (e) { return process.nextTick(cb, e); }
      call(...req).then((r) => cb(null, spec.out(r, ...args)), (e) => cb(e));
    };
    const promiseFn = async function(...a) { return spec.out(await call(...spec.args(...a)), ...a); };
    if (spec.native) { syncFn.native = syncFn; cbFn.native = cbFn; }
    if (spec.sync !== false) lock(fs, syncName, syncFn, handled.fs, spec.route);
    if (spec.callback !== false) lock(fs, name, cbFn, handled.fs, spec.route);
    if (spec.promise !== false) lock(fsp, name, promiseFn, handled.promises, spec.route);
  }

  const none = () => undefined;
  const P0 = {__proto__: null, paths: [0]};
  const P01 = {__proto__: null, paths: [0, 1]};
  const P1 = {__proto__: null, paths: [1]};
  const F0 = {__proto__: null, fd: 0};
  const bfd = (fd) => toBroker(fd);

  define('access', {args: (path, m) => ['access', [p(path), m]], out: none, route: P0});
  define('stat', {args: (path, o) => ['stat', [p(path), opts(o)]], out: stats, route: P0, noEntry: 1});
  define('lstat', {args: (path, o) => ['lstat', [p(path), opts(o)]], out: stats, route: P0, noEntry: 1});
  define('fstat', {args: (fd, o) => ['fstat', [bfd(fd), opts(o)]], out: stats, promise: false, route: F0});
  define('statfs', {args: (path, o) => ['statfs', [p(path), opts(o)]], out: (r) => r, route: P0});
  define('realpath', {args: (path) => ['realpath', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding), native: true, route: P0});
  define('readlink', {args: (path) => ['readlink', [p(path)]], out: (r, path, o) => str(r, opts(o).encoding), route: P0});
  define('readdir', {
    args: (path, o) => { const x = opts(o); return ['readdir', [p(path), {withFileTypes: !!x.withFileTypes, recursive: !!x.recursive}]]; },
    out: (r, path, o) => { const x = opts(o); return x.withFileTypes ? r.map(dirent) : r.map((n) => str(n, x.encoding)); },
    route: P0
  });
  define('mkdir', {args: (path, o) => { const x = (typeof(o) === 'object' && o != null) ? o : {mode: o}; return ['mkdir', [p(path), {recursive: !!x.recursive, mode: mode(x.mode, 0o777)}]]; }, out: (r) => r, route: P0});
  define('mkdtemp', {args: (prefix) => ['mkdtemp', [p(prefix, 'prefix')]], out: (r, prefix, o) => str(r, opts(o).encoding), route: P0});
  define('rmdir', {args: (path, o) => ['rmdir', [p(path), o]], out: none, route: P0});
  define('rm', {args: (path, o) => ['rm', [p(path), opts(o)]], out: none, route: P0});
  define('unlink', {args: (path) => ['unlink', [p(path)]], out: none, route: P0});
  define('rename', {args: (a, b) => ['rename', [p(a, 'oldPath'), p(b, 'newPath')]], out: none, route: P01});
  define('copyFile', {args: (a, b, m) => ['copyFile', [p(a, 'src'), p(b, 'dest'), m]], out: none, route: P01});
  define('link', {args: (a, b) => ['link', [p(a, 'existingPath'), p(b, 'newPath')]], out: none, route: P01});
  define('symlink', {args: (target, path, type) => ['symlink', [p(target, 'target'), p(path), type]], out: none, route: P1});
  define('chmod', {args: (path, m) => ['chmod', [p(path), mode(m)]], out: none, route: P0});
  define('chown', {args: (path, uid, gid) => ['chown', [p(path), uid, gid]], out: none, route: P0});
  define('lchown', {args: (path, uid, gid) => ['lchown', [p(path), uid, gid]], out: none, route: P0});
  define('utimes', {args: (path, at, mt) => ['utimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, route: P0});
  define('lutimes', {args: (path, at, mt) => ['lutimes', [p(path), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, route: P0});
  define('truncate', {args: (path, len) => (typeof(path) === 'number' ? ['ftruncate', [bfd(path), len || 0]] : ['truncate', [p(path), len || 0]]), out: none, route: {__proto__: null, paths: [0], fd: 0}});
  define('open', {args: (path, flags, m) => ['open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)]], out: fromBroker, promise: false, route: P0});
  define('close', {args: (fd) => ['close', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('fsync', {args: (fd) => ['fsync', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('fdatasync', {args: (fd) => ['fdatasync', [bfd(fd)]], out: none, promise: false, route: F0, consoleNoop: true});
  define('ftruncate', {args: (fd, len) => ['ftruncate', [bfd(fd), len || 0]], out: none, promise: false, route: F0});
  define('fchmod', {args: (fd, m) => ['fchmod', [bfd(fd), mode(m)]], out: none, promise: false, route: F0});
  define('fchown', {args: (fd, uid, gid) => ['fchown', [bfd(fd), uid, gid]], out: none, promise: false, route: F0});
  define('futimes', {args: (fd, at, mt) => ['futimes', [bfd(fd), toUnixTimestamp(at), toUnixTimestamp(mt)]], out: none, promise: false, route: F0});

  // exists: the callback gets one argument, a boolean.
  lock(fs, 'existsSync', (path) => { try { return sync('exists', [p(path)]); } catch (e) { return false; } }, handled.fs, P0);
  lock(fs, 'exists', (path, cb) => {
    let req;
    try { req = p(path); } catch (e) { return process.nextTick(cb, false); }
    call('exists', [req]).then((r) => cb(r), () => cb(false));
  }, handled.fs, P0);

  // read / write on descriptors, with Node's argument shapes.
  function readArgs(fd, buffer, offset, length, position) {
    if (buffer != null && !ArrayBuffer.isView(buffer) && typeof(buffer) === 'object') {
      const o = buffer;
      buffer = o.buffer || Buffer.alloc(16384);
      offset = o.offset; length = o.length; position = o.position;
    } else if (offset != null && typeof(offset) === 'object') {
      const o = offset;
      offset = o.offset; length = o.length; position = o.position;
    }
    offset = offset || 0;
    if (offset < 0 || offset > buffer.byteLength) throw outOfRange('offset', offset);
    length = (length == null) ? buffer.byteLength - offset : length;
    if (length < 0 || length > buffer.byteLength - offset) throw outOfRange('length', length);
    return {buffer, offset, length: Math.min(length, MAX_IO), position: (position == null || position === -1) ? null : Number(position)};
  }
  function fillRead(r, a) {
    const b = Buffer.from(r);
    b.copy(Buffer.from(a.buffer.buffer, a.buffer.byteOffset, a.buffer.byteLength), a.offset);
    return b.length;
  }
  function writeArgs(fd, data, offset, length, position) {
    if (typeof(data) === 'string') {
      // write(fd, string[, position[, encoding]])
      return {buf: Buffer.from(data, typeof(length) === 'string' ? length : 'utf8'), position: (offset == null) ? null : offset};
    }
    const buf = toBuffer(data);
    if (offset != null && typeof(offset) === 'object') {
      const o = offset;
      return {buf: buf.subarray(o.offset || 0, (o.offset || 0) + (o.length == null ? buf.length - (o.offset || 0) : o.length)), position: o.position == null ? null : o.position};
    }
    const off = offset || 0;
    const len = (length == null) ? buf.length - off : length;
    return {buf: buf.subarray(off, off + len), position: position == null ? null : position};
  }
  function writeChunks(fd, buf, position) {
    if (fd === 1 || fd === 2) { if (!consoleSilenced) consoleWrite(fd, buf); return buf.length; }
    let done = 0;
    while (done < buf.length) {
      const chunk = buf.subarray(done, done + MAX_IO);
      done += sync('write', [bfd(fd), chunk, position == null ? null : position + done]);
    }
    return done;
  }
  async function writeChunksAsync(fd, buf, position) {
    if (fd === 1 || fd === 2) { if (!consoleSilenced) consoleWrite(fd, buf); return buf.length; }
    let done = 0;
    while (done < buf.length) {
      const chunk = buf.subarray(done, done + MAX_IO);
      done += await call('write', [bfd(fd), chunk, position == null ? null : position + done]);
    }
    return done;
  }

  lock(fs, 'readSync', (fd, ...rest) => { const a = readArgs(fd, ...rest); return fillRead(sync('read', [bfd(fd), a.length, a.position]), a); }, handled.fs, F0);
  lock(fs, 'read', (fd, ...all) => {
    const {args, cb} = splitCb(all);
    let a;
    try { a = readArgs(fd, ...(args.length > 0 ? args : [{}])); } catch (e) { return process.nextTick(cb, e); }
    call('read', [bfd(fd), a.length, a.position]).then((r) => cb(null, fillRead(r, a), a.buffer), (e) => cb(e));
  }, handled.fs, F0);
  lock(fs, 'writeSync', (fd, ...rest) => { const w = writeArgs(fd, ...rest); return writeChunks(fd, w.buf, w.position); }, handled.fs, F0);
  lock(fs, 'write', (fd, data, ...all) => {
    const {args, cb} = splitCb(all);
    let w;
    try { w = writeArgs(fd, data, ...args); } catch (e) { return process.nextTick(cb, e); }
    writeChunksAsync(fd, w.buf, w.position).then((n) => cb(null, n, data), (e) => cb(e));
  }, handled.fs, F0);
  function vec(buffers) { return Buffer.concat(buffers.map((b) => toBuffer(b))); }
  lock(fs, 'writevSync', (fd, buffers, position) => writeChunks(fd, vec(buffers), position), handled.fs, F0);
  lock(fs, 'writev', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    writeChunksAsync(fd, vec(buffers), args[0]).then((n) => cb(null, n, buffers), (e) => cb(e));
  }, handled.fs, F0);
  function scatter(r, buffers) {
    const b = Buffer.from(r);
    let off = 0;
    for (const t of buffers) {
      const n = Math.min(t.byteLength, b.length - off);
      b.copy(Buffer.from(t.buffer, t.byteOffset, t.byteLength), 0, off, off + n);
      off += n;
    }
    return b.length;
  }
  const total = (buffers) => Math.min(buffers.reduce((n, b) => n + b.byteLength, 0), MAX_IO);
  lock(fs, 'readvSync', (fd, buffers, position) => scatter(sync('read', [bfd(fd), total(buffers), position == null ? null : position]), buffers), handled.fs, F0);
  lock(fs, 'readv', (fd, buffers, ...all) => {
    const {args, cb} = splitCb(all);
    call('read', [bfd(fd), total(buffers), args[0] == null ? null : args[0]]).then((r) => cb(null, scatter(r, buffers), buffers), (e) => cb(e));
  }, handled.fs, F0);

  // Whole files: a path goes to the broker's readFile (one round trip, up to
  // 16 MB, chunked past it); a descriptor reads from its current position.
  function readAllFd(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(sync('read', [bfd(fd), MAX_IO, null]));
      if (r.length === 0) break;
      parts.push(r);
    }
    return Buffer.concat(parts);
  }
  async function readAllFdAsync(fd) {
    const parts = [];
    for (;;) {
      const r = Buffer.from(await call('read', [bfd(fd), MAX_IO, null]));
      if (r.length === 0) break;
      parts.push(r);
    }
    return Buffer.concat(parts);
  }
  function readFileSyncImpl(path, o) {
    const x = opts(o, {flag: 'r'});
    if (typeof(path) === 'number') return enc(readAllFd(path), x.encoding);
    try {
      return enc(sync('readFile', [p(path), x.flag]), x.encoding);
    } catch (e) {
      if (e.code !== 'EFBIG') throw e;
    }
    // past 16 MB: chunked reads the worker assembles
    const fd = fromBroker(sync('open', [p(path), x.flag, 0o666]));
    try { return enc(readAllFd(fd), x.encoding); } finally { sync('close', [bfd(fd)]); }
  }
  async function readFileImpl(path, o) {
    const x = opts(o, {flag: 'r'});
    if (typeof(path) === 'number') return enc(await readAllFdAsync(path), x.encoding);
    if (path instanceof BrokeredFileHandle) return enc(await readAllFdAsync(path.fd), x.encoding);
    try {
      return enc(await call('readFile', [p(path), x.flag]), x.encoding);
    } catch (e) {
      if (e.code !== 'EFBIG') throw e;
    }
    const fd = fromBroker(await call('open', [p(path), x.flag, 0o666]));
    try { return enc(await readAllFdAsync(fd), x.encoding); } finally { await call('close', [bfd(fd)]); }
  }
  function writeFileSyncImpl(path, data, o, defFlag) {
    const x = opts(o, {flag: defFlag, mode: 0o666});
    const buf = toBuffer(data, x.encoding);
    if (typeof(path) === 'number') { writeChunks(path, buf, null); return; }
    // One brokered call for the common case (plan 5 Task 4b, B).
    if (buf.length <= MAX_IO && !x.flush) { sync('writeFile', [p(path), buf, x.flag, mode(x.mode)]); return; }
    const fd = fromBroker(sync('open', [p(path), x.flag, mode(x.mode)]));
    try { writeChunks(fd, buf, null); } finally { sync('close', [bfd(fd)]); }
  }
  async function writeFileImpl(path, data, o, defFlag) {
    const x = opts(o, {flag: defFlag, mode: 0o666});
    if (data != null && typeof(data) === 'object' && !ArrayBuffer.isView(data) && typeof(data[Symbol.asyncIterator]) === 'function') {
      const parts = [];
      for await (const chunk of data) parts.push(toBuffer(chunk, x.encoding));
      data = Buffer.concat(parts);
    }
    const buf = toBuffer(data, x.encoding);
    if (typeof(path) === 'number') { await writeChunksAsync(path, buf, null); return; }
    if (path instanceof BrokeredFileHandle) { await writeChunksAsync(path.fd, buf, null); return; }
    if (buf.length <= MAX_IO && !x.flush && x.signal == null) { await call('writeFile', [p(path), buf, x.flag, mode(x.mode)]); return; }
    const fd = fromBroker(await call('open', [p(path), x.flag, mode(x.mode)]));
    try { await writeChunksAsync(fd, buf, null); } finally { await call('close', [bfd(fd)]); }
  }
  const FILE = {__proto__: null, paths: [0], fd: 0};
  lock(fs, 'readFileSync', readFileSyncImpl, handled.fs, FILE);
  lock(fs, 'readFile', (path, ...all) => { const {args, cb} = splitCb(all); readFileImpl(path, args[0]).then((r) => cb(null, r), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'readFile', readFileImpl, handled.promises, P0);
  lock(fs, 'writeFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'w'), handled.fs, FILE);
  lock(fs, 'writeFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'w').then(() => cb(null), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'writeFile', (path, data, o) => writeFileImpl(path, data, o, 'w'), handled.promises, P0);
  lock(fs, 'appendFileSync', (path, data, o) => writeFileSyncImpl(path, data, o, 'a'), handled.fs, FILE);
  lock(fs, 'appendFile', (path, data, ...all) => { const {args, cb} = splitCb(all); writeFileImpl(path, data, args[0], 'a').then(() => cb(null), (e) => cb(e)); }, handled.fs, FILE);
  lock(fsp, 'appendFile', (path, data, o) => writeFileImpl(path, data, o, 'a'), handled.promises, P0);

  // FileHandle (fs.promises.open). Like Node's own, one that is never closed
  // is closed when it is garbage-collected, with a warning (review M4).
  const unclosed = new FinalizationRegistry((fd) => {
    process.emitWarning('Closing a file handle on garbage collection (countinghouse file broker)');
    call('close', [bfd(fd)]).catch(() => {});
  });
  // A handle's references, as Node's own FileHandle counts them (kRefs): one
  // for the handle itself, one per live stream (from its making until its
  // own close has run, after any read, write or fsync it had in flight),
  // one per operation of the handle's own while it runs (a readFile's every
  // read). close() drops the handle's own; its descriptor stays valid, and
  // what starts meanwhile still runs, until none is left, and only then is
  // it closed, once. On close its read streams are destroyed and its write
  // streams closed (ended, their writes done, then destroyed: WriteStream's
  // own close), each releasing its reference as it closes: so no stream
  // reads, writes or fsyncs to the broker after the descriptor closes
  // (EBADF, an error nobody listens for: uncaught), and no write is lost.
  // Each stream reads and writes the handle's descriptor through an fs of
  // its own (frozen, so module code can't change another's) that holds the
  // handle (never collected, and closed, under a stream still using it); a
  // read of a stream told to close, or destroyed, that fails is the end of
  // the file (the stream closes with no error, as Node's own).
  // handle -> {refs, closing, settled, done, webLocked, streams: Map stream -> kind}
  const stateOf = new WeakMap();
  function handleState(handle) {
    let st = WeakMapGet(stateOf, handle);
    if (st == null) {
      st = {__proto__: null, refs: 1, closing: null, brokerDone: null, settled: false, done: null, webLocked: false, streams: new MapCtor()};
      WeakMapSet(stateOf, handle, st);
    }
    return st;
  }
  const ref = (st) => { st.refs += 1; };
  const unref = (st) => {
    st.refs -= 1;
    if (st.refs === 0 && st.done != null) { const done = st.done; st.done = null; done(); }
  };
  // -> {sfs, bind}: the stream's fs, and the stream it is told it serves.
  // kind: {isRead, isWeb, closing, released}, the stream's entry in
  // st.streams (a web stream's also reading)
  // a stream's reference released once (by its own close, its 'close', its
  // end or cancel), and the stream out of the handle's list
  function releaseFor(st, kind, streamOf) {
    const release = () => { if (!kind.released) { kind.released = true; MapDeleteP(st.streams, streamOf()); unref(st); } };
    kind.release = release;
    return release;
  }
  function streamFs(handle, st, kind) {
    let stream = null;
    const releaseOnce = releaseFor(st, kind, () => stream);
    // (its close, its I/O done: it holds the descriptor no more, and closes
    // the handle too, as Node's own closes its FileHandle when its stream is
    // destroyed, at its end with autoClose or not)
    // (it waits for the handle's close and is given the broker's error, as
    // Node's own: its reference released first, so the close is never
    // waiting on it; a 'close' listener's error is the handle's alone)
    const noop = () => {};
    const own = {__proto__: null, open: (...a) => ReflectApply(fs.open, fs, a),
      close: (fd, cb) => {
        releaseOnce();
        if (st.closing == null) ReflectApply(PromiseThen, closeHandle(handle), [noop, noop]);
        if (st.brokerDone == null) return process.nextTick(cb, null);
        ReflectApply(PromiseThen, st.brokerDone, [() => cb(null), (e) => cb(e)]);
      }};
    if (kind.isRead) {
      own.read = (fd, buffer, offset, length, position, cb) => {
        // (a stream ending as its handle closes reads no more: its end)
        if (kind.closing) return process.nextTick(cb, null, 0, buffer);
        return ReflectApply(fs.read, fs, [fd, buffer, offset, length, position, (e, n, b) => {
          if (kind.closing) return cb(null, 0, b);
          if (e != null && stream != null && ReadableDestroyed(stream) === true) return cb(null, 0, b);
          return cb(e, n, b);
        }]);
      };
    } else {
      own.write = (...a) => ReflectApply(fs.write, fs, a);
      own.writev = (...a) => ReflectApply(fs.writev, fs, a);
      own.fsync = (...a) => ReflectApply(fs.fsync, fs, a);
    }
    return {sfs: ObjectFreeze(own), bind: (s) => { stream = s; }};
  }
  // a stream of the handle, holding a reference until it closes (its
  // options as the module gives them, fd and fs aside)
  function ownStream(handle, o, isRead) {
    const st = handleState(handle);
    const fd = handle._fd;
    const kind = {__proto__: null, isRead, isWeb: false, closing: false, released: false, release: null};
    const {sfs, bind} = streamFs(handle, st, kind);
    const options = ObjectAssign({__proto__: null}, o, {fd, fs: sfs});
    const stream = isRead ? fs.createReadStream(null, options) : fs.createWriteStream(null, options);
    bind(stream);
    ref(st);
    MapSetP(st.streams, stream, kind);
    StreamOnce(stream, 'close', kind.release);
    return stream;
  }
  // A web stream over the handle's reads, as Node's own readableWebStream:
  // a byte stream (a BYOB reader too) that reads nothing until it is asked
  // (highWaterMark 0: the handle's position is never moved ahead of a
  // read), each read into the buffer the reader gives or one allocated for
  // it, zero-filled. A handle closed or closing makes none, and a handle
  // makes one only (it is locked from then on), as Node's own (both
  // ERR_INVALID_STATE). It holds a reference until its end or cancel; the
  // handle's close ends it (a read under way answered first, its reader
  // seeing the end).
  function webStream(handle) {
    const st = handleState(handle);
    if (handle._fd < 0) throw invalidState('closed');
    if (st.closing != null) throw invalidState('closing');
    if (st.webLocked) throw invalidState('locked');
    st.webLocked = true;
    const kind = {__proto__: null, isRead: true, isWeb: true, closing: false, reading: false, released: false, release: null, end: null};
    let controller = null;
    let web = null;
    const release = releaseFor(st, kind, () => web);
    const finish = () => {
      release();
      try { ByteControllerClose(controller); } catch (e) { /* closed already */ }
      try { const req = ByteControllerRequest(controller); if (req != null) RequestRespond(req, 0); } catch (e) { /* none pending */ }
    };
    kind.end = () => { kind.closing = true; if (!kind.reading) finish(); };
    web = new ReadableStreamCtor({
      __proto__: null,
      type: 'bytes',
      autoAllocateChunkSize: 16384,
      start(c) { controller = c; },
      pull(c) {
        if (kind.closing || st.closing != null) { finish(); return undefined; }
        const req = ByteControllerRequest(c);
        if (req == null) return undefined;
        const view = RequestView(req);
        kind.reading = true;
        return ReflectApply(PromiseThen, ReflectApply(HandleRead, handle, [view, 0, view.byteLength, null]), [(r) => {
          kind.reading = false;
          if (kind.closing || r.bytesRead === 0) return finish();
          return RequestRespond(req, r.bytesRead);
        }, (e) => {
          kind.reading = false;
          if (kind.closing) return finish();
          release();
          return ByteControllerError(controller, e);
        }]);
      },
      // (a read under way when cancelled keeps the reference until it
      // answers: the descriptor never closes under it)
      cancel() { kind.closing = true; if (!kind.reading) release(); }
    }, {__proto__: null, highWaterMark: 0});
    ref(st);
    MapSetP(st.streams, web, kind);
    return web;
  }
  // the handle's streams told to close (as Node's own on its handle's close)
  function closeStreams(st) {
    const streams = [];
    MapForEachP(st.streams, (kind, stream) => { ArrayPush(streams, [stream, kind]); });
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i][0];
      const kind = streams[i][1];
      try {
        // (a web stream ends: its reader sees the end, as Node's own
        // readableWebStream is cancelled on its handle's close)
        if (kind.isWeb) kind.end();
        else if (kind.isRead) {
          kind.closing = true;
          ReadableDestroy(stream);
        }
        else if (WritableDestroyed(stream) === true) continue;
        // (one finished, or failed, has nothing left to write: destroyed)
        else if (WritableFinished(stream) === true || WritableErrored(stream) != null) WritableDestroy(stream);
        else WriteStreamClose(stream);
      } catch (e) { /* the stream's own */ }
    }
  }
  // An operation of the handle's own, holding a reference for its whole run
  // (Node's fsCall): the descriptor stays valid under it, a close waiting
  function fsCall(handle, fn) {
    const st = handleState(handle);
    ref(st);
    let result;
    try { result = fn(); } catch (e) { unref(st); throw e; }
    return ReflectApply(PromiseThen, PromiseResolve(result), [(v) => { unref(st); return v; }, (e) => { unref(st); throw e; }]);
  }
  // the class's own close (closeHandle), so a stream's close never runs a
  // close module code put on its handle
  let HandleClose = null;
  let HandleRead = null;
  function closeHandle(handle) {
    return ReflectApply(HandleClose, handle, []);
  }
  class BrokeredFileHandle extends EventEmitter {
    constructor(fd) { super(); this._fd = fd; RegistryRegister(unclosed, this, fd, this); }
    get fd() { return this._fd; }
    getAsyncId() { return -1; }
    // (a close asked again while one is under way is that one, as Node's;
    // once done, a close asked again resolves; a 'close' listener that
    // throws rejects the close with its error; a close that failed leaves
    // the handle closed, as Node's own: the broker has dropped the
    // descriptor first. Each step is chained through the captured then,
    // never one module code put on Promise.prototype)
    close() {
      const st = handleState(this);
      if (st.closing != null && !st.settled) return st.closing;
      if (this._fd < 0) return PromiseResolve();
      let resolve = null;
      let reject = null;
      const closing = new PromiseCtor((res, rej) => { resolve = res; reject = rej; });
      st.closing = closing;
      const fd = this._fd;
      // ('close' at once, as Node's own, once the handle's own reference is
      // dropped: a listener learns to stop now; one that throws rejects the
      // close with its error, the close still made)
      let listenerError = null;
      // (the broker's close sent first, before anything that could throw:
      // the descriptor is never left open behind a close pending forever)
      // (the broker's answer alone, for the handle's streams to wait on)
      let brokerResolve = null;
      let brokerReject = null;
      st.brokerDone = new PromiseCtor((res, rej) => { brokerResolve = res; brokerReject = rej; });
      ReflectApply(PromiseThen, st.brokerDone, [() => {}, () => {}]);
      st.done = () => {
        const sent = call('close', [bfd(fd)]);
        ReflectApply(PromiseThen, sent, [() => brokerResolve(), (e) => brokerReject(e)]);
        this._fd = -1;
        try { RegistryUnregister(unclosed, this); } catch (e) { /* the broker closes it */ }
        // (settled on the next tick after the broker's answer: a stream
        // waiting on the same answer emits 'close' on a tick queued in the
        // same turn, after this one, before any awaiter of the handle's
        // close runs, which is Node's order)
        ReflectApply(PromiseThen, st.brokerDone, [() => process.nextTick(() => {
          st.settled = true;
          if (listenerError != null) reject(listenerError); else resolve();
        }), (e) => process.nextTick(() => { st.settled = true; reject(e); })]);
      };
      // (Node's order: its own reference dropped, 'close' emitted, which a
      // listener sees its streams still open at, then its streams closed)
      unref(st);
      try { this.emit('close'); } catch (e) { listenerError = e; }
      closeStreams(st);
      return closing;
    }
    async [Symbol.asyncDispose]() { await this.close(); }
    // (each operation through fsCall, holding a reference for its whole run,
    // as Node's own; test/fs-broker/29 checks every method of the class)
    read(buffer, offset, length, position) {
      return fsCall(this, async () => {
        if (buffer == null || (!ArrayBuffer.isView(buffer) && typeof(buffer) === 'object')) {
          const o = buffer || {};
          buffer = o.buffer || Buffer.alloc(16384);
          offset = o.offset; length = o.length; position = o.position;
        }
        const a = readArgs(this._fd, buffer, offset, length, position);
        const n = fillRead(await call('read', [bfd(this._fd), a.length, a.position]), a);
        return {bytesRead: n, buffer: a.buffer};
      });
    }
    write(data, ...rest) { return fsCall(this, async () => { const w = writeArgs(this._fd, data, ...rest); return {bytesWritten: await writeChunksAsync(this._fd, w.buf, w.position), buffer: data}; }); }
    readv(buffers, position) { return fsCall(this, async () => ({bytesRead: scatter(await call('read', [bfd(this._fd), total(buffers), position == null ? null : position]), buffers), buffers})); }
    writev(buffers, position) { return fsCall(this, async () => ({bytesWritten: await writeChunksAsync(this._fd, vec(buffers), position), buffers})); }
    readFile(o) { return fsCall(this, () => readFileImpl(this, o)); }
    writeFile(data, o) { return fsCall(this, () => writeFileImpl(this, data, o, 'w')); }
    appendFile(data, o) { return fsCall(this, () => writeFileImpl(this, data, o, 'a')); }
    stat(o) { return fsCall(this, async () => stats(await call('fstat', [bfd(this._fd), opts(o)]))); }
    truncate(len) { return fsCall(this, async () => { await call('ftruncate', [bfd(this._fd), len || 0]); }); }
    sync() { return fsCall(this, async () => { await call('fsync', [bfd(this._fd)]); }); }
    datasync() { return fsCall(this, async () => { await call('fdatasync', [bfd(this._fd)]); }); }
    chmod(m) { return fsCall(this, async () => { await call('fchmod', [bfd(this._fd), mode(m)]); }); }
    chown(uid, gid) { return fsCall(this, async () => { await call('fchown', [bfd(this._fd), uid, gid]); }); }
    utimes(at, mt) { return fsCall(this, async () => { await call('futimes', [bfd(this._fd), toUnixTimestamp(at), toUnixTimestamp(mt)]); }); }
    createReadStream(o) { return ownStream(this, o, true); }
    createWriteStream(o) { return ownStream(this, o, false); }
    readLines(o) { return readline.createInterface({input: this.createReadStream(o), crlfDelay: Infinity}); }
    // (as Node's own: a web stream pulling the handle's reads, holding a
    // reference until its end or cancel; the handle stays open; its close
    // ends it, a read under way done first, its reader seeing the end)
    readableWebStream() { return webStream(this); }
  }
  HandleClose = BrokeredFileHandle.prototype.close;
  HandleRead = BrokeredFileHandle.prototype.read;
  Object.getOwnPropertyNames(BrokeredFileHandle.prototype).forEach((k) => handled.fileHandle.add(k));
  lock(fsp, 'open', async(path, flags, m) => new BrokeredFileHandle(fromBroker(await call('open', [p(path), flags == null ? 'r' : flags, mode(m, 0o666)]))), handled.promises, P0);

  // Directories as streams of entries (fs.opendir).
  function makeDir(path, entries) {
    const dir = Object.create(fs.Dir.prototype);
    let i = 0;
    let closed = false;
    const next = () => (i < entries.length ? entries[i++] : null);
    Object.defineProperties(dir, {
      path: {value: path, enumerable: true},
      readSync: {value: () => next()},
      read: {value: (cb) => (typeof(cb) === 'function' ? process.nextTick(cb, null, next()) : Promise.resolve(next()))},
      closeSync: {value: () => { closed = true; }},
      close: {value: (cb) => { closed = true; return typeof(cb) === 'function' ? process.nextTick(cb, null) : Promise.resolve(); }},
      entries: {value: async function* () { let e; while (!closed && (e = next()) != null) yield e; }},
      [Symbol.asyncIterator]: {value: async function* () { let e; while (!closed && (e = next()) != null) yield e; closed = true; }},
      [Symbol.asyncDispose]: {value: async() => { closed = true; }},
      [Symbol.dispose]: {value: () => { closed = true; }}
    });
    return dir;
  }
  lock(fs, 'opendirSync', (path, o) => makeDir(p(path), sync('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}]).map(dirent)), handled.fs, P0);
  lock(fs, 'opendir', (path, ...all) => {
    const {args, cb} = splitCb(all);
    call('readdir', [p(path), {withFileTypes: true, recursive: !!(args[0] && args[0].recursive)}]).then((r) => cb(null, makeDir(p(path), r.map(dirent))), (e) => cb(e));
  }, handled.fs, P0);
  lock(fsp, 'opendir', async(path, o) => makeDir(p(path), (await call('readdir', [p(path), {withFileTypes: true, recursive: !!(o && o.recursive)}])).map(dirent)), handled.promises, P0);

  // cp: a recursive copy built on the primitives, so every step is checked.
  // Node's semantics: force overwrites (whatever errorOnExist says); without
  // force an existing destination is skipped, or an error with errorOnExist;
  // a destination inside the source is refused. A tree holding absolute
  // symlinks fails with EPERM under the link rules.
  function cpPlan(src, dest, o) {
    const plan = {src: pathMod.posix.resolve(p(src, 'src')), dest: pathMod.posix.resolve(p(dest, 'dest')), o: Object.assign({force: true, recursive: false}, o || {})};
    if (plan.dest === plan.src || plan.dest.startsWith(`${plan.src}/`)) {
      throw cpError('ERR_FS_CP_EINVAL', `Invalid src or dest: cp returned EINVAL (cannot copy ${plan.src} to a subdirectory of self ${plan.dest})`);
    }
    return plan;
  }
  function cpFile(srcPath, destPath, o, exists) {
    if (exists && !o.force) {
      if (o.errorOnExist) throw cpError('ERR_FS_CP_EEXIST', `Target already exists: cp returned EEXIST (${destPath} already exists)`);
      return null;
    }
    return 0;
  }
  function cpSyncImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !o.filter(src, dest)) return;
    const st = stats(sync(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) throw cpError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${src}`);
      sync('mkdir', [dest, {recursive: true}]);
      for (const name of sync('readdir', [src, {}])) cpSyncImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else {
      const exists = sync('exists', [dest]);
      if (cpFile(src, dest, o, exists) === null) return;
      if (exists) sync('unlink', [dest]);
      if (st.isSymbolicLink()) sync('symlink', [sync('readlink', [src]), dest]);
      else sync('copyFile', [src, dest, 0]);
    }
    if (o.preserveTimestamps) sync('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  async function cpImpl(src, dest, o) {
    if (typeof(o.filter) === 'function' && !(await o.filter(src, dest))) return;
    const st = stats(await call(o.dereference ? 'stat' : 'lstat', [src, {}]));
    if (st.isDirectory()) {
      if (!o.recursive) throw cpError('ERR_FS_EISDIR', `Recursive option is required to copy a directory: ${src}`);
      await call('mkdir', [dest, {recursive: true}]);
      for (const name of await call('readdir', [src, {}])) await cpImpl(pathMod.posix.join(src, name), pathMod.posix.join(dest, name), o);
    } else {
      const exists = await call('exists', [dest]);
      if (cpFile(src, dest, o, exists) === null) return;
      if (exists) await call('unlink', [dest]);
      if (st.isSymbolicLink()) await call('symlink', [await call('readlink', [src]), dest]);
      else await call('copyFile', [src, dest, 0]);
    }
    if (o.preserveTimestamps) await call('utimes', [dest, toUnixTimestamp(st.atime), toUnixTimestamp(st.mtime)]);
  }
  lock(fs, 'cpSync', (src, dest, o) => { const c = cpPlan(src, dest, o); cpSyncImpl(c.src, c.dest, c.o); }, handled.fs, P01);
  lock(fs, 'cp', (src, dest, ...all) => {
    const {args, cb} = splitCb(all);
    let c;
    try { c = cpPlan(src, dest, args[0]); } catch (e) { return process.nextTick(cb, e); }
    cpImpl(c.src, c.dest, c.o).then(() => cb(null), (e) => cb(e));
  }, handled.fs, P01);
  lock(fsp, 'cp', async(src, dest, o) => { const c = cpPlan(src, dest, o); return cpImpl(c.src, c.dest, c.o); }, handled.promises, P01);

  // glob: one non-recursive readdir per directory level, starting from the
  // pattern's literal prefix, descending only as deep as the pattern can
  // match ('**' unbounded). Absolute patterns give absolute results.
  function globPlan(pattern, o) {
    const x = Object.assign({}, o || {});
    // the module's cwd in the namespace's form (on Windows it is <V>:\app, #195)
    x.cwd = x.cwd != null ? p(x.cwd, 'cwd') : virtualForm(process.cwd());
    const pats = (Array.isArray(pattern) ? pattern : [pattern]).map((pat) => {
      const abs = pathMod.posix.isAbsolute(pat);
      const segs = pat.split('/').filter((s, i) => !(abs && i === 0 && s === ''));
      const lit = [];
      while (lit.length < segs.length - 1 && !GLOB_CHARS.test(segs[lit.length])) lit.push(segs[lit.length]);
      const rest = segs.slice(lit.length);
      const base = abs ? `/${lit.join('/')}` : pathMod.posix.join(x.cwd, ...lit);
      return {pat, abs, base, depth: rest.includes('**') ? Infinity : rest.length};
    });
    return {x, pats};
  }
  function globKeep(x, pl, full, d, out, seen) {
    const shown = pl.abs ? full : pathMod.posix.relative(x.cwd, full);
    if (seen.has(shown) || !pathMod.matchesGlob(shown, pl.pat)) return;
    if (typeof(x.exclude) === 'function' && x.exclude(x.withFileTypes ? d : shown)) return;
    if (Array.isArray(x.exclude) && x.exclude.some((e) => pathMod.matchesGlob(shown, e))) return;
    seen.add(shown);
    out.push(x.withFileTypes ? d : shown);
  }
  function globSyncImpl(pattern, o) {
    const {x, pats} = globPlan(pattern, o);
    const out = [];
    const seen = new Set();
    for (const pl of pats) {
      const queue = [[pl.base, 1]];
      while (queue.length > 0) {
        const [dir, level] = queue.shift();
        let entries;
        try { entries = sync('readdir', [dir, {withFileTypes: true}]); } catch (e) { continue; }
        for (const e of entries) {
          const d = dirent(e);
          const full = pathMod.posix.join(dir, e.name);
          globKeep(x, pl, full, d, out, seen);
          if (e.type === 'dir' && level < pl.depth) queue.push([full, level + 1]);
        }
      }
    }
    return out;
  }
  async function globAsyncImpl(pattern, o) {
    const {x, pats} = globPlan(pattern, o);
    const out = [];
    const seen = new Set();
    for (const pl of pats) {
      const queue = [[pl.base, 1]];
      while (queue.length > 0) {
        const [dir, level] = queue.shift();
        let entries;
        try { entries = await call('readdir', [dir, {withFileTypes: true}]); } catch (e) { continue; }
        for (const e of entries) {
          const d = dirent(e);
          const full = pathMod.posix.join(dir, e.name);
          globKeep(x, pl, full, d, out, seen);
          if (e.type === 'dir' && level < pl.depth) queue.push([full, level + 1]);
        }
      }
    }
    return out;
  }
  lock(fs, 'globSync', (pattern, o) => globSyncImpl(pattern, o), handled.fs);
  lock(fs, 'glob', (pattern, ...all) => {
    const {args, cb} = splitCb(all);
    globAsyncImpl(pattern, args[0]).then((r) => cb(null, r), (e) => cb(e));
  }, handled.fs);
  lock(fsp, 'glob', (pattern, o) => (async function* () { for (const m of await globAsyncImpl(pattern, o)) yield m; })(), handled.promises);

  lock(fs, 'openAsBlob', async(path, o) => new Blob([await readFileImpl(path)], {type: (o && o.type) || ''}), handled.fs, P0);
  // Node 26 adds openAsBlobSync. Unpatched, it read the host path under every
  // mode. Brokered like openAsBlob, and installed only where Node has it, so
  // Node 24 gains no method it never had.
  if (typeof(fs.openAsBlobSync) === 'function') {
    lock(fs, 'openAsBlobSync', (path, o) => new Blob([readFileSyncImpl(path)], {type: (o && o.type) || ''}), handled.fs, P0);
  }
  lock(fs, 'mkdtempDisposableSync', (prefix) => {
    const path = sync('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => sync('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.dispose]: remove};
  }, handled.fs, P0);
  lock(fsp, 'mkdtempDisposable', async(prefix) => {
    const path = await call('mkdtemp', [p(prefix, 'prefix')]);
    const remove = () => call('rm', [path, {recursive: true, force: true}]);
    return {path: path, remove: remove, [Symbol.asyncDispose]: remove};
  }, handled.promises, P0);

  // Watching is not offered (spec decision 2); Utf8Stream is not brokered.
  ['watch', 'watchFile'].forEach((k) => lock(fs, k, () => { throw unavailable(`fs.${k}`); }, handled.fs));
  lock(fs, 'unwatchFile', () => undefined, handled.fs);
  lock(fsp, 'watch', () => { throw unavailable('fs.promises.watch'); }, handled.promises);
  // A plain function: callers construct it (new fs.Utf8Stream), which an arrow cannot be.
  lock(fs, 'Utf8Stream', function() { throw unavailable('fs.Utf8Stream'); }, handled.fs); // eslint-disable-line prefer-arrow-callback
  // lchmod exists only on macOS; the promise form throws there anyway.
  lock(fsp, 'lchmod', async() => { throw withCode(new Error('The lchmod() method is not implemented'), 'ERR_METHOD_NOT_IMPLEMENTED'); }, handled.promises);

  // HTTP/2 respondWithFile opens through this fs, then hands the descriptor
  // to native code, which cannot read a broker descriptor: not available to
  // modules, in every mode (user decision, plan 3; CHANGELOG known issues).
  // The server stream prototype is not exported, so it is reached the first
  // time a server stream appears, by a listener that runs before any of the
  // module's. Defined replaceable, so part 1's lockdown can wrap these again.
  const http2 = http2Lib;
  let fileResponseOff = false;
  const onStream = (stream) => {
    const proto = Object.getPrototypeOf(stream);
    if (fileResponseOff || proto == null || typeof(proto.respondWithFile) !== 'function') return;
    Object.defineProperty(proto, 'respondWithFile', {writable: false, configurable: false, enumerable: false,
      value: () => { throw unavailable('http2 respondWithFile'); }});
    fileResponseOff = true;
  };
  const onSession = (session) => PrependListener(session, 'stream', onStream);
  ['createServer', 'createSecureServer'].forEach((key) => {
    const create = http2[key];
    http2[key] = (...args) => {
      const server = ReflectApply(create, http2, args);
      PrependListener(server, 'session', onSession);
      return server;
    };
  });
  if (typeof(http2.performServerHandshake) === 'function') {
    const handshake = http2.performServerHandshake;
    http2.performServerHandshake = (...args) => {
      const session = ReflectApply(handshake, http2, args);
      onSession(session);
      return session;
    };
  }

  // process.loadEnvFile reads with native code, past this patch: read through
  // the broker instead and apply it as Node does (variables already set win).
  Object.defineProperty(process, 'loadEnvFile', {writable: false, configurable: false, enumerable: true, value: (path) => {
    const parsed = utilLib.parseEnv(fs.readFileSync(path === undefined ? './.env' : path, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }});

  // The loader's grants (header comment). Releases remove exactly what their
  // grant added, so grants nest.
  // (by index, and each list rebuilt rather than spliced: no Array method a
  // module could have replaced decides what is granted or released)
  const take = (list, items) => {
    const added = [];
    for (let i = 0; i < items.length; i++) { put(list, list.length, items[i]); put(added, added.length, items[i]); }
    // The release removes each item its grant added once, the last
    // occurrence first, in one pass over the list (a root grant holds every
    // package directory of countinghouse's dependencies, so a scan per item
    // made each release quadratic), then writes the rest back in order.
    return () => {
      const remove = new MapCtor();
      for (let j = 0; j < added.length; j++) MapSetP(remove, added[j], (MapGetP(remove, added[j]) || 0) + 1);
      const kept = [];
      for (let i = list.length - 1; i >= 0; i--) {
        const n = MapGetP(remove, list[i]);
        if (n) { MapSetP(remove, list[i], n - 1); continue; }
        put(kept, kept.length, list[i]);
      }
      const len = kept.length;
      for (let k = 0; k < len; k++) put(list, k, kept[len - 1 - k]);
      list.length = len;
    };
  };
  const absolute = (xs) => {
    const out = [];
    for (let i = 0; i < xs.length; i++) put(out, out.length, pathResolve(StringCtor(xs[i])));
    return out;
  };
  // F4-6: everything of fs and fs/promises handled nowhere above and known
  // as no data or class (PASSTHROUGH) is locked, in every mode, at boot too,
  // by one rule, fail closed: its slot answers a primitive as it is, and
  // anything else -- a method, a class, a namespace, an iterator, a Map --
  // as a function that throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM, as an
  // unbrokered feature does (sync, a promise one too; constructible, so new
  // meets it too). A lazy getter's slot never runs Node's getter. What is
  // set in a slot later is answered the same way (an assignment takes, so a
  // patcher's strict-mode assignment never throws). The cost: a later
  // Node's new data export is unusable until it is added to PASSTHROUGH or
  // the handled set. Where Node made a slot unchangeable -- a
  // non-configurable accessor, or a non-configurable writable slot holding
  // anything but a constant (null or undefined included: it could be filled
  // later), or
  // a fixed one holding a non-primitive -- it can't be locked: it is listed,
  // and the worker refuses to start under enforce, naming it
  // (lib/lean-worker.js; swept.refusal). (The reviews of F4-6.)
  const swept = [];
  const unsweepable = [];
  const labels = new WeakMap();
  const throwers = new WeakMap();
  const lockedOnes = new MapCtor();
  const isObjectLike = (v) => typeof(v) === 'function' || (v !== null && typeof(v) === 'object');
  const labelOf = (prefix, key) => `${prefix}.${typeof(key) === 'symbol' ? StringCtor(key) : key}`;
  // (one frozen thrower per original, named by the original's own export
  // key; per label for a getter's slot)
  const makeThrower = (label) => {
    const f = function() { throw unavailable(label); };
    ObjectFreeze(f.prototype);
    return ObjectFreeze(f);
  };
  const lockedFor = (v, label) => {
    if (isObjectLike(v)) {
      let f = WeakMapGet(throwers, v);
      if (f === undefined) {
        const own = WeakMapGet(labels, v);
        f = makeThrower(own !== undefined ? own : label);
        WeakMapSet(throwers, v, f);
      }
      return f;
    }
    let f = MapGetP(lockedOnes, label);
    if (f === undefined) {
      f = makeThrower(label);
      MapSetP(lockedOnes, label, f);
    }
    return f;
  };
  const NONE = {};
  const lockSlot = (obj, key, d, label) => {
    let held = ObjectHasOwn(d, 'value') ? d.value : NONE;
    ObjectDefineProperty(obj, key, {__proto__: null, configurable: false, enumerable: d.enumerable,
      get() { return held === NONE || isObjectLike(held) ? lockedFor(held === NONE ? null : held, label) : held; },
      set(v) { held = v; }});
  };
  const sweep = (obj, set, pass, prefix) => {
    const keys = ReflectOwnKeys(obj);
    // (first, each original's own label)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof(key) === 'string' && (SetHas(set, key) || listed(pass, key))) continue;
      const d = ObjectGetOwnPropertyDescriptor(obj, key);
      if (d != null && ObjectHasOwn(d, 'value') && isObjectLike(d.value) && WeakMapGet(labels, d.value) === undefined) WeakMapSet(labels, d.value, labelOf(prefix, key));
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof(key) === 'string' && (SetHas(set, key) || listed(pass, key))) continue;
      const d = ObjectGetOwnPropertyDescriptor(obj, key);
      if (d == null) continue;
      const label = labelOf(prefix, key);
      const isData = ObjectHasOwn(d, 'value');
      const locks = !isData || isObjectLike(d.value);
      if (d.configurable === true) {
        try {
          lockSlot(obj, key, d, label);
          if (locks) ArrayPush(swept, label);
        } catch (e) { ArrayPush(unsweepable, label); }
        continue;
      }
      // (a writable one holding nothing yet -- null or undefined -- could be
      // filled later; one holding a constant passes)
      if (!isData || isObjectLike(d.value) || (d.writable === true && d.value == null)) ArrayPush(unsweepable, label);
    }
  };
  sweep(fs, handled.fs, PASSTHROUGH.fs, 'fs');
  sweep(fsp, handled.promises, PASSTHROUGH.promises, 'fs.promises');
  const sweptState = ObjectFreeze({swept: ObjectFreeze(swept), unsweepable: ObjectFreeze(unsweepable),
    refusal: unsweepable.length > 0 ? unguardedRefusal(unsweepable) : null});

  handled.grant = Object.freeze({
    // Node's readFileSync opens through the public fs.openSync and reads
    // through fs.readSync, which are patched: open with the original and
    // mark the descriptor real for the read, so every step stays original.
    originals: Object.freeze({readFileSync: (file, o) => {
      const fd = ReflectApply(origFs.openSync, fs, [file, 'r']);
      SetAdd(realFds, fd);
      try { return ReflectApply(origFs.readFileSync, fs, [fd, o]); } finally { SetDelete(realFds, fd); ReflectApply(origFs.closeSync, fs, [fd]); }
    }}),
    // Windows: never a drive's root (roots.js assertGrantRoots).
    resolving: (roots) => take(grants.roots, grantRoots(absolute(roots))),
    reading: (file) => take(grants.files, absolute([file])),
    boot: (roots) => take(grants.bootRoots, grantRoots(absolute(roots))),
    bootOutside: () => ({paths: bootOutside.slice(), dropped: bootDropped}),
    // (F4-6: what install() locked to throw, and what it couldn't)
    swept: sweptState
  });

  return handled;
}

// Exports that are data or classes, not file operations. ReadStream and
// WriteStream look fs methods up at call time, so they use the patched ones.
// A function joins this list only with the reviewer's agreement. F_OK, R_OK,
// W_OK and X_OK are the access modes as plain numbers (fs.constants' own),
// which Node 22 still exports at the top level and 24 no longer does.
const PASSTHROUGH = Object.freeze({
  fs: Object.freeze(['Dir', 'Dirent', 'FileReadStream', 'FileWriteStream', 'ReadStream', 'Stats', 'WriteStream', '_toUnixTimestamp',
    'constants', 'promises', 'createReadStream', 'createWriteStream', 'lchmod', 'lchmodSync', 'F_OK', 'R_OK', 'W_OK', 'X_OK']),
  promises: Object.freeze(['constants'])
});

// The worker's refusal to start under enforce (lib/lean-worker.js) for what
// the sweep couldn't lock, naming each key and what to do for a constant.
function unguardedRefusal(keys) {
  return `module sandbox: cannot guard this Node's ${keys.join(', ')} (unchangeable, so not locked); not starting under enforce` +
    ' -- if it is a constant, add it to PASSTHROUGH in lib/fs-broker/patch.js';
}

module.exports = {install, setConsoleSilenced, PASSTHROUGH, FD_BASE, unguardedRefusal};
