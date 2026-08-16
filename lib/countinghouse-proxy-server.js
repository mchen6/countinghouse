const cp        = require('child_process');
const events    = require('events');
const util      = require('util');
const CHUtil  = require('./countinghouse-util');
const CHError = require('./countinghouse-error').CHError;

function ProxyServer() {
  this.server    = null;
  this.proxyUrl  = '';
  // For now this is onvif only
  this.streamUrl = '';
}

util.inherits(ProxyServer, events.EventEmitter);

ProxyServer.prototype.createServer = function(path, callback) {
  try {
    this.server = cp.fork(path);

    this.server.on('message', (msg) => {
      if (msg.port) {
        const port = msg.port;
        const protocol = CHUtil.getHostProtocol();
        const hostIp = CHUtil.getHostIp();
        this.proxyUrl = `${protocol + hostIp}:${port}`;
        this.emit('proxyurl', this.proxyUrl);
      } else if (msg.streamUrl) {
        // For now this is onvif only
        this.streamUrl = msg.streamUrl;
        this.emit('streamurl', this.streamUrl);
      } else if (msg.error) {
        this.emit('error', msg.error);
      }
    });
  } catch(e) {
    if (typeof(callback) === 'function') {
      callback(new CHError('PROXY_SERVER_CREATE_FAIL', e.message));
    }
    return;
  }
  if (typeof(callback) === 'function') {
    callback(null);
  }
};

ProxyServer.prototype.killServer = function(callback) {
  if (this.server) {
    this.server.kill('SIGTERM');
  }
  if (typeof(callback) === 'function') {
    callback(null);
  }
};

ProxyServer.prototype.setDeviceID = function(id) {
  this.server.send({deviceID: id});
};

ProxyServer.prototype.setDeviceRootUrl = function(url) {
  this.server.send({deviceRootUrl: url});
};

// For now this is onvif only
ProxyServer.prototype.setDeviceStreamUrl = function(url) {
  this.server.send({deviceStreamUrl: url});
};

module.exports = ProxyServer;
