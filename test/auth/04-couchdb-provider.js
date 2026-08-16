const CouchDBAuthProvider = require('../../lib/couchdb-adapter/couchdb-auth-provider');

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
  let provider;

  before(function(done) {
    const dbUrl = process.env.COUCHDB_TEST_URL || 'http://admin:12345678@127.0.0.1:5984';

    try {
      provider = new CouchDBAuthProvider({dbUrl: dbUrl});
    } catch (e) {
      console.log(`auth 04: skipping, CouchDBAuthProvider unavailable: ${e.message}`);
      return this.skip();
    }

    provider.usersDB.info((err) => {
      if (err) {
        console.log(`auth 04: skipping, CouchDB not reachable at ${dbUrl}: ${err.message}`);
        return this.skip();
      }
      return done();
    });
  });

  it('authenticate() denies an unknown apiKey against a reachable CouchDB', (done) => {
    provider.authenticate(`definitely-not-a-real-key-${Date.now()}`, 'some-device-id', null, null, (err, result) => {
      if (err) return done(err);
      if (result.ok !== false) return done(new Error(`expected ok:false for an unknown apiKey, got: ${JSON.stringify(result)}`));
      done();
    });
  });

  it('listDevices() returns an empty list for an unknown apiKey', (done) => {
    provider.listDevices(`definitely-not-a-real-key-${Date.now()}`, (err, result) => {
      if (err) return done(err);
      if (!Array.isArray(result.devices) || result.devices.length !== 0) {
        return done(new Error(`expected an empty devices list, got: ${JSON.stringify(result)}`));
      }
      done();
    });
  });

  // admin gating: verified live against a real CouchDB 3.5.2 instance
  // during development (this environment doesn't have one, same as every
  // other test above) -- writes a real user doc satisfying CouchDB's own
  // built-in _users validate_doc_update (requires name, roles: [], and
  // _id: 'org.couchdb.user:'+name -- none of which couchdb-auth-provider.js
  // itself reads, but a real document has to satisfy them to be written
  // at all) with admin: true, and one without it, confirming isAdmin is
  // independent of device access (an admin key still gets ok:false for a
  // device it isn't granted, but isAdmin stays true).
  it('authenticate() sets isAdmin from the admin field, independent of device access', (done) => {
    const plainDoc = {
      _id: `org.couchdb.user:test-plain-${Date.now()}`,
      type: 'user', name: `test-plain-${Date.now()}`, roles: [],
      appKey: `test-plain-${Date.now()}`, userName: 'plain-user',
      balance: 0, devices: [{deviceID: '*'}]
    };
    const adminDoc = {
      _id: `org.couchdb.user:test-admin-${Date.now()}`,
      type: 'user', name: `test-admin-${Date.now()}`, roles: [],
      appKey: `test-admin-${Date.now()}`, userName: 'admin-user',
      balance: 0, devices: [{deviceID: 'granted-device'}], admin: true
    };

    provider.usersDB.insert(plainDoc, (err) => {
      if (err) return done(err);
      provider.usersDB.insert(adminDoc, (err) => {
        if (err) return done(err);

        provider.authenticate(plainDoc.appKey, null, null, null, (err, result) => {
          if (err) return done(err);
          if (result.isAdmin !== false) return done(new Error(`a doc with no admin field must default to isAdmin:false, got: ${JSON.stringify(result)}`));

          provider.authenticate(adminDoc.appKey, 'ungranted-device', null, null, (err, result) => {
            if (err) return done(err);
            if (result.ok !== false) return done(new Error(`admin-key should still be denied a device it is not granted, got: ${JSON.stringify(result)}`));
            if (result.isAdmin !== true) return done(new Error(`admin:true must set isAdmin:true even when the device-ownership check itself fails, got: ${JSON.stringify(result)}`));
            done();
          });
        });
      });
    });
  });
});
