// Second built-in AuthProvider implementation (see provider.js): sqlite3,
// reusing the dependency this repo already has (package.json's sqlite3,
// used elsewhere for the device-db module manager) rather than adding a
// new one. Two tables:
//
//   users(apiKey TEXT PRIMARY KEY, userName TEXT)
//   user_devices(apiKey TEXT, deviceID TEXT, PRIMARY KEY (apiKey, deviceID))
//
// deviceID may be the literal string "*" to mean "every device" -- same
// wildcard convention FileAuthProvider uses, for consistency across
// providers. Runtime add/remove is a separate CLI
// (bin/countinghouse-auth-sqlite.js), not an HTTP admin endpoint -- an
// endpoint for managing *who can authenticate* would itself need
// authenticating, which is circular complexity this doesn't need; a CLI
// against the db file directly is simpler and matches how auth.json is
// already just hand-edited for FileAuthProvider.
var sqlite3 = require('sqlite3');
var CHError = require('../countinghouse-error').CHError;
var AuthProvider = require('./provider');

function SqliteAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.dbPath = opts.dbPath || (process.cwd() + '/auth.sqlite3');
  this.db = opts.db || new sqlite3.Database(this.dbPath);
  this._ensureSchema();
}

require('util').inherits(SqliteAuthProvider, AuthProvider);

SqliteAuthProvider.prototype._ensureSchema = function() {
  var db = this.db;
  db.serialize(function() {
    db.run('CREATE TABLE IF NOT EXISTS users (apiKey TEXT PRIMARY KEY, userName TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
  });
};

SqliteAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  var _this = this;

  if (apiKey == null) return callback(null, {ok: false, userName: null, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

  this.db.get('SELECT userName FROM users WHERE apiKey = ?', [apiKey], function(err, userRow) {
    if (err) return callback(err);
    if (userRow == null) return callback(null, {ok: false, userName: null, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

    if (deviceID == null) {
      return callback(null, {ok: true, userName: userRow.userName, err: null});
    }

    _this.db.get('SELECT 1 FROM user_devices WHERE apiKey = ? AND (deviceID = ? OR deviceID = ?)', [apiKey, deviceID, '*'], function(err, deviceRow) {
      if (err) return callback(err);
      if (deviceRow == null) return callback(null, {ok: false, userName: userRow.userName, err: new CHError('USER_HAS_NO_DEVICE')});
      return callback(null, {ok: true, userName: userRow.userName, err: null});
    });
  });
};

SqliteAuthProvider.prototype.listDevices = function(apiKey, callback) {
  if (apiKey == null) return callback(null, {devices: []});

  this.db.all('SELECT deviceID FROM user_devices WHERE apiKey = ?', [apiKey], function(err, rows) {
    if (err) return callback(err);
    return callback(null, {devices: rows.map(function(r) { return r.deviceID; })});
  });
};

module.exports = SqliteAuthProvider;
