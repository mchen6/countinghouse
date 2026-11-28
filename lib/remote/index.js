'use strict';
// RC1-min (docs/superpowers/specs/2026-11-11-rc1-min-remote-mcp-design.md):
// the main thread's registry of each loaded module's remote MCP server, and
// callRemote, which serves ctx.call('remote:<name>/<tool>', args). The
// remote is found by the module that owns the call (the worker's own
// module, never a name the worker states), so a module reaches only what it
// declared; the credential never leaves this thread.
const crypto = require('crypto');
const {STAND_IN} = require('../usage/labels');
const originMap = require('./origin-map');
// a remote call's charge, waited for at most METER_PENDING_MS (B-hopcharge)
const {boundedCharge, chargeLost} = require('../metering/charge-bound');
const fs = require('fs');
const path = require('path');
const LOG = require('../logger');
const options = require('../cli-options');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {parseRemotes, refusedAddress, portOf} = require('./declaration');
const credentials = require('./credentials');
const {moduleLine} = require('../module-text');
const {createRemoteClient, configuredRedis} = require('./client');
const {recorder} = require('./usage');
const {checkHop} = require('../usage/hop');
const {textBytes} = require('../usage');
const callTokens = require('../call-tokens');

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

// The load line's tool names (the reviewer, A-redact): what a remote serves,
// so a user can see what a token is used with. Text the remote server
// supplies, so (the medium on this change):
// - the credential is scrubbed out first (the client's own scrub: a
//   remote that echoes the token in a name never puts it in a log);
// - each name is cleaned as any text a module supplies is (module-text's
//   moduleLine: one plain line, control, bidi, zero-width and tag
//   characters gone) and cut to NAME_MAX;
// - they are written as one JSON list (no name can break the line or forge
//   an entry) within one budget, NAMES_TEXT_MAX characters after escaping,
//   at most NAMES_SHOWN of them, then how many more and how many cleaning
//   changed, so the list is never taken for the exact names.
// A remote may still order decoys first; the count and the sha256 say
// what changed. Names only: the runtime does nothing else with them here.
const NAMES_SHOWN = 64;
const NAME_MAX = 128;
const NAMES_TEXT_MAX = 4096;
function toolNamesText(names, scrub = (t) => t) {
  const shown = [];
  let size = 2;
  let changed = 0;
  for (const raw of names.slice(0, NAMES_SHOWN)) {
    const name = moduleLine(String(scrub(String(raw))), NAME_MAX);
    const json = JSON.stringify(name);
    if (size + json.length + 1 > NAMES_TEXT_MAX) break;
    shown.push(name);
    size += json.length + 1;
    if (name !== String(raw)) changed++;
  }
  const more = names.length - shown.length;
  return `names ${JSON.stringify(shown)}${more > 0 ? ` (+${more} more)` : ''}${changed > 0 ? ` (${changed} cleaned)` : ''}`;
}

function listInto(moduleName, entry) {
  return entry.client.list().then((tools) => {
    const sorted = tools.map((t) => ({name: String(t.name), inputSchema: (t.inputSchema != null) ? t.inputSchema : null}))
      .sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    const sha256 = crypto.createHash('sha256').update(canonical(sorted)).digest('hex').slice(0, 16);
    entry.listing = {tools: sorted, sha256: sha256};
    // (the names' text built apart, so nothing in it can mark a listing
    // already recorded as failed)
    let names = '';
    try { names = `: ${toolNamesText(sorted.map((t) => t.name), entry.client.scrub)}`; } catch (e) { names = ''; }
    LOG.I(`module remote: ${moduleName}: remote ${entry.remote.name}: tools/list ${sorted.length} tools sha256 ${sha256}${names}`);
  }).catch((err) => {
    // A registration a reload or unload replaced has nothing to report.
    if (!current(moduleName, entry)) return;
    entry.listFailed = true;
    LOG.I(`module remote: ${moduleName}: remote ${entry.remote.name}: tools/list failed (${(err && err.code) || err}); one attempt at the first call`);
  });
}

// #413 section 6.5: why a module gets no key under a version 2 start, and
// who can bind it: ch-local's command on a runtime it started (the control
// channel, which framework.js allows only in the single-identity profile),
// the operator's file otherwise; a tenant of an HTTP server never sees a
// ch-local command.
function notAllowedSentence(moduleName, version, credential) {
  const hint = (options.controlChannel != null)
    ? `: run \`ch-local credentials add ${moduleName}\` at a terminal`
    : ': the operator binds it in the --remoteCredentials file';
  const named = (typeof(version) === 'string' && version !== '') ? `${moduleName} ${version}` : moduleName;
  if (credential.why === 'new-origin') {
    return `${named} sends its credential ${credential.variable} somewhere new (${credential.origin}); it gets no key until that is allowed${hint}`;
  }
  if (credential.why === 'new-variable') {
    return `${named} asks for its credential under a new name (${credential.variable}) for ${credential.origin}; it gets no key until that is allowed${hint}`;
  }
  return `no credential is bound to ${moduleName} for ${credential.origin}${hint}`;
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
// -> {problems: [string], notes: [string], entries, disabled}; a problem
// refuses the load. entries is the registration's own, for unregister(name,
// entries) when that load fails: a newer load's registration is left alone.
// disabled: each remote's {code, variable, origin} that is disabled.
// M3 (module-level configuration, #413 section 6.5): under a version 2
// start file the credential is resolved against the module's own binding
// (credentials.moduleEntry): a module the start binds has the start's
// binding, and one it does not has none; under version 1, the process's
// allowance (a pack's own file went with the pack form, M6). opts.version:
// the module's version, for what is said.
function register(moduleName, modulePath, opts = {}) {
  const byModule = credentials.version() === 2;
  const allowance = credentials.allowance();
  unregister(moduleName);
  // opts.pkg: the package.json the module's pin takes (M3, #413 section
  // 6.1), so a supervised restart registers the remotes the last operator
  // action took; read from disk without it (single-thread mode).
  const pkg = (opts.pkg !== undefined) ? opts.pkg : readPackage(modulePath);
  const parsed = parseRemotes(pkg, {debug: options.debug === true, redisEndpoint: configuredRedis()});
  if (parsed.problems.length > 0) return {problems: parsed.problems, notes: []};
  // --remoteOriginMap (acceptance only): the map framework.js fixed at start,
  // already checked whole (lib/remote/origin-map.js), never an option.
  const map = originMap.current();
  // Each remote's stand-in, worked out once: the transport built on the
  // parsed target, with the declared path and query set on it (a path that
  // starts with // is a path there, never another host). The declared origin
  // stays the remote's, for the allowance, the variable and the receipt.
  const planned = parsed.remotes.map((remote) => {
    const mapped = (map != null && Object.prototype.hasOwnProperty.call(map, remote.origin)) ? map[remote.origin] : null;
    if (mapped == null) return {remote, target: null, transport: remote};
    const u = new URL(mapped.url.href);
    u.pathname = remote.url.pathname;
    u.search = remote.url.search;
    return {remote, target: mapped.target, transport: Object.assign({}, remote, {url: u, shown: `${remote.origin} (${STAND_IN} at ${mapped.target})`})};
  });
  const notes = [];
  const entries = new Map();
  planned.forEach(({remote, target, transport: transportRemote}) => {
    const entry = {remote: remote, client: null, disabled: null, credential: null,
      listing: null, listFailed: false, listing$: null, retried: false};
    if (map != null && target == null) {
      // An acceptance run sends nothing to a real remote: one the map does not
      // cover (a key spelled otherwise, say) is disabled, never contacted.
      entry.disabled = {code: 'REMOTE_CREDENTIAL_NOT_ALLOWED', detail: `${remote.origin}: not covered by --remoteOriginMap; acceptance runs contact mapped origins only`};
      notes.push(`remote ${remote.name}: ${remote.origin} is not covered by --remoteOriginMap; acceptance runs contact mapped origins only, so the remote is disabled`);
      entries.set(remote.name, entry);
      return;
    }
    const credential = byModule
      ? credentials.resolveModuleCredential(remote, process.env, credentials.moduleEntry(moduleName))
      : credentials.resolveCredential(remote, process.env, allowance);
    // Only the transport goes to the local stand-in. Its calls are marked in
    // their usage records and not metered.
    if (target != null) entry.mapped = true;
    const mappedNote = (target != null) ? `, mapped to ${target} (acceptance only)` : '';
    const clientOptions = () => ({timeoutMs: Number(options.remoteTimeout) * 1000,
      maxBytes: Number(options.remoteMaxBytes), debug: options.debug === true, redisEndpoint: configuredRedis()});
    if (credential != null && credential.missing === 'not-allowed' && byModule) {
      // Not bound to this module, or bound for another destination (#413
      // section 6.6): not contacted at all.
      const detail = notAllowedSentence(moduleName, opts.version, credential);
      entry.disabled = {code: 'REMOTE_CREDENTIAL_NOT_ALLOWED', variable: credential.variable, origin: credential.origin, detail: detail};
      notes.push(`remote ${remote.name}: ${detail}; the remote is disabled${mappedNote}`);
    } else if (credential != null && credential.missing === 'not-allowed') {
      // A module cannot choose where a credential goes: not contacted at all.
      entry.disabled = {code: 'REMOTE_CREDENTIAL_NOT_ALLOWED', variable: credential.variable, origin: credential.origin};
      notes.push(`remote ${remote.name}: ${credential.variable} is not allowed for ${credential.origin} by --remoteCredentials; the remote is disabled${mappedNote}`);
    } else if (credential != null && credential.missing === 'unset') {
      // Allowed but empty: disabled for calls; tools/list still runs, with
      // no credential (a server that needs one answers 401, logged).
      entry.disabled = {code: 'REMOTE_CREDENTIAL_MISSING', variable: credential.variable, origin: credential.origin};
      entry.client = createRemoteClient(transportRemote, null, clientOptions());
      entry.listing$ = listInto(moduleName, entry);
      notes.push(`remote ${remote.name}: ${credential.variable} is allowed for ${credential.origin} but not set; the remote is disabled for calls${mappedNote}`);
    } else {
      entry.credential = (credential != null) ? credential.source : null;
      entry.client = createRemoteClient(transportRemote, credential, clientOptions());
      notes.push((credential != null) ? `remote ${remote.name}: sends ${credential.source} to ${remote.origin}${mappedNote}`
        : `remote ${remote.name}: sends no credential to ${remote.origin}${mappedNote}`);
      // At load, without waiting: a laptop can start offline, and the load
      // does not depend on the remote.
      entry.listing$ = listInto(moduleName, entry);
    }
    entries.set(remote.name, entry);
  });
  if (entries.size > 0) registry.set(moduleName, entries);
  const disabled = [...entries.values()].filter((e) => e.disabled != null).map((e) => e.disabled);
  return {problems: [], notes: notes, entries: entries, disabled: disabled};
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
// included), as DeviceManager meters a device hop: charged once, waited for
// at most METER_PENDING_MS (B-hopcharge: lib/metering/charge-bound.js), its
// outcome past that logged when it comes.
// progress: the outer call's notifier, or null (M9): a remote call billed
// under it, in time, is a tick.
function meter(billingKey, tool, progress = null) {
  const CHUtil = require('../countinghouse-util');
  if (CHUtil.ci == null) return Promise.resolve();
  return new Promise((resolve) => boundedCharge(CHUtil.ci, billingKey, tool, options.mcpToolCallCost, (err, result, pending) => {
    if (err != null) LOG.E(chargeLost(tool, billingKey, options.mcpToolCallCost, err));
    else if (!pending && progress != null) progress.tick();
    resolve();
  }, {what: 'remote call'}));
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
    throw new CountinghouseError(entry.disabled.code, entry.disabled.detail != null ? entry.disabled.detail : `${entry.disabled.variable} for ${entry.disabled.origin}`);
  }
  if (typeof(tool) !== 'string' || tool === '' || tool.length > 128) {
    throw new CountinghouseError('REMOTE_ARGS_INVALID', 'the tool name must be a non-empty string');
  }
  const input = (args === undefined) ? {} : args;
  if (!isPlainObject(input)) throw new CountinghouseError('REMOTE_ARGS_INVALID', 'the arguments must be a plain JSON object');
  // R2-1 Task 3: a worker's remote call is billed by the call's token, which
  // the main thread issued to that worker; an unknown, expired or foreign
  // one is refused, after the remote's own checks so a refusal tells a
  // module nothing about a remote it does not declare. A worker states no
  // key (its billing key is the token's entry's, here); only the main
  // thread's own calls (single-thread mode, not a sandbox) state theirs.
  let billingKey = m.billingKey;
  let progress = null;
  if (m.workerId !== undefined) {
    const tokenEntry = callTokens.resolve(m.token, {workerId: m.workerId});
    if (tokenEntry == null) throw new CountinghouseError('CALL_TOKEN_INVALID', `remote:${remoteName}/${tool}`);
    billingKey = tokenEntry.billingKey;
    // the outer call's progress (M9), taken now: the token may be gone by the time it is billed
    progress = callTokens.progressOf(m.token);
  }
  if (billingKey == null) throw new CountinghouseError('HOP_IDENTITY_UNRESOLVED', `remote:${remoteName}/${tool}`);
  // billed to its call's key: it goes out only while that charge can be
  // recorded (the owner's decision, 11-27); the util required here, as
  // meter() does (a require cycle at load)
  const ci = require('../countinghouse-util').ci;
  // (an acceptance stand-in's calls are never charged, below: never refused for it)
  if (entry.mapped !== true && ci != null && typeof(ci.chargeable) === 'function') {
    const refusal = await new Promise((resolve) => ci.chargeable(billingKey, resolve));
    if (refusal != null) throw refusal;
  }
  // Step 5: the tools/call this server call is recorded under. A worker's id
  // is its claim, checked here, after the remote's own checks, so a refusal
  // tells a module nothing about a remote it does not declare
  // (lib/usage/hop.js): an id it was not given is USAGE_CALL_FOREIGN, a
  // finished one goes on unrecorded. The main thread's own (single-thread
  // mode) is taken as given unless its call has finished: single-thread
  // mode is not a sandbox, so a module there shares the process with the
  // recorder and there is no worker boundary to check a claim across.
  const usage = recorder();
  let usageCall = null;
  if (m.workerId !== undefined) {
    const claimed = {usageCall: m.usageCall};
    const refused = checkHop(usage, claimed, m.workerId);   // strips a finished id
    if (refused != null) throw refused;
    usageCall = Number.isInteger(claimed.usageCall) ? claimed.usageCall : null;
  } else if (Number.isInteger(m.usageCall) && !usage.isFinished(m.usageCall)) {
    usageCall = m.usageCall;
  }
  // A listing is never waited for: one that failed at load is started once
  // more here, beside the call, which goes ahead at once (not a retry of
  // the call).
  if (entry.listFailed && !entry.retried) {
    entry.retried = true;
    entry.listFailed = false;
    entry.listing$ = listInto(moduleName, entry);
  }
  const started = Date.now();
  const record = (outcome, result) => {
    if (usageCall == null) return;
    let bytes = 0;
    for (const block of (result != null && Array.isArray(result.content)) ? result.content : []) {
      if (block == null || block.type !== 'text') continue;   // passed, not counted
      bytes += textBytes(block.text);
    }
    // A record never fails the call: an id the main thread never began
    // (single-thread mode, where the module shares the process) is dropped.
    try {
      usage.recordIn(usageCall, {server: remoteName, module: moduleName, tool, bytes, ms: Date.now() - started, outcome, credential: entry.credential, mapped: entry.mapped === true});
    } catch (e) {
      LOG.I(`remote ${remoteName}: no usage record for call ${usageCall}: ${e.message}`);
    }
  };
  // A worker's call is aborted when its token goes (M19, spec section 13:
  // a cancel, or its timeout), so the remote server stops being called for
  // a call nobody is waiting on. An aborted call never answers, so it is
  // not metered below.
  const abort = (m.workerId !== undefined && typeof(m.token) === 'string') ? new AbortController() : null;
  const offDrop = (abort != null) ? callTokens.onDrop(m.token, () => abort.abort(new CountinghouseError('CALL_TOKEN_INVALID', `remote:${remoteName}/${tool}`))) : () => {};
  let result;
  try {
    result = await entry.client.call(tool, input, abort != null ? {signal: abort.signal} : {});
  } catch (e) {
    const err = (abort != null && abort.signal.aborted) ? abort.signal.reason : e;
    record((err != null && typeof(err.code) === 'string') ? err.code : 'REMOTE_PROTOCOL', null);
    throw err;
  } finally {
    offDrop();
  }
  record((result != null && result.isError === true) ? 'isError' : 'ok', result);
  // An acceptance stand-in's calls are not real use: never charged.
  if (entry.mapped !== true) await meter(billingKey, `remote:${remoteName}/${tool}`, progress);
  return result;
}

// A worker's remote-call message, answered for the worker's own module
// (`moduleName`, from the spawn, never from the message), with its usage
// call id checked against the worker that sent it.
function answerRemoteMessage(moduleName, data, workerId) {
  const d = (data != null && typeof(data) === 'object') ? data : {};
  // billed by the call's token: nothing the worker states about a key is read
  return callRemote(moduleName, d.remote, d.tool, d.args, {usageCall: d.usageCall, token: d.token, workerId: workerId});
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

module.exports = {register, unregister, callRemote, answerRemoteMessage, listing, toolNamesText, NAMES_SHOWN, NAME_MAX};
