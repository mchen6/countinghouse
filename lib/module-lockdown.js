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
const ALLOWED_BUILTINS = new Set([
  '_http_agent', '_http_client', '_http_common', '_http_incoming', '_http_outgoing', '_http_server',
  '_stream_duplex', '_stream_passthrough', '_stream_readable', '_stream_transform', '_stream_wrap',
  '_stream_writable', '_tls_common', '_tls_wrap', 'assert', 'assert/strict', 'async_hooks', 'buffer',
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
// --permission it may refuse: then the public entry points' checks alone apply.
const HANDLE_PROTOTYPES = [['tcp_wrap', 'TCP'], ['pipe_wrap', 'Pipe'], ['udp_wrap', 'UDP']].map(([b, c]) => {
  try { return process.binding(b)[c].prototype; } catch (e) { return null; }
}).filter((p) => p != null && typeof(p.open) === 'function');

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
  const fdOrHandle = (o) => o != null && typeof(o) === 'object' && (o.fd != null || o.handle != null || o._handle != null);
  const net = require('net');
  const guardedSocket = new Proxy(net.Socket, {
    construct(target, args, newTarget) {
      if (fdOrHandle(args[0])) adopt('a descriptor or handle (net.Socket)');
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, self, args) {
      if (fdOrHandle(args[0])) adopt('a descriptor or handle (net.Socket)');
      return Reflect.apply(target, self, args);
    }
  });
  lock(net, 'Socket', guardedSocket);
  lock(net, 'Stream', guardedSocket);
  // The Redis endpoint (R2-1, the always-denied set): EACCES in audit and
  // enforce alike, and recorded. One wrap on Socket.prototype.connect covers
  // net.connect and createConnection, a raw Socket, a TLSSocket (it connects
  // through it) and http(s) over a socketPath (the agent's createConnection).
  // tls.connect is checked at its entry as well: it builds its TLSSocket
  // over a fresh handle before connecting, and under enforce the descriptor
  // backstop above answers for that handle first; checked here, the Redis
  // denial is what a TLS connection gets in both modes. A loopback Redis is
  // denied under every loopback name. An in-worker check, not a boundary,
  // until the network broker (sandbox parts 3 and 4) moves connections to
  // the main thread.
  const denied = (cfg.denied != null) ? cfg.denied : {endpoints: [], socketPaths: []};
  const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::']);
  const sameHost = (a, b) => a === b || (LOOPBACK.has(a) && LOOPBACK.has(b));
  const endpointOf = (args) => {
    let a = args[0];
    if (Array.isArray(a)) a = a[0];   // net.connect hands its normalised [options, cb] on
    if (a != null && typeof(a) === 'object') return {host: a.host, port: a.port, path: a.path};
    if (typeof(a) === 'string' && !/^\d+$/.test(a)) return {path: a};
    return {port: a, host: typeof(args[1]) === 'string' ? args[1] : undefined};
  };
  const deniedTarget = (t) => {
    if (t.path != null) return denied.socketPaths.includes(String(t.path)) ? String(t.path) : null;
    const host = String(t.host != null ? t.host : 'localhost').toLowerCase();
    const port = Number(t.port);
    return denied.endpoints.some((e) => e.port === port && sameHost(host, e.host)) ? `${host}:${port}` : null;
  };
  const refuseDenied = (args) => {
    const target = deniedTarget(endpointOf(args));
    if (target == null) return;
    once('redis', target);
    const err = accessDenied(`a connection to the Redis endpoint ${target}`, name);
    err.code = 'EACCES';
    throw err;
  };
  const socketConnect = net.Socket.prototype.connect;
  lock(net.Socket.prototype, 'connect', function(...args) {
    refuseDenied(args);
    return socketConnect.apply(this, args);
  });
  const tls = require('tls');
  const tlsConnect = tls.connect;
  lock(tls, 'connect', function(...args) {
    refuseDenied(args);
    return tlsConnect.apply(this, args);
  });
  // http, https, http2 and tls servers inherit this listen.
  const listen = net.Server.prototype.listen;
  lock(net.Server.prototype, 'listen', function(...args) {
    const a = args[0];
    // A handle object is not a plain options object (listen(handle)).
    const handleObject = a != null && typeof(a) === 'object' && !Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype;
    if (fdOrHandle(a) || handleObject) adopt('a descriptor or handle (server.listen)');
    return listen.apply(this, args);
  });
  const dgram = require('dgram');
  const bind = dgram.Socket.prototype.bind;
  lock(dgram.Socket.prototype, 'bind', function(...args) {
    if (args[0] != null && typeof(args[0]) === 'object' && args[0].fd != null) adopt('a descriptor (dgram bind)');
    return bind.apply(this, args);
  });
  const tty = require('tty');
  ['ReadStream', 'WriteStream'].forEach((key) => {
    lock(tty, key, new Proxy(tty[key], {
      construct(target, args, newTarget) { adopt(`a descriptor (tty.${key})`); return Reflect.construct(target, args, newTarget); },
      apply(target, self, args) { adopt(`a descriptor (tty.${key})`); return Reflect.apply(target, self, args); }
    }));
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

module.exports = {install, normaliseRequestOptions, builtinAllowed, ALLOWED_BUILTINS};
