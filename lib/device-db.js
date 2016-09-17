var sqlite3  = require('sqlite3');
var options  = require('./cli-options');
var mkdirp   = require('mkdirp');
var logger   = require('./logger');

module.exports = {
  getDeviceUUIDFromHWAddr: function(hwAddr, callback) {
    if (hwAddr == null) {
      return callback(null, null);
    }

    this.db.serialize(function() {
      this.db.get("SELECT uuid FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    }.bind(this));
  },

  setDeviceUUID: function(hwAddr, deviceUUID, callback) {
    if (hwAddr == null) {
      return callback(null, null);
    }

    this.db.serialize(function() {
      this.db.run("INSERT OR REPLACE INTO device_db(hwaddr, uuid, spec) VALUES (?, ?, (SELECT spec FROM device_db WHERE hwaddr = ?))",
      hwAddr, deviceUUID, hwAddr, callback);
    }.bind(this));
  },

  getDeviceSpecFromHWAddr: function(hwAddr, callback) {
    this.db.serialize(function() {
      this.db.get("SELECT spec FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    }.bind(this));
  },

  setSpecForDevice: function(hwAddr, spec) {
    if (hwAddr == null) return;

    this.db.serialize(function() {
      this.db.run("INSERT OR REPLACE INTO device_db(hwaddr, uuid, spec) VALUES (?, (SELECT uuid FROM device_db WHERE hwaddr = ?), ?)",
      hwAddr, hwAddr, spec);
    }.bind(this));
  },

  getSpecForAllDevices: function(callback) {
    this.db.parallelize(function() {
      this.db.all("SELECT spec FROM device_db", callback);
    }.bind(this));
  },

  deleteDeviceInformation: function(hwAddr, callback) {
    this.db.serialize(function() {
      this.db.run("DELETE FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    }.bind(this));
  },

  loadSecret: function(deviceUUID, callback) {
    this.db.serialize(function() {
      this.db.get("SELECT hash FROM device_hash WHERE uuid = ?", deviceUUID, callback);
    }.bind(this));
  },

  storeSecret: function(deviceUUID, hash, callback) {
    this.db.serialize(function() {
      this.db.run("INSERT OR REPLACE INTO device_hash(uuid, hash) VALUES (?, ?)",
      deviceUUID, hash, callback);
    }.bind(this));
  },

  setModuleInfo: function(name, version, callback) {
    if (name == null) {
      return callback(new Error('setting incorrect module name'), null);
    }

    this.moduleDB.serialize(function() {
      this.moduleDB.run("INSERT OR REPLACE INTO module_info(name, version) VALUES (?, ?)",
      name, version, callback);
    }.bind(this));
  },

  removeModuleInfo: function(name, callback) {
    if (name == null) {
      return callback(new Error('remove incorrect module name'), null);
    }

    this.moduleDB.serialize(function() {
      this.moduleDB.run("DELETE FROM module_info WHERE name = ?", name, callback);
    }.bind(this));
  },

  getAllModuleInfo: function(callback) {
    this.moduleDB.parallelize(function() {
      this.moduleDB.all("SELECT * FROM module_info", callback);
    }.bind(this));
  },

  init: function() {
    var deviceDBName, moduleDBName;

    if (options.dbPath !== null) {
      deviceDBName = options.dbPath + '/device_store.db';
      moduleDBName = options.dbPath + '/modules.db';
      //TODO: check write safety of this call, do not crash
      try {
        mkdirp.sync(options.dbPath);
      } catch (e) {
        return logger.error(e);
      }
    } else {
      deviceDBName = __dirname + '/../device_store.db';
      moduleDBName = __dirname + '/../modules.db';
    }

    this.db       = new sqlite3.Database(deviceDBName);
    this.moduleDB = new sqlite3.Database(moduleDBName);

    this.db.serialize(function() {
      this.db.run("CREATE TABLE IF NOT EXISTS device_db(hwaddr TEXT PRIMARY KEY, uuid TEXT, spec TEXT)");
      this.db.run("CREATE TABLE IF NOT EXISTS device_hash(uuid TEXT PRIMARY KEY, hash TEXT)");
    }.bind(this));

    this.moduleDB.serialize(function() {
      this.moduleDB.run("CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT)");
    }.bind(this));
  }
};

