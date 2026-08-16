const fs = require('fs');
const exec = require('child_process').exec;
const request = require('supertest');

const url = 'http://127.0.0.1:9527';

// docs/direct-peer-channels-design.md section 5, step 3's required test:
// "无权模块请求 brokering 被拒" (an unauthorized module's brokering request is
// rejected).
//
// Unlike 01-echo-roundtrip.js/02-invalidation-on-restart.js (loaded into
// test8.js's shared server), this needs its own dedicated server: testing
// denial requires echo-device-client-module's baked-in ServiceClient
// appKey ('aabbcc', see its device.js) to be *wrong* for the running
// server, which the shared --debugKey aabbcc server test8.js starts can
// never produce (aabbcc always matches there by construction). So this
// file spawns its own server with a mismatched --debugKey, self-contained
// like test1.js/test2.js are, and is run standalone --
// `npx mocha test/direct-peer-channels/03-grant-time-auth.js`.
// test8.js explicitly excludes this filename from its directory sweep for
// exactly this reason (found the hard way: without that exclusion, this
// file's own before()/after() collided with test8.js's own server spawn on
// the same port, producing a confusing unrelated-looking failure).
describe('direct-peer-channels 03: grant-time authorization (D3)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with a debugKey that does NOT match echo-device-client-module\'s baked-in appKey...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey not-aabbcc --directPeerChannels --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', (err, stdout, stderr) => { console.log(err); });
    // test1.js/test2.js's shared-server harness gets away with a 5000ms
    // wait here because their much larger describe tree (30+ nested test
    // files) adds enough of its own setup time before the first real HTTP
    // call fires; this file's single, immediate test doesn't have that
    // slack, and sequentially discovering 2 modules (each with its own
    // fixed ~5s discovery window, see sandbox.js's 'discover-device'
    // handling) can take longer than 5s in total on its own.
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    // /shutdown is now admin-gated (lib/routes/admin-only.js) -- this
    // server's --debugKey is the mismatched 'not-aabbcc' (the whole point
    // of this file), not the shared 'aabbcc' other standalone tests use.
    request(url).post('/shutdown').set('X-CH-Key', 'not-aabbcc').end(() => { done(); });
  });

  const ECHO_DEVICE_CLIENT_ID = 'efefb416-bdc0-54eb-96a9-38f96f52779d'; // echo-device-client-module

  it('denies brokering for a module whose ServiceClient appKey the running server does not recognize', (done) => {
    const t0 = Date.now();

    // the outer HTTP call itself must use the server's real debugKey
    // (not-aabbcc) to get past the ordinary invoke-action userAuth gate at
    // all -- what's being tested is the *inner* brokering check, which
    // uses echo-device-client-module's own hardcoded 'aabbcc' regardless
    // of what X-CH-Key this outer request carries.
    request(url).post(`/devices/${ECHO_DEVICE_CLIENT_ID}/invoke-action`)
    .set('X-CH-Key', 'not-aabbcc')
    .send({serviceID: 'urn:example-com:serviceID:errTestService', actionName: 'testErrorInfo', input: {foo: 'test'}})
    .end((err, res) => {
      if (err) return done(err);

      const ms = Date.now() - t0;
      const code = res.body != null ? res.body.code : null;

      // must fail fast (denied at brokering, not hung waiting on a port
      // that was never granted) and with a real, recognizable auth-failure
      // code -- doUserAuth's debug-mode key mismatch (lib/user-auth.js)
      // reports SYSTEM_ERROR_UNKNOWN_USER.
      if (ms > 5000) {
        return done(new Error(`direct-peer-channels 03 fail: took ${ms}ms -- expected a fast denial, not a hang`));
      }
      if (code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
        return done(new Error(`direct-peer-channels 03 fail: expected SYSTEM_ERROR_UNKNOWN_USER, got: ${JSON.stringify(res.body)}`));
      }
      return done();
    });
  });
});
