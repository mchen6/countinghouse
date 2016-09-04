var sqlite3  = require('sqlite3');
var db       = new sqlite3.Database('./device_store.db');
var moduleDB = new sqlite3.Database('./modules.db');

db.serialize(function() {
  db.run("CREATE TABLE IF NOT EXISTS device_db(hwaddr TEXT PRIMARY KEY, uuid TEXT, spec TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS device_hash(uuid TEXT PRIMARY KEY, hash TEXT)");
});

moduleDB.serialize(function() {
  moduleDB.run("CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT)");
});

module.exports = {
  getDeviceUUIDFromHWAddr: function(hwAddr, callback) {
    if (hwAddr == null) {
      return callback(null, null);
    }

    db.serialize(function() {
      db.get("SELECT uuid FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    });
  },

  setDeviceUUID: function(hwAddr, deviceUUID, callback) {
    if (hwAddr == null) {
      return callback(null, null);
    }

    db.serialize(function() {
      db.run("INSERT OR REPLACE INTO device_db(hwaddr, uuid, spec) VALUES (?, ?, (SELECT spec FROM device_db WHERE hwaddr = ?))",
      hwAddr, deviceUUID, hwAddr, callback);
    });
  },

  getDeviceSpecFromHWAddr: function(hwAddr, callback) {
    db.serialize(function() {
      db.get("SELECT spec FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    });
  },

  setSpecForDevice: function(hwAddr, spec) {
    if (hwAddr == null) return;

    db.serialize(function() {
      db.run("INSERT OR REPLACE INTO device_db(hwaddr, uuid, spec) VALUES (?, (SELECT uuid FROM device_db WHERE hwaddr = ?), ?)",
      hwAddr, hwAddr, spec);
    });
  },

  getSpecForAllDevices: function(callback) {
    db.parallelize(function() {
      db.all("SELECT spec FROM device_db", callback);
    });
  },

  deleteDeviceInformation: function(hwAddr, callback) {
    db.serialize(function() {
      db.run("DELETE FROM device_db WHERE hwaddr = ?", hwAddr, callback);
    });
  },

  loadSecret: function(deviceUUID, callback) {
    db.serialize(function() {
      db.get("SELECT hash FROM device_hash WHERE uuid = ?", deviceUUID, callback);
    });
  },

  storeSecret: function(deviceUUID, hash, callback) {
    db.serialize(function() {
      db.run("INSERT OR REPLACE INTO device_hash(uuid, hash) VALUES (?, ?)",
      deviceUUID, hash, callback);
    });
  },

  setModuleInfo: function(name, version, callback) {
    if (name == null) {
      return callback(new Error('setting incorrect module name'), null);
    }

    moduleDB.serialize(function() {
      moduleDB.run("INSERT OR REPLACE INTO module_info(name, version) VALUES (?, ?)",
      name, version, callback);
    });
  },

  removeModuleInfo: function(name, callback) {
    if (name == null) {
      return callback(new Error('remove incorrect module name'), null);
    }

    moduleDB.serialize(function() {
      moduleDB.run("DELETE FROM module_info WHERE name = ?", name, callback);
    });
  },

  getAllModuleInfo: function(callback) {
    moduleDB.parallelize(function() {
      moduleDB.all("SELECT * FROM module_info", callback);
    });
  }
};

