var exec = require('child_process').exec;
var request = require('supertest');

var url = 'http://127.0.0.1:9527';

// Regression test for the double-billing fix (docs/composite-tools.md's
// "billing authority" principle): platform automatic metering is now the
// SOLE thing that deducts balance for a cross-worker call, on both the
// main-thread-routed path (lib/device-manager.js's
// sendInvokeActionMessageToWorker) and the --directPeerChannels path
// (lib/peer-channel-broker.js's handleMeteringRequest). composite-demo's
// own CHUtil.recordUsage call (com-countinghouse-compositeService-run.js)
// is app-layer bookkeeping only now and never touches balance -- before
// this fix, composite-demo-internal's balance dropped by 3x the per-hop
// cost for this exact 2-hop call when --directPeerChannels was on (one
// double-counted hop), not 2x. See test/direct-peer-channels/04-metering.js
// for the equivalent single-hop, no-self-metering case.
//
// Standalone-only (own --debugKey/--mcpToolCallCost/--loadModule set,
// incompatible with test8.js's shared server -- see that file's
// STANDALONE_ONLY_PEER_CHANNEL_TESTS comment for why these can never run
// concurrently with it or with each other).
var COMPOSITE_DEVICE_ID = '6042a93c-06b1-54b5-a62d-a68c15f1ce1e'; // composite-demo
var ECHO_DEVICE_ID      = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module, called directly for the outer-charge baseline
var INTERNAL_API_KEY    = 'composite-demo-internal'; // composite-demo/device.js's fixed internal identity

function loadModuleArgs() {
  return '--loadModule ./pre-installed-packages/composite-demo ' +
         '--loadModule ./pre-installed-packages/transform-demo ' +
         '--loadModule ./pre-installed-packages/echo-device-module';
}

function getBalance(cb) {
  request(url).get('/balance')
  .set('X-CH-Key', INTERNAL_API_KEY)
  .end(function(err, res) {
    if (err) return cb(err);
    return cb(null, res.body.balance);
  });
}

var SETTLE_POLL_MS    = 200;   // gap between balance reads
var SETTLE_STABLE     = 3;     // identical consecutive reads that count as quiesced
var SETTLE_TIMEOUT_MS = 15000; // overall cap before giving up

// Balance debits are applied asynchronously: an invoke's HTTP response can
// return before every hop's metering write has landed. Reading the balance
// straight out of the invoke callback therefore races the debits, and the
// shortfall shows up as an under-count -- observed under full-suite load as
// a 2-hop composite call measuring as 1 hop, while the bill array in the
// same response correctly held 2 entries.
//
// Polling until the *expected* number appears would be the wrong fix: this
// test exists to catch double-billing, so stopping the moment the balance
// reaches the expected value would hide a third charge arriving just after.
// Instead wait for the balance to go quiet -- unchanged across several
// consecutive reads -- and only then let the caller assert. A surplus
// charge either keeps the balance moving (so we keep waiting) or has landed
// before it settles; either way the assertion still sees it.
//
// mustDifferFrom: when non-null, also require the balance to have moved off
// that value first. Every call site here is known to cost at least the outer
// invoke-action charge, so "quiet" must not be satisfied by reading three
// times before the first debit even lands.
function settledBalance(mustDifferFrom, cb) {
  var deadline = Date.now() + SETTLE_TIMEOUT_MS;
  var last     = null;
  var stable   = 0;
  var changed  = (mustDifferFrom === null);

  (function poll() {
    getBalance(function(err, balance) {
      if (err) return cb(err);
      if (typeof balance !== 'number') {
        return cb(new Error('06-no-double-billing fail: /balance did not return a numeric balance, got ' + JSON.stringify(balance)));
      }

      if (balance !== mustDifferFrom) changed = true;
      stable = (last !== null && balance === last) ? stable + 1 : 1;
      last   = balance;

      if (changed && stable >= SETTLE_STABLE) return cb(null, balance);

      if (Date.now() >= deadline) {
        return cb(new Error('06-no-double-billing fail: balance did not ' +
                            (changed ? 'settle' : 'move from ' + mustDifferFrom) +
                            ' within ' + SETTLE_TIMEOUT_MS + 'ms (last read ' + balance + ')'));
      }
      setTimeout(poll, SETTLE_POLL_MS);
    });
  })();
}

function invokeComposite(cb) {
  request(url).post('/devices/' + COMPOSITE_DEVICE_ID + '/invoke-action')
  .set('X-CH-Key', INTERNAL_API_KEY)
  .send({serviceID: 'urn:countinghouse-com:serviceID:compositeService', actionName: 'run', input: {text: 'hello'}})
  .end(function(err, res) {
    if (err) return cb(err);
    return cb(null, res.body);
  });
}

// A non-composing call: straight to echo-device-module, zero inner hops, so
// its whole cost is the outer HTTP invoke-action charge.
//
// This baseline is measured rather than assumed because HTTP invoke-action
// is itself a metered entry path. It always should have been; until
// 2026-08-11 it recorded nothing at all, and this test's original "delta
// must be 2" expectation had quietly baked that bug in. With the outer call
// correctly billed, a 2-hop composite call costs 1 (outer) + 2 (hops) = 3,
// and asserting the bare total could no longer tell "one charge per hop"
// apart from "a hop got double-counted" -- which is the only thing this
// regression test exists to detect. Subtracting a separately measured outer
// charge keeps the assertion about hops.
function invokeDirect(cb) {
  request(url).post('/devices/' + ECHO_DEVICE_ID + '/invoke-action')
  .set('X-CH-Key', INTERNAL_API_KEY)
  .send({serviceID: 'urn:countinghouse-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}})
  .end(function(err, res) {
    if (err) return cb(err);
    return cb(null, res.body);
  });
}

function measureOuterCallCost(cb) {
  settledBalance(null, function(err, before) {
    if (err) return cb(err);
    invokeDirect(function(err, body) {
      if (err) return cb(err);
      if (body.output == null) return cb(new Error('06-no-double-billing fail: baseline invoke did not succeed: ' + JSON.stringify(body)));
      settledBalance(before, function(err, after) {
        if (err) return cb(err);
        return cb(null, before - after);
      });
    });
  });
}

function runBillingAssertion(done) {
  measureOuterCallCost(function(err, outerCallCost) {
    if (err) return done(err);
    if (outerCallCost !== 1) {
      return done(new Error('06-no-double-billing fail: expected a plain invoke-action with zero inner hops to cost exactly 1, got ' + outerCallCost));
    }

  settledBalance(null, function(err, before) {
    if (err) return done(err);

    invokeComposite(function(err, body) {
      if (err) return done(err);
      if (body.output == null) return done(new Error('06-no-double-billing fail: invoke did not succeed: ' + JSON.stringify(body)));

      var bill = body.output.bill;
      if (!Array.isArray(bill) || bill.length !== 2) {
        return done(new Error('06-no-double-billing fail: expected bill with exactly 2 entries, got ' + JSON.stringify(bill)));
      }

      settledBalance(before, function(err, after) {
        if (err) return done(err);

        var delta   = before - after;
        var hopCost = delta - outerCallCost;
        if (hopCost !== 2) {
          return done(new Error('06-no-double-billing fail: expected the 2 inner hops to be billed exactly once each (2 total, cost=1 per hop), got ' + hopCost +
                                ' (total delta ' + delta + ' minus the measured outer invoke-action charge ' + outerCallCost + '; before=' + before + ', after=' + after + ')'));
        }
        return done();
      });
    });
  });
  });
}

describe('direct-peer-channels 06: composite-demo does not double-bill (--directPeerChannels on)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse with --directPeerChannels for double-billing regression test...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey ' + INTERNAL_API_KEY + ' --mcpToolCallCost 1 --directPeerChannels ' + loadModuleArgs(), function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    request(url).post('/shutdown').set('X-CH-Key', INTERNAL_API_KEY).end(function() { done(); }); // /shutdown is now admin-gated
  });

  it('a 2-hop composite call bills exactly 2, and bill still shows 2 independent records', function(done) {
    runBillingAssertion(done);
  });
});

describe('direct-peer-channels 06b: composite-demo does not double-bill (--directPeerChannels off)', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse without --directPeerChannels for double-billing regression test...');
    exec('"./bin/countinghouse" --workerThread --debug --bindAddr 127.0.0.1 --debugKey ' + INTERNAL_API_KEY + ' --mcpToolCallCost 1 ' + loadModuleArgs(), function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    request(url).post('/shutdown').set('X-CH-Key', INTERNAL_API_KEY).end(function() { done(); }); // /shutdown is now admin-gated
  });

  it('a 2-hop composite call bills exactly 2, and bill still shows 2 independent records', function(done) {
    runBillingAssertion(done);
  });
});
