// do not require CdifUtil here to avoid circular dep
// var CdifUtil = require('./cdif-util');

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
    this.reverseProxy            = (argv.reverseProxy    === true) ? true : false;
    this.cloud9                  = (argv.cloud9          === true) ? true : false;

    this.workerThread            = (argv.workerThread    === true) ? true : false;
    this.withPM2                 = (argv.withPM2         === true) ? true : false;

    this.modulePath   = argv.modulePath || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/cdif_modules';
    this.dbUrl        = argv.dbUrl      || 'http://admin:12345678@127.0.0.1:5984';
    this.regUrl       = argv.regUrl     || 'http://127.0.0.1:8037/';
    this.debugKey     = argv.debugKey   || null;

    // it is weird that on error condition, redis url which the ip is accessible would return ECONNREFUSED, but unaccessible ip won't report any error
    this.redisUrl     = argv.redisUrl   || 'redis://127.0.0.1:6379';

    this.bindAddr     = argv.bindAddr   || null;
    this.port         = argv.port       || '9527';

    this.locale       = argv.locale || 'zh-CN';

    this.globalRateLimit = argv.globalRateLimit != null ? parseInt(argv.globalRateLimit) : null;

    if (argv.loadModule != null) {
      this.localModulePath = argv.loadModule;
    }

    // the entry url of cdif, it should be configured to local url for on-premise deployments
    this.centralPortalUrl = argv.centralPortalUrl || 'https://api.apemesh.com:3049';

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
      reverseProxy:             this.reverseProxy,
      workerThread:             this.workerThread,
      modulePath:               this.modulePath,
      dbUrl:                    this.dbUrl,
      regUrl:                   this.regUrl,
      redisUrl:                 this.redisUrl,
      bindAddr:                 this.bindAddr,
      port:                     this.port,
      locale:                   this.locale,
      centralPortalUrl:         this.centralPortalUrl,
      deviceLogEntrySize:       this.deviceLogEntrySize,
      requestTimeout:           this.requestTimeout,
      simOpenStackAPI:          this.simOpenStackAPI,
      withPM2:                  this.withPM2,
      globalRateLimit:          this.globalRateLimit
    }
  }
};
