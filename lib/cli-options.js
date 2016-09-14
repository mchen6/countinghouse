var logger = require('logger');

module.exports = {
  setOptions: function(argv) {
    this.isDebug       = (argv.debug         === true) ? true : false;
    this.global        = (argv.global        === true) ? true : false;
    this.allowDiscover = (argv.allowDiscover === true) ? true : false;
    this.heapDump      = (argv.heapDump      === true) ? true : false;
    this.wsServer      = (argv.wsServer      === true) ? true : false;
    this.sioServer     = (argv.sioServer     === true) ? true : false;

    if (this.wsServer === true && this.sioServer === true) {
      logger.info('trying to start WebSocket and SocketIO server simultanenouesly, start with WebSocket server');
    }
  }
};
