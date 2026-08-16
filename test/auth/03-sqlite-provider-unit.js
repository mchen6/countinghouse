const fs = require('fs');

// sqlite3 ships a prebuilt native binding, and the prebuild for current
// versions is linked against a newer glibc than some supported hosts have
// (observed: it needs GLIBC_2.38, Ubuntu 22.04 has 2.35 -- ERR_DLOPEN_FAILED).
// This whole file is unrunnable on such a host, so it skips itself, loudly.
//
// The probe is `require('sqlite3')` directly, NOT "does requiring
// SqliteAuthProvider throw". It used to be the latter, which worked only
// while the provider required sqlite3 at module scope; once the provider was
// changed to require it lazily (so that a deployment not using this backend
// is unaffected by its absence), the provider module started loading fine on
// a host where sqlite3 cannot load, this guard stopped tripping, and these
// six tests failed instead of skipping. Probing the actual dependency is
// both simpler and immune to where the provider happens to require it.
let sqliteLoadError = null;
try {
  require('sqlite3');
} catch (e) {
  sqliteLoadError = e;
}

const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');

// Pure unit tests, no server -- SqliteAuthProvider instantiated directly,
// same style as 02-file-provider-unit.js. Covers the users/user_devices
// schema, wildcard device grants, and that bin/countinghouse-auth-sqlite.js
// (a separate manual smoke-test, not re-run here) writes rows this
// provider actually reads.
(sqliteLoadError != null ? describe.skip : describe)(
  `auth 03: SqliteAuthProvider (users/user_devices schema)${
  sqliteLoadError != null
    ? ` [SKIPPED: sqlite3 native binding will not load on this host -- ${
      sqliteLoadError.message.split('\n')[0]
      }. The sqlite AuthProvider backend and bin/countinghouse-auth-sqlite.js ` +
      `are unusable here; the file and couchdb backends are unaffected.]`
    : ''}`,
  () => {
  const dbPath = `/tmp/countinghouse-test-auth-03-${process.pid}.sqlite3`;

  beforeEach(() => {
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  function assertOk(err, result, msg) {
    if (err) throw err;
    if (result.ok !== true) throw new Error(`${msg || 'expected ok:true'}, got: ${JSON.stringify(result)}`);
  }

  function assertDenied(err, result, expectedCode, msg) {
    if (err) throw err;
    if (result.ok !== false) throw new Error(`${msg || 'expected ok:false'}, got: ${JSON.stringify(result)}`);
    if (expectedCode != null && (result.err == null || result.err.code !== expectedCode)) {
      throw new Error(`expected err.code ${expectedCode}, got: ${JSON.stringify(result)}`);
    }
  }

  it('creates the users/user_devices schema on first use and starts empty', (done) => {
    const provider = new SqliteAuthProvider({dbPath: dbPath});
    provider.authenticate('nobody', 'some-device', null, null, (err, result) => {
      assertDenied(err, result, 'SYSTEM_ERROR_UNKNOWN_USER', 'a fresh db should authorize nobody');
      done();
    });
  });

  it('authenticate: denies an unknown apiKey, denies a known key for an ungranted device, allows a granted device', (done) => {
    const provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(() => {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['scoped-key', 'scoped-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['scoped-key', 'device-a']);
    });

    provider.authenticate('scoped-key', 'device-b', null, null, (err, result) => {
      assertDenied(err, result, 'USER_HAS_NO_DEVICE', 'scoped-key should be denied device-b (not granted)');

      provider.authenticate('scoped-key', 'device-a', null, null, (err, result) => {
        assertOk(err, result, 'scoped-key should be allowed device-a (granted)');

        provider.authenticate('unknown-key', 'device-a', null, null, (err, result) => {
          assertDenied(err, result, 'SYSTEM_ERROR_UNKNOWN_USER', 'unknown-key should be denied outright');
          done();
        });
      });
    });
  });

  it('a "*" device grant authorizes every deviceID, same convention as FileAuthProvider', (done) => {
    const provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(() => {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['wildcard-key', 'wildcard-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['wildcard-key', '*']);
    });

    provider.authenticate('wildcard-key', 'literally-any-device-id', null, null, (err, result) => {
      assertOk(err, result, 'a "*" grant should authorize any deviceID');
      done();
    });
  });

  it('admin column defaults to false and is independent of device grants', (done) => {
    const provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(() => {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['plain-key', 'plain-user']);
      provider.db.run('INSERT INTO users (apiKey, userName, admin) VALUES (?, ?, ?)', ['admin-key', 'admin-user', 1]);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['admin-key', 'device-a']);
    });

    provider.authenticate('plain-key', null, null, null, (err, result) => {
      assertOk(err, result, 'plain-key should authenticate');
      if (result.isAdmin !== false) throw new Error(`a user row with no explicit admin value must default to isAdmin:false, got: ${JSON.stringify(result)}`);

      provider.authenticate('admin-key', 'device-b', null, null, (err, result) => {
        assertDenied(err, result, 'USER_HAS_NO_DEVICE', 'admin-key should still be denied a device it is not granted');
        if (result.isAdmin !== true) throw new Error(`admin:1 must set isAdmin:true even when the device-ownership check itself fails, got: ${JSON.stringify(result)}`);
        done();
      });
    });
  });

  it('migrates a pre-existing db file created before the admin column existed', (done) => {
    // Simulates an operator's real auth.sqlite3 from before this feature
    // shipped: users/user_devices tables exist, but users has no admin
    // column at all -- not just unset rows. _ensureSchema's ALTER TABLE
    // must add it without losing the existing row, and immediately
    // (calling authenticate() with zero delay is the actual regression
    // this guards: a naive PRAGMA-table_info-then-conditional-ALTER
    // implementation can lose that race against an immediate call).
    const sqlite3 = require('sqlite3');
    const rawDb = new sqlite3.Database(dbPath);
    rawDb.serialize(() => {
      rawDb.run('CREATE TABLE users (apiKey TEXT PRIMARY KEY, userName TEXT)');
      rawDb.run('CREATE TABLE user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
      rawDb.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['legacy-key', 'legacy-user'], () => {
        rawDb.close(() => {
          const provider = new SqliteAuthProvider({dbPath: dbPath});
          // No setTimeout/delay -- immediate call is the point of this test.
          provider.authenticate('legacy-key', null, null, null, (err, result) => {
            assertOk(err, result, 'legacy-key from a pre-migration db should still authenticate');
            if (result.isAdmin !== false) throw new Error(`a migrated row with no admin value must default to isAdmin:false, got: ${JSON.stringify(result)}`);
            done();
          });
        });
      });
    });
  });

  it('listDevices returns exactly the granted rows for an apiKey', (done) => {
    const provider = new SqliteAuthProvider({dbPath: dbPath});

    provider.db.serialize(() => {
      provider.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['multi-key', 'multi-user']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['multi-key', 'device-a']);
      provider.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['multi-key', 'device-b']);
    });

    provider.listDevices('multi-key', (err, result) => {
      if (err) return done(err);
      const devices = result.devices.slice().sort();
      if (JSON.stringify(devices) !== JSON.stringify(['device-a', 'device-b'])) {
        return done(new Error(`expected [device-a, device-b], got: ${JSON.stringify(devices)}`));
      }
      done();
    });
  });
});
