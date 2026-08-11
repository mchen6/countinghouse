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

function invokeComposite(cb) {
  request(url).post('/devices/' + COMPOSITE_DEVICE_ID + '/invoke-action')
  .set('X-CH-Key', INTERNAL_API_KEY)
  .send({serviceID: 'urn:countinghouse-com:serviceID:compositeService', actionName: 'run', input: {text: 'hello'}})
  .end(function(err, res) {
    if (err) return cb(err);
    return cb(null, res.body);
  });
}

function runBillingAssertion(done) {
  getBalance(function(err, before) {
    if (err) return done(err);

    invokeComposite(function(err, body) {
      if (err) return done(err);
      if (body.output == null) return done(new Error('06-no-double-billing fail: invoke did not succeed: ' + JSON.stringify(body)));

      var bill = body.output.bill;
      if (!Array.isArray(bill) || bill.length !== 2) {
        return done(new Error('06-no-double-billing fail: expected bill with exactly 2 entries, got ' + JSON.stringify(bill)));
      }

      getBalance(function(err, after) {
        if (err) return done(err);

        var delta = before - after;
        if (delta !== 2) {
          return done(new Error('06-no-double-billing fail: expected balance to drop by exactly 2 (one platform charge per hop, cost=1, 2 hops), dropped by ' + delta + ' (before=' + before + ', after=' + after + ')'));
        }
        return done();
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
