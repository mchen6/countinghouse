// Second built-in AuthProvider implementation (see provider.js): sqlite3,
// reusing the dependency this repo already has (package.json's sqlite3,
// used elsewhere for the device-db module manager) rather than adding a
// new one. Two tables:
//
//   users(apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)
//   user_devices(apiKey TEXT, deviceID TEXT, PRIMARY KEY (apiKey, deviceID))
//
// deviceID may be the literal string "*" to mean "every device" -- same
// wildcard convention FileAuthProvider uses, for consistency across
// providers. `admin` (0/1) gates the module-lifecycle routes
// (lib/routes/admin-only.js), independent of device grants. Runtime
// add/remove is a separate CLI (bin/countinghouse-auth-sqlite.js), not an
// HTTP admin endpoint -- an endpoint for managing *who can authenticate*
// would itself need authenticating, which is circular complexity this
// doesn't need; a CLI against the db file directly is simpler and matches
// how auth.json is already just hand-edited for FileAuthProvider.
// sqlite3 is an optionalDependency and is required lazily -- see
// lib/optional-sqlite3.js for why (the prebuilt native binding needs a
// newer glibc than some supported hosts have, so it can fail at require
// time even after a successful install) and for the message shape.
const requireSqlite3 = require('../optional-sqlite3').requireSqlite3;

const CHError = require('../countinghouse-error').CHError;
const LOG     = require('../logger');
const AuthProvider = require('./provider');

function SqliteAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.dbPath = opts.dbPath || (`${process.cwd()}/auth.sqlite3`);
  this.db = opts.db || new (requireSqlite3(
    '--authProvider sqlite',
    'use --authProvider file (the default), which needs no native modules at all; '  +
    'see docs/authentication.md'
  ).Database)(this.dbPath);
  this._ensureSchema();
}

require('util').inherits(SqliteAuthProvider, AuthProvider);

SqliteAuthProvider.prototype._ensureSchema = function() {
  const db = this.db;
  db.serialize(() => {
    db.run('CREATE TABLE IF NOT EXISTS users (apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
    db.run('CREATE TABLE IF NOT EXISTS module_identities (moduleName TEXT PRIMARY KEY, apiKey TEXT NOT NULL)');
    // Migration for a users table created before the admin column existed
    // -- CREATE TABLE IF NOT EXISTS above is a no-op against an
    // already-existing table. Unconditional ALTER TABLE + swallow the
    // "duplicate column" error, rather than PRAGMA table_info + a
    // conditional ALTER: this stays inside db.serialize()'s synchronous
    // statement queue, so it's guaranteed to run before any authenticate()
    // call issued right after construction. A PRAGMA's own callback fires
    // async -- a conditional ALTER queued from inside it could lose that
    // race against an immediate authenticate() call.
    db.run('ALTER TABLE users ADD COLUMN admin INTEGER DEFAULT 0', (err) => {
      if (err != null && !/duplicate column name/i.test(err.message)) {
        LOG.E(new Error(`SqliteAuthProvider: failed to migrate admin column: ${err.message}`));
      }
    });
  });
};

SqliteAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  const _this = this;

  if (apiKey == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

  this.db.get('SELECT userName, admin FROM users WHERE apiKey = ?', [apiKey], (err, userRow) => {
    if (err) return callback(err);
    if (userRow == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

    const isAdmin = userRow.admin === 1;

    if (deviceID == null) {
      return callback(null, {ok: true, userName: userRow.userName, isAdmin: isAdmin, err: null});
    }

    _this.db.get('SELECT 1 FROM user_devices WHERE apiKey = ? AND (deviceID = ? OR deviceID = ?)', [apiKey, deviceID, '*'], (err, deviceRow) => {
      if (err) return callback(err);
      if (deviceRow == null) return callback(null, {ok: false, userName: userRow.userName, isAdmin: isAdmin, err: new CHError('USER_HAS_NO_DEVICE')});
      return callback(null, {ok: true, userName: userRow.userName, isAdmin: isAdmin, err: null});
    });
  });
};

SqliteAuthProvider.prototype.listDevices = function(apiKey, callback) {
  if (apiKey == null) return callback(null, {devices: []});

  this.db.all('SELECT deviceID FROM user_devices WHERE apiKey = ?', [apiKey], (err, rows) => {
    if (err) return callback(err);
    return callback(null, {devices: rows.map((r) => { return r.deviceID; })});
  });
};

// moduleName is the PRIMARY KEY, so the two-claimants case the file provider
// has to detect by scanning cannot arise here -- the insert fails instead.
// `conflicts` is still part of the returned shape so both providers answer
// identically.
SqliteAuthProvider.prototype.identityForModule = function(friendlyName, callback) {
  if (friendlyName == null) return callback(null, {apiKey: null, conflicts: null});

  this.db.get('SELECT apiKey FROM module_identities WHERE moduleName = ?', [friendlyName], (err, row) => {
    if (err) return callback(err);
    if (row == null) return callback(null, {apiKey: null, conflicts: null});
    return callback(null, {apiKey: row.apiKey, conflicts: null});
  });
};

module.exports = SqliteAuthProvider;
