// Worker side of the module sandbox: runs once, on set-options, before any
// module code loads (lib/sandbox.js). Design: docs/superpowers/specs/
// 2026-10-15-module-sandbox-foundation-design.md, section 3.
//
// In enforce a violation throws the error Node itself would throw; in audit it
// is reported and the original runs. Either way report() hears about it once.
//
// This is a barrier inside the same process, not a boundary: see the spec's
// "What this can and cannot promise".
const Module = require('module');
const path   = require('path');
const url    = require('url');

const modulePermissions = require('./module-permissions');

// The built-ins module code may load, written out from Node 24.21's
// builtinModules. A literal on purpose: a built-in a later Node adds is
// refused until someone has read it. Left out: child_process, cluster,
// worker_threads (new processes and threads outside every check),
// inspector, inspector/promises, v8 (the debugger and heap internals), wasi,
// sqlite (loadExtension dlopens), test and test/reporters (run() spawns
// unsandboxed child processes), and sea. Node 26's ffi (calls native code) is
// not on it either, so it is refused like every built-in a later Node adds.
// Nor are _tls_wrap and _tls_common: a module needs tls, not the internals
// behind it.
const ALLOWED_BUILTINS = new Set([
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap',
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

function bare(specifier) {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

// id: a specifier Node reports as built-in, with or without node:.
function builtinAllowed(id) {
  return ALLOWED_BUILTINS.has(bare(String(id)));
}

function accessDenied(what, moduleName) {
  const err = new Error(`${what} is not allowed for module ${moduleName} ${SANDBOX_TAG}`);
  err.code = 'ERR_ACCESS_DENIED';
  return err;
}

function notFound(specifier) {
  const err = new Error(`Cannot find module '${specifier}' ${SANDBOX_TAG}`);
  err.code = 'MODULE_NOT_FOUND';
  return err;
}

// True when a bare specifier names a file in countinghouse's own lib/, the
// route NODE_PATH=lib would open.
function reachesLib(specifier) {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) return false;
  if (specifier.split(/[\\/]/).includes('..')) return false;
  try {
    require.resolve(path.join(__dirname, specifier));
    return true;
  } catch (e) {
    return false;
  }
}

// 'host:port' of an absolute URL string, or null when it is not one.
function hostPort(href) {
  try {
    const u = new URL(href);
    return {host: u.hostname, port: u.port !== '' ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80), href: u.href};
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
  // Read each value once, into the copy that is checked and then used.
  const options = {};
  for (const key of Object.keys(given)) {
    const value = given[key];
    if (value === undefined) continue;
    if (!REQUEST_OPTIONS.has(key)) return refuse(key);
    options[key] = value;
  }
  let target = options.uri != null ? options.uri : options.url;
  if (target != null && typeof(target) === 'object') target = target.href;
  if (typeof(target) !== 'string') return refuse('invalid');
  const parsed = hostPort(target);
  if (parsed == null) return refuse('invalid');
  if (!modulePermissions.hostAllowed(net, parsed.host, parsed.port)) return refuse(`${parsed.host}:${parsed.port}`);

  delete options.url;
  options.uri   = parsed.href;
  options.proxy = null;
  if (options.followRedirect !== false) {
    const original = options.followRedirect;
    // postman-request calls followRedirect with the request as `this`.
    options.followRedirect = function(response) {
      const location = response != null && response.headers != null ? response.headers.location : null;
      let next = null;
      try { next = hostPort(new URL(location, this.uri.href).href); } catch (e) { next = null; }
      if (next == null || !modulePermissions.hostAllowed(net, next.host, next.port)) {
        onRedirectDenied(next != null ? `${next.host}:${next.port}` : 'invalid');
        return false;
      }
      return typeof(original) === 'function' ? original.call(this, response) : true;
    };
  }
  return {refusal: null, options: options};
}

function lock(obj, key, value) {
  Object.defineProperty(obj, key, {value: value, writable: false, configurable: false, enumerable: false});
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

function install(cfg, report, opts) {
  const enforce = (cfg.mode === 'enforce');
  const name    = cfg.moduleName;
  const root    = path.resolve(cfg.moduleRoot);
  const seen    = new Set();

  const once = (rule, target) => {
    const key = `${rule}\0${target}`;
    if (seen.has(key)) return;
    // A module in a loop could otherwise flood the main thread with distinct
    // targets: past the cap, say so once and go quiet.
    if (seen.size > MAX_REPORTS) return;
    seen.add(key);
    if (seen.size > MAX_REPORTS) return report('suppressed', '');
    report(rule, target);
  };
  const violate = (rule, target, makeError) => {
    once(rule, target);
    if (enforce) throw makeError();
  };
  const unguarded = [];
  if (UNGUARDED_HANDLES.length > 0) unguarded.push(`open(fd) on the ${UNGUARDED_HANDLES.join(' and ')} handle`);
  if (NORMALIZED == null) unguarded.push('the connect arguments net.connect normalises');
  if (unguarded.length > 0) {
    const what = `${unguarded.join(' and ')} under Node ${process.version}`;
    if (enforce) throw new Error(`module sandbox: cannot guard ${what}; not starting under enforce`);
    // The lockdown's own state, not something the module did.
    report('unguarded', what);
  }
  // Under the file broker a module names its own files /app/...
  const hostOf = (file) => ((cfg.virtualRoot != null && (file === cfg.virtualRoot || file.startsWith(`${cfg.virtualRoot}/`)))
    ? root + file.slice(cfg.virtualRoot.length) : file);
  const inside = (file) => { const h = hostOf(file); return h === root || h.startsWith(root + path.sep); };
  // Module code is a file inside the module root, or anything that is not a
  // file at all (a data: module a module imported has no location of its own
  // and must not become a way out). An undefined parent is the entry point.
  const fromModule = (parentURL) => {
    if (typeof(parentURL) !== 'string') return false;
    if (!parentURL.startsWith('file:')) return !parentURL.startsWith('node:');
    try { return inside(url.fileURLToPath(parentURL)); } catch (e) { return false; }
  };
  const fromPath = (from) => {
    if (from instanceof URL) return url.fileURLToPath(from);
    if (typeof(from) === 'string' && from.startsWith('file:')) return url.fileURLToPath(from);
    // path.resolve drops a trailing separator, which createRequire reads as
    // "this is a directory".
    const resolved = path.resolve(String(from));
    return /[\\/]$/.test(String(from)) && !resolved.endsWith(path.sep) ? resolved + path.sep : resolved;
  };

  // 1. Native code.
  const dlopen = process.dlopen;
  lock(process, 'dlopen', (mod, filename, ...rest) => {
    violate('native', String(filename), () => accessDenied('loading native code', name));
    return dlopen.call(process, mod, filename, ...rest);
  });
  const nodeLoader = Module._extensions['.node'];
  Module._extensions['.node'] = function(mod, filename) {
    violate('native', String(filename), () => accessDenied('loading native code', name));
    return nodeLoader.apply(this, arguments);
  };
  Object.defineProperty(Module._extensions, '.node', {writable: false, configurable: false});
  ['binding', '_linkedBinding'].forEach((key) => {
    const original = process[key];
    lock(process, key, (id, ...rest) => {
      violate(`process.${key}`, String(id), () => accessDenied(`process.${key}`, name));
      return original.call(process, id, ...rest);
    });
  });

  // OpenSSL engines are shared libraries too: crypto.setEngine and the TLS
  // options privateKeyEngine and clientCertEngine load them. The TLS options
  // end in two methods of the native SecureContext prototype, which every
  // context shares; it is reached through a throwaway context, so nothing
  // becomes reachable that module code could not already reach the same way.
  const crypto = require('crypto');
  const setEngine = crypto.setEngine;
  lock(crypto, 'setEngine', (id, ...rest) => {
    violate('native', `engine ${String(id)}`, () => accessDenied('loading an OpenSSL engine', name));
    return setEngine.call(crypto, id, ...rest);
  });
  const contextProto = Object.getPrototypeOf(require('tls').createSecureContext().context);
  ['setEngineKey', 'setClientCertEngine'].forEach((key) => {
    const original = contextProto[key];
    if (typeof(original) !== 'function') return;
    lock(contextProto, key, function(...args) {
      violate('native', `engine ${String(args[args.length - 1])}`, () => accessDenied('loading an OpenSSL engine', name));
      return original.apply(this, args);
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
  const copyOf = (o) => {
    if (o == null || typeof(o) !== 'object' || copies.has(o)) return o;
    const copy = {};
    for (const key of Object.keys(o)) copy[key] = o[key];
    copies.add(copy);
    return copy;
  };
  // The marker a normalised array carries, or null. Without NORMALIZED
  // (install has then reported it as unguarded, and refused under enforce),
  // a symbol under Node's description.
  const markerOf = (a) => {
    if (!Array.isArray(a)) return null;
    if (NORMALIZED != null) return (a[NORMALIZED] === true) ? NORMALIZED : null;
    return Object.getOwnPropertySymbols(a).find((k) => k.description === 'normalizedArgs' && a[k] === true) || null;
  };
  const copyArgs = (args) => {
    if (args.length === 0) return args;
    let first = args[0];
    const marker = markerOf(first);
    if (marker != null) {
      const copy = Array.prototype.slice.call(first);
      copy[0] = copyOf(copy[0]);
      copy[marker] = true;
      first = copy;
    } else {
      first = copyOf(first);
    }
    return [first].concat(Array.prototype.slice.call(args, 1));
  };
  // After copyArgs, an array is a normalised one.
  const optionsOf = (args) => (Array.isArray(args[0]) ? args[0][0] : args[0]);
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
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, self, args) {
      args = copyArgs(args);
      if (adoptsFd(args[0])) adopt('a descriptor (net.Socket)');
      return Reflect.apply(target, self, args);
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
    return netConnect.apply(this, args);
  };
  lock(net, 'connect', guardedConnect);
  lock(net, 'createConnection', guardedConnect);
  // The Redis endpoint (R2-1, the always-denied set): EACCES in audit and
  // enforce alike, and recorded. One wrap on Socket.prototype.connect covers
  // net.connect and createConnection, a raw Socket, a TLSSocket (it connects
  // through it) and http(s) over a socketPath (the agent's createConnection).
  // tls.connect dials through it with the options as _tls_wrap merged them,
  // and given a socket dials nothing, so it has no check of its own (L1
  // round 4: a second reading of its arguments refused tls.connect(port,
  // {host}) as localhost). A refused socket that already has a handle (a
  // TLSSocket's) is destroyed, so the handle does not outlive the call. A
  // loopback Redis is denied under every loopback literal and name
  // (isLoopback). An in-worker check, not a boundary, until the network
  // broker (sandbox parts 3 and 4) moves connections to the main thread.
  const denied = (cfg.denied != null) ? cfg.denied : {endpoints: [], socketPaths: []};
  // Loopback: an IPv4 literal in 127/8 or 0.0.0.0 in every form getaddrinfo
  // takes (127.1, 0x7f.1, 2130706433; WHATWG's host parser reads them the
  // same way), ::1 and :: however written, the IPv4-mapped and
  // IPv4-compatible forms of those IPv4 ones, and the loopback names. A name that reaches loopback only through /etc/hosts or
  // DNS, or through a lookup function the module passes, is not caught
  // until the network broker.
  const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
  // A host as it will be connected to: an empty one is localhost (Node's own
  // default), a literal address in its one canonical spelling (so 10.5 is
  // 10.0.0.5 and fd00:0:0::5 is fd00::5; an IPv4-mapped or IPv4-compatible
  // address is its IPv4 one, so ::ffff:a00:5 and ::10.0.0.5 are 10.0.0.5),
  // a name lower-cased without its trailing dot.
  const canonicalHost = (host) => {
    let h = String(host || 'localhost').toLowerCase().replace(/%.*$/, '');
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (net.isIPv6(h)) {
      const v6 = new URL(`http://[${h}]/`).hostname.slice(1, -1);
      const v4 = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
      if (v4 == null) return v6;
      const high = parseInt(v4[1], 16), low = parseInt(v4[2], 16);
      return [high >> 8, high & 255, low >> 8, low & 255].join('.');
    }
    let parsed = null;
    try { parsed = new URL(`http://${h}/`).hostname; } catch (e) { /* not a host a URL can carry */ }
    if (parsed != null && net.isIPv4(parsed)) return parsed;
    return h.endsWith('.') ? h.slice(0, -1) : h;
  };
  const isLoopback = (canonical) => {
    if (net.isIPv4(canonical)) return canonical === '0.0.0.0' || canonical.startsWith('127.');
    if (net.isIPv6(canonical)) return canonical === '::1' || canonical === '::';
    return LOOPBACK_NAMES.has(canonical) || canonical.endsWith('.localhost');
  };
  // Each denied endpoint's host, canonical and whether it is loopback, once.
  const endpoints = denied.endpoints.map((e) => {
    const canonical = canonicalHost(e.host);
    return {port: e.port, canonical: canonical, loopback: isLoopback(canonical)};
  });
  const anyLoopback = endpoints.some((e) => e.loopback);
  // A socket path as the connect reaches it: a relative one from the
  // process's directory, with . , .. and // resolved. An abstract (Linux)
  // name is left as it is. A symlink or hard link to the socket is not
  // caught until the network broker.
  const socketPathOf = (p) => (p.startsWith('\0') ? p : path.resolve(CWD, p));
  const socketPaths = new Set(denied.socketPaths.map((p) => socketPathOf(String(p))));
  const endpointOf = (args) => {
    const a = optionsOf(args);   // net.connect hands its normalised [options, cb] on
    if (a != null && typeof(a) === 'object') return {host: a.host, port: a.port, path: a.path};
    // Node's isPipeName: a string is a path unless it reads as a number
    // (0x18eb, ' 6379' and 6.379e3 are all port 6379).
    if (typeof(a) === 'string' && !(Number(a) >= 0)) return {path: a};
    return {port: a, host: typeof(args[1]) === 'string' ? args[1] : undefined};
  };
  const deniedTarget = (t) => {
    if (t.path) {   // Node: a pipe when path is truthy
      const p = socketPathOf(String(t.path));
      return socketPaths.has(p) ? p : null;
    }
    const host = canonicalHost(t.host);
    const port = Number(t.port);
    const loopback = anyLoopback && isLoopback(host);
    return endpoints.some((e) => e.port === port && (host === e.canonical || (e.loopback && loopback))) ? `${host}:${port}` : null;
  };
  const refuseDenied = (socket, args) => {
    const target = deniedTarget(endpointOf(args));
    if (target == null) return;
    once('redis', target);
    if (socket._handle != null) socket.destroy();
    const err = accessDenied(`a connection to the Redis endpoint ${target}`, name);
    err.code = 'EACCES';
    throw err;
  };
  const socketConnect = net.Socket.prototype.connect;
  lock(net.Socket.prototype, 'connect', function(...args) {
    args = copyArgs(args);
    refuseDenied(this, args);
    return socketConnect.apply(this, args);
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
  const isListenHandle = (o) => o != null && typeof(o) === 'object' &&
    HANDLE_PROTOTYPES.some((p) => Object.prototype.isPrototypeOf.call(p, o));
  lock(net.Server.prototype, 'listen', function(...args) {
    const handle = isListenHandle(args[0]);
    if (!handle) args = copyArgs(args);
    if (handle || fdOrHandle(args[0])) adopt('a descriptor or handle (server.listen)');
    return listen.apply(this, args);
  });
  const dgram = require('dgram');
  const bind = dgram.Socket.prototype.bind;
  lock(dgram.Socket.prototype, 'bind', function(...args) {
    args = copyArgs(args);
    if (hasFd(args[0])) adopt('a descriptor (dgram bind)');
    return bind.apply(this, args);
  });
  // tty builds its handle from the fd itself, with no open(fd), so no
  // backstop sees a real constructor: prototype.constructor is the guard too.
  ['ReadStream', 'WriteStream'].forEach((key) => {
    const guarded = new Proxy(tty[key], {
      construct(target, args, newTarget) { adopt(`a descriptor (tty.${key})`); return Reflect.construct(target, args, newTarget); },
      apply(target, self, args) { adopt(`a descriptor (tty.${key})`); return Reflect.apply(target, self, args); }
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
    const proto = Object.getPrototypeOf(stream);
    if (streamGuarded || proto == null || typeof(proto.respondWithFD) !== 'function') return;
    const respondWithFD = proto.respondWithFD;
    lock(proto, 'respondWithFD', function(...args) {
      adopt('a descriptor (http2 respondWithFD)');
      return respondWithFD.apply(this, args);
    });
    streamGuarded = true;
  };
  const guardSession = (session) => session.prependListener('stream', guardStream);
  ['createServer', 'createSecureServer'].forEach((key) => {
    const create = http2[key];
    lock(http2, key, (...args) => {
      const server = create.apply(http2, args);
      server.prependListener('session', guardSession);
      return server;
    });
  });
  if (typeof(http2.performServerHandshake) === 'function') {
    const handshake = http2.performServerHandshake;
    lock(http2, 'performServerHandshake', (...args) => {
      const session = handshake.apply(http2, args);
      guardSession(session);
      return session;
    });
  }
  HANDLE_PROTOTYPES.forEach((proto) => {
    const open = proto.open;
    lock(proto, 'open', function(...args) {
      adopt('a descriptor (handle open)');
      return open.apply(this, args);
    });
  });

  // Files written by native code, past the broker: diagnostic reports, the
  // compile cache, and source maps (which make Node read .map files).
  const procReport = process.report;
  const writeReport = procReport.writeReport;
  lock(procReport, 'writeReport', (...args) => {
    violate('report', String(args[0] != null ? args[0] : ''), () => accessDenied('process.report.writeReport', name));
    return writeReport.apply(procReport, args);
  });
  ['directory', 'filename', 'signal', 'reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException'].forEach((key) => {
    const d = Object.getOwnPropertyDescriptor(procReport, key);
    if (d == null || typeof(d.set) !== 'function') return;
    Object.defineProperty(procReport, key, {get: d.get, enumerable: true, configurable: false, set: (v) => {
      violate('report', key, () => accessDenied(`process.report.${key}`, name));
      d.set.call(procReport, v);
    }});
  });
  ['enableCompileCache', 'flushCompileCache'].forEach((key) => {
    const original = Module[key];
    if (typeof(original) !== 'function') return;
    lock(Module, key, (...args) => {
      violate('compile-cache', key, () => accessDenied(`module.${key}`, name));
      return original.apply(Module, args);
    });
  });
  [[process, 'setSourceMapsEnabled'], [Module, 'setSourceMapsSupport']].forEach(([obj, key]) => {
    const original = obj[key];
    if (typeof(original) !== 'function') return;
    lock(obj, key, (...args) => {
      violate('source-maps', key, () => accessDenied(key, name));
      return original.apply(obj, args);
    });
  });

  // 2. Process controls. process.exit stays: in a worker it ends only this module.
  PROCESS_CONTROLS.forEach((key) => {
    const original = process[key];
    if (typeof(original) !== 'function') return;
    lock(process, key, (...args) => {
      violate(`process.${key}`, key, () => accessDenied(`process.${key}`, name));
      return original.apply(process, args);
    });
  });

  // 4 (reduced `module`). Served in enforce in place of the real one.
  lock(globalThis, REDUCED_MODULE, Object.freeze({
    builtinModules: Module.builtinModules.slice(),
    isBuiltin:      Module.isBuiltin,
    createRequire:  (from) => {
      let file = null;
      try { file = fromPath(from); } catch (e) { file = null; }
      if (file == null || !inside(file)) {
        violate('require', String(file != null ? file : from), () => notFound(String(from)));
      }
      return Module.createRequire(file);
    }
  }));

  const getBuiltinModule = process.getBuiltinModule;
  if (typeof(getBuiltinModule) === 'function') {
    lock(process, 'getBuiltinModule', (id) => {
      const b = bare(String(id));
      // Node's own answer for an id it does not know is undefined.
      if (Module.isBuiltin(String(id)) && !builtinAllowed(b)) {
        once('builtin', b);
        if (enforce) return undefined;
      }
      if (b === 'module' && enforce) return globalThis[REDUCED_MODULE];
      return getBuiltinModule.call(process, id);
    });
  }

  // 3 and 4. The require boundary and blocked built-ins.
  Module.registerHooks({
    resolve(specifier, context, nextResolve) {
      const b = bare(specifier);
      const moduleCode = fromModule(context.parentURL);
      if (Module.isBuiltin(specifier)) {
        // Blocked for every caller: hooks run on each built-in require, and
        // countinghouse's own worker code took what it needs before lockdown.
        if (!builtinAllowed(b)) violate('builtin', b, () => notFound(specifier));
        if (moduleCode && WATCHED.has(b)) once('uses', b);
        if (moduleCode && b === 'module' && enforce) {
          return {url: 'countinghouse-lockdown:module', format: 'commonjs', shortCircuit: true};
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
          !(resolved.url.startsWith('file:') && inside(url.fileURLToPath(resolved.url)))) {
        violate('require', specifier.slice(0, 200), () => notFound(specifier.slice(0, 200)));
      }
      return resolved;
    },
    load(hookUrl, context, nextLoad) {
      if (hookUrl === 'countinghouse-lockdown:module') {
        return {format: 'commonjs', shortCircuit: true,
                source: 'module.exports = globalThis[Symbol.for("countinghouse.lockdown.module")];'};
      }
      return nextLoad(hookUrl, context);
    }
  });
  if (opts != null && typeof(opts.beforeLock) === 'function') opts.beforeLock(Module.registerHooks);
  // No later hook may run ahead of ours (except the one just handed over).
  ['registerHooks', 'register'].forEach((key) => {
    lock(Module, key, () => {
      violate(`module.${key}`, key, () => accessDenied(`module.${key}`, name));
    });
  });

  // 5. CHUtil's own routes out (global in every worker, lib/sandbox.js).
  const CHUtil = global.CHUtil;
  if (CHUtil != null) {
    const loadFile = CHUtil.loadFile;
    lock(CHUtil, 'loadFile', (file) => {
      const resolved = path.resolve(String(file));
      if (!inside(resolved)) violate('loadFile', resolved, () => notFound(resolved));
      return loadFile.call(CHUtil, file);
    });
    // Reports (and in enforce refuses) one URL. Returns an error to refuse.
    const checkHref = (href) => {
      let host = null;
      let port = null;
      try {
        const u = new URL(href);
        host = u.hostname;
        port = u.port !== '' ? parseInt(u.port) : (u.protocol === 'https:' ? 443 : 80);
      } catch (e) {
        host = null;
      }
      if (host == null || !modulePermissions.hostAllowed(cfg.net, host, port)) {
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
          return process.nextTick(() => callback(denied));
        }
        return request.call(CHUtil, opts, callback);
      }
      return request.call(CHUtil, enforce ? result.options : opts, callback);
    });
    const createSOAPClient = CHUtil.createSOAPClient;
    lock(CHUtil, 'createSOAPClient', (target, opts, callback) => {
      let denied = checkHref(String(target));
      if (denied == null && opts != null && opts.endpoint != null) denied = checkHref(String(opts.endpoint));
      if (denied != null) return process.nextTick(() => callback(denied));
      return createSOAPClient.call(CHUtil, target, opts, callback);
    });
  }
}

// HANDLE_CAPTURE: for the tests, which build the same handles as a module
// would, so a Node change to how a handle is taken needs one edit.
module.exports = {install, normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTINS,
  HANDLE_CAPTURE: {fromSocket, fromDgram, CAPTURE}};
