'use strict';
// Worker side of the module sandbox: runs once, on set-options, before any
// module code loads (lib/lean-worker.js). Design: docs/superpowers/specs/
// 2026-10-15-module-sandbox-foundation-design.md, section 3.
//
// In enforce a violation throws the error Node itself would throw; in audit it
// is reported and the original runs. Either way report() hears about it once.
//
// This is a barrier inside the same process, not a boundary: see the spec's
// "What this can and cannot promise".
const Module = require('module');
const resolveShim = require('./resolve-shim');
const path   = require('path');
const url    = require('url');

const modulePermissions = require('./module-permissions');
// The error module and the one runtime file that takes its issue(), loaded
// with this file, before install() puts any guard up: loaded inside install
// they came after the built-in guard, and on Node 26 their own
// require('worker_threads') was refused as a module's would be (#52's Node
// 26 leg). install() freezes the class and removes issue from these
// exports (d2b).
const errorsModule = require('./countinghouse-error');
// Taken here, with the other loads before install() puts a guard up (#170).
const {parentPort, MessagePort, MessageChannel, isMainThread} = require('worker_threads');
const asyncHooks = require('async_hooks');
const {pinPort} = require('./message-envelope');
// (its fromWinFor and roots.js's underFor are on captured intrinsics, as
// the checks here are)
const {fromWinFor, pathToFileHref} = require('./fs-broker/identity');
const {underFor} = require('./fs-broker/roots');
const workerStdio = require('./worker-stdio');
// Whether a value is a MessagePort, decided with what was taken at load.
const isPortOf = Function.prototype.call.bind(Object.prototype.isPrototypeOf);
const isPort = (v) => v != null && typeof(v) === 'object' && isPortOf(MessagePort.prototype, v);
// A list without its ports, by index: no Array.prototype method a module
// could have replaced is called with the unfiltered list, and each element
// is defined, not assigned (an assignment to an index runs a setter a module
// put on Array.prototype, with the list as `this`).
const withoutPorts = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i++) if (!isPort(list[i])) own(out, out.length, list[i]);
  return out;
};
// WeakMap's methods as they are now, called with a port as the key.
const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
// Node's own port for a worker's stdout and stderr (one port, held by both
// streams under a kPort symbol), found while this file loads; null on the
// main thread, or if a Node release moves it (install() then refuses
// enforce, as for the other internals it cannot guard).
const STDIO_PORT = (() => {
  if (isMainThread) return null;
  const key = Object.getOwnPropertySymbols(process.stdout).find((k) => k.description === 'kPort');
  return (key != null && isPort(process.stdout[key])) ? process.stdout[key] : null;
})();
require('./handler-ctx');
// one rule with the remote client's URL check; it runs on functions taken
// when that file loads, before any module code (#207)
const {isLoopbackHost} = require('./loopback-names');

// The built-ins module code may load, written out from Node 24.21's
// builtinModules. A literal on purpose: a built-in a later Node adds is
// refused until someone has read it. Left out: child_process, cluster,
// worker_threads (new processes and threads outside every check),
// inspector, inspector/promises, v8 (the debugger and heap internals), wasi,
// sqlite (loadExtension dlopens), test and test/reporters (run() spawns
// unsandboxed child processes), and sea. Node 26's ffi (calls native code) is
// not on it either, so it is refused like every built-in a later Node adds.
// Nor are _tls_wrap and _tls_common: a module needs tls, not the internals
// behind it. Nor is _stream_wrap (DEP0125): its JSStreamSocket extends the
// real net.Socket, a constructor past the guard (L1 round 5).
const ALLOWED_BUILTINS = new Set([
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform',
  '_stream_writable', 'assert', 'assert/strict', 'async_hooks', 'buffer',
  'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'path/posix',
  'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises',
  'stream', 'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys',
  'timers', 'timers/promises', 'tls', 'tty', 'url', 'util', 'util/types', 'vm', 'zlib'
]);
const WATCHED = new Set(['fs', 'fs/promises', 'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises']);
const MAX_REPORTS = 100;
// The only CHUtil.request options enforce passes on to postman-request (read
// against its request.js: none can change the destination host, port, socket
// or resolver; a `host` header only sets the Host header, the connection goes
// to uri.hostname). Everything else -- agent, agents, agentOptions, pool,
// forever, lookup, socketPath, localAddress, urlParser, httpModules, har,
// baseUrl, proxy, disableUrlEncoding, followAllRedirects... -- is refused.
const REQUEST_OPTIONS = new Set(['method', 'headers', 'body', 'json', 'form', 'formData', 'multipart',
  'preambleCRLF', 'postambleCRLF', 'qs', 'qsParseOptions', 'qsStringifyOptions', 'useQuerystring', 'timeout',
  'gzip', 'brotli', 'encoding', 'auth', 'oauth', 'hawk', 'aws', 'httpSignature', 'jar', 'followRedirect',
  'followOriginalHttpMethod', 'maxRedirects', 'removeRefererHeader', 'strictSSL', 'rejectUnauthorized', 'ca',
  'cert', 'key', 'passphrase', 'time', 'callback', 'url', 'uri']);
// _kill is the raw signal call behind process.kill. The other underscore
// functions on a worker's process (_rawDebug, _getActiveRequests,
// _getActiveHandles, _fatalException, _tickCallback) send no signals, load no
// native code and open no bindings; _linkedBinding is locked with binding.
const PROCESS_CONTROLS = ['kill', '_kill', 'abort', 'chdir', 'setuid', 'setgid', 'seteuid', 'setegid', 'setgroups', 'initgroups'];
const REDUCED_MODULE   = Symbol.for('countinghouse.lockdown.module');
const SANDBOX_TAG      = '(countinghouse module sandbox)';

// Every check below that runs after module code has loaded calls only what
// was taken here, when this file loads (before any module code): never a
// String, Array, Set, RegExp or Function method, nor a property of a shared
// module object (require('path').resolve, require('url').fileURLToPath,
// require('module').isBuiltin, an export of a runtime file), looked up when
// the check runs. Module code shares this realm and can replace any of
// those; a check that called one would answer what the module chose. An
// original a guard hands a call on to is called with ReflectApply, never
// its own call or apply, which would hand the original to a replaced
// Function.prototype.call or apply.
const ReflectApply = Reflect.apply;
const ReflectConstruct = Reflect.construct;
const uncurry = (fn) => Function.prototype.call.bind(fn);
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const MapGet = uncurry(Map.prototype.get);
const StringCtor = String;
const StringStartsWith = uncurry(String.prototype.startsWith);
const StringEndsWith = uncurry(String.prototype.endsWith);
const StringSlice = uncurry(String.prototype.slice);
const StringIndexOf = uncurry(String.prototype.indexOf);
const StringCharCodeAt = uncurry(String.prototype.charCodeAt);
const StringToLowerCase = uncurry(String.prototype.toLowerCase);
const StringToUpperCase = uncurry(String.prototype.toUpperCase);
const ObjectIsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const ModuleIsBuiltin = Module.isBuiltin;
const isBuiltin = (id) => ReflectApply(ModuleIsBuiltin, Module, [id]);
const FileURLToPath = url.fileURLToPath;
const fileURLToPath = (u) => ReflectApply(FileURLToPath, url, [u]);
const PathResolve = path.resolve;
const pathResolve = (...parts) => ReflectApply(PathResolve, path, parts);
const PATH_SEP = path.sep;
const PathIsAbsolute = path.isAbsolute;
const PathJoin = path.join;
const PathDirname = path.dirname;
const PathBasename = path.basename;
const ReflectGet = Reflect.get;
const ObjectFreeze = Object.freeze;
const ObjectPreventExtensions = Object.preventExtensions;
const MapClear = uncurry(Map.prototype.clear);
const MapSize = uncurry(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
// Node's symbol for a parent's URL, once a lockdown in this thread has found
// it (a second install's probe request would be answered from Node's cache)
let knownUrlKey = null;
const RequireResolve = require.resolve;
const hostAllowed = modulePermissions.hostAllowed;
const ModuleCreateRequire = Module.createRequire;
const ReflectOwnKeys = Reflect.ownKeys;
const EventTargetCtor = globalThis.EventTarget;
const TypeErrorCtor = TypeError;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const PrependListener = uncurry(require('events').prototype.prependListener);
const ProcessNextTick = process.nextTick;

function bare(specifier) {
  const s = StringCtor(specifier);
  return StringStartsWith(s, 'node:') ? StringSlice(s, 5) : s;
}

// id: a specifier Node reports as built-in, with or without node:.
function builtinAllowed(id) {
  return SetHas(ALLOWED_BUILTINS, bare(id));
}

// (each code defined, not assigned: an assignment runs a setter a module
// put on Object.prototype or Error.prototype)
function accessDenied(what, moduleName) {
  const err = new Error(`${what} is not allowed for module ${moduleName} ${SANDBOX_TAG}`);
  own(err, 'code', 'ERR_ACCESS_DENIED');
  return err;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' ${SANDBOX_TAG}`);
  own(err, 'code', 'MODULE_NOT_FOUND');
  return err;
}

// True when a bare specifier names a file in countinghouse's own lib/, the
// route NODE_PATH=lib would open.
function reachesLib(specifier) {
  const s = StringCtor(specifier);
  if (StringStartsWith(s, '.') || ReflectApply(PathIsAbsolute, path, [s])) return false;
  // a ".." segment, by index (either separator)
  let segment = '';
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || s[i] === '/' || s[i] === '\\') {
      if (segment === '..') return false;
      segment = '';
    } else {
      segment += s[i];
    }
  }
  try {
    ReflectApply(RequireResolve, require, [ReflectApply(PathJoin, path, [__dirname, s])]);
    return true;
  } catch (e) {
    return false;
  }
}

// 'host:port' of an absolute URL string, or null when it is not one.
// (base: a URL string to read href against, as new URL(href, base))
function hostPort(href, base) {
  try {
    const u = base !== undefined ? new URLCtor(href, base) : new URLCtor(href);
    const port = URLPort(u);
    return {host: URLHostname(u), port: port !== '' ? ParseInt(port, 10) : (URLProtocol(u) === 'https:' ? 443 : 80), href: URLHref(u)};
  } catch (e) {
    return null;
  }
}

// Enforce-side normalisation of CHUtil.request's options, so that what is
// checked is exactly what postman-request will use: one string uri, no har /
// baseUrl / proxy or other key to move it (only REQUEST_OPTIONS pass), no
// environment proxy (an own `proxy: null` stops postman-request's
// getProxyFromURI), and every redirect checked.
// Returns {refusal: null, options} or {refusal: <target>, options: null}.
// onRedirectDenied(target) is called when a redirect is refused.
function normaliseRequestOptions(opts, net, onRedirectDenied) {
  const refuse = (target) => ({refusal: target, options: null});
  const given = typeof(opts) === 'string' ? {uri: opts} : opts;
  if (given == null || typeof(given) !== 'object') return refuse('invalid');
  // Read each value once, into the copy that is checked and then used: each
  // the copy's own (no prototype: a missing key reads as undefined, never
  // through an Object.prototype getter).
  const options = {__proto__: null};
  const keys = ObjectKeys(given);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = given[key];
    if (value === undefined) continue;
    if (!SetHas(REQUEST_OPTIONS, key)) return refuse(key);
    own(options, key, value);
  }
  let target = options.uri != null ? options.uri : options.url;
  if (target != null && typeof(target) === 'object') target = target.href;
  if (typeof(target) !== 'string') return refuse('invalid');
  const parsed = hostPort(target);
  if (parsed == null) return refuse('invalid');
  if (!hostAllowed(net, parsed.host, parsed.port)) return refuse(`${parsed.host}:${parsed.port}`);

  delete options.url;
  own(options, 'uri', parsed.href);
  own(options, 'proxy', null);
  if (options.followRedirect !== false) {
    const original = options.followRedirect;
    // postman-request calls followRedirect with the request as `this`.
    own(options, 'followRedirect', function(response) {
      const location = response != null && response.headers != null ? response.headers.location : null;
      // postman-request's uri: a url.parse result (its own href), or a URL
      const u = this != null ? this.uri : null;
      let base = null;
      try {
        if (u != null && typeof(u) === 'object') base = ObjectIsPrototypeOf(URLCtor.prototype, u) ? URLHref(u) : (ObjectHasOwn(u, 'href') ? u.href : null);
      } catch (e) {
        base = null;
      }
      if (typeof(base) !== 'string') base = null;
      const next = (typeof(location) === 'string' && base != null) ? hostPort(location, base) : null;
      if (next == null || !hostAllowed(net, next.host, next.port)) {
        onRedirectDenied(next != null ? `${next.host}:${next.port}` : 'invalid');
        return false;
      }
      return typeof(original) === 'function' ? ReflectApply(original, this, [response]) : true;
    });
  }
  // what postman-request reads from: an ordinary object (it may look for
  // its own keys with hasOwnProperty), every value the checked one
  const out = {};
  const outKeys = ObjectKeys(options);
  for (let i = 0; i < outKeys.length; i++) own(out, outKeys[i], options[outKeys[i]]);
  return {refusal: null, options: out};
}

function lock(obj, key, value) {
  ObjectDefineProperty(obj, key, {__proto__: null, value: value, writable: false, configurable: false, enumerable: false});
}

// opts.beforeLock(registerHooks): called once, after this lockdown's own
// hooks are registered and before Module.registerHooks is locked, with the
// original registerHooks -- so the file broker's loader hook
// (lib/fs-broker/identity.js) registers after ours and runs first. Nothing
// else gets it.
// The native handle prototypes whose open(fd) adopts a descriptor, taken
// while process.binding is still the original (install locks it). Under
// --permission (--hardened) process.binding is refused: then each is taken
// from an instance built here, before any module code runs, and destroyed.
// Before 8.0 they were not taken at all there, so a handle a module built
// from an instance's constructor could open any descriptor (review of #36,
// F1). A kind taken neither way is left in UNGUARDED_HANDLES, and install
// refuses to start under enforce.
const fromBinding = (binding, cls) => {
  try { return process.binding(binding)[cls].prototype; } catch (e) { return null; }
};
// A Socket's connect builds its handle before it validates the port or the
// path, and a handle has no socket until it binds or connects: an invalid
// one gives the handle with no syscall. A setter on the instance sees it
// before connect throws.
const fromSocket = (connectArgs) => {
  let proto = null;
  try {
    const s = new (require('net').Socket)();
    let handle = null;
    Object.defineProperty(s, '_handle', {configurable: true, enumerable: true, get: () => handle,
      set: (v) => { handle = v; if (v != null && proto == null) proto = Object.getPrototypeOf(v); }});
    try { s.connect(connectArgs); } catch (e) { /* the invalid port or path, as intended */ }
    s.destroy();
  } catch (e) {
    return null;
  }
  return proto;
};
// A dgram socket makes its handle at once; it has no socket until bind.
const fromDgram = () => {
  try {
    const u = require('dgram').createSocket('udp4');
    const state = Object.getOwnPropertySymbols(u).map((k) => u[k]).find((v) => v != null && typeof(v) === 'object' && v.handle != null &&
      typeof(v.handle.open) === 'function' && typeof(v.handle.bind) === 'function');
    const proto = (state != null) ? Object.getPrototypeOf(state.handle) : null;
    u.close();
    return proto;
  } catch (e) {
    return null;
  }
};
const CAPTURE = {
  TCP: () => fromSocket({host: '127.0.0.1', port: 'none'}),
  Pipe: () => fromSocket({path: 1}),
  UDP: () => fromDgram()
};
const HANDLES = {
  TCP: fromBinding('tcp_wrap', 'TCP') || CAPTURE.TCP(),
  Pipe: fromBinding('pipe_wrap', 'Pipe') || CAPTURE.Pipe(),
  UDP: fromBinding('udp_wrap', 'UDP') || CAPTURE.UDP()
};
const guardable = (p) => p != null && typeof(p.open) === 'function';
const HANDLE_PROTOTYPES = Object.values(HANDLES).filter(guardable);
const UNGUARDED_HANDLES = Object.keys(HANDLES).filter((k) => !guardable(HANDLES[k]));
// The symbol by which Socket.prototype.connect knows the [options, cb]
// array net.connect has normalised: it reads that array's [0] as the
// options, and any other array as an object of its own properties (review
// of #36, round 2). Taken from the array net._normalizeArgs, which
// net.connect uses, marks.
const fromNormalize = () => {
  try {
    const normalized = require('net')._normalizeArgs([{}]);
    return Object.getOwnPropertySymbols(normalized).find((k) => normalized[k] === true) || null;
  } catch (e) {
    return null;
  }
};
const NORMALIZED = fromNormalize();
// The process's directory, which a relative socket path is read from.
// Workers cannot chdir, and once the namespace is in place process.cwd()
// answers the module's view (/app), so it is read here, at load.
const CWD = process.cwd();
// Taken when this file loads, before any module code: the handle guards
// below (the review of #206) call nothing a module can replace at call time:
// not Function.prototype.apply, nor String's, Set's or BlockList's methods.
const NumberIsInteger = Number.isInteger;
const {BlockList} = require('net');
const BlockListCheck = BlockList.prototype.check;
// And for the net-level Redis check (#207): the host it reads is canonical
// by these alone, never by a String, RegExp, Array or URL method looked up
// when a module connects, nor by net's own isIP functions.
const NumberCtor = Number;
const ParseInt = parseInt;
const ArrayIsArray = Array.isArray;
const URLCtor = URL;
const urlGetter = (key) => uncurry(Object.getOwnPropertyDescriptor(URL.prototype, key).get);
const URLHostname = urlGetter('hostname');
const URLPort = urlGetter('port');
const URLProtocol = urlGetter('protocol');
const URLHref = urlGetter('href');
const NetIsIPv4 = require('net').isIPv4;
const NetIsIPv6 = require('net').isIPv6;
const ObjectKeys = Object.keys;
const ObjectHasOwn = Object.hasOwn;
const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const WeakSetHas = uncurry(WeakSet.prototype.has);
const WeakSetAdd = uncurry(WeakSet.prototype.add);
const MapSet = uncurry(Map.prototype.set);
const BlockListAddAddress = uncurry(BlockList.prototype.addAddress);
const BlockListAddSubnet = uncurry(BlockList.prototype.addSubnet);
// A SocketAddress built from options that are all its own (no prototype),
// with every field it reads given: BlockList.check(string) and
// addAddress(string) build one from {address, family}, and on some Node
// versions (22.23.4, 24.15.0) that reads port and flowlabel through
// Object.prototype, where a module could set them so the check throws and
// answers false (the security review of #227). Throws on a bad address.
const SocketAddressCtor = require('net').SocketAddress;
const socketAddress = (address, family) => new SocketAddressCtor({__proto__: null, address: address, family: family, port: 0, flowlabel: 0});
// an own data property, with no setter on any prototype run (a plain
// assignment to an object or array runs one an Object.prototype or
// Array.prototype accessor of that name defines)
// (the descriptor has no prototype: defineProperty reads get and set, which an
// Object.prototype accessor would otherwise answer)
const own = (o, key, value) => ObjectDefineProperty(o, key, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});
// lower-case hex digits, as the URL parser writes an address
const isHexGroup = (s) => {
  if (s.length < 1 || s.length > 4) return false;
  for (let i = 0; i < s.length; i++) {
    const c = StringCharCodeAt(s, i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
};
// '::ffff:H:L' or '::H:L' (an IPv4-mapped or -compatible address, as the URL
// parser writes it) -> its IPv4 one; anything else -> null
const mappedAfter = (v6, prefix) => {
  if (!StringStartsWith(v6, prefix)) return null;
  const rest = StringSlice(v6, prefix.length);
  const colon = StringIndexOf(rest, ':');
  if (colon === -1 || StringIndexOf(rest, ':', colon + 1) !== -1) return null;
  const hi = StringSlice(rest, 0, colon);
  const lo = StringSlice(rest, colon + 1);
  if (!isHexGroup(hi) || !isHexGroup(lo)) return null;
  const high = ParseInt(hi, 16);
  const low = ParseInt(lo, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
};
// (no loop over a list: an array's iterator is looked up when it runs)
const mappedV4 = (v6) => {
  const mapped = mappedAfter(v6, '::ffff:');
  return mapped != null ? mapped : mappedAfter(v6, '::');
};


// #170: every message to the main thread is an envelope of bounded bytes
// (lib/message-envelope.js), sent on a port module code cannot reach. The
// worker's own port is pinned (pinPort): a patched MessagePort.prototype
// method, or one of an EventTarget above it, is never handed it as `this`.
function install(cfg, report, opts) {
  const enforce = (cfg.mode === 'enforce');
  const name    = cfg.moduleName;
  const root    = path.resolve(cfg.moduleRoot);
  const seen    = new Set();
  let seenCount = 0;

  const once = (rule, target) => {
    const key = `${rule}\0${target}`;
    if (SetHas(seen, key)) return;
    // A module in a loop could otherwise flood the main thread with distinct
    // targets: past the cap, say so once and go quiet.
    if (seenCount > MAX_REPORTS) return;
    SetAdd(seen, key);
    seenCount++;
    if (seenCount > MAX_REPORTS) return report('suppressed', '');
    report(rule, target);
  };
  const violate = (rule, target, makeError) => {
    once(rule, target);
    if (enforce) throw makeError();
  };
  const unguarded = [];
  if (UNGUARDED_HANDLES.length > 0) unguarded.push(`open(fd) on the ${UNGUARDED_HANDLES.join(' and ')} handle`);
  if (NORMALIZED == null) unguarded.push('the connect arguments net.connect normalises');
  if (!isMainThread && STDIO_PORT == null) unguarded.push('Node\'s stdio port (not found on process.stdout)');
  if (unguarded.length > 0) {
    const what = `${unguarded.join(' and ')} under Node ${process.version}`;
    if (enforce) throw new Error(`module sandbox: cannot guard ${what}; not starting under enforce`);
    // The lockdown's own state, not something the module did.
    report('unguarded', what);
  }
  pinPort(parentPort);
  // Under the file broker a module names its own files /app/..., and on
  // Windows <V>:\app\... (#195: the same files, the form Node there has):
  // both are the module's.
  // (each on what this file took at load: see the top)
  const virtualRoot = cfg.virtualRoot != null ? StringCtor(cfg.virtualRoot) : null;
  const virtualDrive = cfg.virtualDrive != null ? StringToUpperCase(StringCtor(cfg.virtualDrive)) : null;
  // every "from" character of s as "to" (one character each), by index
  const swapped = (s, from, to) => {
    let out = '';
    for (let i = 0; i < s.length; i++) out += (s[i] === from ? to : s[i]);
    return out;
  };
  const isSlash = (c) => c === '/' || c === '\\';
  // <V>:\app... -> /app..., the identity loader's own rule
  const fromWin = fromWinFor(virtualDrive);
  const hostOf = (given) => {
    const file = fromWin(given);
    if (virtualRoot == null || typeof(file) !== 'string') return file;
    if (!(file === virtualRoot || StringStartsWith(file, `${virtualRoot}/`))) return file;
    const rest = StringSlice(file, virtualRoot.length);
    return root + (PATH_SEP === '\\' ? swapped(rest, '/', '\\') : rest);
  };
  // the host's rules (the drive letter in either case on Windows), the
  // file broker's own (lib/fs-broker/roots.js underFor)
  const under = underFor(process.platform);
  const roots = [root];
  const inside = (file) => {
    const f = hostOf(file);
    return typeof(f) === 'string' && under(f, roots);
  };
  // Module code is a file inside the module root, or anything that is not a
  // file at all (a data: module a module imported has no location of its own
  // and must not become a way out). An undefined parent is the entry point.
  const fromModule = (parentURL) => {
    if (typeof(parentURL) !== 'string') return false;
    if (!StringStartsWith(parentURL, 'file:')) return !StringStartsWith(parentURL, 'node:');
    try { return inside(fileURLToPath(parentURL)); } catch (e) { return false; }
  };
  const fromPath = (from) => {
    if (from != null && typeof(from) === 'object' && ObjectIsPrototypeOf(URLCtor.prototype, from)) return fileURLToPath(URLHref(from));
    if (typeof(from) === 'string' && StringStartsWith(from, 'file:')) return fileURLToPath(from);
    // path.resolve drops a trailing separator, which createRequire reads as
    // "this is a directory".
    const given = StringCtor(from);
    const resolved = pathResolve(given);
    return given.length > 0 && isSlash(given[given.length - 1]) && !StringEndsWith(resolved, PATH_SEP) ? resolved + PATH_SEP : resolved;
  };

  // 0. What Node's own loader, and the checks here, read from objects a
  // module can reach: the path, path.posix, path.win32 and url exports,
  // URL.prototype's accessors and methods (Node's internals read a URL's
  // href, pathname and the rest through them), and Module.isBuiltin. Made
  // non-writable and non-configurable, in audit and enforce alike, so a
  // module can't show the loader or a check one path and have another one
  // used. A module can no longer patch path, url or URL; the intrinsics
  // (Array, String, Set...) stay as they are: the checks take theirs at load.
  const fix = (obj) => {
    const keys = ReflectOwnKeys(obj);
    for (let i = 0; i < keys.length; i++) {
      const d = ObjectGetOwnPropertyDescriptor(obj, keys[i]);
      if (d == null || d.configurable !== true) continue;
      ObjectDefineProperty(obj, keys[i], ObjectHasOwn(d, 'value')
        ? {__proto__: null, value: d.value, writable: false, configurable: false, enumerable: d.enumerable}
        : {__proto__: null, get: d.get, set: d.set, configurable: false, enumerable: d.enumerable});
    }
  };
  fix(path);
  if (path.posix !== path) fix(path.posix);
  if (path.win32 !== path) fix(path.win32);
  fix(url);
  fix(URLCtor.prototype);
  // A port's methods, and its event targets': Node's own set-up of a port
  // that reaches this worker after module code has loaded (a peer channel's)
  // calls `this.on`, so a replaced method would be handed the port before
  // the runtime ever holds it.
  // Node also assigns keys of its own on every port it sets up (kEvents,
  // kHandlers, the listener limits; on a port, kCurrentlyReceivingPorts):
  // plainly, so a setter module code put on Object.prototype for one would
  // be handed each new port. Each gets an accessor here, on the prototype
  // Node's instances inherit from, whose setter makes the value the
  // instance's own: Object.prototype is never reached. The keys are a real
  // port's own, so one Node adds is covered. EventTarget.prototype's
  // kNewListener and kRemoveListener are among them: an inspected port is
  // copied (Object.assign) onto an object inheriting them, which a fixed,
  // non-writable method would refuse; as accessors they read as the
  // methods, and the copy gets its own.
  const eventTargetProto = ObjectGetPrototypeOf(ObjectGetPrototypeOf(MessagePort.prototype));
  const assignedOwn = (proto, key) => {
    const d = ObjectGetOwnPropertyDescriptor(proto, key);
    if (d != null && (d.configurable !== true || !ObjectHasOwn(d, 'value'))) return;
    const inherited = (d != null) ? d.value : undefined;
    ObjectDefineProperty(proto, key, {__proto__: null, configurable: false, enumerable: d != null ? d.enumerable : false,
      get() { return inherited; },
      set(value) {
        if (this === proto) throw new TypeErrorCtor(`Cannot assign to read only property '${StringCtor(key)}' of object`);
        ObjectDefineProperty(this, key, {__proto__: null, value, writable: true, enumerable: true, configurable: true});
      }});
  };
  {
    const probe = new MessageChannel();
    const portKeys = ReflectOwnKeys(probe.port1);
    probe.port1.close();
    probe.port2.close();
    const targetKeys = ReflectOwnKeys(new EventTargetCtor());
    const onEveryTarget = (key) => {
      if (ObjectHasOwn(eventTargetProto, key)) return true;
      for (let j = 0; j < targetKeys.length; j++) if (targetKeys[j] === key) return true;
      return false;
    };
    for (let i = 0; i < portKeys.length; i++) assignedOwn(onEveryTarget(portKeys[i]) ? eventTargetProto : MessagePort.prototype, portKeys[i]);
  }
  fix(MessagePort.prototype);
  fix(ObjectGetPrototypeOf(MessagePort.prototype));
  fix(eventTargetProto);
  if (ObjectGetOwnPropertyDescriptor(Module, 'isBuiltin').configurable === true) lock(Module, 'isBuiltin', ModuleIsBuiltin);

  // 1. Native code.
  const dlopen = process.dlopen;
  lock(process, 'dlopen', (...args) => {
    violate('native', StringCtor(args[1]), () => accessDenied('loading native code', name));
    return ReflectApply(dlopen, process, args);
  });
  const nodeLoader = Module._extensions['.node'];
  Module._extensions['.node'] = function(mod, filename) {
    violate('native', StringCtor(filename), () => accessDenied('loading native code', name));
    return ReflectApply(nodeLoader, this, arguments);
  };
  Object.defineProperty(Module._extensions, '.node', {writable: false, configurable: false});
  ['binding', '_linkedBinding'].forEach((key) => {
    const original = process[key];
    lock(process, key, (...args) => {
      violate(`process.${key}`, StringCtor(args[0]), () => accessDenied(`process.${key}`, name));
      return ReflectApply(original, process, args);
    });
  });

  // OpenSSL engines are shared libraries too: crypto.setEngine and the TLS
  // options privateKeyEngine and clientCertEngine load them. The TLS options
  // end in two methods of the native SecureContext prototype, which every
  // context shares; it is reached through a throwaway context, so nothing
  // becomes reachable that module code could not already reach the same way.
  const crypto = require('crypto');
  const setEngine = crypto.setEngine;
  lock(crypto, 'setEngine', (...args) => {
    violate('native', `engine ${StringCtor(args[0])}`, () => accessDenied('loading an OpenSSL engine', name));
    return ReflectApply(setEngine, crypto, args);
  });
  const contextProto = Object.getPrototypeOf(require('tls').createSecureContext().context);
  ['setEngineKey', 'setClientCertEngine'].forEach((key) => {
    const original = contextProto[key];
    if (typeof(original) !== 'function') return;
    lock(contextProto, key, function(...args) {
      violate('native', `engine ${StringCtor(args[args.length - 1])}`, () => accessDenied('loading an OpenSSL engine', name));
      return ReflectApply(original, this, args);
    });
  });

  // Descriptors and handles (part 2 spec, section 2, "Other routes to
  // files"). The design spike showed a worker's new net.Socket({fd}) adopting
  // the main thread's listening socket, and server.listen({fd}) on a net or
  // http server taking over its connections: a descriptor number is a way
  // past the broker. The public entry points check their arguments; the
  // native open(fd) of the TCP, Pipe and UDP handles is the backstop for code
  // that reaches the real constructors through an instance.
  const adopt = (what) => violate('descriptor', what, () => accessDenied(`adopting ${what}`, name));
  // Each guarded entry copies an options object once into a plain object,
  // checks the copy and passes the copy on, so a getter or a Proxy cannot
  // answer the check one value and Node another (review of #36, F2). The
  // copy reads each own enumerable property once, as Node's Socket
  // constructor reads them ({...options}). An inherited or non-enumerable
  // property is dropped: the safe direction, since where Node would read an
  // inherited one (connect, listen) the call then fails as if it were
  // absent. Node's normalised [options, cb] array is copied as an array with
  // its marker, options copied; any other array is read as Node reads it,
  // as an object of its own properties. A copy is made once: the
  // prototype connect behind net.connect, which gets net.connect's copy
  // back inside the normalised array, passes it on as it is. The copies go
  // to Node only, never back to module code.
  const copies = new WeakSet();
  // (#207: on the functions taken at load, each property defined as the
  // copy's own, so no accessor on a prototype runs, and each of the
  // module's own read once, here)
  const copyOf = (o) => {
    if (o == null || typeof(o) !== 'object' || WeakSetHas(copies, o)) return o;
    const copy = {};
    const keys = ObjectKeys(o);
    for (let i = 0; i < keys.length; i++) own(copy, keys[i], o[keys[i]]);
    WeakSetAdd(copies, copy);
    return copy;
  };
  // The marker a normalised array carries, or null. Without NORMALIZED
  // (install has then reported it as unguarded, and refused under enforce),
  // a symbol under Node's description.
  const markerOf = (a) => {
    if (!ArrayIsArray(a)) return null;
    if (NORMALIZED != null) return (a[NORMALIZED] === true) ? NORMALIZED : null;
    const symbols = ObjectGetOwnPropertySymbols(a);
    for (let i = 0; i < symbols.length; i++) {
      if (symbols[i].description === 'normalizedArgs' && a[symbols[i]] === true) return symbols[i];
    }
    return null;
  };
  // an array's elements into a new array, by index (no slice or concat: a
  // species constructor or a spreadable flag is looked up when they run)
  const elements = (a, from) => {
    const out = [];
    for (let i = from; i < a.length; i++) own(out, i - from, a[i]);
    return out;
  };
  const copyArgs = (args) => {
    if (args.length === 0) return args;
    let first = args[0];
    const marker = markerOf(first);
    if (marker != null) {
      const copy = elements(first, 0);
      own(copy, 0, copyOf(copy[0]));
      own(copy, marker, true);
      first = copy;
    } else {
      first = copyOf(first);
    }
    const out = elements(args, 0);
    own(out, 0, first);
    return out;
  };
  // After copyArgs, an array is a normalised one.
  const optionsOf = (args) => (ArrayIsArray(args[0]) ? args[0][0] : args[0]);
  // An fd option. Where a bare number is a port (net.connect, dgram bind),
  // this is the whole check.
  const hasFd = (o) => o != null && typeof(o) === 'object' && o.fd != null;
  const fdOrHandle = (o) => hasFd(o) || (o != null && typeof(o) === 'object' && (o.handle != null || o._handle != null));
  // For net.Socket, adoption is a descriptor number: the fd option, or
  // Node's bare-number form new Socket(fd). A handle object is never a way
  // to a foreign descriptor inside a worker: the bindings that make one are
  // locked, and open(fd) on the TCP, Pipe and UDP prototypes is guarded in
  // every mode, --hardened included (HANDLE_PROTOTYPES). Node's own
  // TLSSocket and JSStreamSocket construct net.Socket with {handle}, and
  // refusing that (as 7.x did) left a module under enforce with no TLS
  // connection at all.
  const adoptsFd = (o) => typeof(o) === 'number' || hasFd(o);
  const net = require('net');
  const Socket = net.Socket;
  const guardedSocket = new Proxy(Socket, {
    construct(target, args, newTarget) {
      args = copyArgs(args);
      if (adoptsFd(args[0])) adopt('a descriptor (net.Socket)');
      return ReflectConstruct(target, args, newTarget);
    },
    apply(target, self, args) {
      args = copyArgs(args);
      if (adoptsFd(args[0])) adopt('a descriptor (net.Socket)');
      return ReflectApply(target, self, args);
    }
  });
  lock(net, 'Socket', guardedSocket);
  lock(net, 'Stream', guardedSocket);
  // A Proxy's prototype is its target's, so prototype.constructor (and an
  // instance's constructor) was the real constructor (L1 round 4). So was
  // the [[Prototype]] of each exported subclass, the constructor it extends.
  // A real net.Socket reached another way (Node's internal JSStreamSocket
  // extends it too) builds only a TCP or Pipe handle from a descriptor, and
  // that handle's open(fd) is guarded (HANDLE_PROTOTYPES).
  lock(net.Socket.prototype, 'constructor', guardedSocket);
  const tls = require('tls');
  const tty = require('tty');
  [tls.TLSSocket, tty.ReadStream, tty.WriteStream].forEach((sub) => {
    if (Object.getPrototypeOf(sub) === Socket) Object.setPrototypeOf(sub, guardedSocket);
  });
  // net.connect and createConnection (one function) build Node's internal
  // Socket, not the exported one, so the guard above never sees them; the
  // http agent reaches them through net.createConnection (review of #36).
  const netConnect = net.connect;
  const guardedConnect = function(...args) {
    args = copyArgs(args);
    if (hasFd(optionsOf(args))) adopt('a descriptor (net.connect)');
    return ReflectApply(netConnect, this, args);
  };
  lock(net, 'connect', guardedConnect);
  lock(net, 'createConnection', guardedConnect);
  // Node 24.0 and 22.16 bind http.Agent.prototype.createConnection to
  // net.createConnection itself when http loads (later 22s and 24.14 wrap it
  // in a function of their own that looks net up at each call), so there the
  // agent reached the unwrapped function: an http.request given an fd was
  // not refused at its entry (the floor-shim PR's 24.0.0 CI leg).
  //
  // Guarded as an accessor, not a read-only value: a subclass assigns its
  // own createConnection to its prototype as it loads (https's Agent,
  // forever-agent's ForeverAgentSSL under postman-request, any util.inherits
  // agent), and a read-only inherited property refuses that assignment (a
  // TypeError in strict code, silently dropped in sloppy code). A lean worker
  // loads those libraries on first use, after the lockdown, so a first
  // require('https') threw, and a TLS agent would have kept the guarded plain
  // connect. Any other receiver gets its own property, as an ordinary
  // assignment would give it (module code cannot reach the original
  // net.createConnection to put there); http.Agent.prototype's own stays the
  // guarded one, and an assignment to it is ignored.
  const httpAgent = require('http').Agent;
  if (httpAgent.prototype.createConnection === netConnect) {
    const agentProto = httpAgent.prototype;
    Object.defineProperty(agentProto, 'createConnection', {configurable: false, enumerable: false,
      get: () => guardedConnect,
      set: function(value) {
        if (this === agentProto) return;
        Object.defineProperty(this, 'createConnection', {value: value, writable: true, configurable: true, enumerable: true});
      }});
  }
  // The Redis endpoint (R2-1, the always-denied set): EACCES in audit and
  // enforce alike, and recorded. One wrap on Socket.prototype.connect covers
  // net.connect and createConnection, a raw Socket, a TLSSocket (it connects
  // through it) and http(s) over a socketPath (the agent's createConnection).
  // tls.connect dials through it with the options as _tls_wrap merged them,
  // and given a socket dials nothing, so it has no check of its own (L1
  // round 4: a second reading of its arguments refused tls.connect(port,
  // {host}) as localhost). A refused socket that is connecting with a
  // handle is destroyed: a fresh TLSSocket (tls marks it connecting before it
  // connects), so its handle does not outlive the call, or one already
  // connecting, which Node itself ends with EALREADY. One that is connected,
  // over TCP or a pipe, is left as it was (L1 round 5). A
  // loopback Redis is denied under every loopback literal and name
  // (isLoopback). An in-worker check, not a boundary, until the network
  // broker (sandbox parts 3 and 4) moves connections to the main thread.
  const denied = (cfg.denied != null) ? cfg.denied : {endpoints: [], socketPaths: []};
  // Loopback: an IPv4 literal in 127/8 or 0.0.0.0 in every form getaddrinfo
  // takes (127.1, 0x7f.1, 2130706433; WHATWG's host parser reads them the
  // same way), ::1 and :: however written, the IPv4-mapped and
  // IPv4-compatible forms of those IPv4 ones, and the loopback names. A name that reaches loopback only through /etc/hosts or
  // DNS, or through a lookup function the module passes, is not caught
  // until the network broker. The names are lib/loopback-names.js's.
  // A host as it will be connected to: an empty one is localhost (Node's own
  // default), a literal address in its one canonical spelling (so 10.5 is
  // 10.0.0.5 and fd00:0:0::5 is fd00::5; an IPv4-mapped or IPv4-compatible
  // address is its IPv4 one, so ::ffff:a00:5 and ::10.0.0.5 are 10.0.0.5),
  // a name lower-cased without its trailing dot.
  // (#207: on the functions taken at load only; host is a primitive)
  const canonicalHost = (host) => {
    // any falsy host is Node's localhost (host || 'localhost'), as before
    let h = StringToLowerCase(!host ? 'localhost' : StringCtor(host));
    const zone = StringIndexOf(h, '%');
    if (zone !== -1) h = StringSlice(h, 0, zone);
    if (h.length >= 2 && StringCharCodeAt(h, 0) === 91 && StringCharCodeAt(h, h.length - 1) === 93) h = StringSlice(h, 1, -1);
    if (NetIsIPv6(h)) {
      const v6 = StringSlice(URLHostname(new URLCtor(`http://[${h}]/`)), 1, -1);
      const v4 = mappedV4(v6);
      return v4 != null ? v4 : v6;
    }
    let parsed = null;
    try { parsed = URLHostname(new URLCtor(`http://${h}/`)); } catch (e) { /* not a host a URL can carry */ }
    if (parsed != null && NetIsIPv4(parsed)) return parsed;
    // a name as the URL parser maps it (IDNA, as Node's lookup does: a
    // fullwidth or otherwise mapped spelling is its plain one), else as given
    const name = parsed != null && parsed !== '' ? parsed : h;
    return StringEndsWith(name, '.') ? StringSlice(name, 0, -1) : name;
  };
  const isLoopback = isLoopbackHost;
  // Each denied endpoint's host, canonical and whether it is loopback, once.
  const endpoints = denied.endpoints.map((e) => {
    const canonical = canonicalHost(e.host);
    return {port: e.port, canonical: canonical, loopback: isLoopback(canonical)};
  });
  const ENDPOINTS = endpoints.length;
  const anyLoopback = endpoints.some((e) => e.loopback);
  // A socket path as the connect reaches it: a relative one from the
  // process's directory, with . , .. and // resolved. An abstract (Linux)
  // name is left as it is. A symlink or hard link to the socket is not
  // caught until the network broker.
  const socketPathOf = (p) => (StringStartsWith(p, '\0') ? p : pathResolve(CWD, p));
  const socketPaths = new Set(denied.socketPaths.map((p) => socketPathOf(String(p))));
  // Only primitives are read (#207): Node itself refuses a host, port or
  // path that is not one (ERR_INVALID_ARG_TYPE, ERR_SOCKET_BAD_PORT), so a
  // module's toString or valueOf is never called here, and what the check
  // reads is what the connect reads.
  const primitive = (v) => (v != null && (typeof(v) === 'object' || typeof(v) === 'function') ? undefined : v);
  const endpointOf = (args) => {
    const first = args[0];
    const a = ArrayIsArray(first) ? first[0] : first;   // net.connect hands its normalised [options, cb] on
    if (a != null && typeof(a) === 'object') {
      // read once, and written back as the copy's own (copyArgs's), so Node
      // reads what the check read: a value an Object.prototype getter gave
      // is never asked for again (the security review of #227)
      const t = {host: primitive(a.host), port: primitive(a.port), path: primitive(a.path)};
      // (each by name: a loop over a list would look up its iterator now).
      // Written even as undefined: a getter that answered undefined (or an
      // object, which is not read) is otherwise asked again by Node.
      if (!ObjectHasOwn(a, 'host')) own(a, 'host', t.host);
      if (!ObjectHasOwn(a, 'port')) own(a, 'port', t.port);
      if (!ObjectHasOwn(a, 'path')) own(a, 'path', t.path);
      return t;
    }
    // Node's isPipeName: a string is a path unless it reads as a number
    // (0x18eb, ' 6379' and 6.379e3 are all port 6379).
    if (typeof(a) === 'string' && !(NumberCtor(a) >= 0)) return {path: a};
    return {port: primitive(a), host: typeof(args[1]) === 'string' ? args[1] : undefined};
  };
  const deniedTarget = (t) => {
    if (t.path) {   // Node: a pipe when path is truthy
      const p = socketPathOf(StringCtor(t.path));
      return SetHas(socketPaths, p) ? p : null;
    }
    const host = canonicalHost(t.host);
    const port = NumberCtor(t.port);
    const loopback = anyLoopback && isLoopback(host);
    for (let i = 0; i < ENDPOINTS; i++) {
      const e = endpoints[i];
      if (e.port === port && (host === e.canonical || (e.loopback && loopback))) return `${host}:${port}`;
    }
    return null;
  };
  const refuseDenied = (socket, args) => {
    const target = deniedTarget(endpointOf(args));
    if (target == null) return;
    once('redis', target);
    if (socket._handle != null && socket.connecting) socket.destroy();
    const err = accessDenied(`a connection to the Redis endpoint ${target}`, name);
    own(err, 'code', 'EACCES');
    throw err;
  };
  const socketConnect = net.Socket.prototype.connect;
  lock(net.Socket.prototype, 'connect', function(...args) {
    args = copyArgs(args);
    refuseDenied(this, args);
    // what was checked is handed on with what was taken at load (#207)
    return ReflectApply(socketConnect, this, args);
  });
  // http, https, http2 and tls servers inherit this listen. Unlike
  // net.Socket it stays strict about handles: a module has no need to listen
  // on a handle, and nothing of Node's builds a server from one.
  // A handle given to listen (L1 round 4: not any prototype other than
  // Object's) is one of the kinds whose open(fd) is guarded: Node's listen
  // takes a TCP handle as its handle and reads any other's fd. It is passed
  // on as given, so audit reports it and the call runs as written; any other
  // object is copied, so Node never sees a handle the check did not. A kind
  // the lockdown could not take (reported at install) is copied as well,
  // and Node refuses the copy, which has neither a port nor a path
  // (ERR_INVALID_ARG_VALUE).
  const listen = net.Server.prototype.listen;
  const isListenHandle = (o) => {
    if (o == null || typeof(o) !== 'object') return false;
    for (let i = 0; i < HANDLE_PROTOTYPES.length; i++) if (ObjectIsPrototypeOf(HANDLE_PROTOTYPES[i], o)) return true;
    return false;
  };
  lock(net.Server.prototype, 'listen', function(...args) {
    const handle = isListenHandle(args[0]);
    if (!handle) args = copyArgs(args);
    if (handle || fdOrHandle(args[0])) adopt('a descriptor or handle (server.listen)');
    return ReflectApply(listen, this, args);
  });
  const dgram = require('dgram');
  const bind = dgram.Socket.prototype.bind;
  lock(dgram.Socket.prototype, 'bind', function(...args) {
    args = copyArgs(args);
    if (hasFd(args[0])) adopt('a descriptor (dgram bind)');
    return ReflectApply(bind, this, args);
  });
  // tty builds its handle from the fd itself, with no open(fd), so no
  // backstop sees a real constructor: prototype.constructor is the guard too.
  ['ReadStream', 'WriteStream'].forEach((key) => {
    const guarded = new Proxy(tty[key], {
      construct(target, args, newTarget) { adopt(`a descriptor (tty.${key})`); return ReflectConstruct(target, args, newTarget); },
      apply(target, self, args) { adopt(`a descriptor (tty.${key})`); return ReflectApply(target, self, args); }
    });
    lock(tty, key, guarded);
    lock(tty[key].prototype, 'constructor', guarded);
  });
  // An HTTP/2 server stream's respondWithFD(fd) sends a real descriptor's
  // contents (found by the plan 3 sweep). The stream prototype is not
  // exported: it is locked the first time a server stream appears, by a
  // listener that runs before any of the module's.
  const http2 = require('http2');
  let streamGuarded = false;
  const guardStream = (stream) => {
    const proto = ObjectGetPrototypeOf(stream);
    if (streamGuarded || proto == null || typeof(proto.respondWithFD) !== 'function') return;
    const respondWithFD = proto.respondWithFD;
    lock(proto, 'respondWithFD', function(...args) {
      adopt('a descriptor (http2 respondWithFD)');
      return ReflectApply(respondWithFD, this, args);
    });
    streamGuarded = true;
  };
  // (EventEmitter's prependListener as taken at load: one a module replaced
  // would never put the guard up)
  const guardSession = (session) => PrependListener(session, 'stream', guardStream);
  ['createServer', 'createSecureServer'].forEach((key) => {
    const create = http2[key];
    lock(http2, key, (...args) => {
      const server = ReflectApply(create, http2, args);
      PrependListener(server, 'session', guardSession);
      return server;
    });
  });
  if (typeof(http2.performServerHandshake) === 'function') {
    const handshake = http2.performServerHandshake;
    lock(http2, 'performServerHandshake', (...args) => {
      const session = ReflectApply(handshake, http2, args);
      guardSession(session);
      return session;
    });
  }
  HANDLE_PROTOTYPES.forEach((proto) => {
    const open = proto.open;
    lock(proto, 'open', function(...args) {
      adopt('a descriptor (handle open)');
      return ReflectApply(open, this, args);
    });
  });
  // The handle prototypes' connect and connect6 (found reviewing #177):
  // writable, module code could wrap them to swap the port or path that
  // net.Socket.prototype.connect had checked, and reach a denied endpoint or
  // socket path. Locked, and checking the destination themselves (TCP:
  // (req, address, port); Pipe: (req, path)), so a handle given a prototype
  // of its own that calls them is checked too. Every TCP connect ends here
  // with an address, so a name that resolved to a denied loopback endpoint
  // is caught here as well. The arguments are taken as primitives of the
  // types Node passes (anything else is EINVAL: a port object could read as
  // one port for the check and another for the native side), checked with
  // what was taken when this file loaded, and passed on exactly. A refusal
  // is libuv's EACCES, which net reports as the connect's error; reported
  // like the Redis check above. UDP's methods that take a destination are
  // locked as they are (the denial is of Redis over TCP and pipes).
  const uvCode = (want, fallback) => {
    for (const [code, [errName]] of require('util').getSystemErrorMap()) if (errName === want) return code;
    return fallback;
  };
  const UV_EACCES = uvCode('EACCES', -13);
  const UV_EINVAL = uvCode('EINVAL', -22);
  // port -> {ipv4, ipv6}: the denied addresses for that port, in a
  // BlockList (native matching: every spelling of an address is the same)
  const byPort = new Map();
  // every denied endpoint's port has its list from install, a name's too (its
  // addresses come later, denyAddresses): nothing is ever set at call time
  for (const e of endpoints) if (!byPort.has(Number(e.port))) byPort.set(Number(e.port), new BlockList());
  // a port whose later address could not be added: denied whole
  const portsDenied = new Set();
  for (const e of endpoints) {
    if (!(net.isIPv4(e.canonical) || net.isIPv6(e.canonical) || e.loopback)) continue;   // a name: net's check
    const bl = byPort.get(Number(e.port));
    if (e.loopback) {
      bl.addSubnet('127.0.0.0', 8, 'ipv4');
      bl.addAddress('0.0.0.0', 'ipv4');
      bl.addAddress('::1', 'ipv6');
      bl.addAddress('::', 'ipv6');
      bl.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');
      bl.addAddress('::ffff:0.0.0.0', 'ipv6');
    } else if (net.isIPv4(e.canonical)) {
      bl.addAddress(e.canonical, 'ipv4');
      bl.addAddress(`::ffff:${e.canonical}`, 'ipv6');
    } else {
      bl.addAddress(e.canonical, 'ipv6');
    }
  }
  // Addresses the main thread resolved the denied name to later (a refresh,
  // lib/module-sandbox-config.js): added, never removed, so a worker that
  // started before a name resolved, or before it moved, is caught up. Only
  // ever more restrictive; the worker's message handler calls it.
  // A loopback address (a name that resolves to it) adds every loopback
  // spelling, as install does for a loopback endpoint; one that cannot be
  // added denies the whole port.
  const denyAddresses = (addresses, port) => {
    if (!ArrayIsArray(addresses) || typeof(port) !== 'number' || !NumberIsInteger(port)) return;
    const bl = MapGet(byPort, port);
    if (bl === undefined) return;   // not a denied endpoint's port
    for (let i = 0; i < addresses.length; i++) {
      const a = addresses[i];
      if (typeof(a) !== 'string') continue;
      try {
        if (isLoopbackHost(a)) {
          BlockListAddSubnet(bl, socketAddress('127.0.0.0', 'ipv4'), 8);
          BlockListAddAddress(bl, socketAddress('0.0.0.0', 'ipv4'));
          BlockListAddAddress(bl, socketAddress('::1', 'ipv6'));
          BlockListAddAddress(bl, socketAddress('::', 'ipv6'));
          BlockListAddSubnet(bl, socketAddress('::ffff:127.0.0.0', 'ipv6'), 104);
          BlockListAddAddress(bl, socketAddress('::ffff:0.0.0.0', 'ipv6'));
        } else if (NetIsIPv4(a)) {
          BlockListAddAddress(bl, socketAddress(a, 'ipv4'));
          BlockListAddAddress(bl, socketAddress(`::ffff:${a}`, 'ipv6'));
        } else if (NetIsIPv6(a)) {
          BlockListAddAddress(bl, socketAddress(a, 'ipv6'));
        }
      } catch (e) {
        SetAdd(portsDenied, port);
      }
    }
  };
  const tcpGuard = (original, family) => function(req, address, port, ...rest) {
    if (typeof(address) !== 'string' || typeof(port) !== 'number' || !NumberIsInteger(port) || port < 0 || port > 65535) return UV_EINVAL;
    if (SetHas(portsDenied, port)) {
      once('redis', `${address}:${port}`);
      return UV_EACCES;
    }
    const bl = MapGet(byPort, port);
    if (bl !== undefined) {
      let hit;
      // a SocketAddress of the guard's own making (socketAddress), never a
      // string Node would turn into one through Object.prototype; one that
      // cannot be made is refused
      try { hit = ReflectApply(BlockListCheck, bl, [socketAddress(address, family)]); } catch (e) { return UV_EINVAL; }
      if (hit) {
        once('redis', `${address}:${port}`);
        return UV_EACCES;
      }
    }
    return ReflectApply(original, this, [req, address, port, ...rest]);
  };
  const pipeGuard = (original) => function(req, where, ...rest) {
    if (typeof(where) !== 'string') return UV_EINVAL;
    const p = StringStartsWith(where, '\0') ? where : pathResolve(CWD, where);
    if (SetHas(socketPaths, p)) {
      once('redis', p);
      return UV_EACCES;
    }
    return ReflectApply(original, this, [req, where, ...rest]);
  };
  if (HANDLES.TCP != null) {
    if (typeof(HANDLES.TCP.connect) === 'function') lock(HANDLES.TCP, 'connect', tcpGuard(HANDLES.TCP.connect, 'ipv4'));
    if (typeof(HANDLES.TCP.connect6) === 'function') lock(HANDLES.TCP, 'connect6', tcpGuard(HANDLES.TCP.connect6, 'ipv6'));
  }
  if (HANDLES.Pipe != null && typeof(HANDLES.Pipe.connect) === 'function') lock(HANDLES.Pipe, 'connect', pipeGuard(HANDLES.Pipe.connect));
  if (HANDLES.UDP != null) {
    ['connect', 'connect6', 'send', 'send6'].forEach((key) => {
      if (typeof(HANDLES.UDP[key]) === 'function') lock(HANDLES.UDP, key, HANDLES.UDP[key]);
    });
  }

  // Files written by native code, past the broker: diagnostic reports, the
  // compile cache, and source maps (which make Node read .map files).
  const procReport = process.report;
  const writeReport = procReport.writeReport;
  lock(procReport, 'writeReport', (...args) => {
    violate('report', StringCtor(args[0] != null ? args[0] : ''), () => accessDenied('process.report.writeReport', name));
    return ReflectApply(writeReport, procReport, args);
  });
  ['directory', 'filename', 'signal', 'reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException'].forEach((key) => {
    const d = Object.getOwnPropertyDescriptor(procReport, key);
    if (d == null || typeof(d.set) !== 'function') return;
    Object.defineProperty(procReport, key, {get: d.get, enumerable: true, configurable: false, set: (v) => {
      violate('report', key, () => accessDenied(`process.report.${key}`, name));
      ReflectApply(d.set, procReport, [v]);
    }});
  });
  ['enableCompileCache', 'flushCompileCache'].forEach((key) => {
    const original = Module[key];
    if (typeof(original) !== 'function') return;
    lock(Module, key, (...args) => {
      violate('compile-cache', key, () => accessDenied(`module.${key}`, name));
      return ReflectApply(original, Module, args);
    });
  });
  [[process, 'setSourceMapsEnabled'], [Module, 'setSourceMapsSupport']].forEach(([obj, key]) => {
    const original = obj[key];
    if (typeof(original) !== 'function') return;
    lock(obj, key, (...args) => {
      violate('source-maps', key, () => accessDenied(key, name));
      return ReflectApply(original, obj, args);
    });
  });

  // 2. Process controls. process.exit stays: in a worker it ends only this module.
  PROCESS_CONTROLS.forEach((key) => {
    const original = process[key];
    if (typeof(original) !== 'function') return;
    lock(process, key, (...args) => {
      violate(`process.${key}`, key, () => accessDenied(`process.${key}`, name));
      return ReflectApply(original, process, args);
    });
  });

  // 2b. No port through a listing or an async resource (the review of #186,
  // HIGH 1): the worker's port to the main thread, the file bridge's and
  // Node's own are MessagePorts, and holding one would post past the
  // envelope. In audit and enforce alike, like pinPort: nothing a module
  // legitimately does needs a port from these. The runtime runs the
  // callbacks it dispatches from a port in a scope of its own
  // (lib/port-scope.js), so executionAsyncResource() there is not the port;
  // here, every route that still hands out resources leaves ports out.
  // Node's stdio port posts through MessagePort.prototype as well: pinned
  // like the worker's own. And module code never gets the streams that hold
  // it: process.stdout, stderr and stdin, console's, and _rawDebug go to
  // runtime-owned streams whose output reaches the main thread bounded
  // (lib/worker-stdio.js).
  if (STDIO_PORT != null) pinPort(STDIO_PORT);
  if (!isMainThread) workerStdio.installModuleStdio(name);
  ['_getActiveHandles', '_getActiveRequests'].forEach((key) => {
    const original = process[key];
    if (typeof(original) !== 'function') return;
    lock(process, key, (...args) => { return withoutPorts(ReflectApply(original, process, args)); });
  });
  // A port's stand-in, the same object for the same port (code that keys
  // context on the resource still finds its own).
  const standIns = new WeakMap();
  const standIn = (port) => {
    let s = weakGet(standIns, port);
    if (s === undefined) { s = Object.create(null); weakSet(standIns, port, s); }
    return s;
  };
  const executionAsyncResource = asyncHooks.executionAsyncResource;
  lock(asyncHooks, 'executionAsyncResource', () => {
    const r = executionAsyncResource();
    return isPort(r) ? standIn(r) : r;
  });
  const createHook = asyncHooks.createHook;
  lock(asyncHooks, 'createHook', (callbacks) => {
    if (callbacks == null || typeof(callbacks.init) !== 'function') return createHook(callbacks);
    // Node takes the callbacks once, here, and calls each with the hook as
    // `this`: so does the wrapper.
    const init = callbacks.init;
    const wrapped = {init: function(id, type, trigger, resource) { return ReflectApply(init, this, [id, type, trigger, isPort(resource) ? standIn(resource) : resource]); },
      before: callbacks.before, after: callbacks.after, destroy: callbacks.destroy, promiseResolve: callbacks.promiseResolve};
    return createHook(wrapped);
  });

  // 4 (reduced `module`). Served in enforce in place of the real one.
  const REDUCED = Object.freeze({
    builtinModules: Module.builtinModules.slice(),
    isBuiltin:      Module.isBuiltin,
    createRequire:  (from) => {
      let file = null;
      try { file = fromPath(from); } catch (e) { file = null; }
      if (file == null || !inside(file)) {
        violate('require', StringCtor(file != null ? file : from), () => notFound(StringCtor(from)));
      }
      return ReflectApply(ModuleCreateRequire, Module, [file]);
    }
  });
  lock(globalThis, REDUCED_MODULE, REDUCED);
  // The reduced `module`, as the resolve hook below serves it: to require as
  // CommonJS, and to import as an ES module, with its names as named
  // exports. Served as an ES module where it can be, an import never comes
  // through Module._load (whose fourth argument the wrapper below drops:
  // from Node 24.21 the CommonJS translator would load it with no parent,
  // which no hook knew, #406's high review).
  const REDUCED_CJS = 'countinghouse-lockdown:module';
  const REDUCED_ESM = 'countinghouse-lockdown:module-esm';
  // (CommonJS unless the request is an import: a require whose conditions
  // can't be read still gets the object itself)
  const reducedFor = (esm) => (esm ? {url: REDUCED_ESM, format: 'module', shortCircuit: true} : {url: REDUCED_CJS, format: 'commonjs', shortCircuit: true});
  // every name the real `module` exports, so an import of any links: the
  // reduced one's own, and undefined for the rest (a package that imports
  // findPackageJSON behind a feature check still loads)
  const reducedEsmSource = `const m = globalThis[Symbol.for('countinghouse.lockdown.module')];\nexport default m;\n${
    // (every own name of Node's module, enumerable or not: a few are made
    // non-enumerable when they are locked, and an import of one must link)
    [...new Set(ObjectKeys(REDUCED).concat(ReflectOwnKeys(Module).filter((k) => typeof(k) === 'string')))].filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
      .map((k) => `export const ${k} = m.${k};`).join('\n')}\n`;

  const getBuiltinModule = process.getBuiltinModule;
  if (typeof(getBuiltinModule) === 'function') {
    lock(process, 'getBuiltinModule', (id) => {
      // read once, as a string: what is checked is what Node is given
      const given = StringCtor(id);
      const b = bare(given);
      // Node's own answer for an id it does not know is undefined.
      if (isBuiltin(given) && !builtinAllowed(b)) {
        once('builtin', b);
        if (enforce) return undefined;
      }
      if (b === 'module' && enforce) return REDUCED;
      return ReflectApply(getBuiltinModule, process, [given]);
    });
  }

  // 3 and 4. The require boundary and blocked built-ins. Registered through
  // the resolve shim, which below Node 24.15 also runs this hook for
  // require.resolve and createRequire().resolve (lib/resolve-shim.js).
  resolveShim.registerHooks(Module.registerHooks, {
    resolve(specifier, context, nextResolve) {
      const b = bare(specifier);
      const moduleCode = fromModule(context.parentURL);
      // its own scheme, for a re-resolution (which has no parent): never for
      // module code, whose request of it is refused and reported as any other
      if (!moduleCode && (specifier === REDUCED_CJS || specifier === REDUCED_ESM)) return reducedFor(specifier === REDUCED_ESM);
      if (isBuiltin(specifier)) {
        // Blocked for every caller: hooks run on each built-in require, and
        // countinghouse's own worker code took what it needs before lockdown,
        // except the libraries it loads on first use (lib/lazy-require.js),
        // whose first call test/sandbox/40 makes under enforce.
        if (!builtinAllowed(b)) violate('builtin', b, () => notFound(specifier));
        if (moduleCode && SetHas(WATCHED, b)) once('uses', b);
        if (moduleCode && b === 'module' && enforce) {
          return reducedFor(resolveShim.hasCondition(context, 'import'));
        }
        return nextResolve(specifier, context);
      }
      let resolved = null;
      try {
        resolved = nextResolve(specifier, context);
      } catch (e) {
        // The worker's env is the module's declared names only, so NODE_PATH
        // (which lets a bare name reach countinghouse's lib/) is normally not
        // set here and such a require fails on its own. Still report the
        // attempt, and in enforce say why it failed.
        if (moduleCode && e && e.code === 'MODULE_NOT_FOUND' && reachesLib(specifier)) {
          violate('require', specifier, () => notFound(specifier));
        }
        throw e;
      }
      if (moduleCode && typeof(resolved.url) === 'string' &&
          !(StringStartsWith(resolved.url, 'file:') && inside(fileURLToPath(resolved.url)))) {
        const what = StringSlice(StringCtor(specifier), 0, 200);
        violate('require', what, () => notFound(what));
      }
      return resolved;
    },
    load(hookUrl, context, nextLoad) {
      if (hookUrl === REDUCED_CJS) {
        return {format: 'commonjs', shortCircuit: true,
                source: 'module.exports = globalThis[Symbol.for("countinghouse.lockdown.module")];'};
      }
      if (hookUrl === REDUCED_ESM) return {format: 'module', shortCircuit: true, source: reducedEsmSource};
      return nextLoad(hookUrl, context);
    }
  });
  if (opts != null && typeof(opts.beforeLock) === 'function') opts.beforeLock(Module.registerHooks);
  // Below 24.15, Module._resolveFilename is the shim's way in: locked like
  // the routes below under enforce (where the file broker has already
  // wrapped and locked it); under audit nothing is locked, as on 24.15 and
  // later, so a dependency that patches it (module-alias, say) works alike.
  if (enforce) resolveShim.lock();
  // No later hook may run ahead of ours (except the one just handed over).
  ['registerHooks', 'register'].forEach((key) => {
    lock(Module, key, () => {
      violate(`module.${key}`, key, () => accessDenied(`module.${key}`, name));
    });
  });
  // Module._load takes a fourth, internal argument that skips the resolve
  // hooks, where the built-in gate above and the file broker's bound live
  // (shouldSkipModuleHooks; from Node 24.21 also a resolution handed over,
  // `resolved`, and `source` compiled under any filename: #194's review,
  // B1). Module code reaches _load (module.constructor), so in both modes it
  // is a wrapper that forwards exactly (request, parent, isMain), and every
  // load it makes runs the hooks, apart from what Node answers from its own
  // caches. (What the hooks decide for a parent module code forges, or a
  // null one, is #194's.) A gate in the load hook alone would not do: given
  // `resolved`, that hook is shown whatever URL the caller chose. Node's own
  // callers that pass the argument (an imported CommonJS file, from the ESM
  // translators) run the hooks again too, with no parent: the file broker
  // answers such a file by its lasting grant (lib/fs-broker/identity.js),
  // and the hook above its own scheme.
  //
  // One of those caches is answered before any hook: Node's relative-resolve
  // cache, keyed by `${parent.path}\0${request}` (#406's second review). A
  // parent whose path is countinghouse's lib/ and whose filename is the
  // module's own file resolves a request to the module's file and records it
  // under the lib's key, so a runtime file's later require of the same
  // request gets the module's exports, with no hook and no line. A check of
  // the parent can't hold (Node reads its id, path, filename, paths and an
  // internal URL at different moments, through prototypes module code can
  // reach: three reviews of #406), so Node is never handed the caller's
  // parent. The wrapper reads parent.filename once, and gives Node a shadow
  // of its own, frozen, with no prototype and nothing but own data derived
  // from that one string: id and filename, path its directory, paths Node's
  // lookup paths for it, loaded, and Node's own URL for it, computed here
  // (none of it through anything module code can patch: no iterator, no
  // live Map method). The cache key, the URL the hooks see and
  // the resolution then all come from the one filename, so nothing is ever
  // recorded under a directory other than the one that resolves it. (A
  // filename in countinghouse's lib/ still loads as the runtime would: that
  // is #194's P.) A request that is no string, isMain (only Node's own start
  // of the worker uses it, before the lockdown), and a parent with no
  // absolute filename are refused under enforce, with a line; under audit
  // each is reported and the load goes on (see the wrapper below).
  //
  // Node's linkage is not emulated (#406's reviews: that is where the
  // surface was): a required file's module.parent is a data-only stand-in
  // named for the requiring file (set through Node's own accessor, as taken
  // here, when Node calls its load), and the caller's children are not
  // updated. module.parent has been deprecated since Node 14; #194's C
  // hides a runtime Module's parent and children anyway.
  const originalLoad = Module._load;
  const NodeModulePaths = Module._nodeModulePaths;
  const ModulePrototype = Module.prototype;
  // Node's own parent accessor (non-configurable on Module.prototype),
  // called as taken here; not under --pending-deprecation, where it would
  // emit a warning through what module code can patch: there a child's
  // parent is left as Node made it (a frozen shadow)
  const parentAccessor = ObjectGetOwnPropertyDescriptor(ModulePrototype, 'parent');
  // (as the main thread found it, which sees its own command line and whole
  // environment, NODE_OPTIONS included: a worker's env is its declared names
  // only, and its execArgv never has NODE_OPTIONS' flags; lib/module-
  // sandbox-config.js pendingDeprecation)
  const pending = cfg.pendingDeprecation === true;
  const ParentGet = !pending && parentAccessor != null && typeof(parentAccessor.get) === 'function' && typeof(parentAccessor.set) === 'function' ? parentAccessor.get : null;
  const ParentSet = ParentGet != null ? parentAccessor.set : null;
  const dataOf = (o, key) => {
    const d = ObjectGetOwnPropertyDescriptor(o, key);
    return (d != null && ObjectHasOwn(d, 'value')) ? d.value : undefined;
  };
  const defineData = (o, key, value, writable) => ObjectDefineProperty(o, key, {__proto__: null, value, writable, enumerable: true, configurable: writable});
  // each directory's lookup paths, frozen, at most so many kept
  const lookupPaths = new Map();
  const pathsFor = (dir) => {
    let got = MapGet(lookupPaths, dir);
    if (got === undefined) {
      if (MapSize(lookupPaths) >= 256) MapClear(lookupPaths);
      got = ObjectFreeze(ReflectApply(NodeModulePaths, Module, [dir]));
      MapSet(lookupPaths, dir, got);
    }
    return got;
  };
  // Node's own symbol for a parent's URL, found once: a parent Node resolved
  // for, here, before any module code, has it as its one string-valued
  // symbol. Node stores it only when it resolves (never for a request its
  // relative-resolve cache answers), so the probe asks for a request no one
  // has asked for, which does resolve (this file's own name, spelled with
  // its extension: the cached exports, nothing run). With the symbol each
  // shadow is made whole and frozen, and Node writes nothing to it. If the
  // probe finds no such symbol, or Node wrote anything else to the parent,
  // a frozen shadow would break loads on this Node line, and an extensible
  // one could be changed: the lockdown can't guard it, so (as for the other
  // internals it can't guard) it doesn't start under enforce, and audit
  // reports it and leaves shadows extensible (their fields unwritable).
  const urlKey = knownUrlKey != null ? knownUrlKey : (() => {
    const probe = {__proto__: null, id: __filename, filename: __filename, path: __dirname, paths: pathsFor(__dirname), loaded: true};
    const before = ReflectOwnKeys(probe).length;
    // (one install per thread: a worker locks down once, so this request is
    // new when it is made)
    try { ReflectApply(originalLoad, Module, [`./${ReflectApply(PathBasename, path, [__filename])}`, probe, false]); } catch (e) { return null; }
    const keys = ReflectOwnKeys(probe);
    if (keys.length !== before + 1) return null;
    const symbols = ObjectGetOwnPropertySymbols(probe);
    if (symbols.length !== 1) return null;
    const v = dataOf(probe, symbols[0]);
    return (typeof(v) === 'string' && StringStartsWith(v, 'file:')) ? symbols[0] : null;
  })();
  if (urlKey != null) knownUrlKey = urlKey;
  if (urlKey == null) {
    const what = `the parent a load is resolved for under Node ${process.version} (its URL is not stored as this lockdown expects)`;
    if (enforce) throw new Error(`module sandbox: cannot guard ${what}; not starting under enforce`);
    report('unguarded', what);
  }
  const shadows = new Map();
  const isShadow = new WeakSet();
  const shadowFor = (filename) => {
    let shadow = MapGet(shadows, filename);
    if (shadow === undefined) {
      if (MapSize(shadows) >= 1024) MapClear(shadows);
      const dir = ReflectApply(PathDirname, path, [filename]);
      shadow = {__proto__: null};
      defineData(shadow, 'id', filename, false);
      defineData(shadow, 'filename', filename, false);
      defineData(shadow, 'path', dir, false);
      defineData(shadow, 'paths', pathsFor(dir), false);
      defineData(shadow, 'loaded', true, false);
      if (urlKey != null) {
        defineData(shadow, urlKey, pathToFileHref(filename), false);
        ObjectFreeze(shadow);
      }
      MapSet(shadows, filename, shadow);
      WeakSetAdd(isShadow, shadow);
    }
    return shadow;
  };
  // A Module Node made for a shadowed load gets, before its own code runs
  // (Node calls its load right after making it), a parent that is data only:
  // a stand-in made from the same filename (id, filename, path, paths) and
  // its own plain children, never the shadow and never the caller's object,
  // so nothing of the caller's is linked. A parent is still there, as every
  // file required by another has one: `if (!module.parent)`, "am I the main
  // program", stays false, `module.parent.filename` reads, and `new Module(f,
  // module.parent)` can add to its children (#406's re-probe). Held below
  // with _load: a replacement would run inside every load Node makes, the
  // runtime's included, and could compile the module's own file into a
  // Module the runtime asked for (the medium review of d561eb7d).
  const originalModuleLoad = ModulePrototype.load;
  const moduleLoad = function load(filename) {
    if (ParentGet != null) {
      let made = null;
      try { made = ReflectApply(ParentGet, this, []); } catch (e) { made = null; }
      if (made != null && WeakSetHas(isShadow, made)) {
        // (paths: the shadow's own, frozen: nothing is iterated here)
        ReflectApply(ParentSet, this, [{id: made.id, filename: made.filename, path: made.path, paths: made.paths, children: []}]);
      }
    }
    return ReflectApply(originalModuleLoad, this, [filename]);
  };
  const refuse = (request, why) => {
    const shown = typeof(request) === 'string' ? StringSlice(request, 0, 200) : `a ${typeof(request)}`;
    once('require', `${shown} (${why})`);
    throw notFound(shown);
  };
  // (audit only: what has been added to the extensions table, reported)
  let watchExtensions = null;
  // Under audit nothing is refused (audit observes, #406's re-probe): what
  // enforce would refuse is reported, and the load goes on, but never with
  // a parent Node could key on a runtime directory (the medium reviews of
  // 243abf5d and 0fd4a67b): a request that is no string is made one, once;
  // isMain is passed as given; and a parent with no absolute filename, one
  // that is no object, or one whose filename can't be read, is handed to
  // Node as a stand-in, with whatever filename was read (or none), the
  // parent's own lookup paths (read by own data, each a string), and as its
  // path a key no directory has, one per filename (Node keys its
  // relative-resolve cache by it, and resolves by the filename alone). Under
  // enforce each is refused, with the line.
  const said = (request, problem) => {
    if (enforce) refuse(request, problem);
    once('require', `${typeof(request) === 'string' ? StringSlice(request, 0, 200) : `a ${typeof(request)}`} (${problem})`);
  };
  const ownPaths = (parent) => {
    const out = [];
    try {
      const paths = dataOf(parent, 'paths');
      if (!ArrayIsArray(paths)) return ObjectFreeze(out);
      const length = dataOf(paths, 'length');
      for (let i = 0; i < length && i < 256; i++) {
        const p = dataOf(paths, StringCtor(i));
        if (typeof(p) === 'string') ObjectDefineProperty(out, out.length, {__proto__: null, value: p, writable: false, enumerable: true, configurable: false});
      }
    } catch (e) { /* none */ }
    return ObjectFreeze(out);
  };
  const unkeyed = (parent, named) => ({__proto__: null, id: named, filename: named, path: `\u0000countinghouse-unkeyed:${named}`,
    paths: (parent != null && typeof(parent) === 'object') ? ownPaths(parent) : ObjectFreeze([]), loaded: true});
  const load = function _load(request, parent, isMain) {
    if (watchExtensions != null) watchExtensions();
    if (typeof(request) !== 'string') {
      said(request, 'a request that is no string');
      request = StringCtor(request);
    }
    if (isMain) said(request, 'as the main module');
    const main = !enforce && isMain;
    // (no parent: passed as given, null or undefined, as Node tells them apart)
    if (parent == null) return ReflectApply(originalLoad, this, [request, parent, main]);
    if (typeof(parent) !== 'object' && typeof(parent) !== 'function') {
      said(request, 'a parent that is no object');
      return ReflectApply(originalLoad, this, [request, unkeyed(null, ''), main]);
    }
    let filename;
    try { filename = ReflectApply(ReflectGet, Reflect, [parent, 'filename']); } catch (e) {
      said(request, 'a parent whose filename could not be read');
      return ReflectApply(originalLoad, this, [request, unkeyed(parent, ''), main]);
    }
    // (absolute, then normalised: createRequire keeps a filename as given,
    // and the shadow's every field comes from the one normalised string; a
    // relative one Node would hand to the hooks as it is)
    if (typeof(filename) !== 'string' || filename === '' || !ReflectApply(PathIsAbsolute, path, [filename])) {
      said(request, 'a parent with no absolute filename');
      return ReflectApply(originalLoad, this, [request, unkeyed(parent, typeof(filename) === 'string' ? filename : ''), main]);
    }
    return ReflectApply(originalLoad, this, [request, shadowFor(pathResolve(filename)), main]);
  };
  // Locked under enforce. Under audit left replaceable, as _resolveFilename
  // is above, so a dependency that patches it (proxyquire, an APM hook)
  // still works, and the original is only in this closure, so whatever
  // replaces it can only call the wrapper; but each replacement is reported
  // (an accessor whose setter says so; one made by defineProperty goes past
  // it: audit observes, it doesn't confine), since it decides every later
  // load in the worker, the runtime's own lazy ones included (#194's
  // must-preload list removes those). _resolveFilename, which decides what a
  // load resolves to, is held the same way.
  const held = (target, key, value, name) => {
    if (enforce) {
      // (enumerable as it was: Node finds a file by the extensions it lists)
      const d = ObjectGetOwnPropertyDescriptor(target, key);
      if (d == null || d.configurable === true) {
        ObjectDefineProperty(target, key, {__proto__: null, value, writable: false, configurable: false, enumerable: d != null && d.enumerable === true});
      }
      return;
    }
    let current = value;
    let replaced = 0;
    ObjectDefineProperty(target, key, {__proto__: null, enumerable: true, configurable: true,
      get: () => current,
      // (an assignment on another object that inherits it, `someModule.load
      // = fn` say, is that object's own, as it would be without the accessor)
      set: function(fn) {
        if (this !== target) {
          // (where that can't be, as a plain assignment would quietly not be)
          try { ObjectDefineProperty(this, key, {__proto__: null, value: fn, writable: true, enumerable: true, configurable: true}); } catch (e) { /* not set */ }
          return;
        }
        replaced += 1;
        once('require', `${name} replaced${replaced > 1 ? ` (${replaced})` : ''}`);
        current = fn;
      }});
  };
  held(Module, '_load', load, '_load');
  held(Module, '_resolveFilename', Module._resolveFilename, '_resolveFilename');
  held(ModulePrototype, 'load', moduleLoad, 'Module.prototype.load');
  // the handlers that compile what a load reads, by the same route ('.node'
  // is locked above, with the native loader), and the table itself: Node
  // picks the longest extension a filename ends in, so a new one ('.min.js')
  // would take over a file the runtime asks for. Under enforce the table
  // takes no new extension and the property is locked; under audit an added
  // extension, or another table, is reported at the next load.
  const extensions = Module._extensions;
  const installedExtensions = ReflectOwnKeys(extensions);
  for (let i = 0; i < installedExtensions.length; i++) {
    const ext = installedExtensions[i];
    if (ext !== '.node' && typeof(dataOf(extensions, ext)) === 'function') held(extensions, ext, dataOf(extensions, ext), `Module._extensions['${StringCtor(ext)}']`);
  }
  const knownExtensions = new Set(installedExtensions);
  if (enforce) {
    ObjectPreventExtensions(extensions);
    lock(Module, '_extensions', extensions);
  } else {
    // (read by descriptor and captured helpers, never through what module
    // code could make throw or run; the keys listed only when their count
    // has changed)
    // (every load, the table installed now as well as the original: a few
    // keys, by index)
    const added = (table) => {
      const keys = ReflectOwnKeys(table);
      for (let i = 0; i < keys.length; i++) {
        if (!SetHas(knownExtensions, keys[i])) once('require', `Module._extensions[${StringCtor(keys[i])}] added`);
      }
    };
    watchExtensions = () => {
      try {
        const now = dataOf(Module, '_extensions');
        if (now !== extensions) {
          once('require', 'Module._extensions replaced');
          if (now != null && typeof(now) === 'object') added(now);
        }
        added(extensions);
      } catch (e) { /* nothing to report by */ }
    };
  }
  // Node's path cache, keyed by a request and the directories it is looked
  // up in, is the same kind of cache, and a plain object module code could
  // write an entry into for the runtime's first resolve of a name (the
  // medium review of d561eb7d; #194's revision 5, B3): it reads as empty and
  // drops every write, never answering false to Node. Locked in both modes:
  // nothing but Node itself uses it.
  const emptyPathCache = new Proxy({__proto__: null}, {__proto__: null,
    get: () => undefined, has: () => false, set: () => true, defineProperty: () => true, deleteProperty: () => true,
    getOwnPropertyDescriptor: () => undefined, ownKeys: () => []});
  lock(Module, '_pathCache', emptyPathCache);

  // The error class a module reaches through any error it is given
  // (e.constructor): its statics are how the runtime answers and encodes a
  // handler's failure (answerable, replyFields, fromModule, ...), and the
  // catalogue's getters say what a code means. Frozen (the prototype
  // non-extensible, its getters fixed, review of #45), so a module cannot
  // replace them in its worker to pass a catalogue code off as the
  // runtime's (d2b; the brand itself, lib/countinghouse-error.js ISSUED, is
  // private to that file).
  const {CountinghouseError} = errorsModule;
  ['kind', 'retryable', 'httpStatus', 'mcpCode'].forEach((key) => {
    const d = Object.getOwnPropertyDescriptor(CountinghouseError.prototype, key);
    if (d != null && d.configurable === true) Object.defineProperty(CountinghouseError.prototype, key, {get: d.get, enumerable: d.enumerable, configurable: false});
  });
  Object.preventExtensions(CountinghouseError.prototype);
  Object.freeze(CountinghouseError);
  // issue(), which brands an error as the runtime's, leaves the exports a
  // module can reach (require.cache holds this very object): the runtime
  // files that issue took it when they loaded, handler-ctx.js among them,
  // loaded with this file (above) so it has (the high review of #45: a
  // module found it through require.cache, under enforce too).
  delete errorsModule.issue;

  // 5. CHUtil's own routes out (global in every worker, lib/lean-worker.js).
  const CHUtil = global.CHUtil;
  if (CHUtil != null) {
    const loadFile = CHUtil.loadFile;
    lock(CHUtil, 'loadFile', (file) => {
      // resolved once, and that path both checked and read
      const resolved = pathResolve(StringCtor(file));
      if (!inside(resolved)) violate('loadFile', resolved, () => notFound(resolved));
      return ReflectApply(loadFile, CHUtil, [resolved]);
    });
    // Reports (and in enforce refuses) one URL. Returns an error to refuse.
    const checkHref = (href) => {
      const parsed = hostPort(href);
      const host = parsed != null ? parsed.host : null;
      const port = parsed != null ? parsed.port : null;
      if (host == null || !hostAllowed(cfg.net, host, port)) {
        once('net', `${host}:${port}`);
        if (enforce) return accessDenied(`network access to ${host}:${port}`, name);
      }
      return null;
    };
    const request = CHUtil.request;
    lock(CHUtil, 'request', (opts, callback) => {
      // Normalised in both modes so the audit log sees what enforce would
      // refuse; only enforce hands the normalised options on.
      const result = normaliseRequestOptions(opts, cfg.net, (target) => once('net', target));
      if (result.refusal != null) {
        once('net', result.refusal);
        if (enforce) {
          const denied = accessDenied(`network access to ${result.refusal}`, name);
          return ReflectApply(ProcessNextTick, process, [() => callback(denied)]);
        }
        return ReflectApply(request, CHUtil, [opts, callback]);
      }
      return ReflectApply(request, CHUtil, [enforce ? result.options : opts, callback]);
    });
  }
  return {denyAddresses: denyAddresses};
}

// HANDLE_CAPTURE: for the tests, which build the same handles as a module
// would, so a Node change to how a handle is taken needs one edit.
// The allowed list as a frozen array: the Set the checks read is this
// file's own, never handed out (an export is reachable through the require
// cache, and a Set's add or delete cannot be frozen away).
const ALLOWED_BUILTIN_IDS = Object.freeze(Array.from(ALLOWED_BUILTINS));
module.exports = {install, normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTIN_IDS,
  HANDLE_CAPTURE: {fromSocket, fromDgram, CAPTURE}};
