// do not require CHUtil here to avoid circular dep
// var CHUtil = require('./countinghouse-util');

module.exports = {
  setOptions: function(argv) {
    this.debug                   = (argv.debug           === true) ? true : false;
    this.allowDiscover           = false; //disable allowDiscover flag because it is broken under worker thread mode
    this.allowSimpleType         = (argv.allowSimpleType === true) ? true : false;
    this.heapDump                = (argv.heapDump        === true) ? true : false;
    this.wsServer                = (argv.wsServer        === true) ? true : false;
    this.sioServer               = (argv.sioServer       === true) ? true : false;
    this.verifyModule            = (argv.verifyModule    === true) ? true : false;
    this.apiMonitor              = (argv.apiMonitor      === true) ? true : false;
    this.apiCache                = (argv.apiCache        === true) ? true : false;
    this.loadProfile             = (argv.loadProfile     === true) ? true : false;
    this.wetty                   = (argv.wetty           === true) ? true : false;
    this.logStream               = (argv.logStream       === true) ? true : false;
    // this.doDataValidation        = (argv.validateData    === true) ? true : false;

    this.workerThread            = (argv.workerThread    === true) ? true : false;
    this.withPM2                 = (argv.withPM2         === true) ? true : false;

    // docs/direct-peer-channels-design.md section 3: default OFF. When off,
    // lib/service-client.js's isRemoteThread branch is byte-for-byte the
    // pre-existing main-thread-routed path -- this flag changes nothing
    // about that path's behavior, only which path is taken.
    this.directPeerChannels      = (argv.directPeerChannels === true) ? true : false;

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

    this.modulePath   = argv.modulePath || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/countinghouse_modules';
    this.dbUrl        = argv.dbUrl      || 'http://admin:12345678@127.0.0.1:5984';
    this.regUrl       = argv.regUrl     || 'http://127.0.0.1:8037/';
    this.debugKey     = argv.debugKey   || null;

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
    this.redisUrl     = argv.redisUrl   || 'redis://127.0.0.1:6379';

    this.bindAddr     = argv.bindAddr   || null;
    this.port         = argv.port       || '9527';

    this.locale       = argv.locale || 'zh-CN';

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
    this.mcpToolCallCost = argv.mcpToolCallCost != null ? parseFloat(argv.mcpToolCallCost) : 0;

    if (argv.loadModule != null) {
      this.localModulePath = argv.loadModule;
    }

    // the entry url of countinghouse, it should be configured to local url for on-premise deployments
    this.centralPortalUrl = argv.centralPortalUrl || 'https://api.countinghouse.com:3049';

    this.deviceLogEntrySize = argv.deviceLogEntrySize || 1000;

    if (argv.requestTimeout == null) {
      this.requestTimeout = 30000;
    } else {
      var parsed = parseInt(argv.requestTimeout);
      if (isNaN(parsed)) {
        this.requestTimeout = 30000;
      } else {
        this.requestTimeout = argv.requestTimeout * 1000; // convert sec to msec
        if (isNaN(this.requestTimeout)) this.requestTimeout = 30000;
      }
    }

    if (this.wsServer === true && this.sioServer === true) {
      console.log('trying to start WebSocket and SocketIO server simultanenouesly, start with WebSocket server');
    }

    this.simOpenStackAPI = (argv.simOpenStackAPI === true) ? true : false;
  },

  getOptions: function() {
    return {
      debug:                    this.debug,
      allowDiscover:            this.allowDiscover,
      allowSimpleType:          this.allowSimpleType,
      heapDump:                 this.heapDump,
      wsServer:                 this.wsServer,
      sioServer:                this.sioServer,
      verifyModule:             this.verifyModule,
      apiMonitor:               this.apiMonitor,
      apiCache:                 this.apiCache,
      loadProfile:              this.loadProfile,
      wetty:                    this.wetty,
      logStream:                this.logStream,
      workerThread:             this.workerThread,
      directPeerChannels:       this.directPeerChannels,
      directPeerChannelsMaxConcurrency: this.directPeerChannelsMaxConcurrency,
      modulePath:               this.modulePath,
      dbUrl:                    this.dbUrl,
      regUrl:                   this.regUrl,
      redisUrl:                 this.redisUrl,
      authProvider:             this.authProvider,
      authConfigPath:           this.authConfigPath,
      deviceConfigPath:         this.deviceConfigPath,
      bindAddr:                 this.bindAddr,
      port:                     this.port,
      locale:                   this.locale,
      centralPortalUrl:         this.centralPortalUrl,
      deviceLogEntrySize:       this.deviceLogEntrySize,
      requestTimeout:           this.requestTimeout,
      simOpenStackAPI:          this.simOpenStackAPI,
      withPM2:                  this.withPM2,
      globalRateLimit:          this.globalRateLimit,
      apiKeyRateLimit:          this.apiKeyRateLimit,
      mcpToolCallCost:          this.mcpToolCallCost
    }
  }
};
