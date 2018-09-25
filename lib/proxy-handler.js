var proxy      = require('express-http-proxy');
var options    = require('./cli-options');
var nano       = require('nano')(options.dbUrl);

var apiProxyDB = nano.db.use('api-proxy-device');

module.exports = {
  proxyMap: {},
  app: null,

  loadProxyHost: function(deviceID, target) {
    if (deviceID == null || typeof(deviceID) !== 'string') return;

    if (this.proxyMap[deviceID] == null) {
      if (this.app != null) {
        this.app.use('/api-proxy/' + deviceID, proxy(this.getProxyHost.bind(this, deviceID), {parseReqBody: false, limit: '1gb', timeout: 60000, memoizeHost: false}));
      } else {
        return; //do not add target to map if app route not installed
      }
    }
    this.proxyMap[deviceID] = target;
  },

  loadAllProxyHosts: function(callback) {
    apiProxyDB.view('api-proxy-device', 'getAll', {}, function(err, doc) {
      if (err) return callback(err);

      for (var i = 0; i < doc.rows.length; i++) {
        this.proxyMap[doc.rows[i].key] = doc.rows[i].value;
      }
      return callback(null);
    }.bind(this));
  },

  getProxyHost: function(deviceID) {
    return this.proxyMap[deviceID];
  },

  installProxyRoutes: function(app) {
    if (this.app == null) this.app = app;

    for (var deviceID in this.proxyMap) {
      this.app.use('/api-proxy/' + deviceID, proxy(this.getProxyHost.bind(this, deviceID), {parseReqBody: false, limit: '1gb', timeout: 60000, memoizeHost: false}));
    }
  }
}