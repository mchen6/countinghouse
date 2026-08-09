var fs = require('fs');

var SqliteAuthProvider = require('../../lib/auth/sqlite-provider');

// Pure unit tests, no server -- SqliteAuthProvider instantiated directly,
// same style as 02-file-provider-unit.js. Covers the users/user_devices
// schema, wildcard device grants, and that bin/countinghouse-auth-sqlite.js
// (a separate manual smoke-test, not re-run here) writes rows this
// provider actually reads.
describe('auth 03: SqliteAuthProvider (users/user_devices schema)', function() {
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
