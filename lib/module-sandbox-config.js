// Main thread: everything the module sandbox decides before a module's worker
// starts -- whether enforce refuses it, its effective permissions, the
// Worker's env and heap limit, and the lockdown config the worker receives on
// set-options (lib/module-lockdown.js). Re-reads package.json and the policy
// file on every call, so an edit takes effect on module restart.
const fs   = require('fs');
const path = require('path');

const modulePermissions = require('./module-permissions');
const modulePolicy      = require('./module-policy');
const moduleTreeCheck   = require('./module-tree-check');


// A module worker's young generation and stack, under audit and enforce
// (the review of #186), so its memory is bounded in all its parts, not the
// old generation alone. The young generation is a quarter of the heap, 8 to
// 64 MB (a 256 MB heap: 64); the stack is Node's default for a worker,
// 4 MB, stated so a change in Node does not move it. Under off a worker gets
// none: off decides nothing.
const youngFor = (heapMb) => Math.max(8, Math.min(64, Math.floor(heapMb / 4)));
const STACK_MB = 4;

function readPackage(modulePath) {
  try {
    return {pkg: JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8')), error: null};
  } catch (e) {
    return {pkg: null, error: `package.json could not be read: ${e.message}`};
  }
}

// The Redis endpoint a worker may not connect to (R2-1, the always-denied
// set): the host and port of --redisUrl, or its socket path for a unix form
// (redis+unix:, unix:) should one be given. An unparsable URL denies nothing.
// A host given by a name also denies the addresses the main thread resolved
// it to (resolveDenied, #207): the worker's handle guards block an address,
// never a name, so a module that resolves the name itself and connects to
// the address is refused there.
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
function parseRedisUrl(redisUrl) {
  if (typeof(redisUrl) !== 'string') return null;
  try { return new URL(redisUrl); } catch (e) { return null; }
}
function deniedEndpoints(redisUrl, resolved = cachedFor(redisUrl)) {
  const out = {endpoints: [], socketPaths: []};
  const u = parseRedisUrl(redisUrl);
  if (u == null) return out;
  if (u.protocol === 'redis+unix:' || u.protocol === 'unix:') {
    if (u.pathname !== '') out.socketPaths.push(u.pathname);
    return out;
  }
  const host = hostOf(u);
  const port = u.port !== '' ? parseInt(u.port) : 6379;
  if (host !== '') out.endpoints.push({host: host, port: port});
  for (const address of (resolved != null && Array.isArray(resolved.addresses) ? resolved.addresses : [])) {
    if (address !== host) out.endpoints.push({host: address, port: port});
  }
  return out;
}

// --redisUrl's host name, resolved (lookup: dns.lookup's shape, all: true),
// within timeoutMs: {addresses, problem} (problem: the error's code, or
// TIMEOUT; null when resolved or nothing needs resolving: a literal
// address, a socket path). Never rejects.
const RESOLVE_MS = 5000;
function resolveDenied(redisUrl, {lookup = require('dns').lookup, timeoutMs = RESOLVE_MS} = {}) {
  const u = parseRedisUrl(redisUrl);
  if (u == null || u.protocol === 'redis+unix:' || u.protocol === 'unix:') return Promise.resolve({addresses: [], problem: null});
  const host = hostOf(u);
  if (host === '' || require('net').isIP(host) !== 0) return Promise.resolve({addresses: [], problem: null});
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish({addresses: [], problem: 'TIMEOUT'}), timeoutMs);
    if (typeof(timer.unref) === 'function') timer.unref();
    try {
      lookup(host, {all: true, verbatim: true}, (err, list) => {
        if (err != null) return finish({addresses: [], problem: String(err.code || 'ERROR')});
        const addresses = [];
        for (const a of Array.isArray(list) ? list : []) {
          if (a != null && typeof(a.address) === 'string' && !addresses.includes(a.address)) addresses.push(a.address);
        }
        finish({addresses: addresses, problem: null});
      });
    } catch (err) {
      finish({addresses: [], problem: String(err.code || 'ERROR')});
    }
  });
}

// The last resolution, for the workers started after it. Resolved before the
// first module loads (framework.js), then every REFRESH_MS: a worker holds
// the addresses of its start (a name moved to another address meanwhile is
// caught again only by the name check, until the network broker).
const REFRESH_MS = 5 * 60 * 1000;
let cache = null;   // {url, addresses, problem}
let refreshing = null;
const cachedFor = (redisUrl) => (cache != null && cache.url === redisUrl ? cache : null);
async function refreshDenied(redisUrl, opts) {
  const r = await resolveDenied(redisUrl, opts);
  // a failed resolution keeps the addresses known before (a name that
  // resolved once is denied by them still)
  const before = cachedFor(redisUrl);
  cache = {url: redisUrl, addresses: r.addresses.length > 0 || before == null ? r.addresses : before.addresses, problem: r.problem};
  if (r.problem != null) {
    try { require('./logger').W(`module sandbox: the Redis host name could not be resolved (${r.problem}); a worker is denied it by name${cache.addresses.length > 0 ? ' and its addresses resolved before' : ' only'}`); } catch (e) { /* not serving */ }
  }
  if (refreshing == null) {
    refreshing = setInterval(() => { refreshDenied(redisUrl, opts).catch(() => {}); }, REFRESH_MS);
    if (typeof(refreshing.unref) === 'function') refreshing.unref();
  }
  return cache;
}

// opts: {mode: 'off'|'audit'|'enforce', modulePolicy: file|null, serverEnv: object, redisUrl: string|null}
function build(modulePath, name, opts) {
  if (opts.mode === 'off') return null;

  const moduleRoot = fs.realpathSync.native(path.resolve(modulePath));
  const read = readPackage(moduleRoot);
  const parsed = modulePermissions.parseDeclaration(read.pkg);
  const tree = moduleTreeCheck.checkTree(moduleRoot);
  const problems = [].concat(read.error != null ? [read.error] : [], parsed.problems, tree.problems);

  let policy = modulePolicy.EMPTY;
  const notes = [];
  if (opts.modulePolicy != null) {
    try {
      policy = modulePolicy.load(opts.modulePolicy);
    } catch (e) {
      notes.push(`${e.message} -- using an empty policy for this spawn`);
    }
  }

  // The verified package.json name; the request's name has already been
  // checked against it (lib/module-manager.js nameMismatch).
  const key = (read.pkg != null && typeof(read.pkg.name) === 'string') ? read.pkg.name : name;
  const entry = policy.modules[key] != null ? policy.modules[key] : null;
  const eff = modulePermissions.narrow(parsed.declared, entry, policy.limits, opts.mode);
  const env = modulePermissions.resolveEnv(eff.envNames, eff.envOverrides, opts.serverEnv);
  // A declared COUNTINGHOUSE_* name is left out and the load says so.
  modulePermissions.deniedEnvNames(eff.envNames).forEach((name) => notes.push(`env ${name} denied: COUNTINGHOUSE_* is never handed to a module`));

  const summary = {fs: eff.fs, net: eff.net, env: Object.keys(env), limits: eff.limits};
  return {
    refusal: problems.length > 0 ? problems.join('; ') : null,
    notes: notes.concat(eff.ignored, tree.warnings.map((w) => `warning: ${w}`)),
    workerOptions: {env: env, resourceLimits: {maxOldGenerationSizeMb: eff.limits.heapMb,
      maxYoungGenerationSizeMb: youngFor(eff.limits.heapMb), stackSizeMb: STACK_MB}},
    fs: eff.fs,
    lockdown: {mode: opts.mode, moduleName: name, moduleRoot: moduleRoot, net: eff.net, denied: deniedEndpoints(opts.redisUrl)},
    limits: eff.limits,
    logLine: `module sandbox: ${name} effective permissions ${JSON.stringify(summary)}`
  };
}

module.exports = {build, deniedEndpoints, resolveDenied, refreshDenied,
  resetForTests: () => { cache = null; if (refreshing != null) clearInterval(refreshing); refreshing = null; }};
