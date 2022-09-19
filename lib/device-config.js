var NANO         = require('nano');
var _            = require('lodash');
var isMainThread = require('worker_threads').isMainThread;


function loadDeviceConfigFromDB(opts, moduleName, callback) {
  var dbUrl = opts.dbUrl;
  var nano = NANO({url: dbUrl, requestDefaults: {timeout: 30000}});
  var deviceConfigDB = nano.db.use('device-config');

  deviceConfigDB.view('device-config', 'byModuleName', { key: moduleName }, function(err, doc) {
    if (err || doc.rows.length === 0) {
      if (global.DeviceConfig == null) global.DeviceConfig = {};
      return callback(err);
    }

    var config = doc.rows[0].value;

    try {
      if (config == null) {
        // initialize empty global DeviceConfig object in case no data available
         if (global.DeviceConfig == null) global.DeviceConfig = {};
      } else {
        if (isMainThread === true && opts.workerThread === false) {
          // Under single thread mode, we merge all configs into one large object
          // this could cause conflicts in config keys, we should aware user of this pitfall in manual

          // And under single thread mode, we have to restart the whole CDIF instance to
          // refresh the new config value from CouchDB

          // Multi-thread mode doesn't have this limit because each worker thread will be recreated
          // when we restart the module, causing new config value being read from CouchDB
          global.DeviceConfig = JSON.parse(JSON.stringify(_.merge(global.DeviceConfig, config)));
        } else {
          global.DeviceConfig = JSON.parse(JSON.stringify(config));
        }
      }
    } catch (e) {
      if (global.DeviceConfig == null) global.DeviceConfig = {};
      return callback(e);
    }

    // console.log(global.DeviceConfig);
    return callback();
  });
}


module.exports = loadDeviceConfigFromDB;