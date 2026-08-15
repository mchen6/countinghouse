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
  var ECHO_DEVICE_ID        = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module, called directly for the baseline below

  function getBalance(cb) {
    request(url).get('/balance')
    .set('X-CH-Key', 'aabbcc') // echo-device-client-module's hardcoded ServiceClient appKey -- see its device.js
    .end(function(err, res) {
      if (err) return cb(err);
      return cb(null, res.body.balance);
    });
  }

  var SETTLE_POLL_MS    = 200;
  var SETTLE_STABLE     = 3;
  var SETTLE_TIMEOUT_MS = 15000;

  // The *hop* charge is awaited before the reply (see the note in the second
  // test below), but the *outer* HTTP invoke-action charge is not: it goes
  // through Session.prototype.recordMeteredCall (lib/session.js), which is
  // deliberately fire-and-forget and can land after the response has already
  // been sent. Reading the balance straight out of an invoke callback
  // therefore races that charge, and the miss shows up as an off-by-the-
  // outer-charge result rather than as an obvious failure.
  //
  // Waiting for a specific expected value would defeat the purpose of these
  // tests -- they exist to catch a hop being billed twice, so stopping as
  // soon as the expected number appears would hide a surplus charge landing
  // just after. Wait for the balance to stop moving instead, then assert.
  // See 06-no-double-billing.js for the same helper and the fuller rationale.
  function settledBalance(mustDifferFrom, cb) {
    var deadline = Date.now() + SETTLE_TIMEOUT_MS;
    var last     = null;
    var stable   = 0;
    var changed  = (mustDifferFrom === null);

    (function poll() {
      getBalance(function(err, balance) {
        if (err) return cb(err);
        if (typeof balance !== 'number') {
          return cb(new Error('direct-peer-channels 04 fail: /balance did not return a numeric balance, got ' + JSON.stringify(balance)));
        }

        if (balance !== mustDifferFrom) changed = true;
        stable = (last !== null && balance === last) ? stable + 1 : 1;
        last   = balance;

        if (changed && stable >= SETTLE_STABLE) return cb(null, balance);

        if (Date.now() >= deadline) {
          return cb(new Error('direct-peer-channels 04 fail: balance did not ' +
                              (changed ? 'settle' : 'move from ' + mustDifferFrom) +
                              ' within ' + SETTLE_TIMEOUT_MS + 'ms (last read ' + balance + ')'));
        }
        setTimeout(poll, SETTLE_POLL_MS);
      });
    })();
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

  // A non-composing call: straight to echo-device-module, zero inner hops.
  // Its cost is entirely the outer HTTP invoke-action charge.
  function invokeDirect(cb) {
    request(url).post('/devices/' + ECHO_DEVICE_ID + '/invoke-action')
    .set('X-CH-Key', 'aabbcc')
    .send({serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}})
    .end(function(err, res) {
      if (err) return cb(err);
      return cb(null, res.body);
    });
  }

  // Measured, not assumed. HTTP invoke-action is itself a metered entry path
  // (it always should have been -- until 2026-08-11 it recorded nothing,
  // which is what this test's original "delta must be 1" expectation had
  // quietly baked in). So the total for a composing call is now
  //   outer invoke-action charge + one platform charge per inner hop
  // and asserting a bare total can no longer distinguish "one charge per
  // hop" from "the outer call is being double-counted". Measuring the outer
  // charge separately, against a module that makes no inner calls at all, is
  // what keeps this test a statement about *hops* rather than about the
  // total.
  var outerCallCost = null;

  it('a plain (non-composing) call establishes the outer invoke-action charge', function(done) {
    settledBalance(null, function(err, before) {
      if (err) return done(err);

      invokeDirect(function(err, body) {
        if (err) return done(err);
        if (body.output == null) return done(new Error('direct-peer-channels 04 fail: baseline invoke did not succeed: ' + JSON.stringify(body)));

        settledBalance(before, function(err, after) {
          if (err) return done(err);
          outerCallCost = before - after;
          if (outerCallCost !== 1) {
            return done(new Error('direct-peer-channels 04 fail: expected a plain invoke-action with zero inner hops to cost exactly 1 (the outer charge, cost=1), got ' + outerCallCost));
          }
          return done();
        });
      });
    });
  });

  it('a call over a direct peer channel bills the hop exactly once, not zero or twice', function(done) {
    settledBalance(null, function(err, before) {
      if (err) return done(err);

      invoke(function(err, body) {
        if (err) return done(err);
        if (body.output == null) return done(new Error('direct-peer-channels 04 fail: invoke did not succeed: ' + JSON.stringify(body)));

        // The *hop* charge is a synchronous request/reply (see
        // lib/peer-channel-broker.js's handleMeteringRequest and
        // lib/device-manager.js's onPeerChannelOpen): invoke()'s own
        // callback above only fires after that charge has already landed.
        // The outer HTTP invoke-action charge is the one that has not --
        // Session.prototype.recordMeteredCall is fire-and-forget -- and
        // `delta` below spans both, so it still has to be read from a
        // settled balance. Only the hop half of it was ever race-free.
        settledBalance(before, function(err, after) {
          if (err) return done(err);
          var delta = before - after;
          var hopCost = delta - outerCallCost;
          if (hopCost !== 1) {
            return done(new Error('direct-peer-channels 04 fail: expected the single inner hop to be billed exactly once (cost=1), got ' + hopCost +
                                  ' (total delta ' + delta + ' minus the measured outer invoke-action charge ' + outerCallCost + '; before=' + before + ', after=' + after + ')'));
          }
          return done();
        });
      });
    });
  });
});
