// sqlite3 is an optionalDependency, required lazily -- see
// lib/optional-sqlite3.js. framework.js already skips requiring this file
// at all unless the registry DB is actually needed (i.e. no --loadModule
// was given), so the documented quickstart path never reaches this.
const sqlite3 = require('./optional-sqlite3').requireSqlite3(
  'The module registry database',
  'start with --loadModule <path> to load modules from disk, which does not use the registry DB'
);

module.exports = {
  setModuleInfo: function(name, version, path, deviceList, callback) {
    if (name == null) {
      return callback(new Error('setting incorrect module name'), null);
    }

    this.moduleDB.serialize(() => {
      this.moduleDB.run("INSERT OR REPLACE INTO module_info(name, version, path, deviceList) VALUES (?, ?, ?, ?)",
      name, version, path, deviceList, callback);
    });
  },

  getModuleInfo: function(name, callback) {
    if (name == null) {
      return callback(new Error('getting incorrect module name'), null);
    }

    this.moduleDB.serialize(() => {
      this.moduleDB.get("SELECT * FROM module_info WHERE name = ?", name, callback);
    });
  },

  removeModuleInfo: function(name, callback) {
    if (name == null) {
      return callback(new Error('remove incorrect module name'), null);
    }

    this.moduleDB.serialize(() => {
      this.moduleDB.run("DELETE FROM module_info WHERE name = ?", name, callback);
    });
  },

  getAllModuleInfo: function(callback) {
    this.moduleDB.parallelize(() => {
      this.moduleDB.all("SELECT * FROM module_info", callback);
    });
  },

  init: function(modulePath) {
    const moduleDBName = `${modulePath}/countinghouse-modules.db`;

    this.moduleDB = new sqlite3.Database(moduleDBName);

    this.moduleDB.serialize(() => {
      this.moduleDB.run("CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)");
    });
  }
};
