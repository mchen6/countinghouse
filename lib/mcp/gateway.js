// MCP JSON-RPC 2.0 method dispatch. Transport-agnostic on purpose -- lib/routes/mcp.js
// is the only thing that knows this is running over stateless Streamable HTTP; this
// file just takes a parsed JSON-RPC request object and a callback.
const path          = require('path');
const execFile      = require('child_process').execFile;
const userAuth      = require('../user-auth');
const toolRegistry  = require('./tool-registry');
const JobControl    = require('../job-control');
const options       = require('../cli-options');
const planValidator = require('../plan-validator');
const LOG           = require('../logger');
const encodeLegacyTool = require('../metering/redis-provider').encodeLegacyTool;

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME      = 'countinghouse';
const SERVER_VERSION   = require('../../package.json').version;

const JSONRPC_PARSE_ERROR      = -32700;
const JSONRPC_INVALID_REQUEST  = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS   = -32602;
const JSONRPC_INTERNAL_ERROR   = -32603;

function errorResponse(id, code, message) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: code, message: message}};
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
function resolveCallerIdentity(appKey, callback) {
  userAuth(null, null, null, appKey, null, null, () => {}, (err, session) => {
    if (err != null) return callback(err);
    return callback(null, {appKey: session.appKey, isAdmin: session.isAdmin === true});
  });
}

function handleInitialize(req, cdifInterface, callback) {
  const params = req.params || {};
  const negotiatedVersion = (typeof(params.protocolVersion) === 'string' && params.protocolVersion !== '')
    ? params.protocolVersion
    : PROTOCOL_VERSION;

  const capabilities = {tools: {}};
  if (tasksSupported() === true) {
    capabilities.tasks = {
      list:   {},
      cancel: {},
      requests: {tools: {call: {}}}
    };
  }

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

function handleToolsList(req, cdifInterface, appKey, callback) {
  toolRegistry.buildToolList(cdifInterface, appKey, (err, tools) => {
    if (err) return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));

    // Authoring tools are appended rather than built into buildToolList
    // because listing them needs isAdmin, which only this layer resolves.
    if (options.getOptions().authoringTools !== true) {
      return callback(null, resultResponse(req.id, {tools: tools}));
    }
    return resolveCallerIdentity(appKey, (authErr, authCtx) => {
      if (authErr != null || authCtx.isAdmin !== true) {
        return callback(null, resultResponse(req.id, {tools: tools}));
      }
      return callback(null, resultResponse(req.id, {tools: tools.concat(toolRegistry.AUTHORING_TOOLS)}));
    });
  });
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
    // CHError/DeviceError carry a locale-independent `code` (see Sprint 4's
    // worker-message.js fix, which is what makes `code` survive a cross-worker
    // hop intact). HTTP invoke-action responses already expose it
    // (lib/session.js); surface it here too via structuredContent so MCP
    // clients get the same locale-independent error classification instead
    // of having to pattern-match translated message text. Plain Error
    // objects (request-validation failures raised in this file) have no
    // `code`, so they're unaffected.
    if (err.code != null) result.structuredContent = {code: err.code};
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
// something still to come -- countinghouse_load_module requires()
// caller-supplied code (inside lib/module-validator.js's loadExported)
// directly in this process, unsandboxed, and countinghouse_validate_module
// runs the same kind of caller-supplied require() in a spawned child process
// instead. See the comment on validateModuleInChildProcess below for the
// full explanation of that split and what each tool does and doesn't
// protect against -- --authoringTools plus an admin key is what stands
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
// supplied module's main entry (loadExported in lib/module-validator.js does
// `require(modulePath)`), which is arbitrary JS execution with a friendly
// name -- --authoringTools plus an admin key (dispatchAuthoringTool's gate,
// above) is what stands between a caller and that, not a UX nicety over an
// already-safe tool. Running it via execFile below, in a disposable child
// process, is what keeps a module under test from corrupting or killing the
// long-lived gateway process that's answering every other tenant's requests
// at the same time: a crash, an uncaught exception, or a process.exit() call
// during that require() only takes down this one child. It also sidesteps a
// require() cache that would otherwise go stale across repeated validate
// calls against the same edited module -- each call is a fresh `node bin/
// countinghouse-validate.js` process with its own cache, not a shared one.
//
// countinghouse_load_module is different: it still calls loadModuleFromPath
// -- which requires() caller-supplied code too -- directly in this process,
// unsandboxed, because the module has to land in the live runtime to be
// callable; a disposable child process can't produce that. The same
// --authoringTools + admin gate is what protects that path instead; see
// LOAD_MODULE_TIMEOUT_MS above for the one thing this file does to bound how
// badly a hanging module can affect that call.
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
  execFile(process.execPath, [VALIDATE_CLI_PATH, '--json', modulePath],
    {timeout: VALIDATE_CHILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024},
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
          fix:     'Check the module\'s main entry for a process.exit() call, an infinite loop, or ' +
                   'anything else that could stop it from returning normally while being required.'
        }]
      });
    });
}

function dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback) {
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
      const targets  = toolRegistry.buildToolTargets(cdifInterface);
      const existing = Object.keys(targets);
      const result   = planValidator.validatePlan(toolArgs, existing, targets);
      return callback(null, resultResponse(req.id, toolCallResult(null, result)));
    }

    if (name === 'countinghouse_validate_module') {
      if (typeof(toolArgs.path) !== 'string' || toolArgs.path === '') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path must be a non-empty string'))));
      }
      return validateModuleInChildProcess(toolArgs.path, (vErr, result) => {
        return callback(null, resultResponse(req.id, toolCallResult(vErr, result)));
      });
    }

    if (name === 'countinghouse_load_module') {
      if (typeof(toolArgs.path) !== 'string' || typeof(toolArgs.name) !== 'string') {
        return callback(null, resultResponse(req.id, toolCallResult(new Error('arguments.path and arguments.name are required'))));
      }

      // Guards loadModuleFromPath's callback against never firing at all --
      // verified live against a module whose main entry calls process.exit()
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
          `loadModuleFromPath did not call back within ${LOAD_MODULE_TIMEOUT_MS}ms; the module's main ` +
          'entry may be hanging (an infinite loop, a promise that never resolves) during load. ' +
          'countinghouse_validate_module runs a module\'s main entry in an isolated, disposable child ' +
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
          // the *load* is acked, not once the device is actually discovered
          // -- module-manager.js's onModuleLoad kicks off a *second*,
          // fire-and-forget round trip to the worker (sendDiscoverMessage)
          // after emitting 'moduleload', and it is that second round trip
          // (via onWorkerLoaded's 'deviceonline' listener) that actually
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
      });
    }

    return callback(null, resultResponse(req.id, toolCallResult(new Error(`unknown authoring tool: ${name}`))));
  });
  return true;
}

function handleToolsCall(req, cdifInterface, appKey, callback) {
  const params = req.params || {};
  const name      = params.name;
  const toolArgs  = params.arguments || {};

  if (typeof(name) !== 'string' || name === '') {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, 'params.name must be a non-empty string'));
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
      return cdifInterface.checkBalance(authCtx.appKey, (err, result) => {
        return callback(null, resultResponse(req.id, toolCallResult(err, result)));
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
      dispatchAuthoringTool(req, name, toolArgs, cdifInterface, appKey, callback) === true) {
    return;
  }

  const targets = toolRegistry.buildToolTargets(cdifInterface);
  const target  = targets[name];

  if (target == null) {
    return callback(null, errorResponse(req.id, JSONRPC_INVALID_PARAMS, `unknown tool: ${name}`));
  }

  // task-augmented request: caller wants this call to run as a trackable
  // background task (tasks/get, tasks/result, tasks/cancel) instead of
  // blocking for the result inline.
  if (params.task != null) {
    return createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback);
  }

  const args = {input: toolArgs};

  userAuth(null, null, target.deviceID, appKey, target.serviceID, target.actionName, (err, data) => {
    const result = toolCallResult(err, data);
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
  }, (err, session) => {
    if (err != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, err.message || String(err)));
    }
    session.localInput = args;
    cdifInterface.invokeDeviceAction(target.deviceID, target.serviceID, target.actionName, args, null, session);
  });
}

function createTaskForToolCall(req, cdifInterface, target, toolArgs, appKey, callback) {
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
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

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

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
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

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
    return doHandleTasksResult(req, authCtx, taskId, callback);
  });
}

function doHandleTasksResult(req, authCtx, taskId, callback) {
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
      return callback(null, resultResponse(req.id, toolCallResult(null, record.job.returnvalue)));
    }
    if (status === 'failed') {
      const failedReason = record.job.failedReason != null ? record.job.failedReason : 'task failed';
      // decode the "CODE: message" prefix job-control.js's worker encodes a
      // failed job's error with (see the matching encode there) -- bullmq
      // itself only persists job.failedReason as a plain string, dropping
      // any `code` a CHError/DeviceError had, so without this a
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

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }
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

  resolveCallerIdentity(appKey, (authErr, authCtx) => {
    if (authErr != null) {
      return callback(null, errorResponse(req.id, JSONRPC_INTERNAL_ERROR, authErr.message || String(authErr)));
    }

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

// handles exactly one JSON-RPC request/notification object. batching (an array
// of these) is handled by the route layer, which calls this once per entry.
function handle(req, cdifInterface, appKey, callback) {
  if (req == null || typeof(req) !== 'object' || req.jsonrpc !== '2.0' || typeof(req.method) !== 'string') {
    return callback(null, errorResponse(req && req.id, JSONRPC_INVALID_REQUEST, 'invalid JSON-RPC 2.0 request'));
  }

  if (NOTIFICATION_METHODS[req.method] === true) {
    return callback(null, null); // no response for notifications
  }

  switch (req.method) {
    case 'initialize':   return handleInitialize(req, cdifInterface, callback);
    case 'ping':          return handlePing(req, cdifInterface, callback);
    case 'tools/list':    return handleToolsList(req, cdifInterface, appKey, callback);
    case 'tools/call':    return handleToolsCall(req, cdifInterface, appKey, callback);
    // appKey is threaded into tasks/* exactly the way it already was into
    // tools/* -- its absence from these four signatures was the whole of the
    // bug: with no key in scope there was nothing to authorize against, so
    // any caller (including one with no key at all) could read, enumerate,
    // and cancel every tenant's tasks.
    case 'tasks/get':     return handleTasksGet(req, cdifInterface, appKey, callback);
    case 'tasks/result':  return handleTasksResult(req, cdifInterface, appKey, callback);
    case 'tasks/list':    return handleTasksList(req, cdifInterface, appKey, callback);
    case 'tasks/cancel':  return handleTasksCancel(req, cdifInterface, appKey, callback);
    default:
      return callback(null, errorResponse(req.id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${req.method}`));
  }
}

module.exports = {
  handle: handle,
  PROTOCOL_VERSION: PROTOCOL_VERSION,
  JSONRPC_PARSE_ERROR: JSONRPC_PARSE_ERROR,
  errorResponse: errorResponse
};
