var request = require('supertest');

var url = 'http://127.0.0.1:9527';

// docs/direct-peer-channels-design.md section 5, step 1's required unit
// test: "两 worker 直连 echo 往返" (two workers, direct-connect, echo round
// trip). Uses echo-device-client-module's action, which internally
// constructs a ServiceClient and calls echo-device-module's echo action --
// exactly the isRemoteThread path lib/service-client.js now branches on
// options.directPeerChannels for. This file is only loaded by test8.js,
// whose server is started with --directPeerChannels, so a passing run here
// specifically exercises the new PeerChannel/PeerChannelBroker path (D1/D2),
// not the pre-existing main-thread-routed one (which test1.js/test2.js
// already cover).
describe('direct-peer-channels 01: echo round trip over a direct peer channel', function() {
  this.timeout(0);

  var ECHO_DEVICE_CLIENT_ID = 'efefb416-bdc0-54eb-96a9-38f96f52779d'; // echo-device-client-module

  it('completes a cross-worker call end to end', function(done) {
    request(url).post('/devices/' + ECHO_DEVICE_CLIENT_ID + '/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send({serviceID: 'urn:example-com:serviceID:服务名称', actionName: 'API名称', input: {}})
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('direct-peer-channels 01 fail: ' + err.message));
      if (res.body.output == null) return done(new Error('direct-peer-channels 01 fail: no output in response: ' + JSON.stringify(res.body)));
      return done();
    });
  });

  // D1's port-reuse claim ("端口按 worker 对复用") isn't observable from the
  // outside without instrumenting the broker itself, so this doesn't assert
  // "no new MessageChannel was created" directly -- it asserts the
  // behavior that reuse is *for*: repeated calls keep succeeding with the
  // same correct result, with no re-brokering round trip visible as a
  // failure or a growing delay. See test/direct-peer-channels/ in later
  // steps for D4 (invalidation forces exactly this re-brokering path) and
  // D5 (metering) coverage, which exercise the broker's internal state
  // more directly.
  it('repeated calls to the same device keep succeeding (cached channel, no re-brokering per call)', function(done) {
    var remaining = 5;
    var failed = null;

    function next() {
      if (failed != null) return done(failed);
      if (remaining === 0) return done();
      remaining--;

      request(url).post('/devices/' + ECHO_DEVICE_CLIENT_ID + '/invoke-action')
      .set('X-CH-Key', 'aabbcc')
      .send({serviceID: 'urn:example-com:serviceID:服务名称', actionName: 'API名称', input: {}})
      .expect(200, function(err, res) {
        if (err) { failed = new Error('direct-peer-channels 01 fail: ' + err.message); return next(); }
        if (res.body.output == null) { failed = new Error('direct-peer-channels 01 fail: no output in response on repeat call'); return next(); }
        return next();
      });
    }
    next();
  });
});
