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

const BLOCKED = new Set(['child_process', 'cluster', 'worker_threads', 'inspector', 'inspector/promises', 'wasi', 'v8']);
const WATCHED = new Set(['fs', 'fs/promises', 'net', 'tls', 'http', 'https', 'http2', 'dgram', 'dns', 'dns/promises']);
const MAX_REPORTS = 100;
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
// baseUrl / proxy to move it, no environment proxy (an own `proxy: null`
// stops postman-request's getProxyFromURI), no disableUrlEncoding (which
// makes it read uri.hostname instead of href), and every redirect checked.
// Returns {refusal: null, options} or {refusal: <target>, options: null}.
// onRedirectDenied(target) is called when a redirect is refused.
function normaliseRequestOptions(opts, net, onRedirectDenied) {
  const refuse = (target) => ({refusal: target, options: null});
  const given = typeof(opts) === 'string' ? {uri: opts} : opts;
  if (given == null || typeof(given) !== 'object') return refuse('invalid');
  for (const key of ['har', 'baseUrl', 'proxy']) {
    if (given[key] != null) return refuse(key);
  }
  let target = given.uri != null ? given.uri : given.url;
  if (target != null && typeof(target) === 'object') target = target.href;
  if (typeof(target) !== 'string') return refuse('invalid');
  const parsed = hostPort(target);
  if (parsed == null) return refuse('invalid');
  if (!modulePermissions.hostAllowed(net, parsed.host, parsed.port)) return refuse(`${parsed.host}:${parsed.port}`);

  const options = Object.assign({}, given);
  delete options.url;
  delete options.disableUrlEncoding;
  options.uri   = parsed.href;
  options.proxy = null;
  if (given.followRedirect !== false) {
    const original = given.followRedirect;
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

function install(cfg, report) {
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
  const inside = (file) => file === root || file.startsWith(root + path.sep);
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
    return path.resolve(String(from));
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
      if (BLOCKED.has(b)) {
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
        if (BLOCKED.has(b)) violate('builtin', b, () => notFound(specifier));
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
  // No later hook may run ahead of ours.
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

module.exports = {install, normaliseRequestOptions};
