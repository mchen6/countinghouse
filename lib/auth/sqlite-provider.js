'use strict';
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

const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const LOG     = require('../logger');
const AuthProvider = require('./provider');

function SqliteAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  this.dbPath = opts.dbPath || (`${process.cwd()}/auth.sqlite3`);
  // #364: the open and the schema are one `ready`, and every method waits on
  // it. A database that can't be opened, or whose schema can't be made, fails
  // closed: each call answers SYSTEM_ERROR_USERDB_NA, at once. Before, either
  // was an 'error' event with no listener: the process died, or (under
  // framework.js's uncaughtException handler) every auth call waited forever.
  this.failed = null;   // the error that made the database unusable
  let opened;
  if (opts.db != null) {
    this.db = opts.db;
    opened = Promise.resolve();
  } else {
    const Database = requireSqlite3(
      '--authProvider sqlite',
      'use --authProvider file (the default), which needs no native modules at all; '  +
      'see docs/authentication.md'
    ).Database;
    // the database holds API keys in the clear: used only as this user's own
    // file, owner-only, and made so when it is not there (after sqlite3
    // loads: no file left by a start that can't run); anything else refuses
    // the start (exit 2), naming the fix (B-meter-keys 4r)
    const problem = require('./private-store').preparedStore(this.dbPath, 'the sqlite auth database');
    if (problem != null) throw Object.assign(new Error(problem), {code: 'AUTH_CONFIG_INVALID'});
    opened = new Promise((resolve, reject) => {
      this.db = new Database(this.dbPath, (err) => (err != null ? reject(err) : resolve()));
    });
  }
  // a database error at any time (the open's, a statement's with no
  // callback, a late one) is logged and marks the provider failed: never
  // thrown
  this.db.on('error', (err) => this._fail(err));
  // the schema is queued now, as before (sqlite3 holds statements until the
  // open is done), so a statement anyone queues on this.db after construction
  // still follows it; ready is both
  this.ready = Promise.all([opened, this._ensureSchema()]).then(() => undefined).catch((err) => {
    this._fail(err);
    throw unavailable(err);
  });
  this.ready.catch(() => {});   // answered per call; never an unhandled rejection
}

// The fail-closed answer: the code only, never the database's path.
function unavailable(err) {
  const code = (err != null && typeof(err.code) === 'string') ? err.code : 'error';
  return new CountinghouseError('SYSTEM_ERROR_USERDB_NA', `the sqlite auth database is unusable (${code.slice(0, 40)})`);
}

require('util').inherits(SqliteAuthProvider, AuthProvider);

// Marked unusable, once, with a line in the log.
SqliteAuthProvider.prototype._fail = function(err) {
  if (this.failed != null) return;
  this.failed = err || new Error('unknown');
  const code = (err != null && typeof(err.code) === 'string') ? err.code : 'error';
  try { LOG.E(new Error(`SqliteAuthProvider: the auth database is unusable (${code}); every auth call is refused SYSTEM_ERROR_USERDB_NA until the runtime restarts`)); } catch (e) { /* no logger */ }
};

// fn once the database is ready; else callback(SYSTEM_ERROR_USERDB_NA).
// Called outside the promise, so a throw in a callback is the caller's.
SqliteAuthProvider.prototype._whenReady = function(callback, fn) {
  this.ready.then(() => {
    if (this.failed != null) return process.nextTick(callback, unavailable(this.failed));
    return process.nextTick(fn);
  }, (err) => process.nextTick(callback, err));
};

// -> a Promise: every statement with its callback, in one serialized queue;
// the first failure rejects (an ALTER's "duplicate column" is the migration
// already made, not one).
SqliteAuthProvider.prototype._ensureSchema = function() {
  const db = this.db;
  const statements = [
    ['CREATE TABLE IF NOT EXISTS users (apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)'],
    ['CREATE TABLE IF NOT EXISTS user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))'],
    ['CREATE TABLE IF NOT EXISTS module_identities (moduleName TEXT PRIMARY KEY, apiKey TEXT NOT NULL)'],
    // Migration for a users table created before the admin column existed
    // -- CREATE TABLE IF NOT EXISTS above is a no-op against an
    // already-existing table. Unconditional ALTER TABLE + the "duplicate
    // column" error taken as done, rather than PRAGMA table_info + a
    // conditional ALTER: this stays inside db.serialize()'s statement queue.
    // (Every method now waits on `ready` too.)
    ['ALTER TABLE users ADD COLUMN admin INTEGER DEFAULT 0', /duplicate column name/i],
    // The stable id (R2-1, lib/identity.js): a nullable column, unique where
    // set, added the same way; a database from before gets it empty, so
    // every user keeps falling back to their key.
    ['ALTER TABLE users ADD COLUMN id TEXT', /duplicate column/i],
    // In the same queue, so it follows the column.
    ['CREATE UNIQUE INDEX IF NOT EXISTS users_id ON users (id) WHERE id IS NOT NULL']
  ];
  return new Promise((resolve, reject) => {
    let left = statements.length;
    let failed = false;
    db.serialize(() => {
      for (const [sql, done] of statements) {
        db.run(sql, (err) => {
          if (failed) return;
          if (err != null && !(done != null && done.test(err.message))) {
            failed = true;
            return reject(err);
          }
          if (--left === 0) resolve();
          return undefined;
        });
      }
    });
  });
};

// Every user, for the identity index (lib/identity.js).
SqliteAuthProvider.prototype.entries = function(callback) {
  this._whenReady(callback, () => this.db.all('SELECT apiKey, userName, admin, id FROM users', [], (err, rows) => {
    if (err) return callback(err);
    return callback(null, rows.map((r) => ({apiKey: r.apiKey, userName: r.userName, isAdmin: r.admin === 1, id: r.id != null ? r.id : undefined})));
  }));
};

// Every device ID a grant names, '*' aside, in one query: no key, no user
// (lib/pre-8-device-ids.js, removed after release 1).
SqliteAuthProvider.prototype.grantedDeviceIDs = function(callback) {
  this._whenReady(callback, () => this.db.all("SELECT DISTINCT deviceID FROM user_devices WHERE deviceID <> '*'", [], (err, rows) => {
    if (err) return callback(err);
    return callback(null, rows.map((r) => r.deviceID));
  }));
};

SqliteAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  const _this = this;

  if (apiKey == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER')});

  return this._whenReady(callback, () => this.db.get('SELECT userName, admin FROM users WHERE apiKey = ?', [apiKey], (err, userRow) => {
    if (err) return callback(err);
    if (userRow == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER')});

    const isAdmin = userRow.admin === 1;

    if (deviceID == null) {
      return callback(null, {ok: true, userName: userRow.userName, isAdmin: isAdmin, err: null});
    }

    _this.db.get('SELECT 1 FROM user_devices WHERE apiKey = ? AND (deviceID = ? OR deviceID = ?)', [apiKey, deviceID, '*'], (err, deviceRow) => {
      if (err) return callback(err);
      if (deviceRow == null) return callback(null, {ok: false, userName: userRow.userName, isAdmin: isAdmin, err: new CountinghouseError('USER_HAS_NO_DEVICE')});
      return callback(null, {ok: true, userName: userRow.userName, isAdmin: isAdmin, err: null});
    });
  }));
};

SqliteAuthProvider.prototype.listDevices = function(apiKey, callback) {
  if (apiKey == null) return callback(null, {devices: []});

  return this._whenReady(callback, () => this.db.all('SELECT deviceID FROM user_devices WHERE apiKey = ?', [apiKey], (err, rows) => {
    if (err) return callback(err);
    return callback(null, {devices: rows.map((r) => { return r.deviceID; })});
  }));
};

// moduleName is the PRIMARY KEY, so the two-claimants case the file provider
// has to detect by scanning cannot arise here -- the insert fails instead.
// `conflicts` is still part of the returned shape so both providers answer
// identically.
// Nothing to reload: every authenticate/listDevices call queries the database.
SqliteAuthProvider.prototype.reload = function(callback) {
  return callback(null, {ok: true, entries: null, changed: 0, note: 'sqlite reads its database on every call; nothing to reload'});
};

SqliteAuthProvider.prototype.identityForModule = function(moduleName, callback) {
  if (moduleName == null) return callback(null, {apiKey: null, conflicts: null});

  return this._whenReady(callback, () => this.db.get('SELECT apiKey FROM module_identities WHERE moduleName = ?', [moduleName], (err, row) => {
    if (err) return callback(err);
    if (row == null) return callback(null, {apiKey: null, conflicts: null});
    return callback(null, {apiKey: row.apiKey, conflicts: null});
  }));
};

module.exports = SqliteAuthProvider;
