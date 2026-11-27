'use strict';
const events        = require('events');
const util          = require('util');
const http          = require('http');
const express       = require('express');
const cors          = require('cors');
const CHUtil      = require('./countinghouse-util');
const CdifInterface = require('./countinghouse-interface');
const options       = require('./cli-options');
const LOG           = require('./logger');
// calls in flight, by stdio or a session and their request id (M19)
const inFlight      = require('./mcp/in-flight');

// --stdio: how long tools/list and tools/call wait for the startup discovery
// of the --loadModule modules (under clients' 30 s connect timeouts), and how
// long the tool set must settle before a change is announced.
const path = require('path');
const fs = require('fs');
const STDIO_READY_BOUND_MS = 20000;
// a session runtime's wait for ch-local daemon's 'restore' before it listens
// (the daemon always sends one at once; this is only the safety net)
const RESTORE_WAIT_MS = 3000;
const STDIO_CHANGE_SETTLE_MS = 250;
// a pack loaded in place: how long its reply waits for its devices
const PACK_SETTLE_MS = 5000;

// A loopback server is still reachable from the developer's own browser
// (review R1-2b). DNS rebinding makes a page's host resolve to 127.0.0.1, so
// under --debug without --debugKey, where every request is an admin, the Host
// must name this loopback server. And every route refuses a request whose
// Origin is not allowed, in every mode: a body-less cross-site POST (fetch
// with mode 'no-cors', say to /shutdown) needs no preflight, and MCP
// Streamable HTTP says servers MUST validate Origin (review R1-2b, R1-2c).
// Clients outside a browser send none.
// The ceiling's watch (lib/settings-tool.js watchCeiling): once a process,
// whether the shared runtime serving or a control channel's modules' settings
// started it.
let ceilingWatched = false;
function watchCeilingOnce() {
  if (ceilingWatched) return;
  ceilingWatched = true;
  require('./settings-tool').watchCeiling();
}

function originChecks() {
  const port = String(options.port);
  const loopbackHost = new RegExp(`^(localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|\\[::1\\])(:${port})?$`, 'i');
  const refuse = (res, code, message) => res.status(403).json({code: code, message: message, kind: 'caller'});
  return (req, res, next) => {
    if (options.debug === true && options.debugKey == null && !loopbackHost.test(String(req.headers.host || ''))) {
      return refuse(res, 'HOST_NOT_ALLOWED', 'this --debug server answers only requests addressed to its loopback address');
    }
    const origin = req.headers.origin;
    if (origin != null && !options.allowedOrigins.includes(origin)) {
      return refuse(res, 'ORIGIN_NOT_ALLOWED', `origin ${String(origin).slice(0, 100)} is not allowed (--allowedOrigins)`);
    }
    return next();
  };
}

// BSON is retired (8.0.0): MCP is JSON only, with binary as base64, and the
// CDIF-era invoke-action route took the last BSON body. A request that says
// its body is BSON is told so, 415, on every route; the body is not parsed
// or kept (it is discarded as it arrives, so the connection stays usable).
// By the header as HTTP allows it written: any case, with parameters. A
// request with the header and no body (a client's default header on a GET)
// has no BSON body to refuse.
const BSON_BODY = /^\s*application\/bson\s*(;|$)/i;
const hasBody = (req) => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;

// express re-exports body-parser's json/raw/text/urlencoded middleware directly
// (Express 4.16+, see https://expressjs.com/en/4x/api.html#express.json), so
// body-parser-xml can extend the express module itself with .xml() the same
// way it would extend a standalone body-parser require, without adding a
// separate body-parser dependency.
require('body-parser-xml')(express);

function RouteManager(mm) {
  this.app = express();

  this.moduleManager = mm;
  this.cdifInterface = new CdifInterface(mm);
  // module settings' notices and parts go by the device manager's names,
  // whatever the profile (lib/settings-reread.js)
  require('./settings-reread').configure({dm: () => this.cdifInterface.deviceManager});
  // subscriptions/listen's streams, HTTP's and stdio's (#231): each key lists
  // again once the device manager's changes settle
  const gateway = require('./mcp/gateway');
  const cdif = this.cdifInterface;
  // A list as the gateway shows it to that key (and session): the modern
  // era's (M20), whole, not its first page (M1): a change past it is a
  // change too. The tools' holds every tool and every schema a legacy list
  // does, and the non-object schemas besides, so its fingerprint changes
  // whenever either era's would.
  const listed = (method, field) => (key, session) => new Promise((resolve) => {
    const s = (session != null && this.sessions != null) ? this.sessions.get(session) : null;
    if (session != null && s == null) return resolve(null);
    return gateway.handle({jsonrpc: '2.0', id: 0, method,
      params: {_meta: {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}}}}, cdif, key,
      (err, res) => resolve(err == null && res != null && res.result != null ? res.result[field] : null), Object.assign({wholeList: true}, s != null ? {session: s} : {}));
  });
  const resourcesLib = require('./mcp/resources');
  const moduleState = require('./module-state');
  this.subscriptions = require('./mcp/subscriptions').createHub({
    lists: {
      tools: listed('tools/list', 'tools'),
      resources: listed('resources/list', 'resources'),
      resourceTemplates: listed('resources/templates/list', 'resourceTemplates'),
      prompts: listed('prompts/list', 'prompts')
    },
    // a listener's URIs in its own view: what its key, and its session,
    // can read, each with the device it is read from and what changes it
    resolveUris: (key, session, uris) => new Promise((resolve) => {
      resourcesLib.listEntries(cdif, key, (err, entries) => {
        const seen = new Map();
        if (err == null) {
          for (const uri of uris) {
            const found = resourcesLib.find(entries, uri);
            if (found != null) seen.set(uri, {deviceID: found.entry.target.deviceID, changesWith: found.entry.resource.changesWith || []});
          }
        }
        resolve(seen);
      }, {session});
    }),
    // a resource's read changes nothing, whatever a changesWith says, by
    // whichever road it came (F3-4): the device's registered reads
    isRead: (call) => cdif.deviceManager != null && typeof(cdif.deviceManager.isReadAction) === 'function' &&
      cdif.deviceManager.isReadAction(call.deviceID, call.serviceURN, call.actionName),
    // a module that keeps state per session where it runs (the shared
    // runtime, R1): its resources change per session
    // (a device it cannot place is taken as per-session: told to the calling
    // session only, never to every session of the key)
    perSession: (deviceID) => {
      const held = (cdif.deviceManager != null && cdif.deviceManager.deviceMap != null) ? cdif.deviceManager.deviceMap[deviceID] : null;
      if (held == null) return true;
      const pkg = held.packageInfo;
      const name = held.moduleName || (pkg != null ? pkg.name : null);
      return moduleState.isPerSession(pkg, name, options);
    }
  });
  // a 2026-07-28 task's change (lib/task-events.js, M16): the listeners
  // holding its id build it, each through its own tasks/get view
  // (its off kept: close() removes it, the high review of #433, 10)
  this.offTaskEvents = require('./task-events').on((taskId, kind) => this.subscriptions.taskChanged(taskId, kind));
  // every successful call, as it is recorded (lib/countinghouse-interface.js
  // recordCall, the one point every entry path bills through): a resource
  // whose changesWith names its action may have changed (M8)
  // (a changesWith entry names the service by its short name, as
  // lib/declarations.js does)
  const {decodeLegacyTool} = require('./metering/provider');
  const {shortNameOf} = require('./declarations');
  cdif.on('callrecorded', ({apiKey, tool, session}) => {
    const at = decodeLegacyTool(tool);
    if (at == null) return;
    this.subscriptions.callSucceeded({appKey: apiKey, deviceID: at.deviceID, serviceID: shortNameOf(at.serviceID), serviceURN: at.serviceID, actionName: at.actionName, session});
  });
  if (cdif.deviceManager != null && typeof(cdif.deviceManager.on) === 'function') cdif.deviceManager.on('toolschanged', () => this.subscriptions.changed());
  // a reload of the auth config changes what keys may list: every list's
  // listener compares again, as after a module's change (A13)
  if (cdif.deviceManager != null && typeof(cdif.deviceManager.emit) === 'function') {
    const dmOf = cdif.deviceManager;
    this.offReloaded = require('./auth').onReloaded(() => dmOf.emit('toolschanged'));
  }

  this.deviceControlRouter = express.Router();

  this.server = http.createServer(this.app);

  this.app.use((req, res, next) => {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(originChecks());
  // Cross-origin access only for --allowedOrigins; it was every origin (review R1-2b).
  if (options.allowedOrigins.length > 0) this.app.use(cors({origin: options.allowedOrigins}));
  // the client's address behind a proxy the operator names (--trustProxy),
  // and requests whose key doesn't resolve limited per address, before
  // anything else is done for them (lib/unauth-limit.js); after cors, so a
  // browser reads the 429 (and a preflight is answered by cors, never limited)
  if (options.trustProxy != null) this.app.set('trust proxy', options.trustProxy);
  this.app.use(require('./unauth-limit').middleware());

  this.installNormalRoutes();
  this.startServer();
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  this.app.use((req, res, next) => {
    if (!BSON_BODY.test(String(req.headers['content-type'] || '')) || !hasBody(req)) return next();
    return res.status(415).json({code: 'REQUEST_UNSUPPORTED_MEDIA_TYPE',
      message: 'application/bson bodies are no longer taken (since 8.0.0): send JSON (application/json), with binary data as base64', kind: 'caller'});
  });
  // Bodies are read before any route checks the caller's key, so they are
  // bounded: --maxRequestBody (MB) for JSON and XML, everywhere. An
  // oversized body is answered 413. They were 1 GB everywhere (review R1-1).
  const limit = `${options.maxRequestBody}mb`;
  // Not text/plain: a cross-site POST of text/plain needs no CORS preflight (review R1-2).
  this.app.use(express.json({type: ['application/json'], limit: limit}));
  this.app.use(express.xml({limit: limit}));
  // No form bodies: nothing reads them, and a cross-site form post needs no
  // CORS preflight, so one could drive /load-module under --debug (review R1-2a).

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);

  // MCP gateway: stateless Streamable HTTP transport (2026-07-28 spec) over
  // currently loaded device modules' tools/list + tools/call.
  this.app.use('/mcp', require('./routes/mcp')(this.moduleManager, this.cdifInterface, this.subscriptions));

  this.app.use('/balance', require('./routes/balance')(this.moduleManager, this.cdifInterface));

  // Module-lifecycle routes: always mounted, gated per-request by
  // adminOnly (lib/routes/admin-only.js) rather than by whether a CLI
  // flag was set at startup -- same pattern every device-scoped route
  // already uses (mounted unconditionally, gated by userAuth). --debug
  // still bypasses everything, same as it always has (see admin-only.js).
  const adminOnly = require('./routes/admin-only');
  this.app.use('/get-module-device-list', adminOnly, require('./routes/get-module-device-list')(this.moduleManager, this.cdifInterface));
  this.app.use('/reload-module', adminOnly, require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/shutdown',      adminOnly, require('./routes/shutdown')(this.subscriptions));
  this.app.use('/load-module',    adminOnly, require('./routes/load-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/unload-module',  adminOnly, require('./routes/unload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/restart-module', adminOnly, require('./routes/restart-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/uninstall-module', adminOnly, require('./routes/uninstall-module')(this.moduleManager));
  this.app.use('/reload-auth',    adminOnly, require('./routes/reload-auth')());
  this.app.use('/identity-lookup', adminOnly, require('./routes/identity-lookup')());


  this.app.use('/device-list',  require('./routes/device-list')(this.moduleManager, this.cdifInterface));

  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/user')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/invoke-action',    require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',         require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',           require('./routes/schema')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/package-info',     require('./routes/get-device-package-info')(this.moduleManager, this.cdifInterface));

  this.deviceControlRouter.use('/:deviceID/add-job',        require('./routes/add-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job',        require('./routes/get-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job-history',require('./routes/get-job-history')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/remove-job',     require('./routes/remove-job')(this.cdifInterface));
  // (last: what no device route answered, one unit and the one answer)
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/device-fallback')(this.cdifInterface));

  // Errors no route answered, a body parser's above all (413, a malformed
  // body's 400): Express's default page is HTML with the stack trace when
  // NODE_ENV is unset, and anyone can now provoke one (review R1-1).
  this.app.use(bodyErrorHandler);
};

// The app's last handler: errors no route answered, a body parser's above
// all (413, a malformed body's 400). /mcp's body that is not JSON is
// JSON-RPC's Parse error, -32700, in JSON-RPC's shape; every other route
// answers REST's {code, message, kind} (the final pass's gateway part, A13).
function bodyErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = (err != null && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) ? err.status : 500;
  // (case-blind, as Express's routing is: #531's high, L6)
  const onMcp = typeof(req.originalUrl) === 'string' && /^\/mcp(?:[/?]|$)/i.test(req.originalUrl);
  if (onMcp && err != null && err.type === 'entity.parse.failed') {
    const gateway = require('./mcp/gateway');
    res.setHeader('MCP-Protocol-Version', gateway.PROTOCOL_VERSION);
    // (JSON that is no object or array -- a number, a string -- which the
    // strict parser refuses too: Invalid Request, not Parse error; the
    // medium on PR 2)
    let isJson = false;
    try { JSON.parse(typeof(err.body) === 'string' ? err.body : ''); isJson = true; } catch (e) { isJson = false; }
    return res.status(400).json(isJson ? gateway.errorResponse(null, gateway.JSONRPC_INVALID_REQUEST, 'the request body is JSON, but no request')
      : gateway.errorResponse(null, gateway.JSONRPC_PARSE_ERROR, 'the request body is not JSON'));
  }
  const code = (status === 413) ? 'REQUEST_TOO_LARGE' : (status < 500 ? 'REQUEST_INVALID' : 'SYSTEM_ERROR');
  if (status >= 500) LOG.E(err);
  return res.status(status).json({code: code,
    message: status === 413 ? 'request body too large' : (status < 500 ? 'request body could not be read' : 'internal error'),
    kind: status < 500 ? 'caller' : 'runtime'});
}

RouteManager.prototype.startServer = function() {
  if (options.stdio === true) return this.startStdio();
  if (options.sessionSocket != null) return this.startSessions();
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  // part 3 P2, Task 5, as for --stdio: the start values, and the modules a
  // change applied this start is told to. countinghouse_settings is served
  // on --stdio only today (a single identity needs it: cli-options.js); this
  // is wired here ahead of the shared runtime, which serves it over HTTP.
  const mm = this.moduleManager;
  require('./settings-tool').captureAtStart();
  require('./settings-tool').setLiveModules(() => (mm != null ? mm.liveWorkers() : null));
  this.listensOverHttp = true;
  this.server.listen(options.port, CHUtil.getHostIp());
  LOG.I(`countinghouse listen on: ${CHUtil.getHostIp()}:${options.port}`);
};

// cb once the server takes requests: over HTTP once its port is bound
// (listen() with a host binds only after resolving it); --stdio and a
// session socket open no HTTP port (startServer chose), so at once.
RouteManager.prototype.whenServing = function(cb) {
  if (this.listensOverHttp !== true || this.server.listening === true) return cb();
  this.server.once('listening', () => cb());
};

// ch-local's control channel (packs in place, part 2; settings, part 3),
// for --stdio (ch-local start) and --sessionSocket (ch-local daemon, C3)
// alike, checked at start (framework.js): packs loaded, unloaded and
// reloaded in place, notices, and settings that apply now.
// extra: more request handlers (a session runtime's restore and drain, C3)
RouteManager.prototype.startControlChannel = function(extra = {}) {
  const mm = this.moduleManager;
  const cdifInterface = this.cdifInterface;
  const dm = cdifInterface.deviceManager;
  // A pack loaded, unloaded or reloaded in place (part 2, plan Task A3): the
  // reply names the tools its modules list once their devices are back, or
  // after PACK_SETTLE_MS (a module whose device is slow is still loaded).
  const toolsOf = (moduleNames) => new Promise((resolve) => {
    const deadline = Date.now() + PACK_SETTLE_MS;
    const names = new Set(moduleNames);
    const poll = () => {
      const devices = Object.keys(dm.deviceMap || {}).filter((id) => dm.deviceMap[id] != null && names.has(dm.deviceMap[id].hostModuleName));
      const hosts = new Set(devices.map((id) => dm.deviceMap[id].hostModuleName));
      const listed = [...names].filter((n) => !mm.unlisted.has(n));
      if (listed.some((n) => !hosts.has(n)) && Date.now() < deadline) return setTimeout(poll, 50).unref();
      const targets = require('./mcp/tool-registry').buildToolTargets(cdifInterface);
      const ids = new Set(devices);
      resolve(Object.keys(targets).filter((t) => ids.has(targets[t].deviceID)).sort());
    };
    poll();
  });
  if (options.controlChannel === 'ipc') {
    // load, reload, unload, a notice and set pack.<n>: lib/module-control.js.
    // A notice {module, text} is a change ch-local start applied, said once
    // (lib/notices.js); module null for one no longer loaded. In a shared
    // runtime every open session is told (#413 section 7.3: no session has
    // a view of its own).
    const packs = require('./modules-in-place');
    // the modules going on or off (M4, #413 section 5.5): a device's module,
    // also while it is out of the map; gone once nothing of it is left; a
    // change to the set is a change to what the lists show
    const visibility = require('./module-visibility');
    visibility.configure({
      moduleOf: (deviceID) => (dm != null && typeof(dm.moduleOfDevice) === 'function' ? dm.moduleOfDevice(deviceID) : null),
      isGone: (name) => mm.modules[name] == null && (mm.supervisor == null || mm.supervisor.status(name) == null),
      changed: () => { if (dm != null && typeof(dm.emit) === 'function') dm.emit('toolschanged'); }
    });
    const control = require('./module-control').createModuleControl({mm, dm, packs, toolsOf,
      shared: () => require('./sessions').shared(),
      // set {name, value}: a setting that applies now, for the next call
      // (lib/settings-tool.js applyControlSet)
      applyControlSet: async (msg) => {
        const settingsTool = require('./settings-tool');
        const applied = settingsTool.applyControlSet(msg);
        if (applied.ok !== true) throw Object.assign(new Error(`${String(msg.name).slice(0, 40)} was not applied`), {code: applied.code});
        // and in every running module worker, for its own checks and timers
        settingsTool.broadcastLiveOptions(mm != null ? mm.liveWorkers() : null);
        return {};
      }});
    require('./control-channel').start(Object.assign({
      load: control.load, unload: control.unload, reload: control.reload, notice: control.notice, set: control.set,
      // the module.* values again, each module's applied whole or not at all
      // (lib/settings-reread.js)
      reread: (msg) => (msg != null && msg.what === 'held-back'
        // ch-local's held-back modules again (lib/held-back.js; B-firstrun),
        // its shape checked as every reread's is (the shared vectors)
        ? require('./held-back').reread(msg)
        : require('./settings-reread').reread(mm, msg))
    }, extra));
    LOG.I('countinghouse takes ch-local start\'s control requests on its IPC channel');
    // The operator's ceiling changed while modules run, where it binds module
    // settings (the settings tool's profile): a change of its moduleSettings
    // (or of whether it can be trusted) rereads their settings, on the
    // channel's chain, so a fixed value binds without ch-local (M2a;
    // lib/settings-reread.js ceilingWatcher); watched as the shared runtime
    // watches it
    if (options.settingsTool === true) {
      require('./settings-tool').onCeilingChange(require('./settings-reread').ceilingWatcher(mm, {
        enqueue: (fn) => require('./control-channel').enqueue(fn)}));
      watchCeilingOnce();
    }
    // a start-plan module refused before the channel was up (M4)
    if (mm != null && typeof(mm.tellStartRefused) === 'function') mm.tellStartRefused();
  }
};

// --sessionSocket (the shared runtime, C1; design section 1): the gateway
// served to each session ch-local's shim opens on the socket. The key is the
// process's own, as under --stdio. The run directory is checked and a new
// secret written before the socket listens; a problem stops the start (exit
// 2). Each session's requests go to the gateway with the session object in
// its opts (the interface agreed with B: lib/session-transport/registry.js).
// tools/list and a module's tools/call wait for the startup discovery, as
// on stdio. Stdin isn't read: the runtime ends when ch-local daemon stops
// it, not when its stdin does.
RouteManager.prototype.startSessions = function() {
  const gateway = require('./mcp/gateway');
  const runDir = require('./session-transport/run-dir');
  const handshake = require('./session-transport/handshake');
  const {createRegistry} = require('./session-transport/registry');
  const {createListener} = require('./session-transport/listener');
  const BUILT_IN = new Set(require('./mcp/tool-name').RESERVED_TOOL_NAMES);
  const appKey = options.apiKey || null;
  const cdifInterface = this.cdifInterface;
  const dm = cdifInterface.deviceManager;
  const socketPath = options.sessionSocket;
  const fail = (why) => {
    LOG.E(`--sessionSocket ${socketPath}: ${why}`);
    process.stderr.write(`--sessionSocket ${socketPath}: ${why}\n`);
    process.exit(2);
  };
  // ch-local daemon gone (its IPC channel closed: a daemon SIGKILLed, say),
  // watched from the first line, so a death during startup is never missed:
  // before the listener exists, an exit; after, daemonGone's drain. Either
  // way no orphaned runtime holds the socket against the next daemon.
  let daemonGone = null;
  let disconnected = false;
  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (daemonGone != null) return daemonGone();
    LOG.W('ch-local daemon has gone before this runtime listened: exiting');
    return process.exit(0);
  };
  if (typeof(process.send) === 'function') {
    process.once('disconnect', onDisconnect);
    if (process.connected === false) return onDisconnect();
  }
  // the secret's and the lock's directory, <home>/run/daemon (--sessionDir,
  // C2: required with a named pipe, which has none; on POSIX the socket's
  // own, unless the socket is in the long-home fallback, $TMPDIR/ch-<uid>/,
  // which is then checked as well)
  const pipe = process.platform === 'win32';
  const dir = options.sessionDir != null ? options.sessionDir : path.dirname(socketPath);
  const socketDir = pipe ? null : path.dirname(socketPath);
  const apart = socketDir != null && socketDir !== dir;
  const problem = runDir.socketPathProblem(socketPath) || runDir.runDirProblem(dir) ||
    (apart ? runDir.runDirProblem(socketDir, {stickyParent: true}) : null);
  if (problem != null) return fail(problem);
  // the directories as checked, compared again once the socket listens
  const dirId = runDir.identityOf(dir);
  const socketDirId = apart ? runDir.identityOf(socketDir) : null;
  // one runtime starts in this directory at a time, and holds it
  const lock = runDir.takeStartLock(dir);
  if (!lock.ok) return fail(lock.why);
  process.once('exit', () => lock.release());

  let open = null;
  const ready = new Promise((resolve) => { open = resolve; });
  if (dm.discovered === true) open();
  else {
    const bound = setTimeout(open, STDIO_READY_BOUND_MS);
    if (typeof(bound.unref) === 'function') bound.unref();
    dm.once('discovered', () => { clearTimeout(bound); open(); });
  }
  const waits = (message) => message != null && (message.method === 'tools/list' ||
    (message.method === 'tools/call' && !(message.params != null && BUILT_IN.has(message.params.name))));

  const mm = this.moduleManager;
  require('./settings-tool').captureAtStart();
  require('./settings-tool').setLiveModules(() => (mm != null ? mm.liveWorkers() : null));
  // the operator's ceiling, known before the first session's first call:
  // every call is held to it (lib/session-settings.js underCeiling); and
  // re-checked on a timer, so one lowered while this runs comes to bound them
  require('./settings-tool').primeCeiling();
  watchCeilingOnce();

  // the daemon's token, compared by its keyed hash with each session's
  // (design section 5); never logged or sent
  const token = process.env.COUNTINGHOUSE_GITHUB_TOKEN;
  const MIB = 1024 * 1024;
  // each session's resume hash and end, told to ch-local daemon's table
  const registry = createRegistry({tell: (m) => require('./control-channel').tell(m)});
  this.sessions = registry;
  runDir.clearStale(socketPath).then((stale) => {
    if (stale != null) return fail(stale);
    let secret;
    try {
      secret = runDir.writeSecret(dir);
    } catch (e) {
      return fail(`the secret could not be written (${e.code || e.message})`);
    }
    // B1's per-session state opens with each session the registry announces:
    // attached before the socket listens, so no session is announced before
    // it has state. This turns shared mode on (lib/sessions.js).
    require('./sessions').attach(registry);
    // R1 Task 6 (lib/session-lifetime.js): a session's end stops its
    // per-session workers and then, on every end but 'closed', removes its
    // partitions; the first session after a start that reset them is told so
    const lifetime = require('./session-lifetime');
    // what the start's sweep keeps: every session held, opened or restored
    // here, until its own end has dealt with its partitions (lifetime's
    // sweepGuard: pinned by sessions 33)
    const guard = lifetime.sweepGuard(registry, mm);
    registry.on('gone', (id, reason) => { guard.gone(id, reason); });
    registry.on('session', (s) => { guard.opened(s.id); lifetime.sessionOpened(s.id); });
    // each session's open listens, by request id; a session that detaches
    // or ends takes them with it (its client re-issues on reconnect)
    const listens = require('./session-transport/session-listens').createSessionListens({registry, closeSession: (id) => this.subscriptions.closeSession(id)});
    // a legacy session (2025-11-25) has no listen: once it has listed, it is
    // told when its tool, prompt or resource lists change (lib/session-transport/session-list-notices.js)
    const listNotices = require('./session-transport/session-list-notices').createSessionListNotices({registry});
    if (dm != null && typeof(dm.on) === 'function') dm.on('toolschanged', () => listNotices.changed());
    const listener = createListener({
      path: socketPath, secret, registry,
      runtimeVersion: require('../package.json').version,
      maxToRuntime: options.maxRequestBody * MIB + 4096,
      // twice the largest output cap a session can have, plus 1 MiB (the
      // ceiling's, which a later part reads; 256 MiB without one)
      maxToShim: 2 * 256 * MIB + MIB,
      // a drain completed: ch-local daemon's upgrade need wait no longer
      // ... once no cancelled call is still running either: it bills when it
      // ends (the review of #314), up to the request timeout
      onDrained: () => inFlight.settled(options.requestTimeout).then(() => require('./control-channel').tell({type: 'drained'})),
      tokenMac: (typeof(token) === 'string' && token !== '') ? (s) => handshake.tokenMac(s, token) : null,
      // no credential is ever this runtime's to share: a session socket
      // needs the control channel, which takes only a version 2
      // --remoteCredentials file (M6), whose slots no session's environment
      // supplies. So every credential a client chooses counts as one this
      // runtime lacks (a runtime of its own), and no frame can test a guess
      // at any variable's value.
      credentialMac: () => null,
      onMessage: (s, message, reply) => {
        // a session's notifications/cancelled naming one of its open listens,
        // or one of its calls in flight (M19): the session is the scope, so
        // one session never names another's request
        if (message != null && message.method === 'notifications/cancelled' && message.id === undefined && message.params != null) {
          listens.cancel(s, message.params.requestId);
          // behind `ready`, as a module tool's call waits: in the order they came
          const requestId = message.params.requestId;
          ready.then(() => inFlight.cancel(s.id, requestId));
        }
        // (on arrival, in the order they came, a refused one too)
        listNotices.arrived(s, message);
        // a second listen with an id this session already has open
        if (message != null && message.method === 'subscriptions/listen' && message.id !== undefined && listens.duplicate(s, message)) {
          return reply({jsonrpc: '2.0', id: message.id, error: {code: -32600, message: 'a subscriptions/listen with this id is already open'}});
        }
        // the listen's stream is the session's own connection
        // (lib/session-transport/session-listens.js)
        const openStream = () => listens.streamFor(s, message);
        const run = () => gateway.handle(message, cdifInterface, appKey, (err, res) => {
          if (message != null && message.method === 'initialize' && message.id !== undefined && err == null && res != null && res.result != null) listNotices.initialized(s);
          if (err == null && res != null) reply(res);
          else if (err != null) reply({jsonrpc: '2.0', id: message.id !== undefined ? message.id : null, error: {code: -32603, message: 'internal error'}});
        }, {session: s, subscriptions: this.subscriptions, openStream,
          // a call's progress (M9): this session's own connection, as a
          // headerless frame before the answer; dropped while detached
          notify: (m) => s.notify(m),
          // the call, cancellable by this session's notifications/cancelled
          // (M19); the shim is told to forget its seq (reply.cancel)
          cancellable: (cancel) => inFlight.register(s.id, message.id, () => { cancel(); if (typeof(reply.cancel) === 'function') reply.cancel(); })});
        if (waits(message)) return ready.then(run);
        return run();
      }
    });
    this.sessionListener = listener;
    // ch-local daemon's requests (C3): the session table, handed over before
    // the socket listens ('restore', always sent: empty from a fresh daemon,
    // the table after a runtime restart; B2's importTable takes it), and the
    // stop ('drain': no new handshake, every shim told, every listen ended
    // gracefully, so none holds the drain)
    // once only, validated whole (lib/session-transport/restore.js); refused
    // after the safety net or once the listen begins
    let restored = null;
    const restoreArrived = new Promise((resolve) => { restored = resolve; });
    // the registry's rows first (each session's resume hash, C's), then B2's
    // state, which never holds the hash
    const {createRestore, forSessions} = require('./session-transport/restore');
    const restore = createRestore({log: (m) => LOG.I(m), importTable: (t) => {
      registry._restore(t.sessions.map(({session, resume}) => ({session, resume})));
      const b = require('./sessions');
      if (typeof(b.importTable) === 'function') b.importTable(forSessions(t));
    }});
    this.startControlChannel({
      restore: async(msg) => {
        const answer = restore.handle(msg);
        restored();
        return answer;
      },
      drain: async() => {
        listNotices.stop();
        listener.drain();
        this.subscriptions.endAll();
        return {sessions: registry.all().length};
      },
      // the daemon's idle stop: refused while a session is held (connected,
      // detached within its window, or restored and not yet resumed) or a
      // handshake is in pre-auth; else the runtime drains, at once
      'idle-stop': async() => {
        if (!listener.drainIfIdle()) throw Object.assign(new Error('a session is held, or a handshake is in progress'), {code: 'CONTROL_BUSY'});
        listNotices.stop();
        this.subscriptions.endAll();
        return {};
      }
    });
    // ch-local daemon gone, from here on: drain, for at most the request
    // timeout while a session is still attached, then close and exit
    daemonGone = () => {
      LOG.W('ch-local daemon has gone: draining, then exiting');
      leaving = true;
      listNotices.stop();
      restore.close();
      listener.drain();
      this.subscriptions.endAll();
      const bound = Date.now() + Math.max(0, Number(options.requestTimeout) || 0);
      const check = () => {
        const held = registry.all().some((s) => s.connected === true);
        if (held && Date.now() < bound) return setTimeout(check, 100);
        this.close();
        return listener.close().then(() => process.exit(0), () => process.exit(0));
      };
      check();
    };
    const waited = new Promise((resolve) => {
      const t = setTimeout(() => {
        LOG.W(`no session table from ch-local daemon within ${RESTORE_WAIT_MS / 1000} s: serving with an empty one, and no confirmation form for 30 minutes`);
        // what was declined before this start is not known: every kind of
        // form is locked for a window, and no later table is taken (B2 Task 6)
        require('./session-state').noRestore();
        resolve();
      }, RESTORE_WAIT_MS);
      if (typeof(t.unref) === 'function') t.unref();
      restoreArrived.then(() => { clearTimeout(t); resolve(); });
    });
    // no restore once the listen begins (the net fired, or one came)
    waited.then(() => restore.close());
    // and no listen at all once the daemon has gone
    let leaving = false;
    // bound under umask 077 (the bind is synchronous), then the directory
    // checked again: the same one, holding the socket and the secret
    // R1 Task 6: before the listener accepts, D3's listing only (cheap); the
    // sweep runs once it listens, in the background, keeping every session
    // restored or open (the reviewer's ruling of 11-17)
    const checked = () => {
      if (leaving) return null;
      guard.restored(registry.heldIds());
      return lifetime.checkResetAtStart(registry.idle());
    };
    return waited.then(checked).then(() => (leaving ? new Promise(() => {}) : runDir.withPrivateUmask(() => listener.listen()))).then(() => {
      let ours = false;
      try {
        // a named pipe is no file to look at: its name is held, or the bind failed
        ours = runDir.sameIdentity(dir, dirId) && (!apart || runDir.sameIdentity(socketDir, socketDirId)) &&
          (pipe || fs.lstatSync(socketPath).isSocket()) && fs.lstatSync(path.join(dir, 'secret')).isFile();
      } catch (e) {
        ours = false;
      }
      if (!ours) return fail('its directory changed while the runtime started');
      LOG.I('countinghouse serves MCP sessions on its session socket');
      // ch-local daemon writes daemon.json on this, not on a socket that
      // merely proves a secret (another, older runtime's would): this
      // runtime, its own socket, listening (C4b's review)
      require('./control-channel').tell({type: 'listening', socket: socketPath});
      // and that it is idle, when it is (a fresh table). A restored table has
      // told 'busy' already (the registry's _restore), and every later change
      // is the registry's own tell, so 'busy' is never told twice.
      if (registry.idle()) require('./control-channel').tell({type: 'idle'});
      // the start's sweep: every partition of a session this process never
      // knew (one that ended before it started); kept: a session held,
      // restored or opened here; and all once the runtime is stopping (its
      // sessions, forgotten as 'closed', are the next start's to restore)
      lifetime.sweepAtStart(guard.keep, undefined, {mm})
        .catch(() => {}).then(() => guard.done());
      return undefined;
    }, (e) => fail(e.code === 'EADDRINUSE'
      // fatal for this start: it never serves under a name it doesn't hold
      // (on Windows a held pipe name; the daemon's next start picks a new one)
      ? 'its name is taken by another process (EADDRINUSE): this runtime does not serve under a name it does not hold'
      : `the socket could not be bound (${e.code || e.message})`));
  });
  return undefined;
};

// --stdio (local-mode spec §2): the gateway served over stdin and stdout, no
// port. The key is the process's own (options.apiKey, from the single-identity
// profile, set by the store's auth binding) or COUNTINGHOUSE_API_KEY, never
// printed. The process exits when stdin ends, once the calls in flight have
// drained (up to the request timeout) and the last answer has been flushed.
RouteManager.prototype.startStdio = function() {
  // its one session, opened as it starts serving (lib/sessions.js)
  require('./sessions').openLocal();
  const stdio = require('./mcp/stdio');
  const gateway = require('./mcp/gateway');
  const BUILT_IN = new Set(require('./mcp/tool-name').RESERVED_TOOL_NAMES);
  const appKey = options.apiKey || process.env.COUNTINGHOUSE_API_KEY || null;
  const dm = this.cdifInterface.deviceManager;
  const cdifInterface = this.cdifInterface;

  // A client lists the tools right after initialize, and a stdio client
  // (Claude Code) lists once: tools/list, and a tools/call of a module's tool,
  // wait for the startup discovery of the --loadModule modules (loaded or
  // failed, failing composition verification included; not the verdicts'
  // delivery into the workers: 'discovered' in lib/device-manager.js),
  // bounded so the answer stays inside clients' 30 s connect timeouts.
  // initialize, and calls of the runtime's built-in tools, answer at
  // once. The gate also opens when the client leaves (stdin ends), so a held
  // call never keeps the process. (Dogfooding, 2026-11-13: listed at 10.7 s,
  // saw only the built-ins.) The suite shortens the bound, under its own
  // marker only.
  const testBound = (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1') ? Number(process.env.COUNTINGHOUSE_TEST_STDIO_READY_BOUND_MS) : NaN;
  const boundMs = testBound > 0 ? testBound : STDIO_READY_BOUND_MS;
  let open = null;
  const ready = new Promise((resolve) => { open = resolve; });
  let bound = null;
  const openGate = () => { clearTimeout(bound); open(); };
  if (dm.discovered === true) {
    openGate();
  } else {
    bound = setTimeout(() => {
      LOG.I(`stdio: the modules are still loading after ${boundMs / 1000} s; tools/list answers with what is ready, and the client is told when that changes`);
      open();
    }, boundMs);
    if (typeof(bound.unref) === 'function') bound.unref();
    dm.once('discovered', openGate);
    process.stdin.once('end', openGate);
    process.stdin.once('close', openGate);
  }
  const waits = (message) => message != null && (message.method === 'tools/list' ||
    (message.method === 'tools/call' && !(message.params != null && BUILT_IN.has(message.params.name))));

  // Only a legacy session (one that sent initialize) is sent this notice, or
  // notifications/message, unasked. In 2026-07-28 list_changed travels only
  // on a subscriptions/listen stream the client opens ("The server MUST NOT
  // send notification types the client has not explicitly requested"; #231,
  // this.subscriptions); a modern session's pack notices ride on its next
  // result.
  let legacySession = false;
  // Once the client has listed, a change to what it was shown (a tool added,
  // removed, or its schema or description changed) is announced, once, with
  // notifications/tools/list_changed (declared in initialize's capabilities),
  // and the client lists again. Compared after the changes settle, so a reload
  // that comes back the same says nothing. A change while the client's own
  // list is being answered is compared once that answer is out.
  let shown = null;
  let listing = 0;
  let changedWhileListing = false;
  let served = null;
  const byName = (a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
  const fingerprint = (tools) => (Array.isArray(tools) ? JSON.stringify(tools.slice().sort(byName)) : null);
  let settle = null;
  const compareSoon = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (listing > 0) { changedWhileListing = true; return; }
      if (shown == null) return;
      gateway.handle({jsonrpc: '2.0', id: 0, method: 'tools/list'}, cdifInterface, appKey, (err, res) => {
        const now = (err == null && res != null && res.result != null) ? fingerprint(res.result.tools) : null;
        if (now == null || now === shown || listing > 0) return;
        shown = now;
        if (legacySession) served.notify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
      }, {wholeList: true});
    }, STDIO_CHANGE_SETTLE_MS);
    if (typeof(settle.unref) === 'function') settle.unref();
  };
  // every change, counted: a first page's whole-list fingerprint (below)
  // taken across one is not what the client was shown
  let changeCount = 0;
  const STALE = '';
  // The client's prompts and resources lists (R-cold-prompts: a cold start's
  // client lists its prompts before the packs have loaded), each its own,
  // told plainly to a legacy client when it changes: lib/mcp/plain-list-notices.js
  const listPrint = require('./mcp/subscriptions').fingerprint;
  const LIST_FIELDS = {'prompts/list': 'prompts', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates'};
  const plainLists = require('./mcp/plain-list-notices').createPlainListNotices({
    list: (method, cb) => gateway.handle({jsonrpc: '2.0', id: 0, method}, cdifInterface, appKey,
      (err, res) => cb((err == null && res != null && res.result != null) ? listPrint(res.result[LIST_FIELDS[method]]) : null), {wholeList: true}),
    notify: (method) => { if (legacySession) served.notify({jsonrpc: '2.0', method}); },
    settleMs: STDIO_CHANGE_SETTLE_MS
  });
  dm.on('toolschanged', () => {
    changeCount += 1;
    plainLists.changed();
    if (listing > 0) { changedWhileListing = true; return; }
    if (shown != null) compareSoon();
  });

  // the open listens by request id, for notifications/cancelled (#238's
  // review): a stdio stream has no close of its own
  const listens = new Map();
  const idKey = (id) => JSON.stringify(id);
  const handle = (message, key, cb) => {
    if (message != null && message.method === 'notifications/cancelled' && message.id === undefined && message.params != null) {
      const cancel = listens.get(idKey(message.params.requestId));
      if (cancel != null) { listens.delete(idKey(message.params.requestId)); cancel(); }
      // a call in flight on this connection (M19): one lookup, an unknown id
      // ignored. Behind `ready`, as a module tool's call waits, so a cancel
      // sent right after its call is taken in the order they came
      const requestId = message.params.requestId;
      ready.then(() => inFlight.cancel('stdio', requestId));
    }
    // the session's client, as its initialize named it (part 3 P2)
    if (message != null && message.method === 'initialize') {
      legacySession = true;
      if (message.params != null) require('./mcp/client-info').record(message.params.clientInfo);
    }
    // a well-formed 2026-07-28 request ends it, as on a shared runtime's
    // session (lib/session-transport/session-list-notices.js): the client is
    // speaking that revision, which tells nothing unasked; a malformed one
    // changes nothing, and a later initialize makes it legacy again
    else if (legacySession && gateway.isServedRequest(message) && require('./mcp/era').isModern(message) && require('./mcp/era').checkModern(message, null) == null) {
      legacySession = false;
      plainLists.reset();
    }
    const isList = message != null && message.method === 'tools/list';
    // a legacy client's served request for a list's first page (as a shared
    // runtime's session counts one: a request with an id, whatever its answer)
    const plainToken = (legacySession && gateway.isServedRequest(message) && !(message.params != null && message.params.cursor != null))
      ? plainLists.began(message.method) : null;
    // the request's slot in the drain is freed once: by its answer, or at
    // once by a cancel (M19; no answer will come), as a session's reply.cancel does
    let freed = false;
    const done = (err, res) => {
      if (freed) return;
      freed = true;
      cb(err, res);
    };
    const run = () => {
      if (isList) listing += 1;
      const changesAtStart = changeCount;
      gateway.handle(message, cdifInterface, key, (err, res) => {
        if (!isList) {
          done(err, res);
          if (plainToken != null) plainLists.answered(plainToken, err == null && res != null && res.result != null);
          return;
        }
        // print: the fingerprint now shown, or null to keep the one there
        const listed = (print) => {
          listing -= 1;
          if (print != null) shown = print;
          if (listing === 0 && changedWhileListing) { changedWhileListing = false; compareSoon(); }
        };
        const answered = err == null && res != null && res.result != null;
        // Paged (M1): what the client was shown is the whole list as it was
        // when it began paging, at its first page. A later page, read with a
        // cursor, changes nothing of it (a change since is still to be
        // announced). A first page with more after it is answered at once,
        // and the whole list fingerprinted after it, still counted as
        // listing; a change while that was taken makes it stale, so the
        // next comparison announces. One whole list per paging, as one
        // unpaged list was.
        const cursored = message.params != null && message.params.cursor != null;
        if (cursored || !answered || res.result.nextCursor === undefined) {
          listed(answered && !cursored ? fingerprint(res.result.tools) : null);
          return done(err, res);
        }
        done(err, res);
        gateway.handle({jsonrpc: '2.0', id: 0, method: 'tools/list', params: message.params}, cdifInterface, key, (e, whole) => {
          const tools = e == null && whole != null && whole.result != null ? whole.result.tools : null;
          listed(tools == null ? null : (changeCount !== changesAtStart ? STALE : fingerprint(tools)));
        }, {wholeList: true});
      }, {listChanged: true, subscriptions: this.subscriptions,
        // (release: the listen ended itself, and its id is let go -- its own
        // entry only; the final pass's gateway part, A13)
        openStream: () => {
          let entry = null;
          return {write: (m) => served.notify(m), onClose: (fn) => { entry = fn; listens.set(idKey(message.id), fn); },
            release: () => { if (entry != null && listens.get(idKey(message.id)) === entry) listens.delete(idKey(message.id)); entry = null; }};
        },
        // a call's progress (M9): a line before the answer's line
        notify: (m) => served.notify(m),
        // the call, cancellable by notifications/cancelled naming its id (M19)
        cancellable: (cancel) => inFlight.register('stdio', message.id, () => { cancel(); done(null, null); })});
    };
    if (waits(message)) return ready.then(run);
    return run();
  };

  served = stdio.serveStdio({
    input: process.stdin,
    output: stdio.takeStdout(),
    handle,
    appKey,
    drainMs: options.requestTimeout,
    maxLineBytes: options.maxRequestBody * 1024 * 1024,
    // the client left: its listens end now, so they don't hold the drain
    onEnd: () => this.subscriptions.endAll()
  });
  LOG.I('countinghouse serves MCP on stdio');
  // ch-local start's control channel (packs in place, part 2), checked at
  // start (framework.js); the requests it serves are added task by task.
  require('./notices').setNotifier((m) => { if (legacySession) served.notify(m); });
  const mm = this.moduleManager;
  // part 3 P2, Task 5: the values this runtime started with, captured now
  // (a confirmed raise this start is never taken for one), and the modules a
  // change applied this start is told to
  require('./settings-tool').captureAtStart();
  require('./settings-tool').setLiveModules(() => (mm != null ? mm.liveWorkers() : null));
  this.startControlChannel();
  // the process waits for a cancelled call still running, up to the request
  // timeout: it bills when it ends (the review of #314)
  served.done.then((code) => inFlight.settled(options.requestTimeout).then(() => process.exit(code)));
};

// what this manager subscribed to process-wide, removed (the task events);
// once, whatever calls it
RouteManager.prototype.close = function() {
  if (typeof(this.offTaskEvents) === 'function') this.offTaskEvents();
  this.offTaskEvents = null;
  if (typeof(this.offReloaded) === 'function') this.offReloaded();
  this.offReloaded = null;
};

RouteManager.bodyErrorHandler = bodyErrorHandler;
module.exports = RouteManager;
