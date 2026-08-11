var fs = require('fs');
var exec = require('child_process').exec;
var request = require('supertest');

var url = 'http://127.0.0.1:9527';

// docs/direct-peer-channels-design.md section 5, step 4's required test:
// "直连调用产生计量记录，与主线程路径记录字段一致" (a direct-channel call produces a
// metering record, with fields consistent with other entry paths' records).
//
// Self-contained, own server (like 03-grant-time-auth.js), rather than
// loaded into test8.js: needs --mcpToolCallCost set to a nonzero value to
// make recordCall's effect on balance actually assertable -- N recordCalls
// at test8.js's default cost of 0 would be indistinguishable from 1 by
// balance alone, and distinguishing exactly that (one recordCall per hop,
// not more) is the whole point of this test.
//
// Uses echo-device-client-module (服务名称/API名称), not composite-demo:
// that action calls echo-device-module *without* the calling module doing
// any explicit CHUtil.recordUsage of its own, which is exactly what D5 is
// meant to cover (a module that doesn't meter itself still gets billed).
// composite-demo *also* calls CHUtil.recordUsage per hop, purely as its
// own app-layer bookkeeping now (see docs/composite-tools.md's "billing
// authority" principle) -- it used to call the balance-deducting
// CHUtil.recordCall there too, which caused real, reproducible
// double-billing once --directPeerChannels was on (composite-demo-internal's
// balance moved by 3x cost for a 2-hop call, not 2x); see
// test/direct-peer-channels/06-no-double-billing.js for the composite-demo
// case specifically, now fixed. Testing through echo-device-client-module
// here keeps this test's assertion unambiguous: exactly one platform
// metering charge should fire for exactly one hop.
describe('direct-peer-channels 04: automatic metering on the direct path (D5)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with --mcpToolCallCost 1 to make recordCall\'s effect assertable...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey aabbcc --mcpToolCallCost 1 --directPeerChannels --loadModule ./pre-installed-packages/echo-device-module --loadModule ./pre-installed-packages/echo-device-client-module', function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    request(url).post('/shutdown').set('X-CH-Key', 'aabbcc').end(function() { done(); }); // /shutdown is now admin-gated
  });

  var ECHO_DEVICE_CLIENT_ID = 'efefb416-bdc0-54eb-96a9-38f96f52779d'; // echo-device-client-module

  function getBalance(cb) {
    request(url).get('/balance')
    .set('X-CH-Key', 'aabbcc') // echo-device-client-module's hardcoded ServiceClient appKey -- see its device.js
    .end(function(err, res) {
      if (err) return cb(err);
      return cb(null, res.body.balance);
    });
  }

  function invoke(cb) {
    request(url).post('/devices/' + ECHO_DEVICE_CLIENT_ID + '/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send({serviceID: 'urn:example-com:serviceID:服务名称', actionName: 'API名称', input: {}})
    .end(function(err, res) {
      if (err) return cb(err);
      return cb(null, res.body);
    });
  }

  it('a call over a direct peer channel bills exactly once, not zero or twice', function(done) {
    getBalance(function(err, before) {
      if (err) return done(err);

      invoke(function(err, body) {
        if (err) return done(err);
        if (body.output == null) return done(new Error('direct-peer-channels 04 fail: invoke did not succeed: ' + JSON.stringify(body)));

        // Metering is a synchronous request/reply now (see
        // lib/peer-channel-broker.js's handleMeteringRequest and
        // lib/device-manager.js's onPeerChannelOpen): invoke()'s own
        // callback above only fires after the metering charge has already
        // landed, so no settling delay is needed before reading balance.
        getBalance(function(err, after) {
          if (err) return done(err);
          var delta = before - after;
          if (delta !== 1) {
            return done(new Error('direct-peer-channels 04 fail: expected balance to drop by exactly 1 (one charge for one hop, cost=1), dropped by ' + delta + ' (before=' + before + ', after=' + after + ')'));
          }
          return done();
        });
      });
    });
  });
});
