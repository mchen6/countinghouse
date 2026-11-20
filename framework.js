'use strict';
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
// --partDir (M4): parts of a start confined to --modulesRoot
if (Array.isArray(options.partDir) && options.partDir.length > 0 && !(Array.isArray(options.modulesRoot) && options.modulesRoot.length > 0)) {
  console.error('--partDir is only for a start given --modulesRoot');
  process.exit(2);
}
// --sessionSocket (the shared runtime, C1): ch-local daemon's runtime
{
  var sessionRefusal = options.sessionSocketInvalid === true ? '--sessionSocket needs a path'
    : options.sessionDirInvalid === true ? '--sessionDir needs a path'
    : options.sessionDirNotDrive === true ? '--sessionDir on Windows must be a drive path (C:\\...), not a UNC or device path'
      : options.sessionSocket == null ? (options.sessionDir != null ? '--sessionDir is only for --sessionSocket' : null)
      : options.stdio === true ? '--stdio and --sessionSocket: choose one'
        : options.sessionWithPort === true ? '--sessionSocket and --port: choose one'
          : (process.platform === 'win32' && options.sessionDir == null) ? '--sessionSocket on Windows (a named pipe) needs --sessionDir, the directory of its secret'
            : options.store !== 'local' ? '--sessionSocket needs --store local (the shared runtime is one per user, on ch-local\'s local store)'
              : options.controlChannel !== 'ipc' ? '--sessionSocket needs --controlChannel ipc (ch-local daemon starts it so)'
              : options.singleIdentity !== true ? '--sessionSocket is only for the single-identity profile (--store local, no --authConfigPath or --authProvider)' : null;
  if (sessionRefusal != null) {
    console.error(sessionRefusal);
    process.exit(2);
  }
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
if (options.unauthRateLimitInvalid != null) {
  var badUnauth = options.unauthRateLimitInvalid.value;
  console.error('--unauthRateLimit must be a whole number from 0 to 1000 (got ' +
    (typeof(badUnauth) === 'boolean' || badUnauth === '' ? 'no value' : JSON.stringify(String(badUnauth))) + ')');
  process.exit(2);
}
if (options.trustProxyInvalid != null) {
  var badProxy = options.trustProxyInvalid;
  console.error('--trustProxy takes a number of proxy hops (1 to 10) or a comma list of the proxies\' addresses or CIDRs (got ' +
    (typeof(badProxy.value) === 'boolean' || badProxy.value === '' ? 'no value' : JSON.stringify(String(badProxy.value))) +
    (badProxy.why != null ? `: ${badProxy.why}` : '') + ')');
  process.exit(2);
}
// the list as Express will compile it at the start ('trust proxy'): one it
// cannot read is refused here, as the parse above refuses, never a stack
// trace from the route manager (the high review of #483, round 2, 6)
if (options.trustProxy != null) {
  try {
    require('express')().set('trust proxy', options.trustProxy);
  } catch (e) {
    console.error('--trustProxy takes a number of proxy hops (1 to 10) or a comma list of the proxies\' addresses or CIDRs (got ' +
      JSON.stringify(String(options.trustProxy)) + ': ' + (e != null && e.message != null ? e.message : String(e)) + ')');
    process.exit(2);
  }
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
// --moduleQuestions (ctx.ask): on or off, and nothing else
if (options.moduleQuestionsInvalid != null) {
  console.error('--' + options.moduleQuestionsInvalid.name + ' must be ' + options.moduleQuestionsInvalid.what + ' (got ' +
    JSON.stringify(String(options.moduleQuestionsInvalid.value)) + ')');
  process.exit(2);
}
// MCP completeness M5: the result store's limits.
if (options.resourceLimitInvalid != null) {
  console.error('--' + options.resourceLimitInvalid.name + ' must be ' + options.resourceLimitInvalid.what + ' (got ' +
    JSON.stringify(String(options.resourceLimitInvalid.value)) + ')');
  process.exit(2);
}
// MCP completeness M1: the size of a list's page.
if (options.listPageSizeInvalid != null) {
  console.error('--' + options.listPageSizeInvalid.name + ' must be ' + options.listPageSizeInvalid.what + ' (got ' +
    JSON.stringify(String(options.listPageSizeInvalid.value)) + ')');
  process.exit(2);
}
// R1: the per-session workers' cap.
if (options.maxSessionWorkersInvalid != null) {
  console.error('--' + options.maxSessionWorkersInvalid.name + ' must be ' + options.maxSessionWorkersInvalid.what + ' (got ' +
    JSON.stringify(String(options.maxSessionWorkersInvalid.value)) + ')');
  process.exit(2);
}
// --packsRoot went with the pack form (M6, #413 rev 3 section 16, rule 7):
// ch-local passes --modulesRoot
if (options.packsRootGiven === true) {
  console.error('--packsRoot is no longer taken: the pack form is gone; ch-local passes --modulesRoot');
  process.exit(2);
}
// In-place loading (--controlChannel, --modulesRoot) isn't
// available under --hardened in this release: the relaunched child would
// not reach the control channel, and its roots are not granted
// (lib/hardened-launch.js grants --modulePath and --moduleDataPath), so it
// would fail at its first read. Refused at the start, every in-place flag
// given named, a bare or empty one included.
if (options.hardened === true && Array.isArray(options.inPlaceFlagsGiven) && options.inPlaceFlagsGiven.length > 0) {
  console.error('--' + options.inPlaceFlagsGiven.join(', --') + ': in-place loading isn\'t available under --hardened in this release');
  process.exit(2);
}
// Packs in place (part 2): the control channel exists only between ch-local
// start and the runtime it spawned, in the single-identity profile, over an
// IPC fd.
if (options.controlChannel != null) {
  var controlRefusal = options.controlChannel !== 'ipc' ? 'takes ipc'
    : options.singleIdentity !== true ? 'is only for the single-identity profile (ch-local start)'
      : typeof(process.send) !== 'function' ? 'needs an IPC channel from the process that started this one' : null;
  if (controlRefusal != null) {
    console.error('--controlChannel ' + controlRefusal + ' (got ' + JSON.stringify(String(options.controlChannel)) + ')');
    process.exit(2);
  }
}
// --testLateLoads hands module code the runtime's modules (a test's probe,
// #194): never with --hardened.
if (options.testLateLoads === true && options.hardened === true) {
  console.error('--testLateLoads is a test-only probe: it cannot be used with --hardened');
  process.exit(2);
}
// --settingsFile names the file countinghouse_settings changes, and the tool
// is served only in the single-identity profile (ch-local start): anywhere
// else the flag would half-apply (its options.settingsTool on, the tool not
// served, so a size cap's hint would name a tool that is not there).
// Refused as --controlChannel and --sessionSocket are.
if (options.settingsFileInvalid === true) {
  console.error('--settingsFile needs a path (--settingsFile <file>)');
  process.exit(2);
}
if (options.settingsFile != null && options.singleIdentity !== true) {
  console.error('--settingsFile is only for the single-identity profile (ch-local start), where countinghouse_settings is served (got ' +
    JSON.stringify(String(options.settingsFile)) + ')');
  process.exit(2);
}
// --heldBackFile (B-firstrun): ch-local's held-back modules, read by
// countinghouse_overview, only beside --settingsFile (refused elsewhere, not
// ignored: an ignored flag would read as working)
if (options.heldBackFileInvalid === true) {
  console.error('--heldBackFile needs a path (--heldBackFile <file>)');
  process.exit(2);
}
if (options.heldBackFile != null && options.settingsFile == null) {
  console.error('--heldBackFile is only with --settingsFile (ch-local start), where countinghouse_overview reads it (got ' +
    JSON.stringify(String(options.heldBackFile)) + ')');
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
    const configuredFile = require('./lib/remote/credentials').configure(options.remoteCredentials);
    // M6 (#413 rev 3 sections 6.5 and 16, rule 7): ch-local writes version 2;
    // a runtime with a control channel takes no version 1 file
    if (options.controlChannel != null && configuredFile.version !== 2) {
      throw new Error('--remoteCredentials: a version 1 file is not taken with --controlChannel; it is version 2 (ch-local writes it)');
    }
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
// The identity secret and the server id beside it (lib/private-file.js):
// on Windows their owner and ACL checks read from one PowerShell run.
function prefetchOwnFileAcls() {
  const privateFile = require('./lib/private-file');
  const dir = privateFile.ownDir(options);
  if (dir == null) return;
  privateFile.prefetchAcls([require('./lib/identity').SECRET_FILE, require('./lib/server-id').SERVER_ID_FILE].map((f) => require('path').join(dir, f)));
}

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
  // enforce on Windows: the virtual drive is picked here, where looking at
  // drive letters is allowed, and handed to the child (#195;
  // lib/fs-broker/virtual-drive.js)
  if (options.moduleSandbox === 'enforce' && process.platform === 'win32') {
    var drive = require('./lib/fs-broker/virtual-drive').pick();
    if (drive != null) process.env.COUNTINGHOUSE_VIRTUAL_DRIVE = drive;
  }
  // On Windows the child cannot run the PowerShell the identity secret's
  // and the server id's ACL checks need: they are created and checked here
  // (lib/identity.js, lib/server-id.js prepareForHardened)
  if (process.platform === 'win32') {
    try {
      // (both files' owners and ACLs in one PowerShell run)
      prefetchOwnFileAcls();
      require('./lib/identity').prepareForHardened(options);
      require('./lib/server-id').prepareForHardened(options);
    } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  }
  hardenedLaunch.relaunch(hardenedFlags, realpathRecorder.known());
  return;
}
// The relaunched --hardened server: the parent's real paths, before anything
// here resolves a path (lib/hardened-realpaths.js).
if (process.permission != null) require('./lib/hardened-realpaths').receive();
// Under the permission model without that hand-over (node --permission by
// hand, not --hardened): the links the install is reached through cannot be
// looked for, and the start is refused rather than served without them.
if (process.permission != null) {
  var startProblem = require('./lib/hardened-launch').startProblem();
  if (startProblem != null) {
    console.error(startProblem);
    process.exit(2);
  }
}

var logger = require('./lib/logger');
logger.createLogger();

// Module sandbox mode checks. An explicit mode that cannot work is a startup
// error; the default quietly downgrades (lib/cli-options.js).
if (['off', 'audit', 'enforce'].indexOf(options.moduleSandbox) === -1) {
  console.error('--moduleSandbox must be one of off, audit, enforce (got "' + options.moduleSandbox + '")');
  process.exit(2);
}
// enforce on Windows needs a drive letter for a module's files (#195,
// lib/fs-broker/virtual-drive.js): with none free it refuses to start.
if (options.moduleSandbox === 'enforce' && process.platform === 'win32' && require('./lib/fs-broker/virtual-drive').pick() == null) {
  console.error('--moduleSandbox enforce needs a free drive letter on Windows for the modules\' files (none of D: to Z: is free); free one, or use --moduleSandbox audit');
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
// MCP completeness M6: the result store's effective limits (spec section 2)
logger.I(require('./lib/store/blobs').describeLimits(options));

if (options.modulePolicy != null) {
  try {
    require('./lib/module-policy').load(options.modulePolicy);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

// --moduleSettings: an operator's modules' settings (lib/module-settings.js),
// read at each load; checked here, so a file that cannot be read stops the
// start rather than refusing every module. ch-local's settings are its
// --settingsFile's: one source or the other.
if (options.moduleSettingsInvalid === true) {
  console.error('--moduleSettings needs one path (--moduleSettings <file>, given once)');
  process.exit(2);
}
if (options.moduleSettings != null) {
  if (options.settingsFile != null) {
    console.error('--moduleSettings and --settingsFile: choose one (ch-local\'s settings file holds its modules\' settings)');
    process.exit(2);
  }
  const read = require('./lib/module-settings').readModuleSettings(options.moduleSettings);
  if (read.problem != null) {
    console.error(read.problem);
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
  // on Windows, both files' owners and ACLs in one PowerShell run
  prefetchOwnFileAcls();
  identity.initSync(options);
  // this server's own id, beside the secret (lib/server-id.js): its job
  // queue's prefix and job history keys
  require('./lib/server-id').initSync(options);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
// ch-local's held-back list, its first read begun now (off the main thread
// on Windows, where its ACL is a PowerShell run): countinghouse_overview
// waits for it (lib/held-back.js)
if (options.heldBackFile != null) require('./lib/held-back').start();
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

// With modules to load, the validators boot now, beside the rest of the main
// thread's boot, not when the first module's spec is checked
// (lib/validator-pool.js startEarly). Every synchronous refusal of the start
// has run by here; the id index's (identityReady, below) is the one left.
require('./lib/validator-pool').startEarly();

// deviceDB (lib/device-db.js, sqlite3-backed) is only ever consulted by
// ModuleManager.prototype.loadAllModules's registry-lookup branch, and only
// under --moduleRegistry with no --loadModule path (options.usesModuleRegistry)
// -- every other start, the --loadModule quickstart path and a start with no
// module alike, never touches it.
// Requiring sqlite3 unconditionally here loads its native binding on
// every single startup regardless, which is unnecessary work for the
// common case and the actual crash on a glibc too old for the current
// prebuilt binary (ERR_DLOPEN_FAILED) -- gating the require itself,
// not just the init() call, avoids that entirely for anyone who never
// needed the registry DB in the first place.
// --moduleRegistry only: the registry is opt-in (lib/cli-options.js).
if (options.usesModuleRegistry()) {
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
  // At exit, one synchronous sequence before the local store's exit flush
  // (lib/exit-sequence.js; B-shutdown-usage): the job runner's passes still
  // running ended, then every usage call still open (a tools/call still
  // running too) ended as a cancelled one, so a call begun is always ended
  // in the record.
  const exitSequence = require('./lib/exit-sequence');
  if (options.workerThread === true) exitSequence.atExit(() => require('./lib/store').jobs.close());
  exitSequence.atExit(() => require('./lib/usage/runtime').closeOpen(jobHooks != null ? jobHooks.outcomeOf : null));

  var redisAPI = require('./lib/redis-api');
  redisAPI.init();

  global.CHUtil     = require('./lib/countinghouse-util');
  global.CHDevice   = require('./lib/countinghouse-device');

  //manually set CHUtil.redis because when countinghouse-util.js is first time required, redis-api.js isn't loaded and initialized yet
  global.CHUtil.redis = redisAPI.client;

  var JobControl    = require('./lib/store').jobs;
  // the task hooks (worker mode): the exit sequence asks them for a failure
  // noted while its record was being written
  var jobHooks      = null;
  if (options.workerThread === true) {
    JobControl.initJobProcess(routeManager.cdifInterface);
    jobHooks = require('./lib/mcp/gateway').jobHooks(routeManager.cdifInterface);
    JobControl.setStartHook(jobHooks.start);
    JobControl.setCompletionHook(jobHooks.complete);
    JobControl.setCancelHook(jobHooks.cancel);
    // a 2026-07-28 task's question (M22, lib/task-asks.js)
    JobControl.setAskHooks(jobHooks.ask);
  }

  // routeManager.startServer();
  // Discovery starts once the server takes requests (RouteManager
  // whenServing): over HTTP, listen() with a host binds only after resolving
  // it, and a start with nothing to load finishes discovery at once, so
  // "countinghouse ready" (which every waiter waits for) would otherwise come
  // before the port is bound.
  routeManager.whenServing(function() { mm.loadAllModules(); });
}

// The Redis host name a module worker is denied is resolved before any module
// loads, so its addresses are denied at the worker's handle guards too
// (#207); bounded, never rejecting, and not under --moduleSandbox off. It
// runs beside the id index, not after it. A later refresh that adds an
// address tells every lockdown worker, a validation's too.
function deniedResolved() {
  if (options.moduleSandbox === 'off' || options.store === 'local') return Promise.resolve();
  // (every lockdown worker is told by module-sandbox-config's own set:
  // lib/module-manager.js tracks each at its set-options)
  return require('./lib/module-sandbox-config').refreshDenied(options.redisUrl).then(function() {}, function() {});
}

var denied = deniedResolved();
// the job queue's server id claimed, or refused (exit 2) before anything is
// served (lib/server-claim.js; the Redis runner's only)
var claimDecided = (options.workerThread === true && options.store !== 'local') ? require('./lib/store').jobs.claimServerId().decided : Promise.resolve();
identityReady.then(function() { return Promise.all([denied, claimDecided]).then(serve); }, function(e) {
  // (the provider's own reason, when this is lib/auth's guard answering in
  // the catalogue's words with the provider's error as its cause; else the
  // error's own message: the Reviewer's high review of #448, 8)
  // (as text, whatever it is, and one line: the medium on #448's second
  // round, 4)
  var guarded = e != null && e.code === 'SYSTEM_ERROR_USERDB_NA' && e.cause !== undefined;
  var why = require('./lib/module-text').moduleLine(require('./lib/auth').reasonOf(guarded ? e.cause : e), 500);
  console.error('identity: the id index could not be built from --authProvider ' + options.authProvider + ': ' + why);
  process.exit(2);
});


// forever to restart on crash?
