// do not require CdifUtil here to avoid circular dep
// var CdifUtil = require('./cdif-util');

module.exports = {
  setOptions: function(argv) {
    this.isDebug                 = (argv.debug           === true) ? true : false;
    this.allowDiscover           = (argv.allowDiscover   === true) ? true : false;
    this.allowSimpleType         = (argv.allowSimpleType === true) ? true : false;
    this.heapDump                = (argv.heapDump        === true) ? true : false;
    this.wsServer                = (argv.wsServer        === true) ? true : false;
    this.sioServer               = (argv.sioServer       === true) ? true : false;
    this.enableVerifyAndPublish  = (argv.verifyModule    === true) ? true : false;
    this.enableAPIMonitor        = (argv.apiMonitor      === true) ? true : false;
    this.enableAPICache          = (argv.apiCache        === true) ? true : false;
    this.loadProfile             = (argv.loadProfile     === true) ? true : false;
    this.wetty                   = (argv.wetty           === true) ? true : false;
    this.logStream               = (argv.logStream       === true) ? true : false;
    // this.doDataValidation        = (argv.validateData    === true) ? true : false;

    this.modulePath   = argv.modulePath || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/cdif_modules';
    this.dbUrl        = argv.dbUrl      || 'http://admin:12345678@registry.apemesh.com:5984';
    this.regUrl       = argv.regUrl     || 'http://registry.apemesh.com:8000/';

    // it is weird that on error condition, redis url which the ip is accessible would return ECONNREFUSED, but unaccessible ip won't report any error
    this.redisUrl     = argv.redisUrl   || 'redis://127.0.0.1:6379';

    this.bindAddr     = argv.bindAddr   || null;
    this.hostPort     = argv.port       || '9527';

    this.locale       = argv.locale || 'zh-CN';

    if (argv.loadModule != null) {
      this.localModulePath = argv.loadModule;
    }

    // the entry url of cdif, it should be configured to local url for on-premise deployments
    this.centralPortalUrl = argv.centralPortalUrl || 'https://api.apemesh.com:3049';

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
    // this.apiGateway = argv.apiGateway || null;
    // // do not access local DB when verifying a package
    // if (this.enableVerifyAndPublish === true) {
    //   this.localDBAccess = false;
    // }

    // if (argv.port != null) {
    //   // set field directly to avoid exposing setter function to device modules
    //   CdifUtil.hostPort = argv.port;
    // }

    if (this.wsServer === true && this.sioServer === true) {
      console.log('trying to start WebSocket and SocketIO server simultanenouesly, start with WebSocket server');
    }

    this.simOpenStackAPI = (argv.simOpenStackAPI === true) ? true : false;
  }
};
