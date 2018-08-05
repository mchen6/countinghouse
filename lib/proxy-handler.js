var proxy      = require('express-http-proxy');
var options    = require('./cli-options');
var nano       = require('nano')(options.dbUrl);

var apiProxyDB = nano.db.use('api-proxy-device');

module.exports = {
  proxyMap: {},

  reloadProxyHosts: function(deviceID, target) {
    this.proxyMap[deviceID] = target; // or reload all from couchdb if any change occurs?
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
    for (var deviceID in this.proxyMap) {
      app.use('/api-proxy/' + deviceID, proxy(this.getProxyHost.bind(this, deviceID), {limit: '1gb', timeout: 60000, memoizeHost: false}));
    }
  }
}