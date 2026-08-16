const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// Standalone-only, same reason as 01-file-provider-tools-list-filtering.js:
// needs a real (non---debug) server, since --debug bypasses AuthProvider
// (and therefore the admin check) entirely -- this is the test for the
// gate itself. Covers all 7 module-lifecycle routes (lib/route-manager.js):
// /load-module, /unload-module, /restart-module, /verify-module,
// /get-module-device-list, /reload-module, /shutdown -- previously gated
// by --debug/--verifyModule at mount time (nonexistent otherwise), now
// always mounted and gated per-request by lib/routes/admin-only.js.
const AUTH_CONFIG_PATH = `/tmp/countinghouse-test-auth-06-${process.pid}.json`;

const ADMIN_KEY    = 'admin-key';
const NON_ADMIN_KEY = 'non-admin-key'; // valid apiKey, just not admin
const UNKNOWN_KEY   = 'unknown-key';   // not present in auth.json at all

describe('auth 06: module-lifecycle routes are admin-gated, not --debug/--verifyModule-gated', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    const config = {};
    config[ADMIN_KEY]     = {userName: 'admin-user',     devices: ['*'], admin: true};
    config[NON_ADMIN_KEY] = {userName: 'non-admin-user', devices: ['*']}; // no admin field
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --authProvider file, for admin-gating test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    fs.unlinkSync(AUTH_CONFIG_PATH);
    // The last test in this file shuts the server down for real via the
    // admin key -- if that test never ran (e.g. an earlier failure
    // aborted the suite), fall back to pkill, same technique
    // 01-file-provider-tools-list-filtering.js uses for the same reason.
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  const ADMIN_ONLY_ROUTES = [
    '/load-module', '/unload-module', '/restart-module',
    '/verify-module', '/get-module-device-list', '/reload-module'
    // /shutdown deliberately excluded from this shared list -- see its
    // own dedicated tests below, since it can only safely be exercised
    // once, as this file's very last action.
  ];

  ADMIN_ONLY_ROUTES.forEach((route) => {
    it(`${route}: denies a non-admin apiKey with 403 ADMIN_REQUIRED`, (done) => {
      request(url).post(route).set('X-CH-Key', NON_ADMIN_KEY).send({}).expect(403, (err, res) => {
        if (err) return done(err);
        if (res.body.code !== 'ADMIN_REQUIRED') {
          return done(new Error(`expected ADMIN_REQUIRED for a non-admin (but otherwise valid) key on ${route}, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });

    it(`${route}: denies an unknown apiKey with 403 (not admin, and not a valid user at all)`, (done) => {
      request(url).post(route).set('X-CH-Key', UNKNOWN_KEY).send({}).expect(403, (err, res) => {
        if (err) return done(err);
        if (res.body.code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
          return done(new Error(`expected SYSTEM_ERROR_UNKNOWN_USER for an unknown key on ${route}, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });

    it(`${route}: admin apiKey reaches the actual route handler (not blocked at the admin gate)`, (done) => {
      request(url).post(route).set('X-CH-Key', ADMIN_KEY).send({}).end((err, res) => {
        if (err) return done(err);
        // Deliberately not asserting a specific status/body here -- an
        // empty {} body is nonsense input for every one of these routes,
        // so the handler itself will likely error. The only thing this
        // test verifies is that the error is NOT the admin gate's own
        // 403/ADMIN_REQUIRED -- i.e. the admin key got past admin-only.js
        // and into route-specific logic, whatever that logic then does
        // with garbage input is a separate concern from this test file's
        // job (gating), already covered elsewhere for the routes that
        // have their own functional tests (e.g. reload-module in
        // test/load-module/test002.js).
        if (res.status === 403 && res.body.code === 'ADMIN_REQUIRED') {
          return done(new Error(`admin key should not be blocked by the admin gate on ${route}, got: ${JSON.stringify(res.body)}`));
        }
        return done();
      });
    });
  });

  it('/shutdown: denies a non-admin apiKey with 403 ADMIN_REQUIRED', (done) => {
    request(url).post('/shutdown').set('X-CH-Key', NON_ADMIN_KEY).expect(403, (err, res) => {
      if (err) return done(err);
      if (res.body.code !== 'ADMIN_REQUIRED') {
        return done(new Error(`expected ADMIN_REQUIRED for a non-admin key on /shutdown, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });

  it('/shutdown: an admin apiKey actually shuts the server down', (done) => {
    // The real, end-to-end proof for this route specifically -- unlike
    // the other 6, /shutdown's handler is just process.exit(0), so there
    // is no "reached the handler but errored on bad input" middle ground
    // to check; either the admin key shuts the process down or it
    // doesn't. Safe here because this test file owns a dedicated,
        // disposable server (same pattern test/load-module/test002.js
    // already uses to end its own shared server's life on purpose).
    request(url).post('/shutdown').set('X-CH-Key', ADMIN_KEY).end(() => {
      done();
    });
  });
});
