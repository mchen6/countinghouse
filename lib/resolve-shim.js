// The resolve shim (docs/superpowers/specs/2026-11-11-node-floor-shim-design.md).
//
// Below Node 24.15, module.registerHooks resolve hooks run for require()
// (Module._load) but not for require.resolve or createRequire().resolve,
// which call Module._resolveFilename directly. In a module worker those
// hooks are the sandbox's require boundary (lib/module-lockdown.js) and its
// path mapping (lib/fs-broker/identity.js), so without them a module's
// require.resolve would reach Node's resolver with neither: no refusal, no
// violation recorded, and a probe of host paths. The shim is part of the
// boundary.
//
// It does what 24.15 does (measured on 22.23, 24.14, 24.15 and 26.13, the
// floor-shim PR): every call to Module._resolveFilename that does not come
// from a hook chain already running runs the registered resolve hooks by
// hand, last registered first, whoever the caller -- module code or
// countinghouse's own (the lockdown's own require.resolve needs the file
// broker's grant that the identity hook gives) -- and answers what the chain
// yields: a file URL as its path, a built-in as the request named it, any
// other URL as it is. A call that does come from a running chain is Node's
// own default step (require() runs the chain itself, then calls
// _resolveFilename) or ours; a marker hook, registered first so it runs
// last, holds a depth count around that step, and such a call is passed to
// the resolver unchanged.
//
// The hooks the shim runs are the very functions registered with
// Module.registerHooks: each installer registers through registerHooks()
// below. On 24.15 and later the shim is never installed and registerHooks()
// only registers.
//
// Remove with the floor, when Node 22 reaches end of life (2027-04-30;
// lib/node-version.js).
const Module = require('module');
const path   = require('path');
const url    = require('url');
const {NEEDS_RESOLVE_SHIM} = require('./node-version');

// The conditions Node passes a CommonJS require's resolve hooks (the same
// names on 22 and 24).
const CONDITIONS = Object.freeze(['require', 'node', 'node-addons', 'module-sync']);

// Whether a resolve hook's context names a condition. Node passes an array
// on 22.23 and 24.14 but a Set on 24.0 (measured on 22.23.4, 24.0.0 and
// 24.14.1), so a hook that read only an array took every CommonJS require
// on 24.0 for an import.
function hasCondition(context, name) {
  const c = (context != null) ? context.conditions : null;
  if (Array.isArray(c)) return c.includes(name);
  return c != null && typeof(c.has) === 'function' && c.has(name);
}

const resolvers = [];   // the registered resolve functions, in registration order
let depth = 0;          // > 0 while a chain is at its default step
let installed = false;
// Node's default step's result, as opposed to an answer a hook gave.
const DEFAULT_STEP = Symbol('countinghouse.resolveShim.defaultStep');
// The last answer a hook gave (not Node's resolver), for isHookAnswer: set
// and read in the same synchronous call, by the wrapper around the shim.
let hookAnswer = null;

// The resolver's parent for a hook's context: the original parent when the
// hooks left the parent URL as it was, else a fresh one for that file, as
// createRequire builds it.
function parentFor(parentURL, original) {
  if (typeof(parentURL) !== 'string' || !parentURL.startsWith('file:')) return original;
  const file = url.fileURLToPath(parentURL);
  if (original != null && original.filename === file) return original;
  const parent = new Module(file, null);
  parent.filename = file;
  parent.paths = Module._nodeModulePaths(path.dirname(file));
  return parent;
}

function chain(index, specifier, context, call) {
  if (index < 0) {
    depth++;
    try {
      const found = Module._resolveFilename(specifier, parentFor(context.parentURL, call.parent), call.isMain, call.options);
      return {url: Module.isBuiltin(found) ? `node:${found.replace(/^node:/, '')}` : url.pathToFileURL(found).href, [DEFAULT_STEP]: true};
    } finally {
      depth--;
    }
  }
  return resolvers[index](specifier, context, (nextSpecifier, nextContext) =>
    chain(index - 1, nextSpecifier, (nextContext != null) ? Object.assign({}, context, nextContext) : context, call));
}

function answer(resolved, request) {
  const href = resolved.url;
  if (href.startsWith('file:')) return url.fileURLToPath(href);
  if (href.startsWith('node:')) return Module.isBuiltin(request) ? request : href.slice('node:'.length);
  return href;
}

function install(registerHooks) {
  installed = true;
  registerHooks.call(Module, {
    resolve(specifier, context, nextResolve) {
      depth++;
      try {
        return nextResolve(specifier, context);
      } finally {
        depth--;
      }
    }
  });
  const original = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (depth > 0 || typeof(request) !== 'string' || resolvers.length === 0) {
      return original.call(this, request, parent, isMain, options);
    }
    const parentFile = (parent != null && typeof(parent.filename) === 'string') ? parent.filename : null;
    const context = {parentURL: (parentFile != null) ? url.pathToFileURL(parentFile).href : undefined, conditions: CONDITIONS};
    const resolved = chain(resolvers.length - 1, request, context, {parent: parent, isMain: isMain, options: options});
    const found = answer(resolved, request);
    hookAnswer = (resolved[DEFAULT_STEP] === true) ? null : found;
    return found;
  };
}

// Registers `hooks` with `registerHooks` (Module.registerHooks, or the
// original handed over before the lockdown locks it), and below 24.15 keeps
// its resolve function for the shim, installing the shim on the first call.
function registerHooks(register, hooks) {
  if (NEEDS_RESOLVE_SHIM && !installed) install(register);
  register.call(Module, hooks);
  if (NEEDS_RESOLVE_SHIM && typeof(hooks.resolve) === 'function') resolvers.push(hooks.resolve);
}

// Whether `found` is the answer a hook gave to the call the shim just
// served (a virtual path for a module file, say), not a path Node's own
// resolver found. A wrapper around the shim asks it right after the call
// returns; the answer is then cleared.
function isHookAnswer(found) {
  const yes = installed && hookAnswer != null && found === hookAnswer;
  hookAnswer = null;
  return yes;
}

// Below 24.15, under enforce, makes Module._resolveFilename unreplaceable by
// module code, as the lockdown locks its other routes; a property something
// else has already locked (the file broker under enforce wraps the shim and
// locks it) is left. Under audit nothing is locked, as on 24.15 and later.
function lock() {
  if (!installed) return;
  const d = Object.getOwnPropertyDescriptor(Module, '_resolveFilename');
  if (d == null || d.configurable !== true) return;
  Object.defineProperty(Module, '_resolveFilename', {value: Module._resolveFilename, writable: false, configurable: false, enumerable: true});
}

module.exports = {registerHooks, lock, isHookAnswer, hasCondition, installed: () => installed};
