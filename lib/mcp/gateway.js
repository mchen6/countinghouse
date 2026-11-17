'use strict';
// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
const path          = require('path');
const execFile      = require('child_process').execFile;
const userAuth      = require('../user-auth');
const toolRegistry  = require('./tool-registry');
const JobControl    = require('../store').jobs;   // the store's job runner (lib/store.js)
const options       = require('../cli-options');
const pages         = require('./pages');
const promptsLib     = require('./prompts');
const taskTombstones = require('../task-tombstones');
const resourcesLib   = require('./resources');
const resourceUri    = require('./resource-uri');
const completionLib  = require('./completion');
const {declaredText} = require('../schema-safety');
const planValidator = require('../plan-validator');
const LOG           = require('../logger');
const encodeLegacyTool = require('../metering/provider').encodeLegacyTool;
const rateLimitGate = require('../rate-limit-gate');
const outputSchemaHash = require('./output-schema-hash').outputSchemaHash;
const {blockFields} = require('../binary-fields');
const resultContent = require('./result-content');
const progressLib = require('./progress');
const era = require('./era');

const PROTOCOL_VERSION = '2026-07-28';
// the newest revision with an initialize handshake: an initialize naming no
// version gets it
const LEGACY_VERSION   = '2025-11-25';
const SERVER_NAME      = 'countinghouse';
const SERVER_VERSION   = require('../../package.json').version;
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const usageRuntime = require('../usage/runtime');
const {usageReport} = require('../usage/report');
const {finishToolCall, receiptReserved} = require('../usage/receipt');
const {taskHooks, addTaskReceipt} = require('../usage/task');

// required on first use, then kept (lib/require-once.js): no require() on the call path
const requireOnce = require('../require-once');
const identityLib = requireOnce(() => require('../identity'));
const sessionsLib = requireOnce(() => require('../sessions'));
const sessionScopeLib = requireOnce(() => require('../session-scope'));
const sessionSettingsLib = requireOnce(() => require('../session-settings'));
const callLimitsLib = requireOnce(() => require('../call-limits'));
const moduleAskLib = requireOnce(() => require('../module-ask'));
const requestStateLib = requireOnce(() => require('../request-state'));
const storeLib = requireOnce(() => require('../store'));
const callTokensLib = requireOnce(() => require('../call-tokens'));

const JSONRPC_PARSE_ERROR      = -32700;
const JSONRPC_INVALID_REQUEST  = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS   = -32602;
const JSONRPC_INTERNAL_ERROR   = -32603;

function errorResponse(id, code, message, data) {
  const error = {code: code, message: message};
  if (data !== undefined) error.data = data;
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: error};
}

function resultResponse(id, result) {
  return {jsonrpc: '2.0', id: id, result: result};
}

// This server's request/response handling has no version-specific branches --
// tools/list and tools/call are shaped the same way regardless of which
// protocolVersion the client negotiates. So instead of unilaterally forcing
// our own preferred version and refusing anything else, we echo back whatever
// version the client asked for in its `initialize` call: cheap to support,
// and it keeps us working with clients built against slightly different spec
// dates without a hardcoded compatibility table to maintain.
// Tasks (job-control mapped onto MCP's tasks/* extension) only work when the
// server is running in multi-thread mode -- lib/job-control.js's addJob/getJob/
// removeJob/listJobs all require options.workerThread === true (job execution
// happens by shipping the action call to a worker thread), so the capability
// is only advertised, and tasks/* only answered, when that's the case.
function tasksSupported() {
  return options.workerThread === true;
}

// The tasks extension for 2026-07-28 clients (MCP completeness M15, spec
// section 9). A request declares it in its _meta's clientCapabilities.
const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const TASK_POLL_INTERVAL_MS = 2000;
const MISSING_REQUIRED_CAPABILITY = -32021;
function declaresTasks(params) {
  const meta = (params != null && typeof(params._meta) === 'object') ? params._meta : null;
  const caps = (meta != null) ? meta['io.modelcontextprotocol/clientCapabilities'] : null;
  const ext = (caps != null && typeof(caps) === 'object' && caps.extensions != null && typeof(caps.extensions) === 'object') ? caps.extensions[TASKS_EXTENSION] : null;
  return ext != null && typeof(ext) === 'object' && !Array.isArray(ext);
}
// a task's ttlMs: the job timeout and the result's retention under --store
// local; null under Redis, where a finished job is kept
function taskTtlMs() {
  return options.store === 'local' ? (options.jobTimeout + options.jobResultTtl) : null;
}

// Resolves the caller's apiKey into the {appKey, isAdmin} identity context
// lib/job-control.js's ownership gate expects -- and, for the platform
// check-balance tool, simply to prove the key is real before answering.
//
// deviceID/serviceID/actionName are all null: a task is addressed by taskId,
// and which device it happens to target is not what authorizes reading it --
// ownership is (the creator's apiKey). This is the same device-independent
// use of doUserAuth that lib/routes/admin-only.js already makes, and it is
// what supplies `isAdmin`, which is the only way to legitimately read across
// tenants. A null/unknown apiKey fails here (SYSTEM_ERROR_UNKNOWN_USER),
// which is why every tasks/* method below now requires a key at all --
// previously none of them took one.
//
// Under --debug this returns isAdmin: true for any key (lib/user-auth.js's
// debug branch), so debug-mode callers keep seeing every task, consistent
// with every other capability that mode bypasses.
// The opaque caller id of a key (R2-1's u_..., never the key or a user name),
// for the usage records; null when there is no key or no identity yet.
// the result store (M6): made on first use, as every part of the store is
const blobsOf = () => require('../store').getStore().blobs;

function opaqueCallerOf(appKey) {
  if (appKey == null) return null;
  try {
    return identityLib().idForKey(appKey);
  } catch (_) {
    return null;
  }
}

function resolveCallerIdentity(appKey, callback) {
  userAuth(null, null, null, appKey, null, null, () => {}, (err, session) => {
    if (err != null) return callback(err);
    return callback(null, {appKey: session.appKey, isAdmin: session.isAdmin === true, userName: session.username});
  });
}

// resolveCallerIdentity plus the per-apiKey rate-limit check, in that order
// -- the limiter is keyed on the *resolved* appKey, so it cannot run before
// identity does, and running it on the raw header would let a caller spend
// another tenant's budget by quoting their key.
//
// The four tasks/* methods share this rather than each repeating the pair,
// so a fifth one cannot be added later that resolves identity and quietly
// forgets the limit -- the shape that left these four unlimited (and, before
// 2026-08-11, unauthenticated) in the first place.
//
// The denial reuses JSONRPC_INTERNAL_ERROR because JSON-RPC 2.0 defines no
// code for this condition and it is the same code these handlers already
// answer an auth failure with; the message is what distinguishes it.
function resolveGatedIdentity(req, cdifInterface, appKey, callback, next) {
  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
    return rateLimitGate.check(cdifInterface, authCtx.appKey, (limited) => {
      if (limited === true) {
        return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, 'rate limit exceeded'));
      }
      return next(authCtx);
    });
  });
}

// opts.listChanged: the transport can tell the client when the tool list
// changes (--stdio, lib/route-manager.js); HTTP cannot, so it never declares it.
// What this server offers. modern: server/discover's (2026-07-28), which
// declares neither tools.listChanged nor logging: that revision sends
// list_changed only on a subscriptions/listen stream, which isn't served yet,
// and it removes logging/setLevel.
function serverCapabilities(opts, modern) {
  const stdio = opts != null && opts.listChanged === true;
  // a shared runtime's session: its notices are its own (B2 Task 3)
  const session = opts != null && opts.session != null;
  // modern: list_changed on a subscriptions/listen stream, where the
  // transport serves one (#231)
  const listens = modern && opts != null && opts.subscriptions != null;
  const capabilities = {tools: ((stdio && !modern) || listens) ? {listChanged: true} : {}};
  // stored results are read back with resources/read (M6, spec section 2),
  // never listed; modules' resources are listed and read (M7, section 3).
  // listChanged and subscribe come with M8.
  capabilities.resources = {};
  // the modules' declared prompts (M10, spec section 7); their list notices
  // come with M8
  capabilities.prompts = {};
  // completion of a prompt's arguments from their schemas (M11)
  capabilities.completions = {};
  // stdio and a session: pack changes are announced with
  // notifications/message (lib/notices.js)
  if ((stdio || session) && !modern) capabilities.logging = {};
  // the tasks extension for a 2026-07-28 client (M15), where jobs can run; a
  // shared runtime's session's tasks are its own (B5 Task 2)
  if (modern && tasksSupported() === true) capabilities.extensions = {[TASKS_EXTENSION]: {}};
  // the legacy era's tasks capability; 2026-07-28 has the extension above
  if (!modern && tasksSupported() === true) {
    capabilities.tasks = {
      list:   {},
      cancel: {},
      requests: {tools: {call: {}}}
    };
  }
  return capabilities;
}

// server/discover (2026-07-28: "Servers MUST implement it"): the versions
// served per request, the capabilities and the server's identity.
function handleDiscover(req, callback, opts) {
  return callback(null, resultResponse(req.id, {
    resultType: 'complete',
    supportedVersions: era.SUPPORTED_VERSIONS.slice(),
    capabilities: serverCapabilities(opts, true),
    // caching hints (MUST on discover): the same for every caller; stale at
    // once, since an upgrade or a restart can change it
    ttlMs: 0,
    cacheScope: 'public',
    _meta: {'io.modelcontextprotocol/serverInfo': {name: SERVER_NAME, version: SERVER_VERSION}}
  }));
}

// subscriptions/listen (2026-07-28, basic/patterns/subscriptions.md; #231):
// the one notification type served is tools/list_changed. The transport
// opens the stream (opts.openStream: SSE over HTTP, lines on stdio). The
// acknowledgement goes first ("MUST send notifications/subscriptions/
// acknowledged as the first message carrying the subscription's ID"),
// naming only what is served. The stream's close cancels; the hub's endAll
// answers the request with resultType complete.
const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
function handleListen(req, cdifInterface, appKey, callback, opts) {
  const wanted = req.params != null ? req.params.notifications : undefined;
  if (wanted == null || typeof(wanted) !== 'object' || Array.isArray(wanted)) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.notifications is an object naming the notifications wanted'), {status: 400});
  }
  // the caller's key resolved and rate-limited as tasks/* are, before any
  // stream opens; a subscription counts against the RESOLVED key
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    const {MAX_PER_KEY, MAX_PER_SESSION, MAX_TOTAL} = require('./subscriptions');
    const hub = opts.subscriptions;
    const agreed = wanted.toolsListChanged === true ? {toolsListChanged: true} : {};
    const ack = {jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: {notifications: agreed, _meta: {[SUBSCRIPTION_ID_KEY]: req.id}}};
    const done = () => callback(null, resultResponse(req.id, {resultType: 'complete', _meta: {[SUBSCRIPTION_ID_KEY]: req.id}}));
    // agreeing to nothing holds no slot: acknowledged, then ended
    if (agreed.toolsListChanged !== true) {
      const stream = opts.openStream();
      stream.write(ack);
      return done();
    }
    let ended = false;
    const write = (m) => stream.write(m);
    // on a shared runtime, a session's own: its limit and its tool list
    const session = (opts.session != null && typeof(opts.session.id) === 'string') ? opts.session.id : null;
    const opened = hub.open({id: req.id, appKey: authCtx.appKey, session, filter: agreed, write: (m) => write(m),
      finish: () => {
        if (ended) return;
        ended = true;
        done();
      }});
    if (!opened.ok) {
      const total = opened.reason === 'total';
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, total
        ? `at most ${MAX_TOTAL} subscriptions are open at once on this runtime`
        : (session != null ? `at most ${MAX_PER_SESSION} subscriptions are open at once for one session` : `at most ${MAX_PER_KEY} subscriptions are open at once for one key`),
      {[ERROR_CODE_META_KEY]: 'TOO_MANY_SUBSCRIPTIONS', retryable: true}), {status: total ? 503 : 429});
    }
    const stream = opts.openStream();
    stream.write(ack);
    // a close (HTTP), or notifications/cancelled naming it (stdio), cancels:
    // the subscription goes, and the request is never answered
    stream.onClose(() => {
      if (ended) return;
      ended = true;
      opened.close();
      callback(null, null);
    });
    return undefined;
  });
}

// The legacy handshake (2025-11-25 and earlier): "An initialize request
// selects legacy semantics". It echoes the client's version, as before.
function handleInitialize(req, cdifInterface, callback, opts) {
  const params = req.params || {};
  const negotiatedVersion = (typeof(params.protocolVersion) === 'string' && params.protocolVersion !== '')
    ? params.protocolVersion
    : LEGACY_VERSION;

  const capabilities = serverCapabilities(opts, false);

  return callback(null, resultResponse(req.id, {
    protocolVersion: negotiatedVersion,
    capabilities: capabilities,
    serverInfo: {
      name:    SERVER_NAME,
      version: SERVER_VERSION
    }
  }));
}

function handlePing(req, cdifInterface, callback) {
  return callback(null, resultResponse(req.id, {}));
}

// One page of the caller's tools/list (MCP completeness M1, spec section 5;
// lib/mcp/pages.js): the whole list's order is derived again for this caller
// -- the platform tools, the granted devices' actions, then, for an admin,
// the authoring tools -- and the page is cut from it, so only the page's own
// schemas are resolved. A cursor is a position in that list and nothing
// more: anything that names none is the one -32602. opts.wholeList (the
// change notices' fingerprints, never a client's request) answers the whole
// list in one.
function handleToolsList(req, cdifInterface, appKey, callback, modern = false, opts) {
  const whole = opts != null && opts.wholeList === true;
  const cursor = req.params != null ? req.params.cursor : undefined;
  let anchor;
  if (!whole && cursor != null) {
    anchor = pages.decodeCursor('tools', cursor);
    if (anchor == null) return callback(null, invalidCursor(req));
  }
  // the session's own view (B3 Task 3): a pack it doesn't list is not in it.
  // In shared mode a session that isn't live gets nothing, as its tools/call
  // does (the reviewer's ruling (6) on #340)
  const session = sessionIdOf(opts);
  if (session === undefined) return callback(null, resultResponse(req.id, {tools: []}));
  toolRegistry.listEntries(cdifInterface, appKey, (err, entries) => {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    withAuthoringTools(appKey, entries, (listed) => {
      let entriesOfPage = listed;
      let next = null;
      if (!whole) {
        const cut = pages.page(listed.map((e) => e.name), anchor, options.listPageSize);
        if (cut == null) return callback(null, invalidCursor(req));
        entriesOfPage = listed.slice(cut.from, cut.to);
        next = cut.next;
      }
      toolRegistry.toolsFor(cdifInterface, appKey, entriesOfPage, (err, tools) => {
        if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
        // and by bytes (M2): the page ends before the tool that would take it
        // past pages.MAX_PAGE_BYTES, and the next one starts after the last
        // tool it kept
        if (!whole) {
          const kept = pages.fitting(tools);
          if (kept < tools.length) {
            tools = tools.slice(0, kept);
            next = tools[kept - 1].name;
          }
        }
        const result = {tools};
        if (next != null) result.nextCursor = pages.encodeCursor('tools', next);
        return callback(null, resultResponse(req.id, result));
      }, {modern});
    });
  }, {session: session == null ? null : session});
}

// One page of the caller's prompts (M10, spec section 7): the same paging as
// tools/list (M1's cursor, kind 'prompts', and M2's byte cut).
function handlePromptsList(req, cdifInterface, appKey, callback, opts) {
  const cursor = req.params != null ? req.params.cursor : undefined;
  let anchor;
  if (cursor != null) {
    anchor = pages.decodeCursor('prompts', cursor);
    if (anchor == null) return callback(null, invalidCursor(req));
  }
  // the session's own (B3 Task 3): a pack it hasn't on is not in it. A
  // session that isn't live gets nothing (the reviewer's ruling (6))
  const session = sessionIdOf(opts);
  if (session === undefined) return callback(null, resultResponse(req.id, {prompts: []}));
  promptsLib.listEntries(cdifInterface, appKey, (err, entries) => {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    const cut = pages.page(entries.map((e) => e.name), anchor, options.listPageSize);
    if (cut == null) return callback(null, invalidCursor(req));
    Promise.all(entries.slice(cut.from, cut.to).map((e) => promptsLib.describe(cdifInterface, e))).then((listed) => {
      let next = cut.next;
      const kept = pages.fitting(listed);
      if (kept < listed.length) {
        listed = listed.slice(0, kept);
        next = listed[kept - 1].name;
      }
      const result = {prompts: listed};
      if (next != null) result.nextCursor = pages.encodeCursor('prompts', next);
      return callback(null, resultResponse(req.id, result));
    }, (e) => callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, `the prompts could not be listed (${(e && e.name) || 'Error'})`)));
  }, {session: session == null ? null : session});
}

// completion/complete (M11, spec section 7), for a prompt's argument: the
// candidates its schema declares (its enum, then its examples, derived at
// load), matched to the value typed so far. No module code runs. A ref the
// caller isn't listed is the answer an unknown one gets, so completion can't
// be used to find another tenant's prompts; rate limited as any request. A
// resource template's (ref/resource) come with module resources (M7): until
// then no template is listed, so every one is unknown.
const COMPLETION_REF = 'params.ref must be {type: "ref/prompt", name} or {type: "ref/resource", uri}';
const COMPLETION_ARGUMENT = 'params.argument must be {name, value}, both strings';
const UNKNOWN_TEMPLATE = 'unknown resource template';
const UNKNOWN_ARGUMENT = 'unknown argument';
function handleCompletion(req, cdifInterface, appKey, callback, opts) {
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    const p = (req.params != null && typeof(req.params) === 'object') ? req.params : {};
    const ref = p.ref;
    const arg = p.argument;
    const isObj = (x) => x != null && typeof(x) === 'object' && !Array.isArray(x);
    if (!isObj(ref) || typeof(ref.type) !== 'string') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, COMPLETION_REF));
    if (!isObj(arg) || typeof(arg.name) !== 'string' || typeof(arg.value) !== 'string') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, COMPLETION_ARGUMENT));
    if (ref.type === 'ref/resource') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, UNKNOWN_TEMPLATE));
    if (ref.type !== 'ref/prompt' || typeof(ref.name) !== 'string') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, COMPLETION_REF));
    // a prompt of a pack the session hasn't on is no more than an unknown name (B3 Task 3)
    const session = sessionIdOf(opts);
    promptsLib.listEntries(cdifInterface, authCtx.appKey, (err, entries) => {
      if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      const entry = session === undefined ? null : entries.find((e) => e.name === ref.name);
      if (entry == null) return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, UNKNOWN_PROMPT));
      let answered = false;
      const answer = (response) => { answered = true; callback(null, response); };
      promptsLib.candidatesOf(entry, arg.name).then((candidates) => {
        if (candidates == null) return answer(errorResponse(req.id, JSONRPC_INVALID_PARAMS, UNKNOWN_ARGUMENT));
        return answer(resultResponse(req.id, {completion: completionLib.match(candidates, arg.value)}));
      }).catch((e) => {
        // a derivation that failed is the server's, never "unknown argument";
        // a throw after the answer (the transport's) is logged, never left
        // an unhandled rejection
        if (!answered) return answer(errorResponse(req.id, JSONRPC_INTERNAL_ERROR, 'the prompt\'s completions could not be read'));
        try { require('../logger').E(e); } catch (_) { /* no logger */ }
        return undefined;
      });
    }, {session: session == null ? null : session});
  });
}

// prompts/get (M10, spec section 7): no module code runs. Rate limited and
// counted in the usage records, never billed. An unknown name and a prompt
// not listed to the caller are one answer.
const UNKNOWN_PROMPT = 'unknown prompt';
const PROMPT_ARGUMENTS_SHAPE = 'params.arguments must be an object whose values are strings';
function handlePromptsGet(req, cdifInterface, appKey, callback, opts) {
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    const name = req.params != null ? req.params.name : undefined;
    const given = req.params != null ? req.params.arguments : undefined;
    // a prompt of a pack the session hasn't on is no more than an unknown name (B3 Task 3)
    const session = sessionIdOf(opts);
    promptsLib.listEntries(cdifInterface, authCtx.appKey, (err, entries) => {
      if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      // a session that isn't live knows no prompt (the reviewer's ruling (6))
      const entry = (typeof(name) === 'string' && session !== undefined) ? entries.find((e) => e.name === name) : null;
      if (entry == null) return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, UNKNOWN_PROMPT));
      const args = (given === undefined) ? {} : given;
      if (args == null || typeof(args) !== 'object' || Array.isArray(args) || Object.values(args).some((v) => typeof(v) !== 'string')) {
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, PROMPT_ARGUMENTS_SHAPE));
      }
      const startedMs = Date.now();
      const caller = opaqueCallerOf(authCtx.appKey);
      // counted in the usage records, refused or answered (never billed):
      // a scenario's under its pack, as a tool call is
      const record = (outcome, bytes, code) => {
        try {
          const usage = usageRuntime.usage();
          const call = usage.beginCall({pack: entry.role === 'scenario' ? entry.module : null, module: entry.module, tool: 'prompts/get', caller, session: sessionsLib().forUsage(sessionIdOf(opts))});
          usage.recordOut(call, {tool: 'prompts/get', bytes, lines: 0, ms: Math.max(0, Date.now() - startedMs), outcome, code});
        } catch (e) {
          try { LOG.E(e); } catch (_) { /* no logger: the answer still goes */ }
        }
      };
      const TOO_LARGE = 'the prompt\'s result would be over 64 KiB; a prompt\'s result is at most 64 KiB';
      // its text's size first, from the arguments' lengths: nothing is
      // checked or built for a request over the bound (the review of #321)
      if (promptsLib.overBound(entry.prompt, args, promptsLib.MAX_RESULT_BYTES)) {
        record('error', 0, 'OUTPUT_TOO_LARGE');
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, TOO_LARGE));
      }
      // every path answers, once: a throw in the answer's own handler too
      let answered = false;
      const answer = (response) => {
        if (answered) return;
        answered = true;
        callback(null, response);
      };
      const unchecked = () => answer(errorResponse(req.id, JSONRPC_INTERNAL_ERROR, 'the prompt\'s arguments could not be checked'));
      promptsLib.checkArguments(entry, args, caller).then((checked) => {
        if (Array.isArray(checked)) {
          // the validators refused the check itself: this caller throttled, or the module quarantined
          const code = checked[0] != null && typeof(checked[0].code) === 'string' ? checked[0].code : null;
          return answer(errorResponse(req.id, JSONRPC_INTERNAL_ERROR, `the prompt's arguments could not be checked now${code != null ? ` (${code})` : ''}`));
        }
        if (checked != null && checked.timeout != null) {
          // its check ran past its deadline: the code, as a refusal's
          const code = typeof(checked.timeout.code) === 'string' ? checked.timeout.code : 'VALIDATION_TIMEOUT';
          return answer(errorResponse(req.id, JSONRPC_INTERNAL_ERROR, `the prompt's arguments could not be checked now (${code})`));
        }
        if (checked == null || checked.errors === undefined) return unchecked();
        if (checked.errors != null) {
          record('error', 0, 'INPUT_DATA_VALIDATION_FAIL');
          // the module's schema's words: cut and cleaned, and few (the review of the M10 plan)
          const said = checked.errors.map((e) => declaredText(`${e.instancePath === '' ? '(arguments)' : e.instancePath} ${e.message}`)).join('; ');
          return answer(errorResponse(req.id, JSONRPC_INVALID_PARAMS, `invalid arguments: ${said}`.slice(0, 2048)));
        }
        const result = {};
        if (typeof(entry.prompt.description) === 'string') result.description = entry.prompt.description;
        let bytes;
        try {
          result.messages = promptsLib.render(entry.prompt, args);
          bytes = Buffer.byteLength(JSON.stringify(result));
        } catch (e) {
          try { LOG.E(e); } catch (_) { /* no logger: the answer still goes */ }
          // (a string past the engine's length is a RangeError)
          record('error', 0, (e instanceof RangeError) ? 'OUTPUT_TOO_LARGE' : null);
          return answer(errorResponse(req.id, JSONRPC_INTERNAL_ERROR, `the prompt's result could not be built (${(e && e.name) || 'Error'})`));
        }
        // the bound again, on the answer as sent (escaping can add to it)
        if (bytes > promptsLib.MAX_RESULT_BYTES) {
          record('error', 0, 'OUTPUT_TOO_LARGE');
          return answer(errorResponse(req.id, JSONRPC_INVALID_PARAMS, `the prompt's result is ${bytes} bytes; a prompt's result is at most 64 KiB`));
        }
        record('ok', bytes);
        return answer(resultResponse(req.id, result));
      }).catch((e) => {
        try { LOG.E(e); } catch (_) { /* no logger: the answer still goes */ }
        unchecked();
      });
    }, {session: session == null ? null : session});
  });
}

// Authoring tools are appended rather than built into listEntries because
// listing them needs isAdmin, which only this layer resolves.
function withAuthoringTools(appKey, entries, next) {
  if (options.getOptions().authoringTools !== true || options.singleIdentity === true) return next(entries);
  return resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null || authCtx.isAdmin !== true) return next(entries);
    return next(entries.concat(toolRegistry.AUTHORING_TOOLS.map((tool) => ({name: tool.name, tool}))));
  });
}

// every cursor that names no position in the caller's list, alike
function invalidCursor(req) {
  return errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'invalid cursor');
}

const ERROR_CODE_META_KEY = 'countinghouse/code';

// The success result of a module tool. A handler returns {output: <result>};
// MCP clients get <result> itself. With an outputSchema (resolved by
// toolRegistry.resolveOutputSchema, the same lookup tools/list advertises
// from) it is structuredContent and, serialized, the text block. Without one
// the result is text only: a string as-is, nothing as an empty text block,
// anything else as JSON. ctx.call and HTTP invoke-action keep {output}.
// With binary fields that make blocks (M4 and M6, lib/mcp/result-content.js):
// structuredContent and the text block hold a reference for each image or
// audio value, and each value follows as its own block, in schema order.
// `who` names the module and action in TOO_MANY_BINARY_VALUES.
// Any JSON value (M20): with a schema the era sees, structuredContent is the
// output whatever its type, and the text block a string output itself, else
// its JSON. rawSchema, the module's own: a whole output that is an image or
// audio, for a legacy request (no schema advertised to it), is that one
// block and no text block (spec section 1).
// rawSchema is the module's own output schema; what the request's era sees
// of it (toolRegistry.forEra) is derived here, so every caller -- a call, a
// task's result, its completion -- shapes alike. A legacy request, which is
// advertised no schema for a non-object output, still gets each image or
// audio value as its block: a whole output that is one is that block and no
// text block (spec section 1); values nested under a non-object root are the
// text of their references, then the blocks.
const textOf = (v) => (typeof(v) === 'string' ? v : JSON.stringify(v));
// M6 (spec section 2): the module's result with its binary values placed
// (lib/mcp/result-content.js). moduleToolResult plans, stores what it must
// as `place.owner`'s (the outer call's opaque caller id) and builds; a
// store that fails (RESULT_STORE_FULL) is the call's error, with nothing
// left stored. moduleToolResultWith builds from URIs stored already (a
// task's, kept with its job at completion), storing nothing.
async function moduleToolResult(data, rawSchema, who = {module: 'module', action: 'action'}, modern = false, place = {}) {
  let uris = {};
  let entries = null;
  try {
    entries = (rawSchema != null && blockFields(rawSchema).length > 0)
      ? resultContent.plan(data != null ? data.output : undefined, rawSchema, who, {inlineBytes: options.inlineContentBytes}) : null;
    if (entries != null && entries.some((e) => e.store)) {
      uris = await resultContent.store(entries, {blobs: place.blobs, owner: place.owner, session: place.session != null ? place.session : null, source: {module: who.module, tool: who.tool}});
    }
  } catch (e) {
    return toolCallResult(e);
  }
  return moduleToolResultWith(data, rawSchema, who, modern, uris, entries);
}

// entries: the plan already made for this output and schema, if any (a
// result is planned once per call)
function moduleToolResultWith(data, rawSchema, who = {module: 'module', action: 'action'}, modern = false, uris = {}, planned = null) {
  const output = (data != null) ? data.output : undefined;
  const outputSchema = toolRegistry.forEra(rawSchema, modern);
  // outputSchema is rawSchema itself or null (forEra), so a plan made for
  // rawSchema is this one's
  const reshape = (out, schema) => {
    const entries = planned != null ? planned : resultContent.plan(out, schema, who, {inlineBytes: options.inlineContentBytes});
    return entries == null ? null : resultContent.assemble(out, entries, uris);
  };
  if (outputSchema == null && rawSchema != null && blockFields(rawSchema).length > 0) {
    let shaped = null;
    try {
      shaped = reshape(output, rawSchema);
    } catch (e) {
      return toolCallResult(e);
    }
    if (shaped != null && shaped.blocks.length > 0) {
      if (blockFields(rawSchema).some((f) => f.path.length === 0)) return {isError: false, content: shaped.blocks};
      return {isError: false, content: [{type: 'text', text: JSON.stringify(shaped.structured)}, ...shaped.blocks]};
    }
  }
  if (outputSchema != null) {
    let shaped = null;
    try {
      shaped = reshape(output, outputSchema);
    } catch (e) {
      return toolCallResult(e);
    }
    if (shaped != null) {
      return {isError: false, content: [{type: 'text', text: JSON.stringify(shaped.structured)}, ...shaped.blocks], structuredContent: shaped.structured};
    }
    return {isError: false, content: [{type: 'text', text: textOf(output)}], structuredContent: output};
  }
  let text;
  if (typeof(output) === 'string') text = output;
  else if (output == null) text = '';
  else text = JSON.stringify(output);
  return {isError: false, content: [{type: 'text', text: text}]};
}

// shapes a plain (err, data) result the way every tools/call response is
// shaped -- content/isError/structuredContent -- shared by the platform
// check-balance tool, the regular device-tool invoke path, and tasks/result.
function toolCallResult(err, data) {
  if (err != null) {
    const result = {
      isError: true,
      content: [{type: 'text', text: (err.message != null ? err.message : String(err))}]
    };
    // A CountinghouseError carries a locale-independent `code` (see Sprint 4's
    // worker-message.js fix, which is what makes `code` survive a cross-worker
    // hop intact). HTTP invoke-action responses already expose it
    // (lib/session.js); surface it here too via structuredContent so MCP
    // clients get the same locale-independent error classification instead
    // of having to pattern-match translated message text. Plain Error
    // objects (request-validation failures raised in this file) have no
    // `code`, so they're unaffected.
    //
    // The code rides in _meta, never in structuredContent: MCP clients
    // validate structuredContent against the tool's outputSchema even on an
    // error result (the official SDK does), and an error code object would
    // fail any strict one. "countinghouse/" is the key's prefix, per MCP's
    // _meta key rules (an optional prefix ending in "/"; "mcp"/
    // "modelcontextprotocol" prefixes are reserved).
    if (err.code != null) result._meta = {[ERROR_CODE_META_KEY]: err.code};
    return result;
  }
  return {
    isError: false,
    content: [{type: 'text', text: JSON.stringify(data == null ? {} : data)}],
    structuredContent: (data == null ? {} : data)
  };
}

// Bound for polling for a just-loaded module's devices after
// countinghouse_load_module (see the comment at its call site for why a
// single synchronous read isn't enough under --workerThread). Generous
// relative to the actual round trip (a worker message hop, not real I/O),
// but bounded so a module whose device never comes online doesn't hang the
// tool call indefinitely -- see waitForModuleTools' discoveryComplete for
// how a caller tells that case apart from "loaded, no tools".
const LOAD_MODULE_DISCOVERY_TIMEOUT_MS = 3000;
const LOAD_MODULE_DISCOVERY_POLL_MS    = 50;

// Bound on loadModuleFromPath's own callback -- the load itself, not the
// post-load discovery wait above (that one already has its own bound).
// Mirrors VALIDATE_CHILD_TIMEOUT_MS's role for the sibling tool, but for a
// different reason: countinghouse_load_module cannot run the module under
// test in a disposable child process (it has to land in the live runtime to
// be callable), so there is no child process to time out and kill out from
// under a hanging module -- only this callback to give up waiting on.
// Verified live against test/fixtures/handler-map-process-exit under
// --workerThread: loadModuleFromPath's callback never fires (the worker
// thread survives the module's process.exit(), so nothing ever reports
// failure back up), and without this bound the tool call hung past 100s.
// This is the tool call's answer deadline only. The worker itself is bounded
// by --moduleLoadTimeout (#144, default 120 s; lib/module-manager.js): with
// the default the tool answers first and the worker is ended later; with a
// bound under 15 s the load's own MODULE_LOAD_TIMEOUT is the answer.
const LOAD_MODULE_TIMEOUT_MS = 15000;

// The deviceIDs this specific module instance currently owns -- not a
// global before/after diff (see the C2 fix note at the call site for why a
// diff is wrong on reload). Two shapes, matching getAllDeviceSpecs'
// (tool-registry.js) own worker-vs-not branch:
//  - worker-thread mode: `moduleInstance` IS the WorkerMessage returned by
//    loadModuleFromPath's callback, and DeviceManager.onWorkerLoaded (see
//    device-manager.js) keeps its own .deviceList map current as
//    'deviceonline' messages arrive from the worker -- including, on a
//    reload, the entries already recorded by the *previous* load, which is
//    what makes reload's answer available instantly rather than needing a
//    fresh wait.
//  - non-worker-thread mode: `moduleInstance` has no .deviceList of its own;
//    DeviceManager.onDeviceOnline instead tags each CHDevice it adds to
//    deviceMap with `.module` pointing back at the owning moduleInstance
//    (module-manager.js's onDeviceOnline is the source of that reference),
//    so deviceMap is filtered by identity instead.
function moduleDeviceIDs(cdifInterface, moduleInstance) {
  if (moduleInstance != null && moduleInstance.deviceList != null) {
    return Object.keys(moduleInstance.deviceList);
  }
  const deviceMap = cdifInterface.deviceManager.deviceMap;
  const ids = [];
  for (const deviceID in deviceMap) {
    if (deviceMap[deviceID] != null && deviceMap[deviceID].module === moduleInstance) ids.push(deviceID);
  }
  return ids;
}

function toolNamesForDeviceIDs(cdifInterface, deviceIDs) {
  const idSet = {};
  deviceIDs.forEach((id) => { idSet[id] = true; });
  const targets = toolRegistry.buildToolTargets(cdifInterface);
  return Object.keys(targets).filter((n) => idSet[targets[n].deviceID] === true);
}

// Polls until this module has at least one device online, or the deadline
// passes. discoveryComplete is keyed off *device* presence, not tool-name
// presence, on purpose: a device that came online but exposes zero
// MCP-describable actions (buildToolTargets skips actions with no
// description) is a confirmed "this module has nothing to call" --
// discoveryComplete: true, toolNames: [] -- genuinely different from
// "discovery hasn't finished yet" -- discoveryComplete: false, toolNames: []
// -- which a bare empty array can't tell apart on its own.
function waitForModuleTools(cdifInterface, moduleInstance, deadline, callback) {
  const deviceIDs = moduleDeviceIDs(cdifInterface, moduleInstance);
  if (deviceIDs.length > 0 || Date.now() >= deadline) {
    return callback({
      discoveryComplete: deviceIDs.length > 0,
      toolNames:         toolNamesForDeviceIDs(cdifInterface, deviceIDs)
    });
  }
  return setTimeout(() => waitForModuleTools(cdifInterface, moduleInstance, deadline, callback), LOAD_MODULE_DISCOVERY_POLL_MS);
}

// Every authoring tool takes the same two gates: the flag, then admin. These
// gates are load-bearing for all four tools today, not preparation for
// something still to come -- countinghouse_load_module loads caller-supplied
// code, and countinghouse_validate_module requires it too: in a discarded
// sandboxed worker under audit and enforce (lib/module-manager.js
// validateModuleSandboxed), in a clean-environment child process otherwise
// (validateModuleInChildProcess below; review R1-4) -- --authoringTools plus an admin key is what stands
// between a caller and either of them, not a UX nicety over an already-safe
// tool.
//
// A disabled tool answers exactly like an unknown one -- a caller without the
// flag should not be able to tell the feature exists. That property has to
// hold one gate deeper too: a caller whose identity doesn't even resolve
// (no key, or a key AuthProvider doesn't recognize) gets the *identical*
// unknown-tool errorResponse an unregistered name would produce, not a
// distinct auth-failure result -- otherwise the shape of the response
// becomes a second oracle for which of the four reserved names exist, one
// gate past the flag check. ADMIN_REQUIRED below is reserved for a caller
// who *did* authenticate but isn't admin -- that caller has already proven
// they're a real, resolvable identity, so there's no reconnaissance value
// left to protect by hiding the tool's existence from them.
// bin/countinghouse-validate.js run with --json, invoked with
// process.execPath rather than relying on PATH/the shebang -- this must run
// under the exact same Node binary already running the gateway, not
// whatever `node` PATH happens to resolve to (which is not guaranteed to be
// the same version, or even present).
const VALIDATE_CLI_PATH = path.join(__dirname, '..', '..', 'bin', 'countinghouse-validate.js');

// Generous relative to what a well-behaved module's own require() work
// costs (real disk I/O, not network), but bounded: a module whose entry
// hangs (an infinite loop, a never-resolving promise chain during a
// synchronous require) must not hang this tool call, or the caller,
// forever. execFile below sends SIGTERM to the child once this elapses.
const VALIDATE_CHILD_TIMEOUT_MS = 15000;

// Scans from the END of the child's stdout for the last line that parses as
// JSON, rather than trying to JSON.parse the whole (trimmed) stream as one
// blob. bin/countinghouse-validate.js's --json mode always emits its result
// as exactly one console.log call, so it is always the last line WHEN
// nothing else got past its own stdout capture -- but that capture only
// intercepts process.stdout.write; a module under test using
// fs.writeSync(1, ...) writes straight to the file descriptor and bypasses
// it. Scanning for the last parseable line is what still finds the real
// result in that case instead of a stray console.log line (module-load-time
// output, ordinary and not adversarial) making a clean module look like the
// subprocess crashed.
//
// Parsing as JSON is not enough on its own, though: bin/countinghouse-
// validate.js restores process.stdout.write BEFORE printing its own result
// line (so that line itself isn't captured), which leaves a window where a
// module's own teardown code -- a process 'exit' handler, an atexit-style
// logger -- can print something AFTER the real result and win this
// end-of-stream scan. A bare `42` or an unrelated JSON object parses fine
// but is not the CLI's result, so only a line shaped like the CLI's actual
// contract is accepted: the {ok, ...} result shape, or the {error} failure
// shape. Anything else -- valid JSON or not -- is treated as noise and the
// scan keeps looking further back for the real line.
function parseValidateChildOutput(stdout) {
  const lines = (stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (parsed != null && typeof(parsed) === 'object' &&
        (typeof(parsed.ok) === 'boolean' || typeof(parsed.error) === 'string')) {
      return parsed;
    }
    // Parsed fine but doesn't match the CLI's result shape -- keep scanning
    // backward past it instead of returning it.
  }
  return null;
}

// Turns whatever execFile handed back into one human-readable line, for the
// case where the child produced no parseable JSON at all -- a crash, a
// process.exit() with no output yet written, or the bounded timeout above
// firing. Distinguishing these is purely for a better message; all three
// end up reported as a validation problem the same way.
function describeValidateChildFailure(execErr, stderr) {
  if (execErr != null && execErr.killed === true) {
    return `the validator subprocess did not finish within ${VALIDATE_CHILD_TIMEOUT_MS}ms and was killed`;
  }
  if (execErr != null && execErr.signal != null) {
    return `the validator subprocess was killed by ${execErr.signal}`;
  }
  const trimmedStderr = (stderr || '').trim().split('\n')[0];
  if (trimmedStderr) return trimmedStderr;
  if (execErr != null && typeof(execErr.code) === 'number') {
    return `the validator subprocess exited with code ${execErr.code} and produced no output`;
  }
  return 'the validator subprocess produced no output';
}

// Runs the module validator in a fresh child process instead of require()-ing
// caller-supplied JS into this gateway process directly.
//
// This is the canonical explanation of that boundary -- lib/cli-options.js's
// authoringTools comment and test/module-authoring/03-authoring-tools-
// gating.js's file header both point back here rather than restating it, so
// there is exactly one place to keep this accurate as the tools evolve.
//
// countinghouse_validate_module's whole job requires running a caller-
// supplied module's handler files (resolveHandlerMap in lib/module-validator.js
// requires each one), which is arbitrary JS execution with a friendly
// name -- --authoringTools plus an admin key (dispatchAuthoringTool's gate,
// above) is what stands between a caller and that, not a UX nicety over an
// already-safe tool. Under --moduleSandbox audit and enforce it runs in a
// sandboxed module worker that is then discarded
// (ModuleManager.validateModuleSandboxed), with the same namespace, declared
// environment, limits and lockdown a load of that module gets. Under off (a
// worker would get the whole environment) and in single-thread mode it runs
// here, via execFile, in a disposable child process given only PATH, HOME
// and NODE_PATH (review R1-4; it used to get the server's whole environment).
// Either way a crash, an uncaught exception, or a process.exit() call during
// that require() ends only that worker or child, and each call starts with
// a fresh require() cache.
//
// countinghouse_load_module lands the module in the live runtime: in its own
// sandboxed worker under --workerThread, directly in this process in
// single-thread mode. See LOAD_MODULE_TIMEOUT_MS above for how long the tool
// call waits for it.
//
// `callback(err, result)` mirrors lib/module-validator.js's own
// validateModule signature exactly: err set only for the "path is unusable"
// case (mirrors the CLI's exit code 2), otherwise result is the {ok, module,
// problems} shape unit tests and the tool's outputSchema already expect. A
// module that crashes or hangs its own validator is reported as
// `result.ok === false` with a problem describing that -- not as an error --
// since the *validate* succeeded at its job (telling the caller something is
// wrong with the module); it just had to find out the hard way.
function validateModuleInChildProcess(modulePath, callback) {
  // Only what the CLI needs: not the server's environment, whose secrets
  // (COUNTINGHOUSE_API_KEY, and the like) the module would otherwise read,
  // and not NODE_OPTIONS (review R1-4).
  const env = {PATH: process.env.PATH, HOME: process.env.HOME, NODE_PATH: path.join(__dirname, '..')};
  execFile(process.execPath, [VALIDATE_CLI_PATH, '--json', modulePath],
    {timeout: VALIDATE_CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: env},
    (execErr, stdout, stderr) => {
      const parsed = parseValidateChildOutput(stdout);

      if (parsed != null && parsed.error != null) {
        // Mirrors lib/module-validator.js's own err callback: "path is not a
        // directory" and the like. Reconstructed as a plain Error, same as
        // what validateModule itself would have handed the caller directly.
        return callback(new Error(parsed.error));
      }
      if (parsed != null) {
        return callback(null, parsed);
      }

      const moduleName = path.basename(path.resolve(modulePath));
      const reason = describeValidateChildFailure(execErr, stderr);
      return callback(null, {
        ok: false,
        module: moduleName,
        problems: [{
          stage:   'validateModuleChildProcess',
          module:  moduleName,
          message: `could not get a result from the validator subprocess: ${reason}`,
          fix:     'Check the module\'s handler files for a process.exit() call, an infinite loop, or ' +
                   'anything else that could stop them from returning normally while being required.'
        }]
      });
    });
}

function dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback, opts) {
  if (options.getOptions().authoringTools !== true) return false;

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name}`));
    }
    if (authCtx.isAdmin !== true) {
      const err = new Error('authoring tools require an admin key');
      err.code = 'ADMIN_REQUIRED';
      return callback(null, resultResponse(req.id, toolCallResult(err)));
    }

    if (name === 'countinghouse_validate_plan') {
      // Two different views of the same loaded devices, on purpose: `existing`
      // (tool-name collisions) needs buildToolTargets' already-slugified,
      // already-deduped tool names; plan.calls resolution needs the raw
      // device specs (getAllDeviceSpecs) so a description-less-but-callable
      // action -- which buildToolTargets skips -- is not misreported as
      // missing. See plan-validator.js's callsProblems comment.
      const targets  = toolRegistry.buildToolTargets(cdifInterface);
      const existing = Object.keys(targets);
      const specs    = cdifInterface.deviceManager.getAllDeviceSpecs();
      const result   = planValidator.validatePlan(toolArgs, existing, specs);
      return callback(null, resultResponse(req.id, toolCallResult(null, result)));
    }

    if (name === 'countinghouse_validate_module') {
      if (typeof(toolArgs.path) !== 'string' || toolArgs.path === '') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path must be a non-empty string'))));
      }
      // Under audit and enforce, a sandboxed worker that is then discarded
      // (review R1-4). Under off a worker would get the server's whole
      // environment, and single-thread mode has no sandbox: there, the child
      // process with a clean environment.
      const answer = (vErr, result) => callback(null, resultResponse(req.id, toolCallResult(vErr, result)));
      if (options.workerThread === true && options.moduleSandbox !== 'off') {
        return cdifInterface.deviceManager.moduleManager.validateModuleSandboxed(toolArgs.path, VALIDATE_CHILD_TIMEOUT_MS, answer);
      }
      // The child runs the module's code too: under --workerThread its
      // package.json is pinned first, for the load that follows (as
      // validateModuleSandboxed does; lib/manifest-pins.js).
      if (options.workerThread === true) cdifInterface.deviceManager.moduleManager.manifestPins.forValidation(toolArgs.path);
      return validateModuleInChildProcess(toolArgs.path, answer);
    }

    if (name === 'countinghouse_load_module') {
      if (typeof(toolArgs.path) !== 'string' || typeof(toolArgs.name) !== 'string') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path and arguments.name are required'))));
      }

      // Guards loadModuleFromPath's callback against never firing at all --
      // verified live against a module whose code calls process.exit()
      // under --workerThread: the worker thread survives (the crash doesn't
      // take the gateway down), but nothing ever reports failure back up
      // module-manager.js's chain, so the callback below simply never runs.
      // `settled` makes the deadline and the real callback mutually
      // exclusive -- whichever answers first wins, and the other becomes a
      // no-op -- so a real callback that arrives late (after the deadline
      // already reported a timeout to the caller) cannot double-answer this
      // tool call.
      let settled = false;
      const deadlineTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const timeoutErr = new Error(
          `loadModuleFromPath did not call back within ${LOAD_MODULE_TIMEOUT_MS}ms; the module's handler ` +
          'files may be hanging (an infinite loop, a promise that never resolves) during load. ' +
          'countinghouse_validate_module requires a module\'s handler files in an isolated, disposable child ' +
          'process and is the safer way to probe it before loading it live.');
        timeoutErr.code = 'LOAD_MODULE_TIMEOUT';
        return callback(null, resultResponse(req.id, toolCallResult(timeoutErr)));
      }, LOAD_MODULE_TIMEOUT_MS);

      return cdifInterface.deviceManager.moduleManager.loadModuleFromPath(
        toolArgs.path, toolArgs.name, toolArgs.version || null, (loadErr, moduleInstance) => {
          if (settled) return; // the deadline above already answered this call
          settled = true;
          clearTimeout(deadlineTimer);

          if (loadErr != null) {
            return callback(null, resultResponse(req.id, toolCallResult(loadErr)));
          }
          // The module's tool names are derived from ITS OWN devices (see
          // waitForModuleTools/moduleDeviceIDs above), not from a global
          // before/after diff of every tool on the server. A global diff is
          // wrong on reload: the second and later times this module loads,
          // its tool names are already present in "before" (they never
          // disappeared), so the diff is structurally empty even though the
          // module -- and its tools -- are right there and callable. Reading
          // per-module state instead is correct on both first load and
          // reload.
          //
          // A bounded wait is still needed for a genuine first load: under
          // --workerThread, loadModuleFromPath's callback fires the moment
          // the *load* is acked, and module-manager.js's onModuleLoad
          // registers the module's device from the main thread's spec a
          // turn later (DeviceManager's registerFromSpec), which is what
          // populates this module's device list. A reload's answer, by
          // contrast, is normally available on the very first poll, since
          // its deviceList already carries the previous load's entries.
          //
          // There is no single reliable "discovery finished for this
          // module" event to await instead of polling: module-manager.js's
          // own 'allmodulediscovered' bookkeeping DOES fire again for a
          // runtime load when the server was started with at least one
          // module preloaded (its noofLoadedModules/noofTotalModules
          // clamp-and-re-emit logic, module-manager.js around line 90) --
          // but not when the server started with none preloaded (exactly
          // this test's setup, and the general case for a bare
          // countinghouse instance), since that logic is gated on
          // noofTotalModules > 0. So the wait is a bounded poll either way.
          return waitForModuleTools(cdifInterface, moduleInstance, Date.now() + LOAD_MODULE_DISCOVERY_TIMEOUT_MS, (discovery) => {
            return callback(null, resultResponse(req.id, toolCallResult(null, {
              loaded:            true,
              name:              toolArgs.name,
              version:           toolArgs.version || null,
              toolNames:         discovery.toolNames,
              discoveryComplete: discovery.discoveryComplete
            })));
          });
        });
    }

    if (name === 'countinghouse_reload_auth') {
      const provider = require('../auth').getAuthProvider();
      return provider.reload((err, result) => {
        if (err != null) return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('AUTH_RELOAD_INVALID', err.message))));
        return require('../identity').rebuild(provider).then(() => callback(null, resultResponse(req.id, toolCallResult(null, result))),
          (e) => callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('AUTH_RELOAD_INVALID', e.message)))));
      });
    }

    if (name === 'countinghouse_lookup_identity') {
      const identity = require('../identity');
      const id = toolArgs.id;
      if (typeof(id) !== 'string' || id === '') return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('IDENTITY_NOT_FOUND', 'arguments.id must be a non-empty string'))));
      const provider = (options.debug === true) ? null : require('../auth').getAuthProvider();
      return identity.resolve(id, provider, (err, found) => {
        if (err != null) return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('SYSTEM_ERROR_USERDB_NA', err.message))));
        if (found == null) return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('IDENTITY_NOT_FOUND'))));
        return callback(null, resultResponse(req.id, toolCallResult(null, {id: id, userName: found.userName, isAdmin: found.isAdmin})));
      });
    }

    if (name === 'countinghouse_call_tool') {
      if (typeof(toolArgs.name) !== 'string' || toolArgs.name === '') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.name must be a non-empty string'))));
      }
      if (toolRegistry.AUTHORING_TOOL_NAMES[toolArgs.name] === true) {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('countinghouse_call_tool cannot invoke an authoring tool'))));
      }
      // Re-enter the normal tools/call path so the inner call gets the same
      // auth, validation, metering and timeout every other call gets. This is
      // a convenience for clients with a stale tool list, not a second,
      // weaker entry point. `innerReq` omits `params.task` on purpose: task-
      // augmentation is a property of the outer call the client made, not
      // something call_tool should silently inherit or grant to an inner
      // invocation the client didn't ask to background.
      const innerReq = {
        id:     req.id,
        params: {name: toolArgs.name, arguments: toolArgs.arguments || {}}
      };
      // the inner call is the same request's: its session too
      return handleToolsCall(innerReq, cdifInterface, appKey, (innerCallbackErr, innerResp, innerInfo) => {
        // a cancelled inner call (M19): the transport is told, as for a direct one
        if (innerInfo != null && innerInfo.cancelled === true) return callback(null, null, innerInfo);
        // handleToolsCall answers a request it can't even dispatch (unknown
        // tool name, a userAuth failure) with a raw JSON-RPC error envelope --
        // correct for a *direct* tools/call, where that failure is the whole
        // response. But call_tool itself IS a known, successfully-dispatched
        // authoring tool: its own outer response must stay in
        // toolCallResult's content/isError shape, like every other authoring
        // tool's failure mode above, not leak the inner request's protocol-
        // level error envelope as if it were this call's own.
        if (innerResp != null && innerResp.error != null) {
          const wrappedErr = new Error(innerResp.error.message);
          // Preserve the inner JSON-RPC error's own code (e.g. -32602 for
          // "unknown tool", -32603 for a userAuth resolution failure)
          // rather than collapsing every inner failure into the same
          // undifferentiated prose -- toolCallResult surfaces err.code as
          // structuredContent.code, which is what lets a caller branch on
          // *which* inner failure happened instead of pattern-matching text.
          wrappedErr.code = innerResp.error.code;
          return callback(innerCallbackErr, resultResponse(req.id, toolCallResult(wrappedErr)));
        }
        return callback(innerCallbackErr, innerResp);
        // not modern, as on master (the model's inner call forms no
        // confirmation); the same request's session
      }, false, opts);
    }

    return callback(null, resultResponse(req.id, toolCallResult(new Error(`unknown authoring tool: ${name}`))));
  });
  return true;
}

// The request's session id, resolved once per call: a shared runtime's
// while it is live and settled (lib/sessions.js), --stdio's one, or null
// (HTTP: none). undefined, and the call refused: a session that has ended
// or not yet settled, or no session at all in shared mode, where every
// call is a session's.
function sessionIdOf(opts) {
  const sessions = sessionsLib();
  if (opts != null && opts.session != null) return sessions.get(opts.session.id) != null ? opts.session.id : undefined;
  if (sessions.shared()) return undefined;
  return options.stdio === true ? sessions.openLocal() : null;
}
// A request's scope (shared runtime B5, Task 0: lib/session-scope.js): what
// its session may see of the runtime's records. A request whose session
// is undefined here (an ended session, or none in shared mode) is refused
// before any view is built, as handleToolsCall refuses it.
function scopeOf(opts) {
  return sessionScopeLib().of(sessionIdOf(opts));
}
const NO_SESSION_CONTEXT = Object.freeze({clientInfo: null, capabilities: null, session: null});

// modern: the request speaks 2026-07-28 (lib/mcp/era.js); only then is a
// confirmation formed or a retry taken.
// opts.session: the request's session (C1's session object), in a shared
// runtime; absent under --stdio (its one session) and over HTTP (none)
function handleToolsCall(req, cdifInterface, appKey, callback, modern, opts) {
  const params = req.params || {};
  const name      = params.name;
  const toolArgs  = params.arguments || {};
  // an ended session's call is answered as an unknown tool's: no new call
  // for it (its calls in flight finish)
  const sessionId = sessionIdOf(opts);
  if (sessionId === undefined) return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED'))));

  if (typeof(name) !== 'string' || name === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.name must be a non-empty string'));
  }

  // The settings tool (packs in place, part 2; spec #168 section 3): listed
  // and callable only in the single-identity profile with --settingsFile, by
  // the admin identity (there, the one local user). Module code never reaches
  // it: ctx.call addresses only a device's service and action.
  if (name === 'countinghouse_settings') {
    if (options.singleIdentity !== true || options.settingsFile == null) {
      return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED'))));
    }
    // The single-identity profile has one caller, the local user, and that
    // user is the admin identity here (spec #168 section 3), though the
    // profile marks no key as an admin key: a caller that resolves is it.
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null) return callback(null, resultResponse(req.id, toolCallResult(authErr)));
      return rateLimitGate.check(cdifInterface, authCtx.appKey, (limited) => {
        if (limited === true) return callback(null, resultResponse(req.id, toolCallResult(rateLimitGate.error())));
        const args = (toolArgs != null && typeof(toolArgs) === 'object') ? toolArgs : {};
        const tool = require('../settings-tool').create({file: options.settingsFile});
        // part 3 P2: the client and its capabilities from this request's
        // _meta (and the session's initialize); a confirmation's
        // requestState and inputResponses only from params, never from the
        // arguments a model writes
        // in the request's own session (HTTP: none, so no form); modern as
        // #229: a 2026-07-28 request's own _meta only, a legacy one its
        // session's initialize and no capabilities
        const ctx = sessionId != null ? sessionsLib().contextOf(sessionId, params, modern) : NO_SESSION_CONTEXT;
        // MRTR (the form and its retry) is the modern era's only (#229)
        const retry = modern === true && params.requestState !== undefined;
        const smuggled = Object.prototype.hasOwnProperty.call(args, 'requestState') || Object.prototype.hasOwnProperty.call(args, 'inputResponses');
        const isSet = args.action === 'set' && typeof(args.name) === 'string' && args.value !== undefined;
        // a shared runtime's session (C1 part 2's guard, lifted by B2 Task 4
        // for the two caps, by name): it reads, and it may set
        // maxOutputBytes and requestTimeout for itself (the settings tool
        // takes only a tightening there, as the session's own override, and
        // writes no file; a loosening is confirmed in the session's own
        // form, and its retry is that session's too: Task 5). Every other
        // set, and its retry, is the terminal's, since the file is every
        // session's.
        const shared = opts != null && opts.session != null;
        // the two caps, and a pack for this session (B3 Task 8)
        const sessionMaySet = sessionSettingsLib().CAPS.includes(args.name) || require('../settings-tool').PACK.test(String(args.name));
        // the tool is told the request is a session's: its set is that
        // session's override, its get that session's view. And what the
        // call says its change is for (B2 Task 5b: scope 'all-sessions'),
        // which the tool checks: it is the model's argument, and a
        // loosening for all is the user's to confirm in a form that says so.
        const scoped = Object.prototype.hasOwnProperty.call(args, 'scope') ? {scope: args.scope === undefined ? null : args.scope} : {};
        const toolCtx = Object.assign({}, ctx, shared ? {shared: true} : {}, scoped);
        let sharedRefusal = null;
        if (shared && isSet && !sessionMaySet) {
          try {
            tool.refuseSharedSet(args.name, args.value);
          } catch (e) {
            sharedRefusal = e;
          }
        }
        const run = smuggled ? Promise.reject(new CountinghouseError('ARGUMENTS_INVALID', 'a confirmation is not given in the arguments'))
          : sharedRefusal != null ? Promise.reject(sharedRefusal)
          : args.action === 'get' ? tool.get(toolCtx)
            : (isSet && retry) ? tool.confirm(args.name, args.value, {requestState: params.requestState, inputResponses: params.inputResponses}, toolCtx)
              : isSet ? tool.set(args.name, args.value, 'settings tool', toolCtx)
                : Promise.reject(new CountinghouseError('ARGUMENTS_INVALID', 'action is get, or set with a name and a value'));
        run.then((answer) => ({answer}), (error) => ({error}))
          // outside the promise chain, as the usage report's
          .then(({answer, error}) => process.nextTick(() => {
            if (error != null) {
              // anything else the tool met (a file it could not create) is said
              // as the file being unusable, naming what failed
              const err = (error instanceof CountinghouseError) ? error
                : CountinghouseError.withFields('SETTINGS_FILE_INVALID', {problem: `it could not be changed (${String((error && (error.code || error.message)) || 'error').slice(0, 40)})`});
              return callback(null, resultResponse(req.id, toolCallResult(err)));
            }
            // a form for the user: the 2026-07-28 InputRequiredResult
            if (answer != null && answer.inputRequired != null && modern === true) {
              return callback(null, resultResponse(req.id, {resultType: 'input_required', inputRequests: answer.inputRequired.inputRequests, requestState: answer.inputRequired.requestState}));
            }
            return callback(null, resultResponse(req.id, toolCallResult(null, answer)));
          }));
      });
    });
  }

  // The single-identity profile lists only the pack's tools (local-mode spec
  // §4): the balance check and the authoring tools are refused by name, as a
  // part is, so the user meets no key or balance vocabulary.
  if (options.singleIdentity === true && name !== 'countinghouse_usage_report' && (toolRegistry.PLATFORM_TOOL_NAMES[name] === true || toolRegistry.AUTHORING_TOOL_NAMES[name] === true)) {
    // Without the name: a built-in's own name would say "balance".
    return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED'))));
  }

  // The usage report (local-mode spec §5): the caller's own calls, an admin's
  // view of every caller by opaque id. A bad argument is a tool error.
  if (name === 'countinghouse_usage_report') {
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null) return callback(null, resultResponse(req.id, toolCallResult(authErr)));
      // Rate limited like countinghouse_check_balance: a report reads files on
      // the main thread (review of #59).
      return rateLimitGate.check(cdifInterface, authCtx.appKey, (limited) => {
        if (limited === true) return callback(null, resultResponse(req.id, toolCallResult(rateLimitGate.error())));
        // Asynchronous: the files are streamed (lib/usage/read.js streamUsage).
        // A rejection is a bad argument; the callback is called once either way.
        // a shared runtime's session sees its own calls only (B5 Task 1);
        // sessionIdOf has refused a request with no live session there
        const session = sessionsLib().shared() ? sessionId : undefined;
        usageReport(toolArgs, {caller: opaqueCallerOf(authCtx.appKey), isAdmin: authCtx.isAdmin === true, session: session}, {usage: usageRuntime.usage(), usageDir: options.usageDir || null})
          .then((report) => ({report}), (e) => ({error: e}))
          // the callback runs outside the promise chain, as it ran before:
          // a throw in it is not turned into an unhandled rejection
          .then(({report, error}) => process.nextTick(() => {
            if (error != null) return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('ARGUMENTS_INVALID', error.message))));
            return callback(null, resultResponse(req.id, toolCallResult(null, report)));
          }));
      });
    });
  }

  // platform tool, not derived from any device module -- handled directly,
  // no task-augmentation support (it's already a fast, synchronous read).
  //
  // Authenticated (S6): this used to check only that *some* key was present
  // and pass it straight to checkBalance, so any invented string got a
  // balance back. It now resolves the key through AuthProvider like every
  // other entry path, and reads the balance of the resolved session's own
  // appKey -- a caller can only ever ask about itself.
  if (name === 'countinghouse_check_balance') {
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null) {
        return callback(null, resultResponse(req.id, toolCallResult(authErr)));
      }
      // Rate limited (7.0.0): authenticated, but one Redis round trip per
      // request and previously pollable as fast as a caller liked. Denied as
      // a tool *error* rather than a JSON-RPC one, matching how the
      // task-creation limiter below already denies -- this is a tools/call,
      // so its failures belong in the result envelope.
      return rateLimitGate.check(cdifInterface, authCtx.appKey, (limited) => {
        if (limited === true) {
          return callback(null, resultResponse(req.id, toolCallResult(rateLimitGate.error())));
        }
        return cdifInterface.checkBalance(authCtx.appKey, (err, result) => {
          if (err != null) return callback(null, resultResponse(req.id, toolCallResult(err)));
          // Built field by field, never from the metering result: tool output
          // reaches model context, transcripts and logs, so it carries the
          // caller's user name and never its key. A user name equal to the key
          // -- the file provider's fallback for an entry without userName -- is
          // returned as null.
          const userName = (typeof(authCtx.userName) === 'string' && authCtx.userName !== authCtx.appKey) ? authCtx.userName : null;
          const balance = (result != null && typeof(result.balance) === 'number') ? result.balance : null;
          return callback(null, resultResponse(req.id, toolCallResult(null, {userName: userName, balance: balance})));
        });
      });
    });
  }

  // No special-case response here on purpose: when the flag is off,
  // dispatchAuthoringTool returns false synchronously without touching
  // `callback`, so control falls straight through to the ordinary
  // targets[name] lookup below. AUTHORING_TOOL_NAMES only reserves names in
  // buildToolTargets' dedup map (tool-registry.js) -- it never adds a
  // target -- so that lookup misses and produces the exact same
  // `errorResponse(..., 'unknown tool: ...')` a name that was never
  // registered at all would get, from the exact same line of code. That is
  // what makes "disabled" and "never existed" structurally indistinguishable
  // rather than two response-shaping call sites someone has to keep in sync.
  if (toolRegistry.AUTHORING_TOOL_NAMES[name] === true &&
      dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback, opts) === true) {
    return;
  }

  // One pass over the devices: the listed targets and, after them, the ones
  // that are loaded but not listed (a scenario's part, or anything but a
  // scenario in the single-identity profile), which answer MODULE_NOT_LISTED.
  // The in-process ctx.call hop never comes through here.
  // A target whose device the session doesn't list (a pack it hasn't on,
  // B3 Task 3) is no target: the line below answers it as a name never
  // registered, before anything that would say the module exists
  // (MODULE_NOT_LISTED, a task).
  const found = toolRegistry.buildToolTargets(cdifInterface, {includeUnlisted: true})[name];
  const target = (found != null && toolRegistry.sessionLists(sessionId, found)) ? found : null;

  if (target == null) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name}`));
  }
  if (target.unlisted === true) {
    return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED', name))));
  }

  // task-augmented request: caller wants this call to run as a trackable
  // background task (tasks/get, tasks/result, tasks/cancel) instead of
  // blocking for the result inline.
  // A modern request's params.task is ignored, as the tasks extension
  // requires of the legacy field (#232): the call runs as an ordinary one.
  if (params.task != null && modern !== true) {
    return createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback, sessionId, opts);
  }
  // a 2026-07-28 task (M15): only when the action declares longRunning, the
  // request declares the extension, and jobs can run; a shared runtime's
  // session's too, its tasks its own (B5 Task 2). The client never chooses.
  if (modern === true && target.action != null && target.action.longRunning === true && declaresTasks(params) && tasksSupported() === true) {
    return createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback, sessionId, opts, true);
  }

  // M19 (spec section 13): a module tool's call can be cancelled while it
  // runs, by its transport's signal (opts.cancellable: the POST's close on
  // HTTP for a modern request, notifications/cancelled on stdio and a
  // session). The cancel drops the call's token at once, as its timeout
  // does, and every hop's under it: from then on a NEW hop, device query,
  // remote call or channel open is refused CALL_TOKEN_INVALID in whatever
  // worker makes it. No worker is interrupted, and no answer is written.
  // The bill is what ran, because each path captures its billing key when
  // the work STARTS, never by resolving the token again when it bills (keep
  // it so: a fresh resolve there would let a client cancel just before a
  // hop finishes and get it free):
  //   - a routed hop: billingKey from the caller's token entry at the hop's
  //     start (lib/device-manager.js handleForeignInvoke), billed at its
  //     answer with that key;
  //   - a peer invoke: the broker's unbilled entry, keyed by the callee's
  //     token with the billingKey taken at the match (lib/peer-channel-
  //     broker.js issueMatched), which outlives the token and is billed by
  //     handleBillRequest; an invoke not yet matched is refused unserved;
  //   - a remote call: billingKey at its token's resolve (lib/remote
  //     index.js), billed after the server answers; a call aborted by the
  //     cancel never answers, so it is not billed.
  // The outer call is billed only on its handler's success, as always: one
  // that ran to its end after the cancel is billed, one stopped by a
  // refused hop is not. Its usage Out record is outcome 'cancelled', one,
  // under the call's own id.
  return runModuleTarget(req, cdifInterface, appKey, target, toolArgs, modern, opts, sessionId, callback, toolFormat(target, modern, sessionId));
}

// A module action run as a tools/call runs it (M7: the one runner for
// tools/call and a module resource's read, so a read is "exactly as a
// call"): authorized for the device (userAuth), cancellable (M19), counted
// (the usage call), rate limited and invoked (invokeDeviceAction), its
// output validated by its module's validators, and billed on success under
// its action's metering identity. `format` is all that differs:
//   shape(data, rawSchema, callerKey) -> Promise of the CallToolResult-shaped
//     result the usage record and the bill read;
//   answer(req, result) -> the JSON-RPC response;
//   receipts: false for a read (no scenario receipt, no notices).
// early: a cancellation its caller registered before any async work
// (earlyCancellable; a resource read's), taken over here; else one is
// registered now.
function runModuleTarget(req, cdifInterface, appKey, target, toolArgs, modern, opts, sessionId, callback, format, early = null) {
  const params = req.params || {};
  let callSession = null;
  const onCancel = () => {
    if (callSession != null) {
      callSession.cancelled = true;
      if (callSession.callToken != null) callTokensLib().drop(callSession.callToken, {abort: true});
    }
    if (progress != null) progress.done();
  };
  const cancellation = (early != null) ? early : cancellableCallback(opts, onCancel, callback);
  if (early != null) early.onCancel(onCancel);
  callback = cancellation.callback;
  const isCancelled = cancellation.isCancelled;

  const args = {input: toolArgs};
  // The call's usage (local-mode spec §5): begun once the caller is
  // authenticated, with the caller id from the session's key, never the raw
  // header (review of #59). Its id rides in the invoke args under
  // `usageCall`, so the remote client records each server call made for it
  // (lib/handler-ctx.js carries it, A's), and respond() records the result
  // and, for a scenario, adds the receipt. Counting never fails a call.
  const startedMs = Date.now();
  let usageCall = null;
  // The output schema in effect when the call starts: the one the caller's
  // tools/list advertised and the module validates its output against. A
  // module reloading before the answer arrives must not change the shape
  // (with nothing loaded at that moment there would be no schema, and a
  // text-only success from a tool that advertised one is rejected by the
  // SDK client). A schema lookup problem never fails a call: it is logged
  // (toolRegistry.outputSchemaForCall, which keeps a resolved schema per
  // action and tool-set generation), and the result goes text only.
  let callRawSchema = null;
  // The call's ask state (ctx.ask; the MCP completeness design, section 8,
  // lib/module-ask.js): who the handler's question can be put to, and the
  // answers its retry brought. Made once the caller is known, since a
  // retry's state is bound to the caller.
  let asking = null;
  // the resolved caller's key (session.appKey), set before any result
  let callerKey = appKey;

  // The call's progress (M9, lib/mcp/progress.js): only for a progress token
  // in params._meta and a transport that can send before the answer (opts
  // .notify, the request's own connection and session); made once the call
  // is authorized, finished with its answer, and ended when the client goes.
  let progress = null;
  const progressToken = progressLib.tokenOf(params);
  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, (err, data) => {
    // The handler ended on a question with no answer: the call is answered
    // with it (an InputRequiredResult), and runs again when the client
    // retries with the answer. Only from the main thread's own record of
    // the question, never from anything the module returned or threw.
    if (err != null && err.code === 'ASK_PENDING' && asking != null && asking.state.pending != null) return inputRequired();
    if (err != null) return respond(toolCallResult(err));
    return format.shape(data, callRawSchema, callerKey)
      .then(respond, (e) => respond(toolCallResult(e))).catch((e) => LOG.E(e));
  }, (err, session) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    callerKey = session.appKey;
    // the call's session carries its token once issued (lib/device-manager
    // .js), so a cancel can drop it; a cancel before then marks it, and the
    // call is never sent
    callSession = session;
    if (isCancelled()) session.cancelled = true;
    try {
      usageCall = usageRuntime.usage().beginCall({pack: target.role === 'scenario' ? target.module : null, module: target.module, tool: target.name, caller: opaqueCallerOf(session.appKey), session: sessionsLib().forUsage(sessionId)});
      args.usageCall = usageCall;
    } catch (e) {
      LOG.E(e);
    }
    session.localInput = args;
    if (progressToken != null && opts != null && typeof(opts.notify) === 'function') {
      progress = progressLib.createProgress({token: progressToken, send: opts.notify});
      if (typeof(opts.onGone) === 'function') opts.onGone(() => progress.gone());
      // on the outer call's token, main-side: its hops tick it (lib/call-tokens.js progressOf)
      session.progress = progress;
    }
    // the call's session (B1 Task 2): into its token, never to its worker
    session.sessionId = sessionId;
    // the session's own values for this call, from its start (B2 Task 2);
    // every check then also takes its session's current ones (call-limits)
    const own = sessionId != null ? sessionSettingsLib().limitsOf(sessionId) : null;
    if (own != null) callLimitsLib().override(session, own);
    const invoke = () => toolRegistry.outputSchemaForCall(cdifInterface, appKey, target, (schemaErr, outputSchema, rawSchema) => {
      callRawSchema = (schemaErr != null) ? null : rawSchema;
      cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, session);
    }, undefined, {modern: modern === true});
    // a legacy request has no one to ask, and reads nothing of a retry
    if (modern !== true) return invoke();
    // A read of a module's resource asks no one (M7: a resource is read, as
    // the application picks it, not a call the model makes): its ctx.ask is
    // ASK_UNAVAILABLE, as #327 shipped it, and nothing of a retry is read.
    if (format.ask == null) {
      session.ask = moduleAskLib().newState({askable: false});
      return invoke();
    }
    let begun;
    try {
      const dm = cdifInterface.deviceManager;
      const device = dm != null && dm.deviceMap != null ? dm.deviceMap[target.deviceID] : null;
      const of = moduleAskLib().ofDevice(device, target.serviceID, target.actionName);
      const meta = params._meta != null && typeof(params._meta) === 'object' ? params._meta : {};
      const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
      asking = {state: null, deps: {
        modern: true,
        // the request's own declaration, as 2026-07-28 gives it per request
        capabilities: capabilities != null && typeof(capabilities) === 'object' ? capabilities : null,
        questionsOn: options.moduleQuestions !== false,
        // whether this call can end on a question: its own action's, or
        // one an action it can reach through the modules' verified
        // declared calls declares (lib/module-ask.js canAsk: bounded).
        // Asked once, and only where someone can be asked.
        asks: (() => {
          let known = null;
          return () => {
            if (known == null) {
              // kept per action and tool-set generation: walked once, not per call
              known = of.asks === true || moduleAskLib().canAskKept({deviceID: target.deviceID, serviceID: target.serviceID, actionName: target.actionName}, {
                asksAt: (t) => {
                  const d = dm != null && dm.deviceMap != null ? dm.deviceMap[t.deviceID] : null;
                  return d != null && moduleAskLib().ofDevice(d, t.serviceID, t.actionName).asks === true;
                },
                // a module's verified declarations, as its hops are checked against them (lib/call-tokens.js declaredTarget)
                callsOf: (deviceID) => {
                  const d = dm != null && dm.deviceMap != null ? dm.deviceMap[deviceID] : null;
                  return d != null ? callTokensLib().declaredTargetsOf(callTokensLib().bindingOf(d, deviceID)) : [];
                }
              }, require('../tool-generation').current());
            }
            return known;
          };
        })(),
        params: params,
        // the tool the client called (its listed name: the target's key in
        // the tool targets, params.name), as handleToolsCall bound it before
        // runModuleTarget was split out of it (#327 left `name` unbound here,
        // so every modern ask failed ASK_UNAVAILABLE)
        binding: {caller: opaqueCallerOf(session.appKey), session: sessionId != null ? sessionId : '', method: format.ask.method, tool: format.ask.tool, arguments: toolArgs},
        // every dialog of this call carries the called, listed module's
        // name, whoever in its chain asks (M14)
        shownAs: target.module,
        // who asked, as the main thread holds it now: the called action or
        // a part's, by its device (gone: null, and its answer is none)
        ofAsker: (asker) => {
          const askerDevice = dm != null && dm.deviceMap != null ? dm.deviceMap[asker.deviceID] : null;
          return askerDevice == null ? null : moduleAskLib().ofDevice(askerDevice, asker.serviceID, asker.actionName);
        },
        // reached only for a state (a retry's, or a form's): a call that
        // carries none touches neither the key nor the store
        key: () => requestStateLib().key(),
        used: () => storeLib().getStore().usedNonces
      }};
      begun = moduleAskLib().begin(asking.deps);
    } catch (e) {
      begun = Promise.reject(e);
    }
    return begun.then((state) => ({state}), (error) => ({error}))
      // outside the promise chain, as the settings tool's answer is
      .then(({state, error}) => process.nextTick(() => {
        if (error instanceof CountinghouseError) {
          // a refusal of the retry (ASK_STATE_INVALID, ASK_STATE_UNCHECKED,
          // an answer in the arguments): the call's answer; nothing runs
          asking = null;
          LOG.E(new Error(`${target.name}: a retry's answer was refused (${error.code}${error.why != null ? `: ${error.why}` : ''})`));
          return respond(toolCallResult(error));
        }
        if (error != null) {
          // the ask state could not be made: the call runs with no one to
          // ask (its ctx.ask is ASK_UNAVAILABLE), never fails for it
          LOG.E(error);
          asking = null;
          session.ask = moduleAskLib().newState({askable: false});
          return invoke();
        }
        // What a state made for this call is bound to: the arguments as the
        // client sent them, kept apart from the object the handler is given
        // (lib/module-ask.js bindingArguments: a copy only where the call
        // can end on a question).
        asking.deps.binding = Object.assign({}, asking.deps.binding, {arguments: moduleAskLib().bindingArguments({state: state, asks: asking.deps.asks, arguments: toolArgs})});
        // the walk and the ask agree: a call it cleared asks no one (#330's review)
        if (state.askable === true) state.reachable = asking.deps.asks() === true;
        asking.state = state;
        session.ask = state;
        return invoke();
      }));
  });

  // The question the handler asked, as the client's InputRequiredResult.
  // Not billed and not a result: the call is billed once, when it
  // completes. If no form can be made the call answers ASK_UNAVAILABLE.
  function inputRequired() {
    // a call cancelled meanwhile (M19) gets no form and no state: respond()
    // then writes nothing and records it cancelled
    moduleAskLib().formOf(asking.state, Object.assign({}, asking.deps, {cancelled: isCancelled})).then((made) => ({made}), (error) => ({error}))
      .then(({made, error}) => process.nextTick(() => {
        if (error != null) return respond(toolCallResult(error instanceof CountinghouseError ? error : new CountinghouseError('ASK_UNAVAILABLE')));
        // the pass's usage record: it asked, in this round (so an operator
        // sees a module that asks, and one that asks late). Counting never
        // fails a call.
        // and who really asked: the dialog carries the listed module's name
        // (an unlisted part is never named to the client), the runtime's
        // record and log name the part (M14)
        const pending = asking.state.pending;
        // its name as the asking worker's was when it asked: the device may
        // be gone by now (#330's review)
        const askedBy = pending != null ? {module: pending.module, action: pending.asker.actionName, question: pending.question} : null;
        try {
          if (usageCall != null) usageRuntime.usage().recordOut(usageCall, {tool: target.name, bytes: 0, lines: 0, ms: Math.max(0, Date.now() - startedMs), outcome: 'asked', round: made.round, askedBy});
        } catch (e) {
          LOG.E(e);
        }
        if (askedBy != null) LOG.I(`${target.name}: ${askedBy.module}/${askedBy.action} asked the user its question ${askedBy.question} (round ${made.round})`);
        // the question is this pass's answer, and nothing is sent after an
        // answer (M9, lib/mcp/progress.js): a tick still waiting for its
        // interval is dropped here. The retry is a call of its own, with
        // its own progress.
        if (progress != null) progress.done();
        return callback(null, resultResponse(req.id, {resultType: 'input_required', inputRequests: made.inputRequests, requestState: made.requestState}));
      }));
  }

  function respond(built) {
    // nothing is sent after the answer
    if (progress != null) progress.done();
    let result = built;
    try {
      // a read's record is its action's call's, with no notices: they ride a
      // tool's result (M7)
      result = finishToolCall({usage: usageRuntime.usage(), call: usageCall, result: built, role: format.receipts === false ? null : target.role, tool: target.name, module: target.module,
        session: sessionId, startedMs, takeNotices: format.receipts !== false, outcome: isCancelled() ? 'cancelled' : undefined});
    } catch (e) {
      LOG.E(e);
    }
    // record the call (see options.mcpToolCallCost) only on success and only
    // when we know who to bill -- fire-and-forget, matching the existing
    // (also fire-and-forget) lib/session.js billing call this bypasses for
    // MCP-originated invocations.
    if (result.isError !== true && appKey != null) {
      // The metering identity is encodeLegacyTool(deviceID, serviceID,
      // actionName), not the MCP tool name: the same action reached over
      // HTTP invoke-action, over a cross-worker call, or over MCP must
      // produce the *same* record, or a per-tool price/quota is silently
      // per-entry-path. The two cross-worker paths (lib/device-manager.js,
      // lib/peer-channel-broker.js) already used this encoding; MCP's
      // slugified tool name was the odd one out, and it isn't even stable
      // (tools/list dedups collisions with a _2 suffix). The MCP name is
      // still what identifies the *tool* to clients -- it just isn't what
      // identifies the *billable action* to MeteringProvider.
      cdifInterface.recordCall(appKey, encodeLegacyTool(target.deviceID, target.serviceID, target.actionName),
                               options.mcpToolCallCost, (err) => {
        if (err) LOG.E(err);
      });
    }
    return callback(null, format.answer(req, result));
  }
}

// tools/call's format: the module's output as MCP CallToolResult content
function toolFormat(target, modern, sessionId) {
  return {
    // what a question's state is bound to (lib/module-ask.js)
    ask: {method: 'tools/call', tool: target.name},
    shape(data, rawSchema, callerKey) {
      // `receipt` is reserved only where the runtime adds its own: a scenario's
      // result (LM1 §5). Any other module's receipt field is its own business.
      if (target.role === 'scenario' && receiptReserved(data)) return Promise.resolve(toolCallResult(new CountinghouseError('RECEIPT_RESERVED')));
      // a stored value is the outer caller's: a composite's parts never come
      // through here (M6)
      // the owner is the resolved caller (session.appKey), as the usage call's
      // and resources/read's are, never the raw header
      return moduleToolResult(data, rawSchema, {module: target.module, action: target.actionName, tool: target.name}, modern === true,
        {blobs: blobsOf(), owner: opaqueCallerOf(callerKey), session: sessionId});
    },
    answer: (req, result) => resultResponse(req.id, result)
  };
}

// sessionId: the request's session (handleToolsCall's sessionIdOf), the job's
// creator's, stored with its owner (B1 Task 3)
// M19: a request registered with its transport's opts.cancellable while it
// runs. onCancel runs once, on the transport's signal; the returned callback
// is the request's every way of ending: its registration goes, and once
// cancelled nothing is written (the transport is told {cancelled: true}).
// -> {callback, isCancelled}
// A cancelled call still running is held (lib/mcp/in-flight.js hold) until
// it ends, so the process does not exit, nor report a drain done, before it
// has billed (the review of #314).
function cancellableCallback(opts, onCancel, callback) {
  let cancelled = false;
  let release = () => {};
  const unregister = (opts != null && typeof(opts.cancellable) === 'function')
    ? opts.cancellable(() => {
      if (cancelled) return;
      cancelled = true;
      release = require('./in-flight').hold();
      onCancel();
    }) : () => {};
  return {
    isCancelled: () => cancelled,
    callback: (err, res, info) => {
      unregister();
      release();
      if (cancelled) return callback(null, null, {cancelled: true});
      return callback(err, res, info);
    }
  };
}

// A cancellation registered at once, before a request's async lookups, whose
// work on a cancel is given later by the runner it hands over to
// (runModuleTarget's `early`): a cancel arriving during the lookups is never
// one for an id not yet registered, so dropped (the review of #327). A cancel
// before the hand-over runs no work: the caller checks isCancelled first.
// -> {callback, isCancelled, onCancel(fn)}
function earlyCancellable(opts, callback) {
  let work = () => {};
  const c = cancellableCallback(opts, () => work(), callback);
  return {callback: c.callback, isCancelled: c.isCancelled, onCancel: (fn) => { work = fn; }};
}

function createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback, sessionId = null, opts = null, modernTask = false) {
  // M19: a task-augmented call cancelled before its CreateTaskResult is
  // written: the client never learned the task's id, so its job is removed
  // (doCreateTaskForToolCall) and nothing is answered
  const cancellation = cancellableCallback(opts, () => {}, callback);
  callback = cancellation.callback;
  const state = {get cancelled() { return cancellation.isCancelled(); }};
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS,
      'task-augmented tools/call requires the server to be running in multi-thread mode (--workerThread)'));
  }

  // Same userAuth gate (device ownership, not just identity) the
  // synchronous tools/call path applies below. Without this, task creation
  // (JobControl.addJob) never checks it, and job execution (job-control.js's
  // worker -> cdifInterface.invokeJobs -> DeviceManager.onInvokeJobs) has no
  // appKey parameter to check it with either -- so any apiKey could
  // task-augment a call against a device it doesn't own and have it run to
  // completion. Found via docs/cross-cutting-matrix.md. The resulting
  // session is discarded (localCB is a no-op): job execution is a separate
  // path (JobControl.addJob/invokeJobs) that doesn't use it -- this call is
  // purely an authorization gate, matching the same JSONRPC_INTERNAL_ERROR
  // shape the synchronous path already uses for a userAuth failure.
  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, () => {}, (err, session) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }

    // The session is no longer discarded: its resolved identity is what the
    // created job records as its owner (and billing subject), so that
    // tasks/get|result|cancel can later match against it.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true, session: sessionId};

    // task creation (JobControl.addJob, below) never goes through
    // CdifInterface.prototype.invokeDeviceAction, so it doesn't automatically
    // inherit that path's rate-limit checks the way a synchronous tools/call
    // does -- without this, a caller could bypass --apiKeyRateLimit entirely
    // by always task-augmenting their calls, queueing jobs without limit.
    // Checked at task *creation* time (not per-execution), matching where the
    // resource-abuse actually happens: unbounded queue growth.
    if (appKey != null) {
      return cdifInterface.rateLimit(appKey, (err, result) => {
        if (err == null && result.limited === true) {
          return callback(null, resultResponse(req.id, toolCallResult(new Error('rate limit exceeded'))));
        }
        return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback, state, modernTask);
      });
    }
    return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback, state, modernTask);
  });
}

function doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback, state = {cancelled: false}, modernTask = false) {
  // job-control groups jobs by a "name" (used for scheduler IDs and history
  // lookups) -- the tool name is a natural fit, since it's already the stable,
  // deterministic identifier tools/list and tools/call agree on. The owning
  // apiKey no longer rides inside jobOpts: it comes from `authCtx`, which
  // addJob takes as its first argument precisely so a request-supplied value
  // can never be mistaken for an authenticated one (see addJob's comment).
  // It is what lib/job-control.js's worker records the call against once the
  // job completes (see initJobProcess) -- this path never goes through
  // lib/session.js's Session/logAPICall machinery at all -- and what
  // tasks/get|result|cancel later match ownership against.
  const jobOpts = {name: target.name};
  // a 2026-07-28 task (M15): an id minted here, 128 random bits, never the
  // runner's own counting one; its result shaped for that era
  if (modernTask) {
    jobOpts.taskId = `t-${require('crypto').randomBytes(16).toString('hex')}`;
    jobOpts.era = 'modern';
  }
  // its session is still live, checked in the same tick as the runner
  // remembers it (lib/job-sessions.js): a session that ended while the
  // call's auth was running gets no job (B1 Task 3)
  if (authCtx.session != null && sessionsLib().get(authCtx.session) == null) {
    return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED'))));
  }

  // cancelled while it was being authorized: no job is made at all (a job
  // made would start at once under BullMQ, and a started job can't be removed)
  if (state.cancelled) return callback(null, null);
  JobControl.addJob(authCtx, jobOpts, target.deviceID, target.serviceID, target.actionName, toolArgs, (err, result) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    if (state.cancelled) {
      // its id would never reach the client: the job goes (M19)
      // A job a worker has already started can't be removed: it runs to its
      // end and is billed, as any work that ran is, its result unread
      JobControl.removeJob(authCtx, jobOpts.name, String(result.id), false, (removeErr) => {
        if (removeErr == null) return;
        try {
          LOG.I(`task ${String(result.id).slice(0, 32)}: cancelled before its id was sent, but already running: it runs to its end (${removeErr.message})`);
        } catch (_) { /* no logger */ }
      });
      return callback(null, null);
    }

    const now = new Date().toISOString();
    if (modernTask) {
      return callback(null, resultResponse(req.id, {resultType: 'task', taskId: String(result.id), status: 'working', createdAt: now, lastUpdatedAt: now,
        ttlMs: taskTtlMs(), pollIntervalMs: TASK_POLL_INTERVAL_MS}));
    }
    const params = req.params || {};
    // ttl here is purely informational -- job-control has no result-expiry
    // mechanism, so a requested ttl isn't actually enforced. It is NOT the
    // same thing as job-control's own jobOpts.timeout (an execution deadline,
    // not a post-completion retention window), so it's never mapped onto it.
    const ttl = (params.task && typeof(params.task.ttl) === 'number') ? params.task.ttl : null;

    return callback(null, resultResponse(req.id, {
      task: {
        taskId: String(result.id),
        status: 'working',
        ttl: ttl,
        createdAt: now,
        lastUpdatedAt: now
      }
    }));
  });
}

function bullmqStateToTaskStatus(state) {
  switch (state) {
    case 'completed': return 'completed';
    case 'failed':     return 'failed';
    default:           return 'working'; // waiting/waiting-children/delayed/active/stalled/unknown
  }
}

// converts a job-control {job, state} record (the shape getJob/listJobs
// return) into an MCP TaskSchema object.
function jobToTask(record) {
  const job = record.job;
  const updateCandidates = [job.finishedOn, job.processedOn, job.timestamp].filter((t) => { return t != null; });
  const lastUpdated = updateCandidates.length > 0 ? Math.max.apply(null, updateCandidates) : job.timestamp;

  const task = {
    taskId:        String(job.id),
    status:        bullmqStateToTaskStatus(record.state),
    ttl:           (job.opts != null && job.opts.timeout != null) ? job.opts.timeout : null,
    createdAt:     new Date(job.timestamp).toISOString(),
    lastUpdatedAt: new Date(lastUpdated).toISOString()
  };

  if (record.state === 'failed' && job.failedReason != null) {
    // its runtime's "CODE: message", which can carry a module's words: cut
    // and cleaned, as a 2026-07-28 task's error is (the review of M15)
    task.statusMessage = declaredText(job.failedReason);
  }

  return task;
}

// A tasks/* request's authCtx with its session (B5 Task 2): the runner
// answers only that session's tasks in a shared runtime (seesJob). A request
// whose session isn't live (ended, unsettled, or none in shared mode) sees
// none: a session no job has. Outside shared mode the session is not read.
const NO_LIVE_SESSION = '(no live session)';
function withTaskSession(authCtx, opts) {
  const session = sessionIdOf(opts);
  return Object.assign({}, authCtx, {session: session === undefined ? NO_LIVE_SESSION : session});
}

function handleTasksGet(req, cdifInterface, appKey, callback, opts) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (gated) => {
    const authCtx = withTaskSession(gated, opts);
    JobControl.getJob(authCtx, taskId, (err, record) => {
      if (err != null) {
        // "unknown task" for both a genuinely missing id and one owned by
        // someone else -- deliberately indistinguishable, so this can't be
        // used to enumerate other tenants' taskIds.
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      }
      // a 2026-07-28 task is the extension's (M15): unknown here
      if (record.job.data != null && record.job.data.era === 'modern') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      // GetTaskResultSchema merges TaskSchema directly into the result (not
      // wrapped under a `task` key, unlike CreateTaskResultSchema).
      return callback(null, resultResponse(req.id, jobToTask(record)));
    });
  });
}

function handleTasksResult(req, cdifInterface, appKey, callback, opts) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (gated) => {
    const authCtx = withTaskSession(gated, opts);
    return doHandleTasksResult(req, cdifInterface, authCtx, taskId, callback);
  });
}

function doHandleTasksResult(req, cdifInterface, authCtx, taskId, callback) {
  JobControl.getJob(authCtx, taskId, (err, record) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
    }

    const status = bullmqStateToTaskStatus(record.state);

    // the result of a task-augmented tools/call is shaped exactly like a
    // normal (synchronous) tools/call result -- same content/isError/
    // structuredContent contract either way, via the shared toolCallResult
    // helper above.
    // a 2026-07-28 task is the extension's (M15): unknown to the legacy methods
    if (record.job.data != null && record.job.data.era === 'modern') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
    if (status === 'completed') {
      return taskCallResult(cdifInterface, authCtx, record, false, (result) => callback(null, resultResponse(req.id, result)));
    }
    if (status === 'failed') {
      return callback(null, resultResponse(req.id, toolCallResult(taskFailure(record))));
    }
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `task ${taskId} has not completed yet (status: ${status})`));
  });
}

// A completed task's CallToolResult, built once for either era (M15): the
// legacy tasks/result and a 2026-07-28 tasks/get alike. modern: the era the
// task was made for, whose view of the output schema its stamp hashed.
function taskCallResult(cdifInterface, authCtx, record, modern, done) {
  // Shaped by the module as it is loaded now, from the address the task was
  // created with (addJob keeps it main-side). structuredContent only while
  // the advertised output schema is the one the result was produced under --
  // the hash the completion stamped (jobHooks), of what the task's era sees
  // of it; after a reload that changed it, text only, even when the old
  // result would happen to validate against the new schema. Comparing hashes
  // means no module schema is compiled on the main thread.
  const data = record.job.data || {};
  const returned = record.job.returnvalue;
  return toolRegistry.resolveOutputSchemaFor(cdifInterface, authCtx.appKey, data.deviceID, data.serviceID, data.actionName, (schemaErr, rawSchema) => {
    let raw = (schemaErr != null) ? null : rawSchema;
    const seen = toolRegistry.forEra(raw, modern);
    if (raw != null && (seen == null ? data.outputSchemaHash != null : (data.outputSchemaHash == null || outputSchemaHash(seen) !== data.outputSchemaHash))) raw = null;
    const jobTarget = toolRegistry.targetFor(cdifInterface, data.deviceID, data.serviceID, data.actionName);
    if (jobTarget != null && jobTarget.role === 'scenario' && receiptReserved(returned)) return done(toolCallResult(new CountinghouseError('RECEIPT_RESERVED')));
    // stored once, at completion (M6): its URIs are kept with the job, and a
    // store that failed then is the task's error now
    if (data.resultStoreError != null) {
      const kept = data.resultStoreError;
      return done(toolCallResult(kept.limit != null
        ? CountinghouseError.withFields(String(kept.code), {limit: String(kept.limit)}) : new CountinghouseError(String(kept.code))));
    }
    return done(addTaskReceipt(moduleToolResultWith(returned, raw,
      {module: jobTarget != null ? jobTarget.module : 'module', action: data.actionName, tool: jobTarget != null ? jobTarget.name : null}, modern,
      (data.resultUris != null && typeof(data.resultUris) === 'object') ? data.resultUris : {}), data));
  }, {raw: true});
}

// A failed task's error, from its job's failedReason. job-control's worker
// encodes a failed job's error as "CODE: message" (BullMQ persists only the
// string, dropping a CountinghouseError's code), so the code is decoded
// here: a task's failure carries the same locale-independent code a
// synchronous tools/call's does. Its text is cut and cleaned as declared
// text for either era (it can carry a module's words; the review of #329).
// `answered`: a 2026-07-28 task's run whose call answered with this error
// (job-control-common CALL_ANSWERED), its result, not a run that left none.
function taskFailure(record) {
  let failedReason = record.job.failedReason != null ? String(record.job.failedReason) : 'task failed';
  const {CALL_ANSWERED} = require('../job-control-common');
  const answered = failedReason.startsWith(CALL_ANSWERED);
  if (answered) failedReason = failedReason.slice(CALL_ANSWERED.length);
  // a code as the runtime writes one, at most 64 characters: anything else
  // is the message's own text (a module's words), cut and cleaned with it
  const codeMatch = /^([A-Z][A-Z0-9_]{0,63}): /.exec(failedReason);
  const failErr = new Error(declaredText(codeMatch != null ? failedReason.slice(codeMatch[0].length) : failedReason) || 'the task failed');
  if (codeMatch != null) failErr.code = codeMatch[1];
  failErr.answered = answered;
  return failErr;
}

// tasks/get, tasks/update and tasks/cancel for a 2026-07-28 request (M15,
// spec section 9). The extension's gate first: a request that does not
// declare it is -32021. Then identity and the rate limit, as the legacy
// methods have them; then the task, which must be the caller's own
// (JobControl.getJob: the session first in a shared runtime, B5 Task 2's
// seesJob, then the owner key) and a 2026-07-28 one. Anything
// else -- another caller's task, an unknown or malformed id, a legacy task --
// is the one -32602, which echoes no id. A cancelled task reads `cancelled`
// from its tombstone (lib/task-tombstones.js), to its owner and session only.
const UNKNOWN_TASK = 'unknown task';

// A 2026-07-28 task as tasks/get finds it (B5 Task 2; M16's notifications
// use the same, so a listener follows only what tasks/get would answer).
// authCtx: the caller's, with its session: callers pass withTaskSession's
// ctx (an unset or a non-live session is no session). -> Promise of
// {taskId, record} (a job, seen by the session and owned by the key: JobControl.getJob's
// seesJob then ownsJob, and a 2026-07-28 one), {tombstone} (one the caller
// cancelled: its owner and session: {taskId, tombstone}), or null: everything tasks/get answers
// -32602 for (a malformed id, another key's or session's, a legacy task, none).
function findModernTask(authCtx, taskId) {
  if (typeof(taskId) !== 'string' || !require('../job-control-common').TASK_ID.test(taskId)) return Promise.resolve(null);
  const owner = require('../key-fingerprint').meterId(authCtx.appKey);
  // A task its owner cancelled reads cancelled, whether its job was removed
  // or, already running, goes on to its end unread (cooperative). Anyone
  // else's tombstone is no answer at all.
  // the tombstone's session by the scope rule, as seesJob judges a job's
  // (lib/session-scope.js): outside shared mode the owner key decides; in
  // shared mode only a live session's own (an unset session, or
  // NO_LIVE_SESSION, is none), compared by its sessionKey hash (the review
  // of B5 Task 2, L1 and L2)
  const scope = require('../session-scope');
  const session = (authCtx.session == null || authCtx.session === NO_LIVE_SESSION) ? null : authCtx.session;
  const seen = (tb) => scope.sees(scope.of(taskTombstones.sessionKey(session)), tb.session == null ? null : tb.session);
  return taskTombstones.get(taskId).then((tb) => tb, () => null).then((tb) => {
    if (tb != null && tb.owner === owner && seen(tb)) return {taskId, tombstone: tb};
    return new Promise((resolve) => JobControl.getJob(authCtx, taskId, (err, record) => {
      if (err != null || record == null || record.job.data == null || record.job.data.era !== 'modern') return resolve(null);
      return resolve({taskId, record});
    }));
  });
}

// A cancelled task as tasks/get answers it, from its tombstone.
function cancelledTaskView(taskId, tombstone) {
  return {taskId, status: 'cancelled', createdAt: tombstone.createdAt, lastUpdatedAt: tombstone.cancelledAt, ttlMs: taskTtlMs(), pollIntervalMs: TASK_POLL_INTERVAL_MS};
}

// A found 2026-07-28 task (findModernTask's record) as tasks/get answers it
// (B5 Task 2, for M16): its status and times; a completed one's result; a
// run whose call answered with an error is completed with that isError
// result (the review of #329); a failed one's error, its code and its text
// cut and cleaned. -> Promise of the DetailedTask.
function modernTaskView(record, cdifInterface, authCtx) {
  return new Promise((resolve) => {
    const task = modernTaskOf(record);
    // M16 D3: a working task's statusMessage is how far it is, its last
    // ctx.job.progress as "NN%"; a failed one's (below) its code
    if (task.status === 'working') {
      const pct = progressText(record.job.progress);
      if (pct != null) task.statusMessage = pct;
    }
    if (task.status === 'completed') return taskCallResult(cdifInterface, authCtx, record, true, (result) => resolve(Object.assign(task, {result})));
    if (task.status === 'failed') {
      const failure = taskFailure(record);
      // A run whose call answered with an error is completed, its result
      // the isError CallToolResult a synchronous call would have returned
      // (spec section 9; the review of #329): the handler's own error, a
      // crash, a refused output. failed is only for a run that left no
      // result -- a timeout, a lost worker, a refused auth re-check -- with
      // its code and its text, cut and cleaned.
      if (failure.answered === true) {
        task.status = 'completed';
        task.result = toolCallResult(failure);
        return resolve(task);
      }
      task.error = Object.assign({code: JSONRPC_INTERNAL_ERROR, message: failure.message}, failure.code != null ? {data: {[ERROR_CODE_META_KEY]: failure.code}} : {});
      // its code, never its text (which can be a module's words): "failed"
      // for one with none (the runner's timeout)
      task.statusMessage = (failure.code != null) ? failure.code : 'failed';
    }
    return resolve(task);
  });
}

// A task's progress as its statusMessage (M16 D3): a finite number,
// clamped to 0-100 and rounded, as "NN%"; null for anything else: a value a
// handler gave that isn't a number, or 0, where both runners start a job
// (a task that never reports would otherwise read "0%" to its end).
function progressText(progress) {
  if (typeof(progress) !== 'number' || !Number.isFinite(progress) || progress <= 0) return null;
  return `${Math.round(Math.min(100, Math.max(0, progress)))}%`;
}

// What tasks/get answers for a found task (findModernTask's): the cancelled
// view from its tombstone, or the task's view with its result or error.
// M16's notifications send the same, so the two are one by construction.
// -> Promise of the DetailedTask.
function detailedTask(found, cdifInterface, authCtx) {
  if (found.tombstone != null) return Promise.resolve(cancelledTaskView(found.taskId, found.tombstone));
  return modernTaskView(found.record, cdifInterface, authCtx);
}

function handleModernTask(req, cdifInterface, appKey, callback, opts) {
  const params = req.params || {};
  // Where the extension is not offered at all -- jobs cannot run -- its
  // methods are unknown, as before M15. Where it is
  // offered, a request that does not declare it is the gate's -32021.
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${req.method}`));
  }
  if (!declaresTasks(params)) {
    return callback(null, errorResponse(req.id, MISSING_REQUIRED_CAPABILITY, `${req.method} needs the ${TASKS_EXTENSION} extension, declared in the request's _meta`,
      {requiredCapabilities: {extensions: {[TASKS_EXTENSION]: {}}}}));
  }
  const unknown = () => callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, UNKNOWN_TASK));
  const empty = () => callback(null, resultResponse(req.id, {}));
  const taskId = params.taskId;
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (resolved) => {
    // the session's own: one that isn't live sees none (withTaskSession)
    const authCtx = withTaskSession(resolved, opts);
    return findModernTask(authCtx, taskId).then((found) => {
      if (found == null) return unknown();
      if (found.tombstone != null) {
        if (req.method !== 'tasks/get') return empty();
        return detailedTask(found, cdifInterface, authCtx).then((view) => callback(null, resultResponse(req.id, view)));
      }
      const record = found.record;
      {
        const task = modernTaskOf(record);
        // nothing is ever input_required in release 1: every key is not outstanding
        if (req.method === 'tasks/update') return empty();
        if (req.method === 'tasks/cancel') {
          // A task that has finished, or was cancelled already, is acknowledged
          // and left as it is: no job removed, no tombstone, its status and
          // result unchanged (ext-tasks 2026-07-28 has no terminal-status rule:
          // "on success ... an empty result", cancellation cooperative; the
          // Reviewer's ruling on #329).
          if (task.status !== 'working') return empty();
          // cooperative, as the legacy cancel: a job not yet running is
          // removed; a run already in a worker can't be, so it goes on to its
          // end, billed, and is kept as a finished job is. Either way its
          // owner reads `cancelled`, with no result, from the tombstone: the
          // removed job's for the task's ttlMs, the running job's for as long
          // as the job can be kept (lib/task-tombstones.js `lasting`), so it
          // never reads completed later (the review of #329). The tombstone
          // is the job OWNER's, whoever cancels (an admin may).
          const tombstone = (lasting) => taskTombstones.put(taskId, {owner: taskOwnerOf(record.job.data), session: authCtx.session, createdAt: task.createdAt},
            taskTtlMs(), {lasting}).catch((e) => { try { LOG.E(e); } catch (_) { /* no logger */ } }).then(empty);
          return JobControl.removeJob(authCtx, record.job.name, taskId, false, (removeErr) => {
            if (removeErr == null) return tombstone(false);
            try { LOG.I(`task ${taskId.slice(0, 34)}: cancelled while running: it runs to its end, unread`); } catch (_) { /* no logger */ }
            return tombstone(true);
          });
        }
        // tasks/get: the DetailedTask (M16's notifications are the same)
        return detailedTask(found, cdifInterface, authCtx).then((view) => callback(null, resultResponse(req.id, view)));
      }
    });
  });
}

// The opaque id a task's tombstone is kept under: its job OWNER's, as
// tasks/get compares it (meterId of the caller's key), whoever cancels.
function taskOwnerOf(jobData) {
  const ownerKey = require('../job-control-common').ownerKeyOf(jobData);
  return ownerKey != null ? require('../key-fingerprint').meterId(ownerKey) : null;
}

// a job record as a 2026-07-28 task: its status (waiting, delayed and active
// are working), times, ttlMs and poll interval
function modernTaskOf(record) {
  const job = record.job;
  const updates = [job.finishedOn, job.processedOn, job.timestamp].filter((t) => t != null);
  return {taskId: String(job.id), status: bullmqStateToTaskStatus(record.state), createdAt: new Date(job.timestamp).toISOString(),
    lastUpdatedAt: new Date(updates.length > 0 ? Math.max.apply(null, updates) : job.timestamp).toISOString(), ttlMs: taskTtlMs(),
    pollIntervalMs: TASK_POLL_INTERVAL_MS};
}

function handleTasksList(req, cdifInterface, appKey, callback, opts) {
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (gated) => {
    const authCtx = withTaskSession(gated, opts);
    // listJobs filters to this caller's own jobs (see its comment) -- an
    // empty list is the correct answer for a caller with none, not an error.
    JobControl.listJobs(authCtx, (err, records) => {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      }
      // a 2026-07-28 task is the extension's (M15): never in the legacy list
      return callback(null, resultResponse(req.id, {tasks: records.filter((r) => r.job == null || r.job.data == null || r.job.data.era !== 'modern').map(jobToTask)}));
    });
  });
}

function handleTasksCancel(req, cdifInterface, appKey, callback, opts) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (gated) => {
    const authCtx = withTaskSession(gated, opts);

    JobControl.getJob(authCtx, taskId, (err, record) => {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      }

      if (record.job.data != null && record.job.data.era === 'modern') return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      // bullmq's job.remove() deletes the job outright rather than leaving it
      // queryable in a terminal state, so the task shape is captured *before*
      // removing and its status is forced to 'cancelled' for this response --
      // a subsequent tasks/get for this taskId will correctly report "unknown
      // task" once it's actually gone.
      const task = jobToTask(record);
      task.status = 'cancelled';

      // removeJob re-checks ownership itself rather than trusting the getJob
      // above -- the gate belongs on every mutating entry point, not on the
      // read that happened to precede it.
      JobControl.removeJob(authCtx, record.job.name, taskId, false, (removeErr) => {
        if (removeErr != null) {
          return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, removeErr.message || String(removeErr)));
        }
        return callback(null, resultResponse(req.id, task));
      });
    });
  });
}

// notifications (no `id`) never get a response -- per JSON-RPC 2.0 and MCP's
// Streamable HTTP transport, the server MUST NOT write a body for these.
const NOTIFICATION_METHODS = {
  'notifications/initialized': true
};
// Removed in 2026-07-28 (ping, logging/setLevel), or the legacy tasks, which
// that revision moved to an extension not served in release 1 (#232).
const REMOVED_IN_MODERN = {'ping': true, 'logging/setLevel': true,
  'tasks/get': true, 'tasks/result': true, 'tasks/list': true, 'tasks/cancel': true};
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const MODERN_TASK_METHODS = {'tasks/get': true, 'tasks/update': true, 'tasks/cancel': true};

// handles exactly one JSON-RPC request/notification object. batching (an array
// of these) is handled by the route layer, which calls this once per entry.
function handle(req, cdifInterface, appKey, callback, opts) {
  if (req == null || typeof(req) !== 'object' || req.jsonrpc !== '2.0' || typeof(req.method) !== 'string') {
    return callback(null, errorResponse(req && req.id, JSONRPC_INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
  }

  // A message without an id is a notification, whatever its method: it is
  // never answered (JSON-RPC 2.0; over HTTP, 202). id null is not an id.
  if (NOTIFICATION_METHODS[req.method] === true || req.id === undefined) {
    return callback(null, null);
  }
  if (req.id === null) return callback(null, errorResponse(null, JSONRPC_INVALID_REQUEST, 'a request\'s id is a string or a number, never null'));

  // 2026-07-28 (#229): a modern request is checked, then answered with
  // resultType on its result, and an unknown method is HTTP 404. callback's
  // third argument, {status}, is for the HTTP route; stdio ignores it.
  const headers = opts != null ? opts.headers : null;
  const modern = era.isModern(req, headers);
  if (modern) {
    const problem = era.checkModern(req, headers);
    if (problem != null) return callback(null, errorResponse(req.id, problem.code, problem.message, problem.data), {status: 400});
    const answer = callback;
    callback = (err, res, info) => {
      if (res != null && res.result != null && typeof(res.result) === 'object') {
        const result = Object.assign({}, res.result);
        if (result.resultType === undefined) result.resultType = 'complete';
        // the caching hints tools/list MUST carry (server/utilities/caching):
        // stale at once, since packs change in place, and per caller
        if (req.method === 'tools/list' && result.resultType === 'complete') {
          if (result.ttlMs === undefined) result.ttlMs = 0;
          if (result.cacheScope === undefined) result.cacheScope = 'private';
        }
        // serverInfo on every result (a SHOULD)
        result._meta = Object.assign({}, result._meta, {[SERVER_INFO_KEY]: {name: SERVER_NAME, version: SERVER_VERSION}});
        res = Object.assign({}, res, {result});
      }
      return answer(err, res, info != null ? info : ((res != null && res.error != null && res.error.code === JSONRPC_METHOD_NOT_FOUND) ? {status: 404} : undefined));
    };
    if (req.method === 'server/discover') return handleDiscover(req, callback, opts);
    if (req.method === 'subscriptions/listen' && opts != null && opts.subscriptions != null && typeof(opts.openStream) === 'function') {
      return handleListen(req, cdifInterface, appKey, callback, opts);
    }
    // the tasks extension's three methods (M15); tasks/result and tasks/list
    // stay removed, below
    if (MODERN_TASK_METHODS[req.method] === true) return handleModernTask(req, cdifInterface, appKey, callback, opts);
    // removed in 2026-07-28 (changelog: "Remove ping, logging/setLevel")
    if (REMOVED_IN_MODERN[req.method] === true) return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${req.method}`));
  }

  switch (req.method) {
    case 'initialize':
      // a shared runtime's session: its client, as its own first initialize
      // names it (lib/sessions.js); --stdio records its one in route-manager
      if (opts != null && opts.session != null) sessionsLib().recordClientInfo(opts.session.id, req.params != null ? req.params.clientInfo : null);
      return handleInitialize(req, cdifInterface, callback, opts);
    case 'ping':          return handlePing(req, cdifInterface, callback);
    // stdio and a shared runtime's session declare logging (pack-change
    // notices): the level the client asks for decides whether a notice is
    // also sent as notifications/message; a session's is its own (B2 Task 3)
    case 'logging/setLevel': {
      const session = (opts != null && opts.session != null) ? opts.session.id : null;
      if (session == null && (opts == null || opts.listChanged !== true)) break;
      const notices = require('../notices');
      const level = req.params != null ? req.params.level : null;
      if (!notices.LEVELS.includes(level)) {
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `params.level must be one of ${notices.LEVELS.join(', ')}`));
      }
      // false: a session whose notices aren't open (it has ended, or not
      // yet settled): it sets nothing, and is told so
      if (!notices.setLevel(level, session)) return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'this session\'s level cannot be set now: it has ended or has not settled'));
      return callback(null, resultResponse(req.id, {}));
    }
    case 'tools/list':    return handleToolsList(req, cdifInterface, appKey, callback, modern, opts);
    case 'tools/call':    return handleToolsCall(req, cdifInterface, appKey, callback, modern, opts);
    case 'resources/read': return handleResourcesRead(req, cdifInterface, appKey, callback, opts, modern);
    case 'prompts/list':  return handlePromptsList(req, cdifInterface, appKey, callback, opts);
    case 'prompts/get':   return handlePromptsGet(req, cdifInterface, appKey, callback, opts);
    case 'completion/complete': return handleCompletion(req, cdifInterface, appKey, callback, opts);
    // the modules' resources (M7); a stored result (M6) is reached by its
    // link only, never listed
    case 'resources/list':           return handleResourceLists(req, cdifInterface, appKey, callback, false, opts);
    case 'resources/templates/list': return handleResourceLists(req, cdifInterface, appKey, callback, true, opts);
    // appKey is threaded into tasks/* exactly the way it already was into
    // tools/* -- its absence from these four signatures was the whole of the
    // bug: with no key in scope there was nothing to authorize against, so
    // any caller (including one with no key at all) could read, enumerate,
    // and cancel every tenant's tasks.
    // (a shared runtime's session's tasks are its own: B5 Task 2, the
    // runner's scope by session, lib/job-control-common.js seesJob)
    default:
      break;
  }
  switch (req.method) {
    case 'tasks/get':     return handleTasksGet(req, cdifInterface, appKey, callback, opts);
    case 'tasks/result':  return handleTasksResult(req, cdifInterface, appKey, callback, opts);
    case 'tasks/list':    return handleTasksList(req, cdifInterface, appKey, callback, opts);
    case 'tasks/cancel':  return handleTasksCancel(req, cdifInterface, appKey, callback, opts);
    default:
      break;
  }
  // a method not served here (logging/setLevel over HTTP, which declares no logging)
  return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${req.method}`));
}

// A task's binary values, stored once at completion as its owner's, in the
// job's session (its run's: lib/job-sessions.js), as a call's are in the
// call's (M6). -> {raw, uris, error, entries}
function placeTaskValues(jobData, results, schema, session, who) {
  let entries = null;
  try {
    entries = (schema != null && blockFields(schema).length > 0) ? resultContent.plan(results != null ? results.output : undefined, schema, who, {inlineBytes: options.inlineContentBytes}) : null;
  } catch (e) {
    return Promise.resolve({raw: schema, uris: {}, error: null, entries: null});   // the result's own error, which buildResult reports
  }
  // a job completed again (a stalled run taken up again) keeps the values
  // its first completion stored, never a second set (the review of #313)
  const kept = jobData != null ? jobData.resultUris : null;
  if (kept != null && typeof(kept) === 'object' && Object.keys(kept).length > 0) return Promise.resolve({raw: schema, uris: kept, error: null, entries});
  if (entries == null || !entries.some((e) => e.store)) return Promise.resolve({raw: schema, uris: {}, error: null, entries});
  const owner = (jobData.ownerId != null) ? String(jobData.ownerId) : opaqueCallerOf(require('../job-control-common').ownerKeyOf(jobData));
  return resultContent.store(entries, {blobs: blobsOf(), owner, session: typeof(session) === 'string' ? session : null, source: who})
    .then((uris) => ({raw: schema, uris, error: null, entries}), (error) => ({raw: schema, uris: {}, error, entries}));
}

// resources/read (M6, spec section 2): a stored result, read by the caller
// who owns it, in its session. The rate limit is checked first (before any
// lookup); then the URI must be countinghouse://r/<43-character id>, and
// the store's get does the access check. An unknown, expired, malformed or
// foreign URI is answered alike: -32602 "Resource not found", never an
// empty contents. text/* that is valid UTF-8 comes back as text, anything
// else as blob; ttlMs is the time left, cacheScope private. Each read is
// written to the usage records with its bytes, and recorded with the
// metering provider at --resourceReadCost.
const RESOURCE_NOT_FOUND = 'Resource not found';
// A module resource (M7, spec section 3): countinghouse://m/<module>/<path>.
// The URI is parsed strictly among the caller's own resources, and anything
// that reads nothing -- malformed, an unknown or unloaded module, a device
// not granted, a module not listed to the caller, no template matching, a
// variable refused -- is the one "Resource not found". The read runs the
// action through tools/call's own runner (runModuleTarget): authorized, rate
// limited, its input and output validated, counted and billed as that
// action's call.
function handleModuleResourceRead(req, cdifInterface, appKey, answer, opts, modern) {
  // cancellable from the first moment, as M6's path is (the review of #327):
  // a cancel during the identity and listing lookups below is kept, and the
  // read then neither runs nor bills; the runner takes this one over
  const early = earlyCancellable(opts, answer);
  const callback = early.callback;
  const notFound = () => callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, RESOURCE_NOT_FOUND));
  const sessionId = sessionIdOf(opts);
  // an ended session reads nothing, as it calls nothing
  if (sessionId === undefined) return notFound();
  const uri = req.params.uri;
  return resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    // a resource of a pack the session doesn't list is a URI never served (B3)
    resourcesLib.listEntries(cdifInterface, authCtx.appKey, (err, entries) => {
      if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      // cancelled while it was looked up: nothing runs, nothing is answered
      if (early.isCancelled()) return callback(null, null);
      const found = resourcesLib.find(entries, uri);
      // A URI that reads nothing is limited too (the review of M7): a probe
      // costs a lookup. A limited caller gets the refusal a limited read of a
      // real resource gets (invokeDeviceAction's DENY_DEVICE_ACCESS), so the
      // limit says nothing of what exists.
      if (found == null) {
        return rateLimitGate.check(cdifInterface, authCtx.appKey, (limited) => (limited === true
          ? callback(null, resourceFormat(null, uri).answer(req, toolCallResult(new CountinghouseError('DENY_DEVICE_ACCESS'))))
          : notFound()));
      }
      return runModuleTarget(req, cdifInterface, appKey, found.entry.target, found.input, modern, opts, sessionId, callback, resourceFormat(found.entry, uri), early);
    }, {session: sessionId});
  });
}

// A read's format for the runner: the output as one `contents` entry (the
// result the usage record reads is its text, or its blob as an inline
// resource block); a handler's error as -32603 with its countinghouse/code.
function resourceFormat(entry, uri) {
  return {
    receipts: false,
    // a resource read asks no one (runModuleTarget)
    ask: null,
    // in a promise: an output that cannot be made JSON (a cycle, a BigInt) is
    // the read's error, as it is a call's, never a read left unanswered
    shape(data, rawSchema) {
      return Promise.resolve().then(() => {
        const contents = resourcesLib.contentsOf(entry, uri, data != null ? data.output : undefined, rawSchema);
        const content = contents.blob != null ? [{type: 'resource', resource: contents}] : [{type: 'text', text: contents.text}];
        return {content, contents};
      });
    },
    answer(req, result) {
      if (result.isError === true || result.contents == null) {
        const code = result._meta != null ? result._meta[ERROR_CODE_META_KEY] : undefined;
        const text = (Array.isArray(result.content) ? result.content : []).filter((c) => c != null && c.type === 'text').map((c) => c.text).join('\n');
        return errorResponse(req.id, JSONRPC_INTERNAL_ERROR, text !== '' ? text : 'the resource could not be read', code != null ? {[ERROR_CODE_META_KEY]: code} : undefined);
      }
      return resultResponse(req.id, {contents: [result.contents], ttlMs: 0, cacheScope: 'private'});
    }
  };
}

// resources/list (templates: false) and resources/templates/list (true), per
// caller as tools/list is, paged with M1's cursor and M2's byte cut
function handleResourceLists(req, cdifInterface, appKey, callback, templates, opts) {
  const kind = templates ? 'resourceTemplates' : 'resources';
  const field = templates ? 'resourceTemplates' : 'resources';
  const cursor = req.params != null ? req.params.cursor : undefined;
  let anchor;
  if (cursor != null) {
    anchor = pages.decodeCursor(kind, cursor);
    if (anchor == null) return callback(null, invalidCursor(req));
  }
  // the session's own (B3): a pack it doesn't list is not in it; one that
  // isn't live gets nothing, as its other lists (the reviewer's ruling (6) on #340)
  const session = sessionIdOf(opts);
  if (session === undefined) return callback(null, resultResponse(req.id, {[field]: [], ttlMs: 0, cacheScope: 'private'}));
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    resourcesLib.listEntries(cdifInterface, authCtx.appKey, (err, entries) => {
      if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      const ofKind = entries.filter((e) => resourcesLib.isStatic(e) !== templates);
      // the anchor: the URI (or URI template) after its fixed prefix, which
      // keeps the longest within the cursor's bound
      const keys = ofKind.map((e) => e.uriTemplate.slice(resourceUri.PREFIX.length));
      const cut = pages.page(keys, anchor, options.listPageSize);
      if (cut == null) return callback(null, invalidCursor(req));
      // only the page's entries are described (their icons inlined)
      let items = ofKind.slice(cut.from, cut.to).map((e) => resourcesLib.describe(cdifInterface, e));
      let next = cut.next;
      const kept = pages.fitting(items);
      if (kept < items.length) {
        items = items.slice(0, kept);
        next = keys[cut.from + kept - 1];
      }
      const result = {[field]: items};
      if (next != null) result.nextCursor = pages.encodeCursor(kind, next);
      result.ttlMs = 0;
      result.cacheScope = 'private';
      return callback(null, resultResponse(req.id, result));
    }, {session: session});
  });
}

function handleResourcesRead(req, cdifInterface, appKey, answer, opts, modern = false) {
  // a module's resource (M7) is read by its action; anything else is M6's
  // stored results' path, as it was
  if (req.params != null && typeof(req.params.uri) === 'string' && req.params.uri.startsWith(resourceUri.PREFIX)) {
    return handleModuleResourceRead(req, cdifInterface, appKey, answer, opts, modern);
  }
  // cancellable while it runs (M19 x M6): a read cancelled before it is
  // charged is neither charged nor served
  const cancellation = cancellableCallback(opts, () => {}, answer);
  const callback = cancellation.callback;
  return resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    const sessionId = sessionIdOf(opts);
    const notFound = () => callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, RESOURCE_NOT_FOUND));
    const uri = (req.params != null) ? req.params.uri : null;
    const id = resultContent.idOfUri(uri);
    const owner = opaqueCallerOf(authCtx.appKey);
    if (id == null || owner == null || sessionId === undefined || !require('../store/blobs').isId(id)) return notFound();
    const startedMs = Date.now();
    return Promise.resolve().then(() => blobsOf().get(id, {owner, session: sessionId})).then((found) => {
      if (found == null) return notFound();
      const {meta, bytes} = found;
      // charged before it is served, so the cost holds: a refusal from the
      // metering provider (no balance left) is the read's answer
      if (cancellation.isCancelled()) return callback(null, null);
      return cdifInterface.recordCall(authCtx.appKey, 'countinghouse:resources/read', options.resourceReadCost, (meterErr) => {
        // a fixed text: the provider's own message is logged, never echoed
        // (the review of #313)
        if (meterErr != null) {
          try { LOG.E(meterErr); } catch (_) { /* no logger: the answer still goes */ }
          return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, 'the read could not be metered'));
        }
        const content = {uri, mimeType: meta.mimeType};
        const text = /^text\//.test(meta.mimeType) ? utf8Of(bytes) : null;
        if (text != null) content.text = text; else content.blob = bytes.toString('base64');
        try {
          const usage = usageRuntime.usage();
          const call = usage.beginCall({pack: null, module: meta.source != null ? meta.source.module : null, tool: 'resources/read', caller: owner, session: sessionsLib().forUsage(sessionId)});
          usage.recordOut(call, {tool: 'resources/read', bytes: bytes.length, lines: 0, ms: Math.max(0, Date.now() - startedMs), outcome: 'ok'});
        } catch (e) {
          LOG.E(e);
        }
        return callback(null, resultResponse(req.id, {contents: [content], ttlMs: Math.max(0, meta.expiresAt - Date.now()), cacheScope: 'private'}));
      });
    }, (e) => {
      LOG.E(e);
      return notFound();
    });
  });
}
// bytes as text when they are valid UTF-8, else null
function utf8Of(bytes) {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch (e) {
    return null;
  }
}

// JobControl's completion hook (registered in framework.js): stamps a
// completed job with the hash of the output schema its result was produced
// under, resolved as the job's owner -- jobData.apiKey, the authenticated
// creator addJob recorded. (R2-1 will have to give this hook the owner's
// identity another way if job data stops carrying the raw key.) Nothing for
// a job without an owner, or an action without an output schema: tasks/result
// then sends text only.
function stampOutputSchema(cdifInterface) {
  return (jobData) => new Promise((resolve) => {
    const ownerKey = require('../job-control-common').ownerKeyOf(jobData);
    if (ownerKey == null) return resolve(null);
    toolRegistry.resolveOutputSchemaFor(cdifInterface, ownerKey, jobData.deviceID, jobData.serviceID, jobData.actionName,
      (err, schema) => resolve((err != null || schema == null) ? null : {outputSchemaHash: outputSchemaHash(schema)}));
  });
}

// The job processor's two hooks (framework.js): the start hook mints a
// task's usage call where the job runs, and the completion hook stamps the
// output schema hash and writes the Out record with the receipt it keeps
// (local-mode spec §5, step 3b). The Out record counts the text tasks/result
// will send, built with the schema the result is stamped with (review of
// #60). A failed run is only counted.
function jobHooks(cdifInterface) {
  const usage = taskHooks({
    usage: () => usageRuntime.usage(),
    targetFor: (d) => toolRegistry.targetFor(cdifInterface, d.deviceID, d.serviceID, d.actionName),
    callerOf: opaqueCallerOf,
    // placed: {raw, uris, error}, stored by complete below before counting
    buildResult: (err, results, placed, target) => (err != null ? toolCallResult(err)
      : (placed != null && placed.error != null) ? toolCallResult(placed.error)
        : moduleToolResultWith(results, placed != null ? placed.raw : null, {module: target != null ? target.module : 'module',
          action: target != null ? target.actionName : 'action', tool: target != null ? target.name : null}, false, placed != null ? placed.uris : {},
        placed != null ? placed.entries : null))
  });
  const placeTask = (jobData, results, schema, session = null) => {
    const target = toolRegistry.targetFor(cdifInterface, jobData.deviceID, jobData.serviceID, jobData.actionName);
    return placeTaskValues(jobData, results, schema, session,
      {module: target != null ? target.module : 'module', action: jobData.actionName, tool: target != null ? target.name : null});
  };
  const schemaOf = (jobData) => new Promise((resolve) => {
    const ownerKey = require('../job-control-common').ownerKeyOf(jobData);
    if (ownerKey == null) return resolve(null);
    toolRegistry.resolveOutputSchemaFor(cdifInterface, ownerKey, jobData.deviceID, jobData.serviceID, jobData.actionName,
      (err, schema) => resolve(err != null ? null : schema), {raw: true});
  });
  return {
    start: usage.start,
    complete: (jobData, results, run) => {
      if (run != null && run.error != null) return usage.complete(jobData, null, run);
      return schemaOf(jobData).then((schema) => placeTask(jobData, results, schema, run != null ? run.session : null).then((placed) => {
        const kept = usage.complete(jobData, results, run, placed);
        // the stamp is of what the task's era sees: a 2026-07-28 task's
        // (M15, jobData.era) the modern view, any other the legacy one
        const seen = toolRegistry.forEra(schema, jobData.era === 'modern');
        const stamped = seen == null ? null : {outputSchemaHash: outputSchemaHash(seen)};
        const stored = Object.keys(placed.uris).length > 0 ? {resultUris: placed.uris} : null;
        // the store's own code (RESULT_STORE_FULL with its limit); anything
        // uncoded is a result that could not be stored
        const refused = placed.error != null ? {resultStoreError: {code: placed.error.code || 'RESULT_NOT_STORABLE',
          limit: (placed.error.fields != null && placed.error.fields.limit != null) ? placed.error.fields.limit : null}} : null;
        return (stamped == null && kept == null && stored == null && refused == null) ? null : Object.assign({}, stamped, kept, stored, refused);
      }));
    }
  };
}

module.exports = {
  sessionIdOf: sessionIdOf,   // (B5 and M17: a request's session)
  // a 2026-07-28 task as tasks/get finds and answers it (B5 Task 2, for M16)
  findModernTask: findModernTask,
  detailedTask: detailedTask,
  modernTaskView: modernTaskView,
  cancelledTaskView: cancelledTaskView,
  withTaskSession: withTaskSession,
  scopeOf: scopeOf,
  placeTaskValues: placeTaskValues,   // (test/mcp-contract/17)
  doCreateTaskForToolCall: doCreateTaskForToolCall,   // (test/mcp-contract/17)
  handle: handle,
  stampOutputSchema: stampOutputSchema,
  jobHooks: jobHooks,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  JSONRPC_PARSE_ERROR: JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST: JSONRPC_INVALID_REQUEST,
  errorResponse: errorResponse
};
