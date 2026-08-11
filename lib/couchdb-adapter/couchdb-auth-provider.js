// CouchDBAuthProvider: wraps the CouchDB-backed authentication logic that
// used to live inline in lib/user-auth.js (before the AuthProvider
// refactor -- see docs/cdif-audit-and-refactoring-plan.md's AuthProvider
// section) as a pluggable AuthProvider (lib/auth/provider.js)
// implementation. This is the only place in the repo that still needs a
// real CouchDB instance -- nano is deliberately NOT a package.json
// dependency anymore, it's required lazily below, only when this
// provider is actually selected (--authProvider couchdb).
//
// Behavior mirrors the original doUserAuth's non-debug branch: `_users`
// db (CouchDB's own reserved system db name, reused for application user
// records -- a pre-existing quirk this port doesn't change), view
// `user`/`byAppKeyWithBasicInfo`, `key: apiKey`, value = [userName,
// balance, devices, admin] where devices = [{deviceID, priceRecord}, ...]
// -- see lib/couchdb-adapter/init-db.js for the from-scratch design-doc
// that produces this shape. balance/priceRecord are read but not part of
// authenticate()'s result -- that's MeteringProvider's domain now, not
// AuthProvider's (see provider.js's header comment). `admin` (the 4th
// tuple element, may be undefined/null for a document predating this
// field or one that never set it -- treated as not-admin either way) is
// part of the result: it gates the module-lifecycle routes
// (lib/routes/admin-only.js), independent of device access.
//
// A small in-process cache (never expires, restart to pick up changes)
// avoids hitting CouchDB on every single call -- the original had a
// similar goal via a shared Redis cache, but AuthProvider is
// deliberately independent of MeteringProvider's Redis usage now (see
// docs/cross-cutting-matrix.md), so this uses a plain in-memory map
// instead, matching how FileAuthProvider/SqliteAuthProvider already
// treat their own config as static-until-restart.
function requireNano() {
  try {
    return require('nano');
  } catch (e) {
    throw new Error('CouchDBAuthProvider requires the "nano" package, which is not installed. Run: npm install nano');
  }
}

var CHError = require('../countinghouse-error').CHError;
var AuthProvider = require('../auth/provider');

function CouchDBAuthProvider(opts) {
  AuthProvider.call(this);
  opts = opts || {};

  var nano = requireNano();
  this.dbUrl = opts.dbUrl || 'http://admin:12345678@127.0.0.1:5984';
  this.usersDB = nano(this.dbUrl).db.use('_users');

  this._cache = {}; // apiKey -> {userName, devices, admin}
}

require('util').inherits(CouchDBAuthProvider, AuthProvider);

CouchDBAuthProvider.prototype._lookup = function(apiKey, callback) {
  if (apiKey == null) return callback(null, null);
  if (this._cache[apiKey] != null) return callback(null, this._cache[apiKey]);

  this.usersDB.view('user', 'byAppKeyWithBasicInfo', {key: apiKey}, function(err, doc) {
    if (err) return callback(err);
    if (doc.rows.length === 0) return callback(null, null);

    var userName    = doc.rows[0].value[0];
    var devicesRaw  = doc.rows[0].value[2];
    var adminRaw    = doc.rows[0].value[3];
    var devices = [];
    if (Array.isArray(devicesRaw)) {
      devices = devicesRaw.map(function(d) { return d.deviceID; });
    }

    var entry = {userName: userName, devices: devices, admin: adminRaw === true};
    this._cache[apiKey] = entry;
    return callback(null, entry);
  }.bind(this));
};

CouchDBAuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  this._lookup(apiKey, function(err, entry) {
    if (err) return callback(err);
    if (entry == null) return callback(null, {ok: false, userName: null, isAdmin: false, err: new CHError('SYSTEM_ERROR_UNKNOWN_USER', apiKey)});

    if (deviceID != null) {
      // '*' wildcard grant: not part of the original CouchDB schema, but
      // supported here for consistency with FileAuthProvider/
      // SqliteAuthProvider (see lib/couchdb-adapter/init-db.js's header
      // comment) -- harmless if no document ever uses it.
      var hasDevice = entry.devices.indexOf('*') !== -1 || entry.devices.indexOf(deviceID) !== -1;
      if (hasDevice !== true) return callback(null, {ok: false, userName: entry.userName, isAdmin: entry.admin, err: new CHError('USER_HAS_NO_DEVICE')});
    }

    return callback(null, {ok: true, userName: entry.userName, isAdmin: entry.admin, err: null});
  });
};

CouchDBAuthProvider.prototype.listDevices = function(apiKey, callback) {
  this._lookup(apiKey, function(err, entry) {
    if (err) return callback(err);
    return callback(null, {devices: entry != null ? entry.devices : []});
  });
};

module.exports = CouchDBAuthProvider;
