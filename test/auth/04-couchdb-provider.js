var CouchDBAuthProvider = require('../../lib/couchdb-adapter/couchdb-auth-provider');

// CouchDBAuthProvider needs a real CouchDB instance (nano isn't even a
// package.json dependency anymore -- see couchdb-auth-provider.js's
// header comment) -- this environment doesn't have one (confirmed during
// the userAuth investigation this whole AuthProvider refactor grew out
// of), so this test skips gracefully rather than failing, both when
// "nano" itself isn't installed and when it is but no CouchDB is
// reachable at the configured --dbUrl. Run lib/couchdb-adapter/init-db.js
// against a real instance first to exercise this for real.
describe('auth 04: CouchDBAuthProvider (skips without a reachable CouchDB instance)', function() {
  this.timeout(5000);
  var provider;

  before(function(done) {
    var dbUrl = process.env.COUCHDB_TEST_URL || 'http://admin:12345678@127.0.0.1:5984';

    try {
      provider = new CouchDBAuthProvider({dbUrl: dbUrl});
    } catch (e) {
      console.log('auth 04: skipping, CouchDBAuthProvider unavailable: ' + e.message);
      return this.skip();
    }

    provider.usersDB.info(function(err) {
      if (err) {
        console.log('auth 04: skipping, CouchDB not reachable at ' + dbUrl + ': ' + err.message);
        return this.skip();
      }
      return done();
    }.bind(this));
  });

  it('authenticate() denies an unknown apiKey against a reachable CouchDB', function(done) {
    provider.authenticate('definitely-not-a-real-key-' + Date.now(), 'some-device-id', null, null, function(err, result) {
      if (err) return done(err);
      if (result.ok !== false) return done(new Error('expected ok:false for an unknown apiKey, got: ' + JSON.stringify(result)));
      done();
    });
  });

  it('listDevices() returns an empty list for an unknown apiKey', function(done) {
    provider.listDevices('definitely-not-a-real-key-' + Date.now(), function(err, result) {
      if (err) return done(err);
      if (!Array.isArray(result.devices) || result.devices.length !== 0) {
        return done(new Error('expected an empty devices list, got: ' + JSON.stringify(result)));
      }
      done();
    });
  });
});
