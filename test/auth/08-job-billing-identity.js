var fs      = require('fs');
var exec    = require('child_process').exec;
var request = require('supertest');

// Standalone-only, non---debug: this is about *whose* balance moves, which
// only means anything when apiKeys are real identities resolved by
// AuthProvider rather than the single bypass identity --debug hands out.
//
// Covers S2: POST /devices/:deviceID/add-job used to forward its entire
// request-body `opts` object into JobControl.addJob, which read `apiKey`
// from it -- so any caller with a valid key could bill an arbitrary other
// key by sending {"opts":{"apiKey":"victim"}}. Verified before the fix:
// alice's forged request moved mallory's balance and left alice's alone.
//
// apiKeys are suffixed with the pid so each run starts from a clean,
// never-before-billed balance in redis (balances are keyed by apiKey).
var PORT             = 9542;
var url              = 'http://127.0.0.1:' + PORT;
var AUTH_CONFIG_PATH = '/tmp/countinghouse-test-auth-08-' + process.pid + '.json';

var ALICE   = 'alice-key-08-' + process.pid;
var MALLORY = 'mallory-key-08-' + process.pid;

var DEVICE_ID  = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module, deterministic UUID.v5
var SERVICE_ID = 'urn:countinghouse-com:serviceID:echoService';
var ECHO_INPUT = {foo: [{item1: 'x'}], bar: 'y'};

function balance(key, cb) {
  request(url).get('/balance').set('X-CH-Key', key).end(function(err, res) {
    if (err) return cb(err);
    cb(null, res.body.balance);
  });
}

describe('auth 08: a job is billed to the authenticated caller, never to a request-supplied identity', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    var config = {};
    config[ALICE]   = {userName: 'alice',   devices: ['*']};
    config[MALLORY] = {userName: 'mallory', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --mcpToolCallCost 1, for billing-identity test...');
    // a nonzero cost is what makes recordCall's effect observable as a
    // balance delta at all -- with the default 0 every assertion below would
    // pass trivially whether or not the fix works.
    exec('"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ' + PORT +
         ' --authProvider file --authConfigPath ' + AUTH_CONFIG_PATH +
         ' --mcpToolCallCost 1' +
         ' --loadModule ./pre-installed-packages/echo-device-module',
         function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec('pkill -f "framework.js.*' + AUTH_CONFIG_PATH + '"', function() { done(); });
  });

  it('both tenants start from a zero balance', function(done) {
    balance(ALICE, function(err, a) {
      if (err) return done(err);
      balance(MALLORY, function(err, m) {
        if (err) return done(err);
        if (a !== 0 || m !== 0) return done(new Error('expected fresh zero balances, got alice=' + a + ' mallory=' + m));
        return done();
      });
    });
  });

  // Billing happens when the job *completes*, which is asynchronous and, on a
  // loaded machine, can take well over the fixed delay this used to wait. A
  // single sleep made the test flaky -- and, worse, made its central negative
  // assertion ("mallory was not billed") pass vacuously whenever the job
  // simply hadn't run yet. So: poll until the job's charge actually lands,
  // and only then check who paid for it.
  function waitForCharge(cb) {
    var deadline = Date.now() + 20000;
    (function poll() {
      balance(ALICE, function(err, a) {
        if (err) return cb(err);
        if (a !== 0) return cb(null, a);                    // the charge landed
        if (Date.now() > deadline) {
          return cb(new Error('job never completed/recorded within 20s -- cannot tell who was billed, ' +
                              'so the forgery assertion below would be meaningless'));
        }
        setTimeout(poll, 500);
      });
    })();
  }

  it('alice posts add-job with opts.apiKey forged to mallory', function(done) {
    request(url).post('/devices/' + DEVICE_ID + '/add-job')
      .set('X-CH-Key', ALICE)
      .send({
        serviceID: SERVICE_ID,
        actionName: 'echo',
        opts: {name: 'forged-billing-job-' + process.pid, apiKey: MALLORY},
        input: ECHO_INPUT
      })
      .end(function(err, res) {
        if (err) return done(err);
        if (res.status !== 200 || res.body.id == null) {
          return done(new Error('expected the job to be created (the forged field must be ignored, not fatal), got: ' +
                                res.status + ' ' + JSON.stringify(res.body)));
        }
        return done();
      });
  });

  it('the bill landed on alice, the real caller -- and NOT on the forged identity', function(done) {
    waitForCharge(function(err, aliceBalance) {
      if (err) return done(err);
      if (aliceBalance !== -1) {
        return done(new Error('expected alice to be charged exactly once (balance -1), got: ' + aliceBalance));
      }
      // checked only now that the job is known to have completed, so a 0 here
      // means "not billed", not "not run yet"
      balance(MALLORY, function(err, m) {
        if (err) return done(err);
        if (m !== 0) {
          return done(new Error('billing-attribution forgery: mallory was charged ' + (0 - m) +
                                ' for a job alice submitted'));
        }
        return done();
      });
    });
  });

  it('the created job is owned by alice, not by the forged identity', function(done) {
    // The same field is both the billing subject and the ownership subject,
    // so a forgeable value was simultaneously a billing and an authorization
    // bug -- mallory must not be able to reach the job either.
    request(url).post('/devices/' + DEVICE_ID + '/get-job-history')
      .set('X-CH-Key', MALLORY).send({name: 'forged-billing-job-' + process.pid})
      .end(function(err, res) {
        if (err) return done(err);
        if (Array.isArray(res.body) && res.body.length > 0) {
          return done(new Error('the forged identity gained access to the job: ' + JSON.stringify(res.body)));
        }
        return done();
      });
  });
});
