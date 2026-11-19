'use strict';
// RC1-min, spec section 3: a module cannot choose where a credential goes.
// The declaration names the variable it would like; the operator's
// --remoteCredentials file says where each variable may be sent, by exact
// origin. A variable is read only where both agree, and only here, on the
// main thread.
//
// M3 (module-level configuration, #413 sections 6.4 and 6.5): version 2 of
// the file binds a credential to one module:
//   {"version": 2, "modules": {"<package>": {"<origin>": {"<VARIABLE>": "COUNTINGHOUSE_CREDENTIAL_<n>"}}}}
// The value is read from the slot, an environment name with the prefix the
// runtime never hands to a module's worker (lib/module-permissions.js), so
// the file cannot make the runtime send any other variable of its
// environment (its identity secret, say) anywhere. The start's file fixes
// each slot to its (module, origin, variable) for the life of the runtime:
// a later entry (a module loaded in place, M4) may only repeat one.
// Version 1 ({"<origin>": ["VARIABLE", ...]}, process-wide) keeps its
// meaning, and is still the only form of a pack's own file.
const fs = require('fs');
const {plainHost, VARIABLE} = require('./declaration');
const {isLoopbackHost} = require('../loopback-names');

const loopbackHost = (hostname) => isLoopbackHost(plainHost(hostname));

const SLOT = /^COUNTINGHOUSE_CREDENTIAL_[1-9][0-9]{0,3}$/;
// npm's package name grammar (lower case; a scope; no leading . or _),
// at most 214 characters.
const PACKAGE = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const isPackage = (name) => typeof(name) === 'string' && name.length <= 214 && PACKAGE.test(name);

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

// A variable every process needs and that holds no secret is no credential:
// a version 2 binding of one is an operator's error, refused, since every
// name a binding reads is denied to every worker (namesReadFrom) and
// denying these would break every module (#422's review).
const NOT_A_CREDENTIAL = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'LANG', 'LANGUAGE', 'TZ', 'TMPDIR', 'TEMP', 'TMP']);
const notACredential = (name) => NOT_A_CREDENTIAL.has(name) || name.startsWith('LC_');

// An origin as an allowance names one: scheme, host and port exactly (no
// path, no wildcard), https, or http to a loopback host (the tests' local
// server, which the declaration allows only under --debug). -> null, or
// why not.
function originProblem(origin) {
  let u = null;
  try { u = new URL(origin); } catch (e) { return `${JSON.stringify(origin)} is not an origin`; }
  if (u.origin !== origin || origin.includes('*')) return `${JSON.stringify(origin)} is not an origin (scheme, host and port only, no wildcard)`;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopbackHost(u.hostname))) {
    return `${JSON.stringify(origin)} must be https (http only to a loopback host)`;
  }
  return null;
}

// Version 1: -> Map<origin, Set<variable>>.
function parseV1(parsed, fail) {
  if (!isObject(parsed)) fail('must be an object of origin -> [variable names]');
  const allowance = new Map();
  for (const [origin, variables] of Object.entries(parsed)) {
    const problem = originProblem(origin);
    if (problem != null) fail(problem);
    if (!Array.isArray(variables) || variables.some((v) => typeof(v) !== 'string' || !VARIABLE.test(v))) {
      fail(`${JSON.stringify(origin)} must list environment variable names`);
    }
    allowance.set(origin, new Set(variables));
  }
  return allowance;
}

// One module's entry, {"<origin>": {"<VARIABLE>": "<slot>"}}: -> Map(origin
// -> Map(variable -> slot)). `at` names the entry in a problem; a value is
// never named (a slot is an environment name, not a value).
function parseEntry(entry, at, fail) {
  if (!isObject(entry)) fail(`${at} must be an object of origin -> {variable: slot}`);
  const out = new Map();
  for (const [origin, variables] of Object.entries(entry)) {
    const problem = originProblem(origin);
    if (problem != null) fail(`${at}: ${problem}`);
    if (!isObject(variables)) fail(`${at}[${JSON.stringify(origin)}] must be an object of variable -> slot`);
    const byVariable = new Map();
    for (const [variable, slot] of Object.entries(variables)) {
      if (!VARIABLE.test(variable)) fail(`${at}[${JSON.stringify(origin)}]: ${JSON.stringify(variable)} is not an environment variable name`);
      if (notACredential(variable)) {
        fail(`${at}[${JSON.stringify(origin)}]: ${variable} is not a credential (it holds no secret, and every worker needs it); bind the variable the module's remote declares for its key`);
      }
      if (typeof(slot) !== 'string' || !SLOT.test(slot)) {
        fail(`${at}[${JSON.stringify(origin)}].${variable} must name a slot, COUNTINGHOUSE_CREDENTIAL_<1-9999>`);
      }
      byVariable.set(variable, slot);
    }
    out.set(origin, byVariable);
  }
  return out;
}

// Version 2: -> {modules: Map(package -> entry), slots: Map(slot ->
// {module, origin, variable})}. One slot holds one binding.
function parseV2(parsed, fail) {
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'modules' || keys[1] !== 'version' || !isObject(parsed.modules)) {
    fail('version 2 is exactly {"version": 2, "modules": {"<package>": {"<origin>": {"<VARIABLE>": "COUNTINGHOUSE_CREDENTIAL_<n>"}}}}');
  }
  const modules = new Map();
  const slots = new Map();
  for (const [name, entry] of Object.entries(parsed.modules)) {
    if (!isPackage(name)) fail(`${JSON.stringify(name)} is not a package name`);
    const at = `modules[${JSON.stringify(name)}]`;
    const map = parseEntry(entry, at, fail);
    for (const [origin, byVariable] of map) {
      for (const [variable, slot] of byVariable) {
        if (slots.has(slot)) fail(`${at}: ${slot} is given to more than one credential`);
        slots.set(slot, {module: name, origin: origin, variable: variable});
      }
    }
    modules.set(name, map);
  }
  return {modules, slots};
}

// -> {version: 1, origins: Map<origin, Set<variable>>} or {version: 2,
// modules, slots}. Throws an Error naming the option and the file for
// anything that is neither form.
function loadFile(file) {
  const fail = (why) => { throw new Error(`--remoteCredentials ${file}: ${why}`); };
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`not a readable JSON file (${e.code || 'invalid JSON'})`); }
  if (isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'version')) {
    if (parsed.version !== 2) fail('the only versioned form is {"version": 2, ...}');
    return Object.assign({version: 2}, parseV2(parsed, fail));
  }
  return {version: 1, origins: parseV1(parsed, fail)};
}

// A pack's own file (lib/modules-in-place.js): version 1 only, -> Map<origin,
// Set<variable>>. A binding by module goes in the start's file.
function loadAllowance(file) {
  const loaded = loadFile(file);
  if (loaded.version !== 1) throw new Error(`--remoteCredentials ${file}: a pack's own credentials file is version 1; version 2 bindings go in the start's file`);
  return loaded.origins;
}

// The declared credential's value from env[name], with the declaration's
// header and scheme.
const sent = (c, value, source) => ({header: c.header, value: (c.scheme === '') ? value : `${c.scheme} ${value}`, source: source});

// Version 1. remote: a parsed remote (declaration.js). env: the main
// thread's environment. allowance: a Map<origin, Set<variable>>, or null.
// -> null (no credential block), {header, value, source} (source is the
// variable's name), or {missing: 'not-allowed' | 'unset', variable, origin}.
// The value appears in nothing else this returns.
function resolveCredential(remote, env, allowance) {
  const c = remote.credential;
  if (c == null) return null;
  const allowed = (allowance != null && allowance.get(remote.origin)) || new Set();
  // (one variable: the declared env; M6)
  if (!allowed.has(c.env)) return {missing: 'not-allowed', variable: c.env, origin: remote.origin};
  const token = env[c.env];
  if (typeof(token) === 'string' && token !== '') return sent(c, token, c.env);
  return {missing: 'unset', variable: c.env, origin: remote.origin};
}

// Version 2. entry: the module's own Map(origin -> Map(variable -> slot)),
// or undefined when no binding names the module. Only the declared `env` is
// a credential. -> null, {header, value,
// source} (source: the declared variable), {missing: 'not-allowed', why:
// 'unbound' | 'new-origin' | 'new-variable', variable, origin}, or {missing: 'unset',
// variable, origin}.
function resolveModuleCredential(remote, env, entry) {
  const c = remote.credential;
  if (c == null) return null;
  const notAllowed = (why) => ({missing: 'not-allowed', why: why, variable: c.env, origin: remote.origin});
  if (!(entry instanceof Map) || entry.size === 0) return notAllowed('unbound');
  if (!entry.has(remote.origin)) return notAllowed('new-origin');
  const slot = entry.get(remote.origin).get(c.env);
  if (slot === undefined) return notAllowed('new-variable');
  const token = env[slot];
  if (typeof(token) === 'string' && token !== '') return sent(c, token, c.env);
  return {missing: 'unset', variable: c.env, origin: remote.origin};
}

// The process's allowance, loaded once at start from --remoteCredentials
// (framework.js): null with no option.
let configured = null;
// Version 2: each module's allowance, module -> Map(origin -> Map(variable
// -> slot)); seeded from the start's file, set and dropped by module
// (a module loaded in place, M4).
let byModule = new Map();

function configure(file) {
  if (typeof(file) !== 'string' || file === '') throw new Error('--remoteCredentials needs a file');
  configured = loadFile(file);
  byModule = (configured.version === 2) ? new Map(configured.modules) : new Map();
  return configured;
}

const version = () => (configured != null ? configured.version : null);
// Version 1's process-wide Map<origin, Set<variable>>; null under version 2
// or with no option.
const allowance = () => (configured != null && configured.version === 1 ? configured.origins : null);
const moduleEntry = (name) => byModule.get(name);
const setModule = (name, entry) => { byModule.set(name, entry); };
// A module's allowance goes at its unload; the binding the start's file
// gave it stays (the medium review of M4a, finding 2): the module loaded
// again, in either form, has its key with no message naming it.
const dropModule = (name) => {
  if (configured != null && configured.version === 2 && configured.modules.has(name)) byModule.set(name, configured.modules.get(name));
  else byModule.delete(name);
};
// A module-form request that names a module and gives it no credentials is
// authoritative (#427's high review, 7): the module has none, the start's
// binding not put back (a revoke).
const clearModule = (name) => { byModule.delete(name); };

// A module's entry given after the start (the load message's `credentials`,
// M4), in the file's per-module shape: checked as the file is, and each
// binding must be one the start's file fixed, the same slot for the same
// module, origin and variable. -> Map(origin -> Map(variable -> slot)).
// Throws otherwise.
function checkEntry(name, obj) {
  const fail = (why) => { throw new Error(`credentials for ${JSON.stringify(name)}: ${why}`); };
  if (!isPackage(name)) fail('not a package name');
  if (version() !== 2) fail('the runtime was not started with a version 2 --remoteCredentials file');
  const map = parseEntry(obj, 'the entry', fail);
  for (const [origin, byVariable] of map) {
    for (const [variable, slot] of byVariable) {
      const fixed = configured.slots.get(slot);
      if (fixed == null) fail(`${slot} was not named by the start's file`);
      if (fixed.module !== name || fixed.origin !== origin || fixed.variable !== variable) {
        fail(`${slot} is fixed to another module, origin or variable`);
      }
    }
  }
  return map;
}

// Every environment name an allowance in force reads a value from, which
// resolveEnv never copies to a worker: under version 1 the start's listed
// variables and each of `extra` (Map<origin, Set<variable>>, a pack's own
// file); under version 2 the start's slots alone (which the COUNTINGHOUSE_
// prefix covers already). -> Set.
// Under version 2: the slots, and every variable name the file binds
// (#422's high review, 2): the value is read from a slot, but the operator's
// own variable of that name (GITHUB_TOKEN, still exported after a
// migration) is the same key and must not reach a worker either. Under
// version 1: the start file's variables (a pack's own file went in M6).
function namesReadFrom() {
  if (version() === 2) {
    const names = new Set(configured.slots.keys());
    for (const b of configured.slots.values()) names.add(b.variable);
    return names;
  }
  return v1Names([allowance()]);
}

// The variables version 1 allowances (Map<origin, Set<variable>>) list.
function v1Names(allowances) {
  const names = new Set();
  for (const a of allowances) {
    if (!(a instanceof Map)) continue;
    for (const variables of a.values()) for (const v of variables) names.add(v);
  }
  return names;
}


// For tests: the module's state, and putting it back.
const snapshot = () => ({configured, byModule: new Map(byModule)});
const restore = (s) => { configured = s.configured; byModule = s.byModule; };

module.exports = {loadFile, loadAllowance, resolveCredential, resolveModuleCredential, configure, allowance, version,
  moduleEntry, setModule, dropModule, clearModule, checkEntry, namesReadFrom, snapshot, restore, SLOT, isPackage};
