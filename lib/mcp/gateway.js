// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
const path          = require('path');
const execFile      = require('child_process').execFile;
const userAuth      = require('../user-auth');
const toolRegistry  = require('./tool-registry');
const JobControl    = require('../store').jobs;   // the store's job runner (lib/store.js)
const options       = require('../cli-options');
const planValidator = require('../plan-validator');
const LOG           = require('../logger');
const encodeLegacyTool = require('../metering/provider').encodeLegacyTool;
const rateLimitGate = require('../rate-limit-gate');
const outputSchemaHash = require('./output-schema-hash').outputSchemaHash;
const {blockFields} = require('../binary-fields');
const resultContent = require('./result-content');
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
const sessionSettingsLib = requireOnce(() => require('../session-settings'));
const callLimitsLib = requireOnce(() => require('../call-limits'));

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
  // stored results are read back with resources/read (M6, spec section 2);
  // they are never listed, and there are no templates
  capabilities.resources = {};
  // stdio and a session: pack changes are announced with
  // notifications/message (lib/notices.js)
  if ((stdio || session) && !modern) capabilities.logging = {};
  // Tasks are the legacy era's here. 2026-07-28 moved them to the
  // io.modelcontextprotocol/tasks extension, which release 1 doesn't serve
  // (#232; the full extension is #239), so discover advertises none.
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

function handleToolsList(req, cdifInterface, appKey, callback, modern = false) {
  toolRegistry.buildToolList(cdifInterface, appKey, (err, tools) => {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));

    // Authoring tools are appended rather than built into buildToolList
    // because listing them needs isAdmin, which only this layer resolves.
    if (options.getOptions().authoringTools !== true || options.singleIdentity === true) {
      return callback(null, resultResponse(req.id, {tools: tools}));
    }
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null || authCtx.isAdmin !== true) {
        return callback(null, resultResponse(req.id, {tools: tools}));
      }
      return callback(null, resultResponse(req.id, {tools: tools.concat(toolRegistry.AUTHORING_TOOLS)}));
    });
  }, {modern});
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
      return handleToolsCall(innerReq, cdifInterface, appKey, (innerCallbackErr, innerResp) => {
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
        const sessionMaySet = sessionSettingsLib().CAPS.includes(args.name);
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
        usageReport(toolArgs, {caller: opaqueCallerOf(authCtx.appKey), isAdmin: authCtx.isAdmin === true}, {usage: usageRuntime.usage(), usageDir: options.usageDir || null})
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
  const target = toolRegistry.buildToolTargets(cdifInterface, {includeUnlisted: true})[name];

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
    return createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback, sessionId);
  }

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
  // the resolved caller's key (session.appKey), set before any result
  let callerKey = appKey;

  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, (err, data) => {
    if (err != null) return respond(toolCallResult(err));
    // `receipt` is reserved only where the runtime adds its own: a scenario's
    // result (LM1 §5). Any other module's receipt field is its own business.
    if (target.role === 'scenario' && receiptReserved(data)) return respond(toolCallResult(new CountinghouseError('RECEIPT_RESERVED')));
    // a stored value is the outer caller's: a composite's parts never come
    // through here (M6)
    // the owner is the resolved caller (session.appKey), as the usage call's
    // and resources/read's are, never the raw header
    return moduleToolResult(data, callRawSchema, {module: target.module, action: target.actionName, tool: target.name}, modern === true,
      {blobs: blobsOf(), owner: opaqueCallerOf(callerKey), session: sessionId})
      .then(respond, (e) => respond(toolCallResult(e))).catch((e) => LOG.E(e));
  }, (err, session) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    callerKey = session.appKey;
    try {
      usageCall = usageRuntime.usage().beginCall({pack: target.role === 'scenario' ? target.module : null, module: target.module, tool: target.name, caller: opaqueCallerOf(session.appKey), session: sessionsLib().forUsage(sessionId)});
      args.usageCall = usageCall;
    } catch (e) {
      LOG.E(e);
    }
    session.localInput = args;
    // the call's session (B1 Task 2): into its token, never to its worker
    session.sessionId = sessionId;
    // the session's own values for this call, from its start (B2 Task 2);
    // every check then also takes its session's current ones (call-limits)
    const own = sessionId != null ? sessionSettingsLib().limitsOf(sessionId) : null;
    if (own != null) callLimitsLib().override(session, own);
    toolRegistry.outputSchemaForCall(cdifInterface, appKey, target, (schemaErr, outputSchema, rawSchema) => {
      callRawSchema = (schemaErr != null) ? null : rawSchema;
      cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, session);
    }, undefined, {modern: modern === true});
  });

  function respond(built) {
    let result = built;
    try {
      result = finishToolCall({usage: usageRuntime.usage(), call: usageCall, result: built, role: target.role, tool: target.name, module: target.module, session: sessionId, startedMs});
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
    return callback(null, resultResponse(req.id, result));
  }
}

// sessionId: the request's session (handleToolsCall's sessionIdOf), the job's
// creator's, stored with its owner (B1 Task 3)
function createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback, sessionId = null) {
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
        return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback);
      });
    }
    return doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback);
  });
}

function doCreateTaskForToolCall(req, target, toolArgs, authCtx, callback) {
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
  // its session is still live, checked in the same tick as the runner
  // remembers it (lib/job-sessions.js): a session that ended while the
  // call's auth was running gets no job (B1 Task 3)
  if (authCtx.session != null && sessionsLib().get(authCtx.session) == null) {
    return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('MODULE_NOT_LISTED'))));
  }

  JobControl.addJob(authCtx, jobOpts, target.deviceID, target.serviceID, target.actionName, toolArgs, (err, result) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }

    const now = new Date().toISOString();
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
    task.statusMessage = job.failedReason;
  }

  return task;
}

function handleTasksGet(req, cdifInterface, appKey, callback) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    JobControl.getJob(authCtx, taskId, (err, record) => {
      if (err != null) {
        // "unknown task" for both a genuinely missing id and one owned by
        // someone else -- deliberately indistinguishable, so this can't be
        // used to enumerate other tenants' taskIds.
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      }
      // GetTaskResultSchema merges TaskSchema directly into the result (not
      // wrapped under a `task` key, unlike CreateTaskResultSchema).
      return callback(null, resultResponse(req.id, jobToTask(record)));
    });
  });
}

function handleTasksResult(req, cdifInterface, appKey, callback) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
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
    if (status === 'completed') {
      // Shaped by the module as it is loaded now, from the address the task
      // was created with (addJob keeps it main-side). structuredContent only
      // while the advertised output schema is the one the result was
      // produced under -- the hash stampOutputSchema wrote at completion;
      // after a reload that changed it, text only, even when the old result
      // would happen to validate against the new schema. Comparing hashes
      // means no module schema is compiled on the main thread.
      const data = record.job.data || {};
      const returned = record.job.returnvalue;
      return toolRegistry.resolveOutputSchemaFor(cdifInterface, authCtx.appKey, data.deviceID, data.serviceID, data.actionName,
        (schemaErr, rawSchema) => {
          // the module's own schema, kept only while what a task's era (the
          // legacy one, until M15) sees of it hashes as it did at completion
          let raw = (schemaErr != null) ? null : rawSchema;
          const seen = toolRegistry.forEra(raw, false);
          if (raw != null && (seen == null ? data.outputSchemaHash != null : (data.outputSchemaHash == null || outputSchemaHash(seen) !== data.outputSchemaHash))) raw = null;
          const jobTarget = toolRegistry.targetFor(cdifInterface, data.deviceID, data.serviceID, data.actionName);
          if (jobTarget != null && jobTarget.role === 'scenario' && receiptReserved(returned)) {
            return callback(null, resultResponse(req.id, toolCallResult(new CountinghouseError('RECEIPT_RESERVED'))));
          }
          // stored once, at completion (M6): its URIs are kept with the job,
          // and a store that failed then is the task's error now
          if (data.resultStoreError != null) {
            const kept = data.resultStoreError;
            return callback(null, resultResponse(req.id, toolCallResult(kept.limit != null
              ? CountinghouseError.withFields(String(kept.code), {limit: String(kept.limit)}) : new CountinghouseError(String(kept.code)))));
          }
          return callback(null, resultResponse(req.id, addTaskReceipt(moduleToolResultWith(returned, raw,
            {module: jobTarget != null ? jobTarget.module : 'module', action: data.actionName, tool: jobTarget != null ? jobTarget.name : null}, false,
            (data.resultUris != null && typeof(data.resultUris) === 'object') ? data.resultUris : {}), data)));
        }, {raw: true});
    }
    if (status === 'failed') {
      const failedReason = record.job.failedReason != null ? record.job.failedReason : 'task failed';
      // decode the "CODE: message" prefix job-control.js's worker encodes a
      // failed job's error with (see the matching encode there) -- bullmq
      // itself only persists job.failedReason as a plain string, dropping
      // any `code` a CountinghouseError had, so without this a
      // task-augmented failure would never carry the same locale-
      // independent code a synchronous tools/call failure gets via
      // toolCallResult below.
      const codeMatch = /^([A-Z][A-Z0-9_]*): /.exec(failedReason);
      const failErr = new Error(codeMatch != null ? failedReason.slice(codeMatch[0].length) : failedReason);
      if (codeMatch != null) failErr.code = codeMatch[1];
      return callback(null, resultResponse(req.id, toolCallResult(failErr)));
    }
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `task ${taskId} has not completed yet (status: ${status})`));
  });
}

function handleTasksList(req, cdifInterface, appKey, callback) {
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {
    // listJobs filters to this caller's own jobs (see its comment) -- an
    // empty list is the correct answer for a caller with none, not an error.
    JobControl.listJobs(authCtx, (err, records) => {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
      }
      return callback(null, resultResponse(req.id, {tasks: records.map(jobToTask)}));
    });
  });
}

function handleTasksCancel(req, cdifInterface, appKey, callback) {
  const params = req.params || {};
  const taskId = params.taskId;

  if (typeof(taskId) !== 'string' || taskId === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.taskId must be a non-empty string'));
  }
  if (tasksSupported() !== true) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'tasks require the server to be running in multi-thread mode (--workerThread)'));
  }

  resolveGatedIdentity(req, cdifInterface, appKey, callback, (authCtx) => {

    JobControl.getJob(authCtx, taskId, (err, record) => {
      if (err != null) {
        return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown task: ${taskId}`));
      }

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
    case 'tools/list':    return handleToolsList(req, cdifInterface, appKey, callback, modern);
    case 'tools/call':    return handleToolsCall(req, cdifInterface, appKey, callback, modern, opts);
    case 'resources/read': return handleResourcesRead(req, cdifInterface, appKey, callback, opts);
    // nothing is listed: a stored result is reached by its link only
    case 'resources/list':
      return resolveGatedIdentity(req, cdifInterface, appKey, callback, () => callback(null, resultResponse(req.id, {resources: [], ttlMs: 0, cacheScope: 'private'})));
    case 'resources/templates/list':
      return resolveGatedIdentity(req, cdifInterface, appKey, callback, () => callback(null, resultResponse(req.id, {resourceTemplates: [], ttlMs: 0, cacheScope: 'private'})));
    // appKey is threaded into tasks/* exactly the way it already was into
    // tools/* -- its absence from these four signatures was the whole of the
    // bug: with no key in scope there was nothing to authorize against, so
    // any caller (including one with no key at all) could read, enumerate,
    // and cancel every tenant's tasks.
    // tasks aren't session-scoped yet (B3/B5): refused for a shared
    // runtime's session, so one can't read or cancel another's
    case 'tasks/get': case 'tasks/result': case 'tasks/list': case 'tasks/cancel':
      if (opts != null && opts.session != null) return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, `${req.method} is not served on a shared runtime yet`));
      break;
    default:
      break;
  }
  switch (req.method) {
    case 'tasks/get':     return handleTasksGet(req, cdifInterface, appKey, callback);
    case 'tasks/result':  return handleTasksResult(req, cdifInterface, appKey, callback);
    case 'tasks/list':    return handleTasksList(req, cdifInterface, appKey, callback);
    case 'tasks/cancel':  return handleTasksCancel(req, cdifInterface, appKey, callback);
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
function handleResourcesRead(req, cdifInterface, appKey, callback, opts) {
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
      return cdifInterface.recordCall(authCtx.appKey, 'countinghouse:resources/read', options.resourceReadCost, (meterErr) => {
        if (meterErr != null) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, meterErr.message || String(meterErr)));
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
        // the stamp is of what a task's era (legacy, until M15) sees
        const seen = toolRegistry.forEra(schema, false);
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
  placeTaskValues: placeTaskValues,   // (test/mcp-contract/17)
  handle: handle,
  stampOutputSchema: stampOutputSchema,
  jobHooks: jobHooks,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  JSONRPC_PARSE_ERROR: JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST: JSONRPC_INVALID_REQUEST,
  errorResponse: errorResponse
};
