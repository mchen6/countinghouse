// RC1-min (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md):
// the main thread's registry of each loaded module's remote MCP server, and
// callRemote, which serves ctx.call('remote:<name>/<tool>', args). The
// remote is found by the module that owns the call (the worker's own
// module, never a name the worker states), so a module reaches only what it
// declared; the credential never leaves this thread.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const LOG = require('../logger');
const options = require('../cli-options');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {parseRemotes} = require('./declaration');
const credentials = require('./credentials');
const {createRemoteClient, configuredRedis} = require('./client');

const registry = new Map();   // module name -> Map(remote name -> entry)

// JSON with every object's keys in order, so the hash names the list, not
// the server's key order.
// An undefined value is left out, as JSON.stringify leaves it.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  if (value != null && typeof(value) === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Step 4 (spec section 5): the remote's tools/list, recorded for the life of
// the process as {tools, sha256}: [{name, inputSchema}] by name, and the
// first 16 hex digits of SHA-256 over its canonical JSON. It refuses
// nothing in RC1-min (not the load, not a call, not a tool missing from
// it); drift handling is a later step, which this record is for.
// Still the module's registration (not one a reload or unload replaced).
const current = (moduleName, entry) => {
  const entries = registry.get(moduleName);
  return entries != null && entries.get(entry.remote.name) === entry;
};

function listInto(moduleName, entry) {
  return entry.client.list().then((tools) => {
    const sorted = tools.map((t) => ({name: String(t.name), inputSchema: (t.inputSchema != null) ? t.inputSchema : null}))
      .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    const sha256 = crypto.createHash('sha256').update(canonical(sorted)).digest('hex').slice(0, 16);
    entry.listing = {tools: sorted, sha256: sha256};
    LOG.I(`module remote: ${moduleName}: remote ${entry.remote.name}: tools/list ${sorted.length} tools sha256 ${sha256}`);
  }).catch((err) => {
    // A registration a reload or unload replaced has nothing to report.
    if (!current(moduleName, entry)) return;
    entry.listFailed = true;
    LOG.I(`module remote: ${moduleName}: remote ${entry.remote.name}: tools/list failed (${(err && err.code) || err}); one attempt at the first call`);
  });
}

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
    const entry = {remote: remote, client: null, disabled: null, credential: null,
      listing: null, listFailed: false, listing$: null, retried: false};
    const clientOptions = () => ({timeoutMs: Number(options.remoteTimeout) * 1000,
      maxBytes: Number(options.remoteMaxBytes), debug: options.debug === true, redisEndpoint: configuredRedis()});
    if (credential != null && credential.missing === 'not-allowed') {
      // A module cannot choose where a credential goes: not contacted at all.
      entry.disabled = {code: 'REMOTE_CREDENTIAL_NOT_ALLOWED', variable: credential.variable, origin: credential.origin};
      notes.push(`remote ${remote.name}: ${credential.variable} is not allowed for ${credential.origin} by --remoteCredentials; the remote is disabled`);
    } else if (credential != null && credential.missing === 'unset') {
      // Allowed but empty: disabled for calls; tools/list still runs, with
      // no credential (a server that needs one answers 401, logged).
      entry.disabled = {code: 'REMOTE_CREDENTIAL_MISSING', variable: credential.variable, origin: credential.origin};
      entry.client = createRemoteClient(remote, null, clientOptions());
      entry.listing$ = listInto(moduleName, entry);
      notes.push(`remote ${remote.name}: ${credential.variable} is allowed for ${credential.origin} but not set; the remote is disabled for calls`);
    } else {
      entry.credential = (credential != null) ? credential.source : null;
      entry.client = createRemoteClient(remote, credential, clientOptions());
      notes.push((credential != null) ? `remote ${remote.name}: sends ${credential.source} to ${remote.origin}`
        : `remote ${remote.name}: sends no credential to ${remote.origin}`);
      // At load, without waiting: a laptop can start offline, and the load
      // does not depend on the remote.
      entry.listing$ = listInto(moduleName, entry);
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
    if (err != null) LOG.E(err);
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
  // A listing is never waited for: one that failed at load is started once
  // more here, beside the call, which goes ahead at once (not a retry of
  // the call).
  if (entry.listFailed && !entry.retried) {
    entry.retried = true;
    entry.listFailed = false;
    entry.listing$ = listInto(moduleName, entry);
  }
  const result = await entry.client.call(tool, input);
  await meter(m.billingKey, `remote:${remoteName}/${tool}`);
  return result;
}

// The recorded tools/list of a module's remote: {tools, sha256}, or null
// (not listed, or not yet). Waits for a listing in progress.
async function listing(moduleName, remoteName) {
  const entries = registry.get(moduleName);
  const entry = (entries != null) ? entries.get(remoteName) : null;
  if (entry == null) return null;
  if (entry.listing$ != null) await entry.listing$;
  return entry.listing;
}

module.exports = {register, unregister, callRemote, listing};
