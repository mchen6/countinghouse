// do not require CHUtil here to avoid circular dep
// var CHUtil = require('./countinghouse-util');
const isMainThread = require('worker_threads').isMainThread;
const path         = require('path');

// minimist gives a flag given twice with string values as an array
// (`--stdio=true --stdio=true` is ['true', 'true']), which every boolean test
// below would read as false. A repeated boolean flag counts by its last
// value, as with one given once (#124). Options that may be repeated
// (--loadModule) are left as they are. Every flag setOptions tests as a
// boolean is in this list (test/stdio/02 checks it against this file).
const BOOLEAN_FLAGS = ['debug', 'heapDump', 'verifyModule', 'apiMonitor', 'wetty', 'logStream', 'workerThread',
  'directPeerChannels', 'meter', 'stdio', 'authoringTools', 'hardened'];
function lastOfRepeated(argv) {
  const out = Object.assign({}, argv);
  for (const k of BOOLEAN_FLAGS) if (Array.isArray(out[k])) out[k] = out[k][out[k].length - 1];
  return out;
}

module.exports = {
  BOOLEAN_FLAGS: BOOLEAN_FLAGS,

  setOptions: function(argv) {
    argv = lastOfRepeated(argv);
    this.debug                   = (argv.debug           === true) ? true : false;
    this.heapDump                = (argv.heapDump        === true) ? true : false;
    this.verifyModule            = (argv.verifyModule    === true) ? true : false;
    this.apiMonitor              = (argv.apiMonitor      === true) ? true : false;
    this.wetty                   = (argv.wetty           === true) ? true : false;
    this.logStream               = (argv.logStream       === true) ? true : false;
    // this.doDataValidation        = (argv.validateData    === true) ? true : false;

    // On unless turned off (8.0.0). minimist gives `--workerThread false` and
    // `--workerThread=false` as the string "false", which means off too.
    this.workerThread            = (argv.workerThread !== false && argv.workerThread !== 'false');

    // On unless the operator passes --no-directPeerChannels (7.1.0; it was
    // opt-in before). When off, lib/service-client.js's isRemoteThread
    // branch is byte-for-byte the main-thread-routed path -- this flag
    // changes nothing about either path's behavior, only which path is
    // taken. `!== false` rather than `=== true` so that the absence of the
    // flag means on, and so that the already-resolved boolean a worker
    // receives from getOptions() below round-trips unchanged.
    // `--directPeerChannels false` and `=false` arrive as the string "false":
    // off too, as for --workerThread (the review of #90).
    this.directPeerChannels      = (argv.directPeerChannels !== false && argv.directPeerChannels !== 'false');
    // Whether the operator named --directPeerChannels: the single-identity
    // profile refuses it (lib/local-profile.js), and only the main thread reads
    // it. A worker's options are rebuilt from getOptions()'s resolved boolean,
    // so there it says only whether peer channels are on.
    this.directPeerChannelsGiven = argv.directPeerChannels !== undefined && argv.directPeerChannels !== false && argv.directPeerChannels !== 'false';

    // Backpressure cap for lib/peer-channel.js (see its maxConcurrentInvokes
    // comment) -- how many peer-invoke calls a single channel will have in
    // flight, on both the sending and receiving side, before queueing the
    // rest. Fixes the regression docs/direct-peer-channels.md's benchmark
    // found at large payloads under high concurrency (direct peer channels
    // losing to the main-thread-routed path because nothing throttled how
    // much work piled up). See that doc's "Backpressure" section for why
    // this default was chosen.
    this.directPeerChannelsMaxConcurrency = argv.directPeerChannelsMaxConcurrency != null
      ? parseInt(argv.directPeerChannelsMaxConcurrency)
      : 16;

    // How often lib/peer-channel-broker.js re-runs the authorization check
    // for the grants behind open peer channels, so that a grant revoked
    // while the server runs closes the channel it opened. 0 turns the
    // re-check off, which restores the pre-7.1.0 behaviour: an open channel
    // then outlives a revocation until its worker restarts.
    this.peerChannelAuthRecheckSeconds = argv.peerChannelAuthRecheckSeconds != null
      ? Number(argv.peerChannelAuthRecheckSeconds)
      : 5;
    if (!(this.peerChannelAuthRecheckSeconds >= 0)) this.peerChannelAuthRecheckSeconds = 5;
    // How long one of those re-check lookups may take before the channel it
    // guards is closed as unconfirmed (R2-1 Task 3, the reviewer's M13): an
    // auth backend that accepts the lookup and never answers must not leave
    // a channel open, nor the re-check stuck in flight.
    this.peerChannelAuthLookupTimeoutMs = argv.peerChannelAuthLookupTimeoutMs != null
      ? Number(argv.peerChannelAuthLookupTimeoutMs)
      : 10000;
    if (!(this.peerChannelAuthLookupTimeoutMs > 0)) this.peerChannelAuthLookupTimeoutMs = 10000;

    this.modulePath   = argv.modulePath || `${process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']}/countinghouse_modules`;
    // Each module's private /data and /tmp (module sandbox part 2). Not
    // $HOME/countinghouse_module_data: a name that extends a likely install
    // directory ($HOME/countinghouse) is one Node's permission model mishandles
    // under --hardened (nodejs/node#66812).
    this.moduleDataPath = argv.moduleDataPath || `${process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']}/.countinghouse/module_data`;
    // The backends' connection strings default on the main thread only: a
    // worker receives none (getOptionsForWorker) and must not invent one.
    this.dbUrl        = argv.dbUrl      || (isMainThread ? 'http://admin:12345678@127.0.0.1:5984' : null);
    // A string: minimist gives an all-digit value as a number, which never
    // equals the X-CH-Key header (review). A bare --debugKey is true to
    // minimist, and must not become the key 'true': debugKeyMissing makes
    // framework.js refuse to start (review R1-5b).
    const dk = argv.debugKey;
    this.debugKeyMissing = (dk != null && typeof(dk) !== 'string' && typeof(dk) !== 'number') || dk === '';
    this.debugKey     = (!this.debugKeyMissing && dk != null) ? String(dk) : null;

    // AuthProvider selection (lib/auth/index.js) -- 'file' (default, no
    // external dependency), 'sqlite' (also no external service, just a
    // local db file), or 'couchdb' (lib/couchdb-adapter/, requires nano +
    // a real CouchDB instance, --dbUrl above). authConfigPath is the
    // backend-specific config file location: auth.json for 'file',
    // the sqlite db file for 'sqlite'; unused for 'couchdb'.
    this.authProvider   = argv.authProvider   || 'file';
    this.authConfigPath = argv.authConfigPath || null;

    // Directory holding one <moduleName>.json file per module with
    // device config to preload (lib/device-config.js, replaces the old
    // CouchDB device-config db). Defaults to ./config/devices relative to
    // cwd; a missing directory/file is not an error, just an empty config.
    this.deviceConfigPath = argv.deviceConfigPath || null;

    // it is weird that on error condition, redis url which the ip is accessible would return ECONNREFUSED, but unaccessible ip won't report any error
    this.redisUrl     = argv.redisUrl   || (isMainThread ? 'redis://127.0.0.1:6379' : null);
    this.redisUrlExplicit = (argv.redisUrl != null);

    // Where the runtime keeps what it used Redis for (LM1, docs/superpowers/
    // specs/2026-11-11-local-mode-design.md section 1): redis (the default,
    // as before) or local, files under --storePath (default beside the
    // module data, <moduleDataPath>/../store). --meter keeps today's
    // balances and limits in --store local. framework.js refuses a --store
    // it does not know, and --store local with --redisUrl.
    this.store        = (argv.store != null) ? String(argv.store) : 'redis';
    this.storePath    = path.resolve((argv.storePath != null) ? String(argv.storePath) : path.join(this.moduleDataPath, '..', 'store'));
    this.meter        = (argv.meter === true);
    // --store local keeps no Redis: no URL to connect to, and none for the
    // module sandbox to deny (the spec: the always-denied endpoint list is
    // empty in local).
    if (this.store === 'local') this.redisUrl = null;

    // The single-identity profile (LM1 spec section 4): --store local
    // --stdio without --authConfigPath. Its key is this process's own, made
    // here on the main thread and held in memory only: never printed,
    // logged or written, and kept out of getOptions() and every copy a
    // worker gets (C's stdio layer reads options.apiKey on the main thread).
    // An explicit --authProvider (sqlite, couchdb, even file) is the
    // operator's choice of tenants and turns the profile off, as any
    // --authConfigPath does (one given with no path is refused at start,
    // authConfigPathInvalid, rather than falling into the zero-config file).
    this.authConfigPathInvalid = (argv.authConfigPath === true || argv.authConfigPath === '');
    this.singleIdentity = (this.store === 'local' && (argv.stdio === true || argv.stdio === 'true') && argv.authConfigPath == null && argv.authProvider == null);
    // Made once per process and read-only: the cached auth provider and
    // the identity index hold it (review of B4).
    if (this.singleIdentity && isMainThread) {
      if (typeof(this.apiKey) !== 'string') {
        Object.defineProperty(this, 'apiKey', {value: `local-${require('crypto').randomBytes(16).toString('hex')}`,
          enumerable: false, writable: false, configurable: true});
      }
    } else {
      delete this.apiKey;
    }

    this.bindAddr     = argv.bindAddr   || null;
    this.port         = argv.port       || '9527';

    // --stdio: MCP over stdin and stdout instead of HTTP (local-mode spec §2).
    // Exclusive with --port (framework.js refuses both).
    this.stdio        = argv.stdio === true || argv.stdio === 'true';
    this.stdioWithPort = this.stdio && argv.port != null;

    // --usageDir <dir>: where the usage records are appended, one file per
    // process per day (local-mode spec §5). Under --store local it defaults to
    // <storePath>/usage, so every launcher sharing a store writes one record of
    // usage across agents (reviewer, 2026-11-12); under --store redis it is
    // explicit-only, a hosted operator opting in to disk writes. Unset, nothing
    // is written; the counters, the receipt and the report's memory source
    // still work.
    this.usageDir     = typeof argv.usageDir === 'string' && argv.usageDir !== '' ? argv.usageDir
      : (this.store === 'local' ? path.join(this.storePath, 'usage') : null);

    this.locale       = argv.locale || 'en-US';

    this.globalRateLimit = argv.globalRateLimit != null ? parseInt(argv.globalRateLimit) : null;
    // per-apiKey rate limit (max calls/second per caller), via
    // MeteringProvider.rateLimit -- separate from and additional to
    // globalRateLimit above, which caps the combined call rate across every
    // caller. Opt-in, off by default, so it never changes behavior for a
    // deployment/test run that doesn't set it.
    this.apiKeyRateLimit = argv.apiKeyRateLimit != null ? parseInt(argv.apiKeyRateLimit) : null;

    // cost recorded via MeteringProvider.recordCall for every MCP tools/call
    // (both synchronous and task-augmented). Defaults to 0: calls are still
    // recorded (toolPriceRecord/balance bookkeeping runs either way), but
    // nothing is actually charged unless this is set to a positive value.
    // A finite number >= 0 only (review M9): a negative cost credits every
    // caller, NaN or Infinity make recordCall fail and the call is served
    // free, and parseFloat read "1abc" as 1. minimist has already turned a
    // numeric value into a number; anything else (a word, an empty value, no
    // value at all, "--mcpToolCallCost -1", which minimist reads as no value)
    // is kept in mcpToolCallCostInvalid, and framework.js exits 2.
    const cost = argv.mcpToolCallCost;
    const costOk = (cost == null) || (typeof(cost) === 'number' && Number.isFinite(cost) && cost >= 0);
    this.mcpToolCallCostInvalid = costOk ? null : {value: cost};
    this.mcpToolCallCost = (costOk && cost != null) ? cost : 0;

    // RC1-min (lib/remote/): the operator's credential allowance, which
    // framework.js loads at start (exit 2 when it is not the documented
    // shape), and the limits on a remote call: seconds, and bytes of one
    // answer. A limit that is not a positive finite number is kept in
    // remoteLimitInvalid, and framework.js exits 2.
    // minimist reads an all-digit path as a number, as it does --debugKey.
    const rc = argv.remoteCredentials;
    this.remoteCredentials = (typeof(rc) === 'string' || typeof(rc) === 'number') ? String(rc) : null;
    const positive = (v) => typeof(v) === 'number' && Number.isFinite(v) && v > 0;
    this.remoteTimeout  = (argv.remoteTimeout  != null) ? argv.remoteTimeout  : 60;
    this.remoteMaxBytes = (argv.remoteMaxBytes != null) ? argv.remoteMaxBytes : 16777216;
    this.remoteLimitInvalid = !positive(this.remoteTimeout) ? {name: 'remoteTimeout', value: this.remoteTimeout}
      : (!positive(this.remoteMaxBytes) ? {name: 'remoteMaxBytes', value: this.remoteMaxBytes} : null);

    if (argv.loadModule != null) {
      this.localModulePath = argv.loadModule;
    }

    // the entry url of countinghouse, it should be configured to local url for on-premise deployments
    this.centralPortalUrl = argv.centralPortalUrl || 'https://api.countinghouse.com:3049';

    this.deviceLogEntrySize = argv.deviceLogEntrySize || 1000;

    if (argv.requestTimeout == null) {
      this.requestTimeout = 30000;
    } else {
      const parsed = parseInt(argv.requestTimeout);
      if (isNaN(parsed)) {
        this.requestTimeout = 30000;
      } else {
        this.requestTimeout = argv.requestTimeout * 1000; // convert sec to msec
        if (isNaN(this.requestTimeout)) this.requestTimeout = 30000;
      }
    }
    // The request timer in milliseconds, as given when present: a worker's
    // options are the main thread's getOptions(), whose requestTimeout is
    // already in milliseconds and would be read as seconds again above.
    // ctx.call's composition wait is bounded under it (lib/handler-ctx.js).
    // requestTimeout itself is set from it too (the review of #138, 2b): a
    // worker's per-invoke timers read requestTimeout, and were 1000 times
    // the flag.
    this.requestTimeoutMs = (typeof(argv.requestTimeoutMs) === 'number' && Number.isFinite(argv.requestTimeoutMs)) ? argv.requestTimeoutMs : this.requestTimeout;
    if (typeof(argv.requestTimeoutMs) === 'number' && Number.isFinite(argv.requestTimeoutMs)) this.requestTimeout = argv.requestTimeoutMs;

    // --jobTimeout <seconds>: how long the job processor lets a job run when
    // it sets no timeout of its own (lib/job-control.js), so a handler that
    // never answers cannot hold a job worker slot forever. 0 means none.
    const jobTimeout = (argv.jobTimeout == null || argv.jobTimeout === '') ? NaN : Number(argv.jobTimeout);
    this.jobTimeout = (Number.isFinite(jobTimeout) && jobTimeout >= 0) ? Math.round(jobTimeout * 1000) : 3600000;
    // --jobResultTtl <seconds>: how long the local job runner (--store local)
    // keeps a finished job's result (ms here, like jobTimeout); default an
    // hour. The BullMQ runner keeps its own (Redis) policy.
    const jobResultTtl = (argv.jobResultTtl == null || argv.jobResultTtl === '') ? NaN : Number(argv.jobResultTtl);
    this.jobResultTtl = (Number.isFinite(jobResultTtl) && jobResultTtl >= 0) ? Math.round(jobResultTtl * 1000) : 3600000;

    // Request bodies are read before any route checks the caller's key, so
    // their size is bounded (MB): JSON, XML and form bodies app-wide, BSON
    // only on the routes that take it (lib/route-manager.js; review R1-1).
    const mb = (v, dflt) => { const n = parseInt(v, 10); return (n > 0) ? n : dflt; };
    this.maxRequestBody     = mb(argv.maxRequestBody, 8);
    this.maxBsonRequestBody = mb(argv.maxBsonRequestBody, 64);
    // Browser origins allowed cross-origin access (CORS) and on /mcp; none by
    // default (review R1-2b; user decision, 2026-11-04). Comma-separated.
    this.allowedOrigins = String(argv.allowedOrigins || '').split(',').map((o) => o.trim()).filter((o) => o !== '');

    // Default-off admin-gated MCP authoring tools (lib/mcp/tool-registry.js's
    // AUTHORING_TOOLS, gated in lib/mcp/gateway.js). This is not precautionary:
    // countinghouse_load_module requires() a caller-supplied path directly in
    // the main gateway process, unsandboxed, to load it into the live
    // runtime -- this flag, plus the admin-key gate beneath it, is the only
    // thing standing between a caller and that. (countinghouse_validate_module
    // runs caller-supplied code too, but in a spawned child process instead --
    // see gateway.js's validateModuleInChildProcess comment for the full
    // picture of what each of the four authoring tools does and doesn't
    // protect against.)
    this.authoringTools          = (argv.authoringTools  === true) ? true : false;

    // Module sandbox (docs/superpowers/specs/2026-10-15-module-sandbox-
    // foundation-design.md). The default depends on --workerThread because
    // the sandbox only exists in worker mode; moduleSandboxExplicit lets
    // framework.js refuse an explicit audit/enforce without it while quietly
    // downgrading the default. A worker receives the already-resolved mode
    // through getOptions(), which counts as explicit there -- harmless, the
    // worker never applies this check.
    this.moduleSandboxExplicit = (argv.moduleSandbox != null);
    this.moduleSandbox = this.moduleSandboxExplicit
      ? String(argv.moduleSandbox)
      : (this.workerThread === true ? 'audit' : 'off');
    this.modulePolicy = argv.modulePolicy || null;
    this.moduleMessageRate = argv.moduleMessageRate != null ? parseInt(argv.moduleMessageRate) : 2000;
    if (!(this.moduleMessageRate > 0)) this.moduleMessageRate = 2000;
    this.hardened = (argv.hardened === true);
  },

  // What a module worker receives on set-options (lib/module-manager.js):
  // everything but the backends' connection strings (R2-1). A --redisUrl or
  // --dbUrl carrying a password would otherwise reach every module, and a
  // worker opens no connection of its own.
  getOptionsForWorker: function() {
    const o = this.getOptions();
    delete o.redisUrl;
    delete o.dbUrl;
    // a worker uses no store (the main thread holds it)
    delete o.storePath;
    return o;
  },

  getOptions: function() {
    return {
      debug:                    this.debug,
      heapDump:                 this.heapDump,
      verifyModule:             this.verifyModule,
      apiMonitor:               this.apiMonitor,
      wetty:                    this.wetty,
      logStream:                this.logStream,
      workerThread:             this.workerThread,
      directPeerChannels:       this.directPeerChannels,
      directPeerChannelsMaxConcurrency: this.directPeerChannelsMaxConcurrency,
      peerChannelAuthRecheckSeconds: this.peerChannelAuthRecheckSeconds,
      modulePath:               this.modulePath,
      moduleDataPath:           this.moduleDataPath,
      dbUrl:                    this.dbUrl,
      redisUrl:                 this.redisUrl,
      store:                    this.store,
      storePath:                this.storePath,
      meter:                    this.meter,
      authProvider:             this.authProvider,
      authConfigPath:           this.authConfigPath,
      deviceConfigPath:         this.deviceConfigPath,
      bindAddr:                 this.bindAddr,
      port:                     this.port,
      stdio:                    this.stdio,
      usageDir:                 this.usageDir,
      locale:                   this.locale,
      centralPortalUrl:         this.centralPortalUrl,
      deviceLogEntrySize:       this.deviceLogEntrySize,
      requestTimeout:           this.requestTimeout,
      requestTimeoutMs:         this.requestTimeoutMs,
      jobTimeout:               this.jobTimeout,
      jobResultTtl:             this.jobResultTtl,
      globalRateLimit:          this.globalRateLimit,
      apiKeyRateLimit:          this.apiKeyRateLimit,
      mcpToolCallCost:          this.mcpToolCallCost,
      remoteCredentials:        this.remoteCredentials,
      remoteTimeout:            this.remoteTimeout,
      remoteMaxBytes:           this.remoteMaxBytes,
      authoringTools:           this.authoringTools,
      moduleSandbox:            this.moduleSandbox,
      modulePolicy:             this.modulePolicy,
      moduleMessageRate:        this.moduleMessageRate,
      hardened:                 this.hardened
    }
  }
};
