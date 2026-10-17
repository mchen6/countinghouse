// Module worker side of the file broker (docs/superpowers/specs/2026-10-17-
// module-sandbox-fs-broker-design.md, section 2): replaces every method of
// the shared fs, fs/promises and FileHandle objects, before any countinghouse
// or dependency code loads, with versions that ask the main thread's broker.
// Sync calls go over the blocking bridge, callback and promise calls over the
// async channel (lib/fs-broker/client.js). Anything not handled here throws,
// so a method a later Node adds fails closed (test/fs-broker/07-patch.js).
//
// Grants (plan 3, L1): install() returns a grant controller, which
// lib/sandbox.js keeps and hands to the loader hook (lib/fs-broker/identity.js)
// and never exports. While a grant is active, the original fs serves the sync
// stat calls for absolute paths under the granted roots (a resolve), reads of
// exactly the granted file (a load), or both under the boot roots
// (countinghouse's own boot requires, until set-options). By path, never by
// time: anything else in the same window still goes to the broker.
const fs = require('fs');
const fsp = require('fs/promises');
const pathMod = require('path');
const url = require('url');
const {EventEmitter} = require('events');

const MAX_IO = 16 * 1024 * 1024;
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
  const err = new Error(`${what} is not available to modules (countinghouse module sandbox)`);
  err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
  return err;
}

function argType(name, value) {
  const err = new TypeError(`The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${typeof(value)}`);
  err.code = 'ERR_INVALID_ARG_TYPE';
  return err;
}

function outOfRange(name, value) {
  const err = new RangeError(`The value of "${name}" is out of range. Received ${value}`);
  err.code = 'ERR_OUT_OF_RANGE';
  return err;
}

// Paths cross the bridge as strings (a Buffer arrives as a Uint8Array and a
// URL does not clone).
function p(v, name) {
  if (typeof(v) === 'string') return v;
  if (v instanceof URL) return v.href;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
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
  const err = new TypeError('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.');
  err.code = 'ERR_INVALID_ARG_TYPE';
  throw err;
}

function splitCb(args) {
  const cb = args[args.length - 1];
  if (typeof(cb) !== 'function') {
    const err = new TypeError('The "cb" argument must be of type function.');
    err.code = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  return {args: Array.prototype.slice.call(args, 0, -1), cb: cb};
}

function cpError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
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
  const under = (s, roots) => roots.some((r) => s === r || s.startsWith(`${r}/`));
  const bootOutside = [];   // the first 20 distinct paths
  let bootDropped = 0;

  function absolutePath(v) {
    let s;
    if (typeof(v) === 'string') s = v;
    else if (v instanceof URL && v.protocol === 'file:') s = url.fileURLToPath(v);
    else return null;
    if (s.startsWith('file:')) { try { s = url.fileURLToPath(s); } catch (e) { return null; } }
    return pathMod.isAbsolute(s) ? pathMod.resolve(s) : null;
  }

  // Only the sync forms on fs: the loader is synchronous.
  function granted(obj, key, v) {
    if (obj !== fs || !BOOT_KEYS.has(key)) return false;
    if (grants.roots.length === 0 && grants.files.length === 0 && grants.bootRoots.length === 0) return false;
    const s = absolutePath(v);
    if (s == null) return false;
    if (under(s, grants.bootRoots)) return true;
    if (STAT_KEYS.has(key)) return under(s, grants.roots);
    return READ_KEYS.has(key) && grants.files.includes(s);
  }

  // During boot only countinghouse's own code runs, so anything else it
  // touches (a dependency probing /proc/self/exe for the libc, say) is
  // answered ENOENT here, not by the broker, which would report it in the
  // module's name. lib/sandbox.js logs these once as countinghouse's own.
  // Reached only from routed() for path-routed calls (route.paths non-empty),
  // so route.paths[0] always names a path argument.
  function bootRefusal(obj, key, a, route) {
    const v = a[route.paths[0]];
    const shown = absolutePath(v) || String(v);
    if (!bootOutside.includes(shown)) {
      if (bootOutside.length < 20) bootOutside.push(shown);
      else bootDropped++;
    }
    const e = new Error(`ENOENT: no such file or directory, ${key.replace(/Sync$/, '')} '${shown}'`);
    Object.assign(e, {code: 'ENOENT', errno: -2, syscall: key.replace(/Sync$/, ''), path: shown});
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
    if (key === 'openSync') { const fd = orig.apply(fs, a); realFds.add(fd); return fd; }
    if (key === 'open' && typeof(a[a.length - 1]) === 'function') {
      const cb = a[a.length - 1];
      a[a.length - 1] = (e, fd) => { if (!e) realFds.add(fd); cb(e, fd); };
    }
    if (key === 'closeSync' || key === 'close') realFds.delete(a[0]);
    return orig.apply(fs, a);
  }

  // route: {paths: [argIndex...], fd: argIndex} -- when every listed path is
  // granted, or the descriptor came from the original fs, call the original.
  function routed(obj, key, value, route) {
    if (route == null) return value;
    const orig = (obj === fs ? origFs : origFsp)[key];
    if (typeof(orig) !== 'function') return value;
    const wrapped = function(...a) {
      if (route.fd != null && typeof(a[route.fd]) === 'number' && realFds.has(a[route.fd])) return callOrig(key, orig, a);
      if (route.paths != null && route.paths.length > 0 &&
          route.paths.every((i) => a[i] != null && typeof(a[i]) !== 'number' && granted(obj, key, a[i]))) {
        return obj === fs ? callOrig(key, orig, a) : orig.apply(fsp, a);
      }
      if (grants.bootRoots.length > 0 && route.paths != null && route.paths.length > 0) return bootRefusal(obj, key, a, route);
      return value.apply(this, a);
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
  const P0 = {paths: [0]};
  const P01 = {paths: [0, 1]};
  const P1 = {paths: [1]};
  const F0 = {fd: 0};
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
  define('truncate', {args: (path, len) => (typeof(path) === 'number' ? ['ftruncate', [bfd(path), len || 0]] : ['truncate', [p(path), len || 0]]), out: none, route: {paths: [0], fd: 0}});
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
    const fd = fromBroker(await call('open', [p(path), x.flag, mode(x.mode)]));
    try { await writeChunksAsync(fd, buf, null); } finally { await call('close', [bfd(fd)]); }
  }
  const FILE = {paths: [0], fd: 0};
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
  class BrokeredFileHandle extends EventEmitter {
    constructor(fd) { super(); this._fd = fd; unclosed.register(this, fd, this); }
    get fd() { return this._fd; }
    getAsyncId() { return -1; }
    async close() {
      if (this._fd < 0) return;
      const fd = this._fd;
      this._fd = -1;
      unclosed.unregister(this);
      await call('close', [bfd(fd)]);
      this.emit('close');
    }
    async [Symbol.asyncDispose]() { await this.close(); }
    async read(buffer, offset, length, position) {
      if (buffer == null || (!ArrayBuffer.isView(buffer) && typeof(buffer) === 'object')) {
        const o = buffer || {};
        buffer = o.buffer || Buffer.alloc(16384);
        offset = o.offset; length = o.length; position = o.position;
      }
      const a = readArgs(this._fd, buffer, offset, length, position);
      const n = fillRead(await call('read', [bfd(this._fd), a.length, a.position]), a);
      return {bytesRead: n, buffer: a.buffer};
    }
    async write(data, ...rest) { const w = writeArgs(this._fd, data, ...rest); return {bytesWritten: await writeChunksAsync(this._fd, w.buf, w.position), buffer: data}; }
    async readv(buffers, position) { return {bytesRead: scatter(await call('read', [bfd(this._fd), total(buffers), position == null ? null : position]), buffers), buffers}; }
    async writev(buffers, position) { return {bytesWritten: await writeChunksAsync(this._fd, vec(buffers), position), buffers}; }
    readFile(o) { return readFileImpl(this, o); }
    writeFile(data, o) { return writeFileImpl(this, data, o, 'w'); }
    appendFile(data, o) { return writeFileImpl(this, data, o, 'a'); }
    async stat(o) { return stats(await call('fstat', [bfd(this._fd), opts(o)])); }
    async truncate(len) { await call('ftruncate', [bfd(this._fd), len || 0]); }
    async sync() { await call('fsync', [bfd(this._fd)]); }
    async datasync() { await call('fdatasync', [bfd(this._fd)]); }
    async chmod(m) { await call('fchmod', [bfd(this._fd), mode(m)]); }
    async chown(uid, gid) { await call('fchown', [bfd(this._fd), uid, gid]); }
    async utimes(at, mt) { await call('futimes', [bfd(this._fd), toUnixTimestamp(at), toUnixTimestamp(mt)]); }
    createReadStream(o) { return fs.createReadStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    createWriteStream(o) { return fs.createWriteStream(null, Object.assign({}, o, {fd: this._fd, autoClose: false})); }
    readLines(o) { return require('readline').createInterface({input: this.createReadStream(o), crlfDelay: Infinity}); }
    readableWebStream() { return require('stream').Readable.toWeb(this.createReadStream()); }
  }
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
    x.cwd = x.cwd != null ? p(x.cwd, 'cwd') : process.cwd();
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
  lock(fsp, 'lchmod', async() => { const e = new Error('The lchmod() method is not implemented'); e.code = 'ERR_METHOD_NOT_IMPLEMENTED'; throw e; }, handled.promises);

  // process.loadEnvFile reads with native code, past this patch: read through
  // the broker instead and apply it as Node does (variables already set win).
  Object.defineProperty(process, 'loadEnvFile', {writable: false, configurable: false, enumerable: true, value: (path) => {
    const parsed = require('util').parseEnv(fs.readFileSync(path === undefined ? './.env' : path, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }});

  // The loader's grants (header comment). Releases remove exactly what their
  // grant added, so grants nest.
  const take = (list, items) => {
    list.push(...items);
    return () => { items.forEach((x) => { const i = list.lastIndexOf(x); if (i >= 0) list.splice(i, 1); }); };
  };
  const absolute = (xs) => xs.map((x) => pathMod.resolve(String(x)));
  handled.grant = Object.freeze({
    // Node's readFileSync opens through the public fs.openSync and reads
    // through fs.readSync, which are patched: open with the original and
    // mark the descriptor real for the read, so every step stays original.
    originals: Object.freeze({readFileSync: (file, o) => {
      const fd = origFs.openSync(file, 'r');
      realFds.add(fd);
      try { return origFs.readFileSync(fd, o); } finally { realFds.delete(fd); origFs.closeSync(fd); }
    }}),
    resolving: (roots) => take(grants.roots, absolute(roots)),
    reading: (file) => take(grants.files, absolute([file])),
    boot: (roots) => take(grants.bootRoots, absolute(roots)),
    bootOutside: () => ({paths: bootOutside.slice(), dropped: bootDropped})
  });

  return handled;
}

// Exports that are data or classes, not file operations. ReadStream and
// WriteStream look fs methods up at call time, so they use the patched ones.
// A function joins this list only with the reviewer's agreement.
const PASSTHROUGH = {
  fs: ['Dir', 'Dirent', 'FileReadStream', 'FileWriteStream', 'ReadStream', 'Stats', 'WriteStream', '_toUnixTimestamp',
    'constants', 'promises', 'createReadStream', 'createWriteStream', 'lchmod', 'lchmodSync'],
  promises: ['constants']
};

module.exports = {install, setConsoleSilenced, PASSTHROUGH, FD_BASE};
