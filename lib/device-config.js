var fs           = require('fs');
var path         = require('path');
var _            = require('lodash');
var isMainThread = require('worker_threads').isMainThread;

// File-backed device config (previously a CouchDB `device-config` db, view
// `byModuleName` -- see docs/cdif-audit-and-refactoring-plan.md's
// AuthProvider section for why CouchDB is being retired as a hard
// dependency across the board, not just for auth). Keyed by module name,
// not individual deviceID -- this loads once per module load, before any
// of that module's devices have even come online (module-manager.js calls
// this right after constructing the module instance, before its
// 'deviceonline' events fire), so a per-deviceID key was never actually
// possible here. Not migrated from CouchDB: this repo never had a write
// path to that db either (config had to be hand-inserted directly), so
// there's no existing data to preserve compatibility with beyond the
// `global.DeviceConfig` shape device modules already read.
function loadDeviceConfigFromFile(opts, moduleName, callback) {
  var configDir  = opts.deviceConfigPath || (process.cwd() + '/config/devices');
  var configPath = path.join(configDir, moduleName + '.json');

  fs.readFile(configPath, 'utf8', function(err, raw) {
    if (err) {
      // no file for this module is not an error -- just an empty config,
      // same as CouchDB's "no matching row" case was.
      if (err.code === 'ENOENT') return finish(null, null);
      return finish(err);
    }

    var config;
    try {
      config = JSON.parse(raw);
    } catch (e) {
      return finish(e);
    }
    return finish(null, config);
  });

  function finish(err, config) {
    if (err) {
      if (global.DeviceConfig == null) global.DeviceConfig = {};
      return callback(err);
    }

    if (config == null) {
      // initialize empty global DeviceConfig object in case no data available
      if (global.DeviceConfig == null) global.DeviceConfig = {};
    } else if (isMainThread === true && opts.workerThread === false) {
      // Under single thread mode, we merge all configs into one large object
      // this could cause conflicts in config keys, we should aware user of this pitfall in manual

      // And under single thread mode, we have to restart the whole COUNTINGHOUSE instance to
      // refresh the new config value from disk.

      // Multi-thread mode doesn't have this limit because each worker thread will be recreated
      // when we restart the module, causing new config value being read from disk.
      global.DeviceConfig = JSON.parse(JSON.stringify(_.merge(global.DeviceConfig, config)));
    } else {
      global.DeviceConfig = JSON.parse(JSON.stringify(config));
    }

    return callback();
  }
}

module.exports = loadDeviceConfigFromFile;
