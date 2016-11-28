var LOG      = require('./logger');
var CdifUtil = require('./cdif-util');

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

    this.modulePath   = argv.modulePath || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'] + '/cdif_modules';
    this.dbUrl        = argv.dbUrl      || 'http://admin:12345678@registry.apemesh.com:5984';

    // this.localDBAccess = true; // whether or not access local device DB
    // this.localDBPath   = null; // the absolute path of local device DB

    // if (argv.localDBPath != null && typeof(argv.localDBPath) === 'string') {
    //   this.localDBPath = argv.localDBPath;
    // }

    // this.localModulePath = null;

    // //TODO: support specify only one module name now
    // if (argv.loadModule != null) {
    //   this.localDBAccess = false;
    //   this.localModulePath = argv.loadModule;
    // }

    // // do not access local DB when verifying a package
    // if (this.enableVerifyAndPublish === true) {
    //   this.localDBAccess = false;
    // }

    if (argv.port != null) {
      // set field directly to avoid exposing setter function to device modules
      CdifUtil.hostPort = argv.port;
    }

    if (this.wsServer === true && this.sioServer === true) {
      LOG.I('trying to start WebSocket and SocketIO server simultanenouesly, start with WebSocket server');
    }
  }
};
