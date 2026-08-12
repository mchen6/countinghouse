var fs = require('fs');

// sqlite3 ships a prebuilt native binding, and the prebuild for current
// versions is linked against a newer glibc than some supported hosts have
// (observed: the prebuilt node_sqlite3.node needs GLIBC_2.38, Ubuntu 22.04
// has 2.35 -- it fails with ERR_DLOPEN_FAILED). Requiring it at the top of
// this file made that abort the *entire* mocha invocation, taking ~90
// unrelated tests in this directory down with it, on a host where the
// quickstart itself works perfectly well (framework.js already avoids
// loading sqlite3 unless the registry DB is actually needed, and the
// AuthProvider only loads it for --authProvider sqlite).
//
// So: load it defensively and skip *this file* with a loud reason if the
// binding won't load. Deliberately narrow -- only a native-binding load
// failure skips; any other error still throws, because "sqlite3 is broken
// here" and "SqliteAuthProvider is broken" must not look alike.
var SqliteAuthProvider = null;
var sqliteLoadError    = null;
try {
  SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
} catch (e) {
  if (e.code === 'ERR_DLOPEN_FAILED' || /GLIBC|\.node|bindings/i.test(e.message)) {
    sqliteLoadError = e;
  } else {
    throw e;
  }
}

// Pure unit tests, no server -- SqliteAuthProvider instantiated directly,
// same style as 02-file-provider-unit.js. Covers the users/user_devices
// schema, wildcard device grants, and that bin/countinghouse-auth-sqlite.js
// (a separate manual smoke-test, not re-run here) writes rows this
// provider actually reads.
(sqliteLoadError != null ? describe.skip : describe)(
  'auth 03: SqliteAuthProvider (users/user_devices schema)' +
  (sqliteLoadError != null
    ? ' [SKIPPED: sqlite3 native binding will not load on this host -- ' +
      sqliteLoadError.message.split('\n')[0] +
      '. The sqlite AuthProvider backend and bin/countinghouse-auth-sqlite.js ' +
      'are unusable here; the file and couchdb backends are unaffected.]'
    : ''),
  function() {
  var dbPath = '/tmp/countinghouse-test-auth-03-' + process.pid + '.sqlite3';

  beforeEach(function() {
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  afterEach(function() {
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  function assertOk(err, result, msg) {
    if (err) throw err;
    if (result.ok !== true) throw new Error((msg || 'expected ok:true') + ', got: ' + JSON.stringify(result));
  }

  function assertDenied(err, result, expectedCode, msg) {
    if (err) throw err;
    if (result.ok !== false) throw new Error((msg || 'expected ok:false') + ', got: ' + JSON.stringify(result));
    if (expectedCode != null && (result.err == null || result.err.code !== expectedCode)) {
      throw new Error('expected err.code ' + expectedCode + ', got: ' + JSON.stringify(result));
    }
  }

  it('creates the users/user_devices schema on first use and starts empty', function(done) {
    var provider = new SqliteAuthProvider({dbPath: dbPath});
    provider.authenticate('nobody', 'some-device', null, null, function(err, result) {
      assertDenied(err, result, 'SYSTEM_ERROR_UNKNOWN_USER', 'a fresh db should authorize nobody');
      done();
    });
  });

  it('authenticate: denies an unknown apiKey, denies a known key for an ungranted device, allows a granted device', function(done) {
    var provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(function() {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['scoped-key', 'scoped-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['scoped-key', 'device-a']);
    });

    provider.authenticate('scoped-key', 'device-b', null, null, function(err, result) {
      assertDenied(err, result, 'USER_HAS_NO_DEVICE', 'scoped-key should be denied device-b (not granted)');

      provider.authenticate('scoped-key', 'device-a', null, null, function(err, result) {
        assertOk(err, result, 'scoped-key should be allowed device-a (granted)');

        provider.authenticate('unknown-key', 'device-a', null, null, function(err, result) {
          assertDenied(err, result, 'SYSTEM_ERROR_UNKNOWN_USER', 'unknown-key should be denied outright');
          done();
        });
      });
    });
  });

  it('a "*" device grant authorizes every deviceID, same convention as FileAuthProvider', function(done) {
    var provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(function() {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['wildcard-key', 'wildcard-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['wildcard-key', '*']);
    });

    provider.authenticate('wildcard-key', 'literally-any-device-id', null, null, function(err, result) {
      assertOk(err, result, 'a "*" grant should authorize any deviceID');
      done();
    });
  });

  it('admin column defaults to false and is independent of device grants', function(done) {
    var provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(function() {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['plain-key', 'plain-user']);
      provider.db.run('INSERT INTO users (apiKey, userName, admin) VALUES (?, ?, ?)', ['admin-key', 'admin-user', 1]);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['admin-key', 'device-a']);
    });

    provider.authenticate('plain-key', null, null, null, function(err, result) {
      assertOk(err, result, 'plain-key should authenticate');
      if (result.isAdmin !== false) throw new Error('a user row with no explicit admin value must default to isAdmin:false, got: ' + JSON.stringify(result));

      provider.authenticate('admin-key', 'device-b', null, null, function(err, result) {
        assertDenied(err, result, 'USER_HAS_NO_DEVICE', 'admin-key should still be denied a device it is not granted');
        if (result.isAdmin !== true) throw new Error('admin:1 must set isAdmin:true even when the device-ownership check itself fails, got: ' + JSON.stringify(result));
        done();
      });
    });
  });

  it('migrates a pre-existing db file created before the admin column existed', function(done) {
    // Simulates an operator's real auth.sqlite3 from before this feature
    // shipped: users/user_devices tables exist, but users has no admin
    // column at all -- not just unset rows. _ensureSchema's ALTER TABLE
    // must add it without losing the existing row, and immediately
    // (calling authenticate() with zero delay is the actual regression
    // this guards: a naive PRAGMA-table_info-then-conditional-ALTER
    // implementation can lose that race against an immediate call).
    var sqlite3 = require('sqlite3');
    var rawDb = new sqlite3.Database(dbPath);
    rawDb.serialize(function() {
      rawDb.run('CREATE TABLE users (apiKey TEXT PRIMARY KEY, userName TEXT)');
      rawDb.run('CREATE TABLE user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
      rawDb.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['legacy-key', 'legacy-user'], function() {
        rawDb.close(function() {
          var provider = new SqliteAuthProvider({dbPath: dbPath});
          // No setTimeout/delay -- immediate call is the point of this test.
          provider.authenticate('legacy-key', null, null, null, function(err, result) {
            assertOk(err, result, 'legacy-key from a pre-migration db should still authenticate');
            if (result.isAdmin !== false) throw new Error('a migrated row with no admin value must default to isAdmin:false, got: ' + JSON.stringify(result));
            done();
          });
        });
      });
    });
  });

  it('listDevices returns exactly the granted rows for an apiKey', function(done) {
    var provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(function() {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['multi-key', 'multi-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['multi-key', 'device-a']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['multi-key', 'device-b']);
    });

    provider.listDevices('multi-key', function(err, result) {
      if (err) return done(err);
      var devices = result.devices.slice().sort();
      if (JSON.stringify(devices) !== JSON.stringify(['device-a', 'device-b'])) {
        return done(new Error('expected [device-a, device-b], got: ' + JSON.stringify(devices)));
      }
      done();
    });
  });
});
