// RC1-min, spec section 3: a module cannot choose where a credential goes.
// The declaration names the variable it would like; the operator's
// --remoteCredentials file says where each variable may be sent, by exact
// origin. A variable is read only where both agree, and only here, on the
// main thread.
const fs = require('fs');
const {plainHost, VARIABLE} = require('./declaration');
const {isLoopbackHost} = require('../loopback-names');

const loopbackHost = (hostname) => isLoopbackHost(plainHost(hostname));

// -> Map<origin, Set<variable>>. Throws an Error naming the option and the
// file for anything that is not {"<origin>": ["VAR", ...]}: an origin is
// scheme, host and port exactly (no path, no wildcard), https, or http to a
// loopback host (the tests' local server, which the declaration allows only
// under --debug).
function loadAllowance(file) {
  const fail = (why) => { throw new Error(`--remoteCredentials ${file}: ${why}`); };
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`not a readable JSON file (${e.code || 'invalid JSON'})`); }
  if (parsed == null || typeof(parsed) !== 'object' || Array.isArray(parsed)) fail('must be an object of origin -> [variable names]');
  const allowance = new Map();
  for (const [origin, variables] of Object.entries(parsed)) {
    let u = null;
    try { u = new URL(origin); } catch (e) { fail(`${JSON.stringify(origin)} is not an origin`); }
    if (u.origin !== origin || origin.includes('*')) fail(`${JSON.stringify(origin)} is not an origin (scheme, host and port only, no wildcard)`);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopbackHost(u.hostname))) {
      fail(`${JSON.stringify(origin)} must be https (http only to a loopback host)`);
    }
    if (!Array.isArray(variables) || variables.some((v) => typeof(v) !== 'string' || !VARIABLE.test(v))) {
      fail(`${JSON.stringify(origin)} must list environment variable names`);
    }
    allowance.set(origin, new Set(variables));
  }
  return allowance;
}

// remote: a parsed remote (declaration.js). env: the main thread's
// environment. allowance: loadAllowance's map, or null with no option.
// -> null (no credential block), {header, value, source} (source is the
// variable's name), or {missing: 'not-allowed' | 'unset', variable, origin}.
// The value appears in nothing else this returns.
function resolveCredential(remote, env, allowance) {
  const c = remote.credential;
  if (c == null) return null;
  const allowed = (allowance != null && allowance.get(remote.origin)) || new Set();
  const candidates = [c.env, c.fallbackEnv].filter((v) => v != null && allowed.has(v));
  if (candidates.length === 0) return {missing: 'not-allowed', variable: c.env, origin: remote.origin};
  for (const variable of candidates) {
    const token = env[variable];
    if (typeof(token) === 'string' && token !== '') {
      return {header: c.header, value: (c.scheme === '') ? token : `${c.scheme} ${token}`, source: variable};
    }
  }
  return {missing: 'unset', variable: candidates[0], origin: remote.origin};
}

// The process's allowance, loaded once at start from --remoteCredentials
// (framework.js); null when the option is not given.
let configured = null;
function configure(file) {
  if (typeof(file) !== 'string' || file === '') throw new Error('--remoteCredentials needs a file');
  configured = loadAllowance(file);
  return configured;
}
const allowance = () => configured;

module.exports = {loadAllowance, resolveCredential, configure, allowance};
