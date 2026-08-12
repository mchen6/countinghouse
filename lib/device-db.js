// optionalDependency -- see lib/auth/sqlite-provider.js's requireSqlite3 for
// why. framework.js already skips requiring this whole file unless the
// registry DB is actually needed (i.e. no --loadModule was given), so the
// common path never reaches this require at all.
var sqlite3 = null;
try {
  sqlite3 = require('sqlite3');
} catch (e) {
  throw new Error('The module registry database requires the "sqlite3" package, which is not ' +
                  'installed or cannot be loaded on this host (' + e.message.split('\n')[0] + '). ' +
                  'Run: npm install sqlite3 -- or start with --loadModule <path>, which does not use it.');
}

module.exports = {
  setModuleInfo: function(name, version, path, deviceList, callback) {
    if (name == null) {
      return callback(new Error('setting incorrect module name'), null);
    }

    this.moduleDB.serialize(function() {
      this.moduleDB.run("INSERT OR REPLACE INTO module_info(name, version, path, deviceList) VALUES (?, ?, ?, ?)",
      name, version, path, deviceList, callback);
    }.bind(this));
  },

  getModuleInfo: function(name, callback) {
    if (name == null) {
      return callback(new Error('getting incorrect module name'), null);
    }

    this.moduleDB.serialize(function() {
      this.moduleDB.get("SELECT * FROM module_info WHERE name = ?", name, callback);
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

  init: function(modulePath) {
    var moduleDBName;

    moduleDBName = modulePath + '/countinghouse-modules.db';

    this.moduleDB = new sqlite3.Database(moduleDBName);

    this.moduleDB.serialize(function() {
      this.moduleDB.run("CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)");
    }.bind(this));
  }
};
