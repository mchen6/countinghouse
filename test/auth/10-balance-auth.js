var fs      = require('fs');
var exec    = require('child_process').exec;
var request = require('supertest');

// Standalone-only, non---debug: --debug accepts every apiKey by
// construction, so "an unknown key is refused" is not expressible there.
//
// Covers S6: GET /balance and the countinghouse_check_balance MCP tool both
// took the apiKey straight off the request and handed it to
// MeteringProvider.checkBalance with no AuthProvider involvement. Verified
// before the fix: `X-CH-Key: totally-made-up-key` answered HTTP 200
// {"apiKey":"totally-made-up-key","balance":0} -- an unauthenticated balance
// oracle, and an unauthenticated Redis round trip per request.
var PORT             = 9544;
var url              = 'http://127.0.0.1:' + PORT;
var AUTH_CONFIG_PATH = '/tmp/countinghouse-test-auth-10-' + process.pid + '.json';

var ALICE   = 'alice-key-10-' + process.pid;
var UNKNOWN = 'totally-made-up-key';

function mcpCheckBalance(key, cb) {
  var req = request(url).post('/mcp').set('Content-Type', 'application/json');
  if (key != null) req.set('X-CH-Key', key);
  req.send({jsonrpc: '2.0', id: 1, method: 'tools/call',
            params: {name: 'countinghouse_check_balance', arguments: {}}}).end(cb);
}

describe('auth 10: /balance and countinghouse_check_balance require a real apiKey', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    var config = {};
    config[ALICE] = {userName: 'alice', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --authProvider file, for balance-auth test...');
    exec('"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ' + PORT +
         ' --authProvider file --authConfigPath ' + AUTH_CONFIG_PATH +
         ' --loadModule ./pre-installed-packages/echo-device-module',
         function(err, stdout, stderr) { console.log(err); });
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec('pkill -f "framework.js.*' + AUTH_CONFIG_PATH + '"', function() { done(); });
  });

  it('GET /balance: a known key gets its own balance', function(done) {
    request(url).get('/balance').set('X-CH-Key', ALICE).expect(200, function(err, res) {
      if (err) return done(err);
      if (res.body.apiKey !== ALICE || typeof(res.body.balance) !== 'number') {
        return done(new Error('expected the caller\'s own balance, got: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('GET /balance: an unknown key is refused (was: 200 with a balance)', function(done) {
    request(url).get('/balance').set('X-CH-Key', UNKNOWN).expect(403, function(err, res) {
      if (err) return done(err);
      if (res.body.code !== 'SYSTEM_ERROR_UNKNOWN_USER') {
        return done(new Error('expected SYSTEM_ERROR_UNKNOWN_USER, got: ' + JSON.stringify(res.body)));
      }
      if (res.body.balance !== undefined) {
        return done(new Error('an unauthenticated caller must not learn a balance: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('GET /balance: no key at all is refused', function(done) {
    request(url).get('/balance').expect(403, function(err, res) {
      if (err) return done(err);
      if (res.body.balance !== undefined) {
        return done(new Error('anonymous caller must not learn a balance: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('countinghouse_check_balance: a known key gets its own balance', function(done) {
    mcpCheckBalance(ALICE, function(err, res) {
      if (err) return done(err);
      var r = res.body.result;
      if (r == null || r.isError === true || r.structuredContent.apiKey !== ALICE) {
        return done(new Error('expected the caller\'s own balance, got: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('countinghouse_check_balance: an unknown key is refused', function(done) {
    mcpCheckBalance(UNKNOWN, function(err, res) {
      if (err) return done(err);
      var r = res.body.result;
      if (r == null || r.isError !== true) {
        return done(new Error('an unknown key must not get a balance, got: ' + JSON.stringify(res.body)));
      }
      if (JSON.stringify(res.body).indexOf('"balance"') !== -1) {
        return done(new Error('balance leaked to an unknown key: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('countinghouse_check_balance: no key at all is refused', function(done) {
    mcpCheckBalance(null, function(err, res) {
      if (err) return done(err);
      var r = res.body.result;
      if (r == null || r.isError !== true) {
        return done(new Error('an anonymous caller must not get a balance, got: ' + JSON.stringify(res.body)));
      }
      return done();
    });
  });

  it('the balance tool is still advertised in tools/list to a valid caller', function(done) {
    // the fix must not make the platform tool disappear -- it is the only
    // tool an otherwise device-less key can see (see tool-registry.js)
    request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', ALICE)
      .send({jsonrpc: '2.0', id: 1, method: 'tools/list'})
      .end(function(err, res) {
        if (err) return done(err);
        var names = res.body.result.tools.map(function(t) { return t.name; });
        if (names.indexOf('countinghouse_check_balance') === -1) {
          return done(new Error('platform balance tool missing from tools/list: ' + JSON.stringify(names)));
        }
        return done();
      });
  });
});
