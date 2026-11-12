// RC1-min (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md):
// the main thread's registry of each loaded module's remote MCP server, and
// callRemote, which serves ctx.call('remote:<name>/<tool>', args). The
// remote is found by the module that owns the call (the worker's own
// module, never a name the worker states), so a module reaches only what it
// declared; the credential never leaves this thread.
const fs = require('fs');
const path = require('path');
const options = require('../cli-options');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {parseRemotes} = require('./declaration');
const credentials = require('./credentials');
const {createRemoteClient, configuredRedis} = require('./client');

const registry = new Map();   // module name -> Map(remote name -> entry)

function readPackage(modulePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json'), 'utf8'));
  } catch (e) {
    return null;   // the load reports a missing or unreadable package.json itself
  }
}

// At load, on the main thread: parse the module's remotes and resolve each
// credential against the operator's allowance, from this process's
// environment, once (a variable set later is read at the next load).
// -> {problems: [string], notes: [string], entries}; a problem refuses the
// load. entries is the registration's own, for unregister(name, entries)
// when that load fails: a newer load's registration is left alone.
function register(moduleName, modulePath) {
  unregister(moduleName);
  const parsed = parseRemotes(readPackage(modulePath), {debug: options.debug === true, redisEndpoint: configuredRedis()});
  if (parsed.problems.length > 0) return {problems: parsed.problems, notes: []};
  const notes = [];
  const entries = new Map();
  parsed.remotes.forEach((remote) => {
    const credential = credentials.resolveCredential(remote, process.env, credentials.allowance());
    const entry = {remote: remote, client: null, disabled: null, credential: null};
    if (credential != null && credential.missing != null) {
      entry.disabled = {code: (credential.missing === 'unset') ? 'REMOTE_CREDENTIAL_MISSING' : 'REMOTE_CREDENTIAL_NOT_ALLOWED',
        variable: credential.variable, origin: credential.origin};
      notes.push((credential.missing === 'unset')
        ? `remote ${remote.name}: ${credential.variable} is allowed for ${credential.origin} but not set; the remote is disabled`
        : `remote ${remote.name}: ${credential.variable} is not allowed for ${credential.origin} by --remoteCredentials; the remote is disabled`);
    } else {
      entry.credential = (credential != null) ? credential.source : null;
      entry.client = createRemoteClient(remote, credential, {timeoutMs: Number(options.remoteTimeout) * 1000,
        maxBytes: Number(options.remoteMaxBytes), debug: options.debug === true, redisEndpoint: configuredRedis()});
      notes.push((credential != null) ? `remote ${remote.name}: sends ${credential.source} to ${remote.origin}`
        : `remote ${remote.name}: sends no credential to ${remote.origin}`);
    }
    entries.set(remote.name, entry);
  });
  if (entries.size > 0) registry.set(moduleName, entries);
  return {problems: [], notes: notes, entries: entries};
}

// At unload, before a reload, or when the load that registered failed
// (only: the registration it made, when `only` is given): each client
// closed, so a call in flight on it rejects and no socket stays open.
function unregister(moduleName, only) {
  const entries = registry.get(moduleName);
  if (only !== undefined && entries !== only) return Promise.resolve();
  registry.delete(moduleName);
  if (entries == null) return Promise.resolve();
  return Promise.all(Array.from(entries.values()).map((e) => (e.client != null ? e.client.close().catch(() => {}) : null)));
}

const isPlainObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// The inner hop's metering, after the server answered (a result, isError
// included), as DeviceManager meters a device hop.
function meter(billingKey, tool) {
  const CHUtil = require('../countinghouse-util');
  if (CHUtil.ci == null) return Promise.resolve();
  return new Promise((resolve) => CHUtil.ci.recordCall(billingKey, tool, options.mcpToolCallCost, (err) => {
    if (err != null) require('../logger').E(err);
    resolve();
  }));
}

// moduleName: the module that owns the call. meta: {billingKey, usageCall}.
// -> Promise<CallToolResult>, as the server sent it.
async function callRemote(moduleName, remoteName, tool, args, meta) {
  const m = meta || {};
  const entries = registry.get(moduleName);
  const entry = (entries != null) ? entries.get(remoteName) : null;
  if (entry == null) {
    throw new CountinghouseError('REMOTE_UNDECLARED', `${moduleName} declares no remote ${JSON.stringify(String(remoteName)).slice(0, 80)}`);
  }
  if (entry.disabled != null) {
    throw new CountinghouseError(entry.disabled.code, `${entry.disabled.variable} for ${entry.disabled.origin}`);
  }
  if (typeof(tool) !== 'string' || tool === '' || tool.length > 128) {
    throw new CountinghouseError('REMOTE_ARGS_INVALID', 'the tool name must be a non-empty string');
  }
  const input = (args === undefined) ? {} : args;
  if (!isPlainObject(input)) throw new CountinghouseError('REMOTE_ARGS_INVALID', 'the arguments must be a plain JSON object');
  if (m.billingKey == null) throw new CountinghouseError('HOP_IDENTITY_UNRESOLVED', `remote:${remoteName}/${tool}`);
  const result = await entry.client.call(tool, input);
  await meter(m.billingKey, `remote:${remoteName}/${tool}`);
  return result;
}

module.exports = {register, unregister, callRemote};
