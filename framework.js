// Brokered file operations from module workers share libuv's threadpool with
// countinghouse's own DNS lookups, crypto and zlib. 16 threads unless the
// operator chose otherwise; it must be set before the pool is first used.
if (process.env.UV_THREADPOOL_SIZE == null) process.env.UV_THREADPOOL_SIZE = '16';

var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var fs            = require('fs');
var packageJson   = require('./package.json');

var nodeVersion = require('./lib/node-version');
if (!nodeVersion.supported(process.version)) {
  console.error(nodeVersion.message(process.version));
  process.exit(2);
}

// Test suite only (test/helpers/require-thread-flag.js): every test server
// must say which thread mode it wants.
if (process.env.COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG === '1' &&
    !process.argv.some((a) => a === '--no-workerThread' || a === '--workerThread' || a.startsWith('--workerThread='))) {
  console.error('no thread flag given (pass --workerThread or --no-workerThread)');
  process.exit(3);
}

process.on('uncaughtException', function(e) {
  console.error('Error: ' + e.stack);
});

process.on('warning', function(e) {
  console.warn(e.stack);
});

options.setOptions(argv);

// --stdio: stdout is the transport from here on; everything else that writes
// to it lands on stderr (lib/mcp/stdio.js takeStdout).
if (options.stdioWithPort === true) {
  console.error('--stdio and --port: choose one');
  process.exit(2);
}
// The single-identity profile: no direct peer channels (lib/local-profile.js).
const profileRefusal = require('./lib/local-profile').profileStart(options);
if (profileRefusal != null) {
  console.error(profileRefusal);
  process.exit(2);
}
if (options.stdio === true) require('./lib/mcp/stdio').takeStdout();

// --debug without --debugKey makes every request an admin (load_module
// included): only on a loopback address (review R1-2).
if (options.debugKeyMissing === true) {
  console.error('--debugKey needs a value (--debugKey <key>)');
  process.exit(2);
}
// A cost that is not a finite number >= 0 would credit callers or serve
// calls free (review M9).
if (options.mcpToolCallCostInvalid != null) {
  var badCost = options.mcpToolCallCostInvalid.value;
  console.error('--mcpToolCallCost must be a finite number >= 0 (got ' +
    (typeof(badCost) === 'boolean' || badCost === '' ? 'no value' : JSON.stringify(String(badCost))) + ')');
  process.exit(2);
}
// #144: a load bound that is not a number of seconds > 0 (or one setTimeout
// cannot hold) would end every load at once or never.
if (options.moduleLoadTimeoutInvalid != null) {
  var badLoad = options.moduleLoadTimeoutInvalid.value;
  console.error('--moduleLoadTimeout must be a number of seconds > 0, at most 2147483 (got ' +
    (typeof(badLoad) === 'boolean' || badLoad === '' ? 'no value' : JSON.stringify(String(badLoad))) + ')');
  process.exit(2);
}
// RC1-min: a module cannot choose where a credential goes; the operator's
// file does. One that cannot be read as {origin: [variable]} stops the start.
if (options.remoteLimitInvalid != null) {
  console.error('--' + options.remoteLimitInvalid.name + ' must be a positive number (got ' +
    JSON.stringify(String(options.remoteLimitInvalid.value)) + ')');
  process.exit(2);
}
// Lean worker step 1(b): the validator pool's size and deadline.
if (options.validatorLimitInvalid != null) {
  console.error('--' + options.validatorLimitInvalid.name + ' must be ' + options.validatorLimitInvalid.what + ' (got ' +
    JSON.stringify(String(options.validatorLimitInvalid.value)) + ')');
  process.exit(2);
}
// --remoteOriginMap moves where a credential goes, so it is honoured only
// with COUNTINGHOUSE_ACCEPTANCE=1 in this process's own environment (which a
// module never sees: every COUNTINGHOUSE_* is withheld), checked whole here,
// targets against the Redis endpoint included, and fixed once
// (lib/remote/origin-map.js). Under --hardened the child, which serves, says so.
if (options.remoteOriginMapArg != null) {
  var originMap = require('./lib/remote/origin-map');
  var parsedMap = originMap.parse(options.remoteOriginMapArg);
  if (parsedMap.problem != null) {
    console.error(parsedMap.problem);
    process.exit(2);
  }
  if (process.env.COUNTINGHOUSE_ACCEPTANCE !== '1') {
    console.error('--remoteOriginMap needs COUNTINGHOUSE_ACCEPTANCE=1 in the environment: it sends a declared origin\'s calls, credential included, to a local stand-in, for acceptance runs only');
    process.exit(2);
  }
  // No Redis is configured under --store local, so no endpoint to avoid.
  var mapProblems = originMap.problems(parsedMap.map, options.store === 'local' ? null : require('./lib/remote/client').configuredRedis());
  if (mapProblems.length > 0) {
    console.error(mapProblems.join('\n'));
    process.exit(2);
  }
  originMap.activate(parsedMap.map);
  if (options.hardened !== true || process.permission != null) {
    for (const [from, to] of Object.entries(parsedMap.map)) console.error(`remote origin mapped: ${from} -> ${to.target} (acceptance only)`);
  }
}
if (options.remoteCredentials != null || process.argv.some((a) => a === '--remoteCredentials' || a.startsWith('--remoteCredentials='))) {
  try {
    require('./lib/remote/credentials').configure(options.remoteCredentials);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
// An --authConfigPath with no path would fall into the zero-config file
// provider, which writes ./auth.json and prints a demo key (review of B4).
if (options.authConfigPathInvalid === true) {
  console.error('--authConfigPath needs a path');
  process.exit(2);
}
// --store (LM1): redis or local; local takes no Redis, so a --redisUrl is
// one of two answers to the same question.
if (options.store !== 'redis' && options.store !== 'local') {
  console.error('--store must be redis or local (got ' + JSON.stringify(options.store) + ')');
  process.exit(2);
}
if (options.store === 'local' && options.redisUrlExplicit === true) {
  console.error('--store local keeps no Redis, and --redisUrl names one: choose one');
  process.exit(2);
}
var bindAddress = require('./lib/bind-address');
if (options.debug === true && options.debugKey == null && !bindAddress.isLoopback(bindAddress.hostIp())) {
  console.error('--debug without --debugKey accepts every request as an admin, so it binds only to loopback; ' +
    'this server would bind ' + bindAddress.hostIp() + '. Give --debugKey <key>, or drop --bindAddr (it defaults to 127.0.0.1).');
  process.exit(2);
}

// --hardened: run the real server as a child under --permission. The child
// sees process.permission and falls through to normal startup.
if (options.hardened === true && process.permission == null) {
  if (options.workerThread !== true) {
    console.error('--hardened needs --workerThread: module workers are what it protects the process from');
    process.exit(2);
  }
  var hardenedLaunch = require('./lib/hardened-launch');
  try {
    hardenedLaunch.prepareGrants(options, process.cwd());
  } catch (e) {
    console.error('--hardened: cannot create the module folder ' + options.modulePath + ' or the module data directory ' +
      options.moduleDataPath + ': ' + e.message + ' -- set --modulePath and --moduleDataPath to writable directories');
    process.exit(2);
  }
  // The child would be refused a realpath of its own granted directories on
  // Node 24.22+ (nodejs/node#66812), so this unrestricted process resolves
  // them and sends the results; the probe checks any granted directory it did
  // not resolve, and refuses clearly instead of failing after the relaunch.
  var realpathRecorder = require('./lib/hardened-realpaths').recorder(require('fs').realpathSync.native);
  var hardenedFlags = hardenedLaunch.permissionFlags(options, __dirname, process.cwd(), realpathRecorder.realpath);
  hardenedLaunch.precompute(options, __dirname, realpathRecorder);
  // Skipped: what the parent resolved, and what those resolved to (the child
  // receives a real path as an answer; it never resolves one again).
  var precomputed = realpathRecorder.known();
  var skip = Object.assign({}, precomputed);
  Object.keys(precomputed).forEach(function(k) { skip[precomputed[k]] = true; });
  // The module folder: the child creates it and checks it is writable before
  // anything else (below), which the realpath skip does not cover (H1).
  var probe = hardenedLaunch.probeGrants(hardenedFlags, {skip: skip, writable: [require('path').resolve(process.cwd(), options.modulePath)]});
  if (!probe.ok) {
    console.error(hardenedLaunch.refusalMessage(probe, hardenedLaunch.grantOverlaps(hardenedFlags), process.version));
    process.exit(2);
  }
  hardenedLaunch.relaunch(hardenedFlags, realpathRecorder.known());
  return;
}
// The relaunched --hardened server: the parent's real paths, before anything
// here resolves a path (lib/hardened-realpaths.js).
if (process.permission != null) require('./lib/hardened-realpaths').receive();

var logger = require('./lib/logger');
logger.createLogger(options.logStream);

// Module sandbox mode checks. An explicit mode that cannot work is a startup
// error; the default quietly downgrades (lib/cli-options.js).
if (['off', 'audit', 'enforce'].indexOf(options.moduleSandbox) === -1) {
  console.error('--moduleSandbox must be one of off, audit, enforce (got "' + options.moduleSandbox + '")');
  process.exit(2);
}
if (options.moduleSandbox !== 'off' && options.workerThread !== true) {
  console.error('--moduleSandbox ' + options.moduleSandbox + ' needs --workerThread: the sandbox applies to module workers');
  process.exit(2);
}
if (options.moduleSandbox === 'off') {
  logger.W(options.moduleSandboxExplicit
    ? 'module sandbox: off (--moduleSandbox off) -- module code runs with the full privileges of this process'
    : 'module sandbox: off -- it needs --workerThread; module code runs with the full privileges of this process');
} else {
  logger.I('module sandbox: mode ' + options.moduleSandbox);
}
if (options.workerThread !== true) {
  logger.W('single-thread mode (--no-workerThread) is for debugging modules: no module sandbox, and not for production');
  // Modules still see /app, /data and /tmp through their fs and os (part 2 spec, section 6).
  require('./lib/single-thread-facade').install();
}
if (options.hardened === true) {
  logger.I('module sandbox: hardened -- running under --permission; modules must live under ' + options.modulePath);
}

if (options.workerThread === true) {
  // Spec decision 12: modules see their own files under /app, and Node keys
  // loaded code by path, so countinghouse itself must not live there.
  var identity = require('./lib/fs-broker/identity');
  var vrootClash = identity.codeUnderVroot(require('./lib/fs-broker').realDir(__dirname), []);
  if (vrootClash.length > 0) {
    console.error(identity.underVrootMessage(vrootClash));
    process.exit(2);
  }
  logger.I('file broker: up to ' + require('./lib/fs-broker/scheduler').FsScheduler.capFor(process.env.UV_THREADPOOL_SIZE) +
    ' module file operations in flight (UV_THREADPOOL_SIZE ' + process.env.UV_THREADPOOL_SIZE + ')');
}

if (options.modulePolicy != null) {
  try {
    require('./lib/module-policy').load(options.modulePolicy);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

var monitor       = require('./lib/monitor');

logger.I('countinghouse@' + packageJson.version + ' start with options:' + JSON.stringify(options.getOptionsForLog()));

// Eagerly instantiate the configured AuthProvider (lib/auth/) here, at
// startup, rather than lazily on the first authenticated request.
// FileAuthProvider's zero-config demo-key generation (see its own header
// comment) needs to happen now so an operator sees the printed key
// immediately -- with lazy instantiation, nothing ever printed it until
// after someone had already tried (and failed) to make a request with no
// key in hand yet, an unusable chicken-and-egg first-run experience.
// Skipped entirely under --debug, which never consults AuthProvider at
// all (see lib/user-auth.js) -- instantiating it there would be pointless
// and could surprise an operator with an auth.json/demo key they don't
// need. A construction failure (e.g. --authProvider couchdb without nano
// installed, or an unreachable CouchDB) fails the whole server the same
// way a missing module folder does above, rather than surfacing as a
// confusing per-request 500 later.
// The identity secret first (lib/identity.js): a secret in the wrong form, a
// file others can read, or a file and a variable that differ refuse startup.
var identity = require('./lib/identity');
try {
  identity.initSync(options);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
var identityReady = Promise.resolve();
if (options.debug === true && require('./lib/auth').identitySource(options) != null) {
  // --debug bypasses auth, but the single-identity profile still indexes its
  // one stable entry, so its caller id comes from the secret and "local",
  // not from the key, under --debug too (review of B4).
  identityReady = identity.rebuild(require('./lib/auth').identitySource(options));
} else if (options.debug !== true) {
  var authProvider = null;
  try {
    authProvider = require('./lib/auth').getAuthProvider();
  } catch (e) {
    // A configuration the provider refuses (two entries sharing an id) is an
    // operator error, exit 2 like the other startup checks; anything else is
    // the backend failing.
    if (e != null && e.code === 'AUTH_CONFIG_INVALID') {
      console.error(e.message);
      process.exit(2);
    }
    logger.E(new Error('AuthProvider (--authProvider ' + options.authProvider + ') failed to initialize: ' + e.message));
    process.exit(-1);
  }
  // The id index, from the provider's entries: built before the server
  // listens (below), so a user with a stable id never gets a key-based id
  // from an early call; rebuilt again on every reload.
  identityReady = identity.rebuild(authProvider);
} else if (options.debugKey != null) {
  identity.addKey(options.debugKey, 'debug', true);
}

try {
  // create module folder
  fs.mkdirSync(options.modulePath, {recursive: true});
  fs.accessSync(options.modulePath, fs.constants.W_OK);
} catch (e) {
  logger.E(new Error('cannot access module folder: ' + e.message));
  process.exit(-1);
}

// deviceDB (lib/device-db.js, sqlite3-backed) is only ever consulted by
// ModuleManager.prototype.loadAllModules's registry-lookup branch, and
// only when no --loadModule path was given (see that function's own
// "in case loading local module, we won't read module info from DB"
// early return) -- the --loadModule quickstart path never touches it.
// Requiring sqlite3 unconditionally here loads its native binding on
// every single startup regardless, which is unnecessary work for the
// common case and the actual crash on a glibc too old for the current
// prebuilt binary (ERR_DLOPEN_FAILED) -- gating the require itself,
// not just the init() call, avoids that entirely for anyone who never
// needed the registry DB in the first place.
if (options.localModulePath == null) {
  require('./lib/device-db').init(options.modulePath);
}

var ModuleManager = require('./lib/module-manager');
var RouteManager  = require('./lib/route-manager');

var mm = new ModuleManager();
// Throwaway directories of validations a crash interrupted (review R1-4).
if (options.workerThread === true) mm.sweepValidateRoot();

// Serving starts once the id index is built (identityReady above): the
// RouteManager listens from its constructor. A provider that cannot answer
// at startup is a configuration error, like AUTH_CONFIG_INVALID: exit 2.
function serve() {
  // The store's clients that used to be made when their files loaded (the
  // device log, the API log), made at start as before (lib/store.js).
  require('./lib/store').getStore().open();

  var routeManager = new RouteManager(mm);

  monitor.init();

  var redisAPI = require('./lib/redis-api');
  redisAPI.init();

  global.CHUtil     = require('./lib/countinghouse-util');
  global.CHDevice   = require('./lib/countinghouse-device');

  //manually set CHUtil.redis because when countinghouse-util.js is first time required, redis-api.js isn't loaded and initialized yet
  global.CHUtil.redis = redisAPI.client;

  var JobControl    = require('./lib/store').jobs;
  if (options.workerThread === true) {
    JobControl.initJobProcess(routeManager.cdifInterface);
    const jobHooks = require('./lib/mcp/gateway').jobHooks(routeManager.cdifInterface);
    JobControl.setStartHook(jobHooks.start);
    JobControl.setCompletionHook(jobHooks.complete);
  }

  // routeManager.startServer();
  mm.loadAllModules();
}

identityReady.then(serve, function(e) {
  console.error('identity: the id index could not be built from --authProvider ' + options.authProvider + ': ' + e.message);
  process.exit(2);
});


// forever to restart on crash?
