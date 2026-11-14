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
function deniedEndpoints(redisUrl) {
  const out = {endpoints: [], socketPaths: []};
  if (typeof(redisUrl) !== 'string') return out;
  let u = null;
  try { u = new URL(redisUrl); } catch (e) { return out; }
  if (u.protocol === 'redis+unix:' || u.protocol === 'unix:') {
    if (u.pathname !== '') out.socketPaths.push(u.pathname);
    return out;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '') out.endpoints.push({host: host, port: u.port !== '' ? parseInt(u.port) : 6379});
  return out;
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

module.exports = {build};
