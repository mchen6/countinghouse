const events        = require('events');
const util          = require('util');
const http          = require('http');
const express       = require('express');
const cors          = require('cors');
const CHUtil      = require('./countinghouse-util');
const CdifInterface = require('./countinghouse-interface');
const options       = require('./cli-options');
const LOG           = require('./logger');
const validateUser  = require('./routes/user');

// --stdio: how long tools/list and tools/call wait for the startup discovery
// of the --loadModule modules (under clients' 30 s connect timeouts), and how
// long the tool set must settle before a change is announced.
const STDIO_READY_BOUND_MS = 20000;
const STDIO_CHANGE_SETTLE_MS = 250;

// A loopback server is still reachable from the developer's own browser
// (review R1-2b). DNS rebinding makes a page's host resolve to 127.0.0.1, so
// under --debug without --debugKey, where every request is an admin, the Host
// must name this loopback server. And every route refuses a request whose
// Origin is not allowed, in every mode: a body-less cross-site POST (fetch
// with mode 'no-cors', say to /shutdown) needs no preflight, and MCP
// Streamable HTTP says servers MUST validate Origin (review R1-2b, R1-2c).
// Clients outside a browser send none.
function originChecks() {
  const port = String(options.port);
  const loopbackHost = new RegExp(`^(localhost|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|\\[::1\\])(:${port})?$`, 'i');
  const refuse = (res, code, message) => res.status(403).json({code: code, message: message});
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

// The routes that take a BSON body (lib/routes/invoke-action.js). Not add-job:
// a job is a JSON description of the task, and the route never read BSON.
const BSON_ROUTES = ['/devices/:deviceID/invoke-action'];
const BSON_TYPES  = ['application/bson'];

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

  this.deviceControlRouter = express.Router();

  this.server = http.createServer(this.app);

  this.app.use((req, res, next) => {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(originChecks());
  // Cross-origin access only for --allowedOrigins; it was every origin (review R1-2b).
  if (options.allowedOrigins.length > 0) this.app.use(cors({origin: options.allowedOrigins}));

  this.installNormalRoutes();
  this.startServer();
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  // Bodies are read before any route checks the caller's key, so they are
  // bounded: --maxRequestBody (MB) for JSON, XML and forms everywhere, and a
  // larger --maxBsonRequestBody only where BSON is taken (BSON_ROUTES). An
  // oversized body is answered 413. They were 1 GB everywhere (review R1-1).
  const limit = `${options.maxRequestBody}mb`;
  // Not text/plain: a cross-site POST of text/plain needs no CORS preflight (review R1-2).
  this.app.use(express.json({type: ['application/json'], limit: limit}));
  this.app.use(express.xml({limit: limit}));
  // No form bodies: nothing reads them, and a cross-site form post needs no
  // CORS preflight, so one could drive /load-module under --debug (review R1-2a).
  const bson = express.raw({type: BSON_TYPES, limit: `${options.maxBsonRequestBody}mb`}); // BSON as a raw buffer
  // The caller is checked before a BSON body is read: the key and the device
  // id are in the headers and the URL. req.is is the type-is test express.raw
  // applies, and one mount gives both the same paths (Express matches them
  // case-insensitively and by prefix), so no body is read unchecked.
  const callerFirst = (req, res, next) => (req.is(BSON_TYPES) ? validateUser.beforeBody(req, res, next) : next());
  BSON_ROUTES.forEach((route) => this.app.use(route, [callerFirst, bson]));

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);

  // MCP gateway: stateless Streamable HTTP transport (2026-07-28 spec) over
  // currently loaded device modules' tools/list + tools/call.
  this.app.use('/mcp', require('./routes/mcp')(this.moduleManager, this.cdifInterface));

  this.app.use('/balance', require('./routes/balance')(this.moduleManager, this.cdifInterface));

  // Module-lifecycle routes: always mounted, gated per-request by
  // adminOnly (lib/routes/admin-only.js) rather than by whether a CLI
  // flag was set at startup -- same pattern every device-scoped route
  // already uses (mounted unconditionally, gated by userAuth). --debug
  // still bypasses everything, same as it always has (see admin-only.js).
  // options.verifyModule itself is NOT retired -- it still exists and
  // still controls real fall-through/reporting behavior inside
  // device-manager.js and countinghouse-util.js during module
  // verification, entirely unrelated to whether these routes are
  // reachable. It just no longer has any bearing on mounting -- that
  // coupling (options.verifyModule === true || options.debug === true)
  // is what's removed here, not the flag itself.
  const adminOnly = require('./routes/admin-only');
  this.app.use('/get-module-device-list', adminOnly, require('./routes/get-module-device-list')(this.moduleManager, this.cdifInterface));
  this.app.use('/reload-module', adminOnly, require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/shutdown',      adminOnly, require('./routes/shutdown')());
  this.app.use('/load-module',    adminOnly, require('./routes/load-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/unload-module',  adminOnly, require('./routes/unload-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/restart-module', adminOnly, require('./routes/restart-module')(this.moduleManager, this.cdifInterface));
  this.app.use('/uninstall-module', adminOnly, require('./routes/uninstall-module')(this.moduleManager));
  this.app.use('/reload-auth',    adminOnly, require('./routes/reload-auth')());
  this.app.use('/identity-lookup', adminOnly, require('./routes/identity-lookup')());


  // if (options.wetty === true) {
  //   require('../wetty/app.js')(this.server, this.app);
  // }

  this.app.use('/device-list',  require('./routes/device-list')(this.moduleManager, this.cdifInterface));

  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/invoke-action',    require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',         require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',           require('./routes/schema')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/package-info',     require('./routes/get-device-package-info')(this.moduleManager, this.cdifInterface));

  this.deviceControlRouter.use('/:deviceID/add-job',        require('./routes/add-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job',        require('./routes/get-job')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-job-history',require('./routes/get-job-history')(this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/remove-job',     require('./routes/remove-job')(this.cdifInterface));

  // Errors no route answered, a body parser's above all (413, a malformed
  // body's 400): Express's default page is HTML with the stack trace when
  // NODE_ENV is unset, and anyone can now provoke one (review R1-1).
  this.app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = (err != null && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) ? err.status : 500;
    const code = (status === 413) ? 'REQUEST_TOO_LARGE' : (status < 500 ? 'REQUEST_INVALID' : 'SYSTEM_ERROR');
    if (status >= 500) LOG.E(err);
    return res.status(status).json({code: code,
      message: status === 413 ? 'request body too large' : (status < 500 ? 'request body could not be read' : 'internal error')});
  });
};

RouteManager.prototype.startServer = function() {
  if (options.stdio === true) return this.startStdio();
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  this.server.listen(options.port, CHUtil.getHostIp());
  LOG.I(`countinghouse listen on: ${CHUtil.getHostIp()}:${options.port}`);
};

// --stdio (local-mode spec §2): the gateway served over stdin and stdout, no
// port. The key is the process's own (options.apiKey, from the single-identity
// profile, set by the store's auth binding) or COUNTINGHOUSE_API_KEY, never
// printed. The process exits when stdin ends, once the calls in flight have
// drained (up to the request timeout) and the last answer has been flushed.
RouteManager.prototype.startStdio = function() {
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
        served.notify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
      });
    }, STDIO_CHANGE_SETTLE_MS);
    if (typeof(settle.unref) === 'function') settle.unref();
  };
  dm.on('toolschanged', () => {
    if (listing > 0) { changedWhileListing = true; return; }
    if (shown != null) compareSoon();
  });

  const handle = (message, key, cb) => {
    const isList = message != null && message.method === 'tools/list';
    const run = () => {
      if (isList) listing += 1;
      gateway.handle(message, cdifInterface, key, (err, res) => {
        if (isList) {
          listing -= 1;
          if (err == null && res != null && res.result != null) shown = fingerprint(res.result.tools);
          if (listing === 0 && changedWhileListing) { changedWhileListing = false; compareSoon(); }
        }
        cb(err, res);
      }, {listChanged: true});
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
    maxLineBytes: options.maxRequestBody * 1024 * 1024
  });
  LOG.I('countinghouse serves MCP on stdio');
  // ch-local start's control channel (packs in place, part 2), checked at
  // start (framework.js); the requests it serves are added task by task.
  require('./notices').setNotifier((m) => served.notify(m));
  const mm = this.moduleManager;
  if (options.controlChannel === 'ipc') {
    // notice {module, text}: a pack change ch-local start applied, said once
    // (lib/notices.js); module null for one no longer loaded
    require('./control-channel').start({
      notice: async (msg) => {
        require('./notices').add((typeof(msg.module) === 'string') ? msg.module : null, msg.text);
        return {};
      },
      // set {name, value}: a setting that applies now, for the next call
      // (lib/settings-tool.js applyControlSet)
      set: async (msg) => {
        const settingsTool = require('./settings-tool');
        const applied = settingsTool.applyControlSet(msg);
        if (applied.ok !== true) throw Object.assign(new Error(`${String(msg.name).slice(0, 40)} was not applied`), {code: applied.code});
        // and in every running module worker, for its own checks and timers
        settingsTool.broadcastLiveOptions(mm != null ? mm.modules : null);
        return {};
      }
    });
    LOG.I('countinghouse takes ch-local start\'s control requests on its IPC channel');
  }
  served.done.then((code) => process.exit(code));
};

module.exports = RouteManager;
module.exports.BSON_ROUTES = BSON_ROUTES;
