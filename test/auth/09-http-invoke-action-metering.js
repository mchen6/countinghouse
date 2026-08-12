var fs      = require('fs');
var exec    = require('child_process').exec;
var request = require('supertest');
var redis   = require('redis');

// Standalone-only, non---debug, --mcpToolCallCost 1.
//
// Covers S3: POST /devices/:deviceID/invoke-action was not metered at all.
// Its original hook (Session.prototype.updateRedisUserRecord) was retired
// during the AuthProvider refactor and nothing replaced it, while
// docs/cross-cutting-matrix.md still claimed the path was metered. Verified
// before the fix: one MCP tools/call moved the balance by 1, five successful
// HTTP invoke-action calls of the same action moved it by 0.
//
// The interesting assertion isn't "HTTP now costs something" -- it's that
// HTTP and MCP produce the *same* metering record for the same action. That
// is checked directly by seeding a per-tool free-call quota
// (`toolPriceRecord`, the only field in RedisMeteringProvider keyed by the
// `tool` identifier) and showing that a call over either entry path consumes
// from that one shared counter. If the two paths recorded under different
// tool strings, only one of them would draw on the seeded quota and the
// other would fall through to a balance deduction.
var PORT             = 9543;
var url              = 'http://127.0.0.1:' + PORT;
var AUTH_CONFIG_PATH = '/tmp/countinghouse-test-auth-09-' + process.pid + '.json';

var ALICE = 'alice-key-09-' + process.pid;

var DEVICE_ID  = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767'; // echo-device-module, deterministic UUID.v5
var SERVICE_ID = 'urn:countinghouse-com:serviceID:echoService';
var ACTION     = 'echo';
var MCP_TOOL   = 'echo_device_echoservice_echo';
var ECHO_INPUT = {foo: [{item1: 'x'}], bar: 'y'};

// must match lib/metering/redis-provider.js's encodeLegacyTool
var TOOL_ID = DEVICE_ID + ':::' + SERVICE_ID + ':::' + ACTION;

// db 0 -- the db lib/countinghouse-interface.js hands RedisMeteringProvider
var redisClient = null;

function balance(cb) {
  request(url).get('/balance').set('X-CH-Key', ALICE).end(function(err, res) {
    if (err) return cb(err);
    cb(null, res.body.balance);
  });
}

function httpInvoke(cb) {
  request(url).post('/devices/' + DEVICE_ID + '/invoke-action')
    .set('X-CH-Key', ALICE)
    .send({serviceID: SERVICE_ID, actionName: ACTION, input: ECHO_INPUT})
    .end(function(err, res) {
      if (err) return cb(err);
      if (res.status !== 200) return cb(new Error('HTTP invoke-action failed: ' + res.status + ' ' + JSON.stringify(res.body)));
      setTimeout(cb, 600); // metering is fire-and-forget, same as the MCP path
    });
}

function mcpInvoke(cb) {
  request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', ALICE)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: MCP_TOOL, arguments: ECHO_INPUT}})
    .end(function(err, res) {
      if (err) return cb(err);
      if (res.body.result == null || res.body.result.isError === true) {
        return cb(new Error('MCP tools/call failed: ' + JSON.stringify(res.body)));
      }
      setTimeout(cb, 600);
    });
}

describe('auth 09: HTTP invoke-action is metered, with the same record MCP tools/call produces', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);

    var config = {};
    config[ALICE] = {userName: 'alice', devices: ['*']};
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(config));

    console.log('starting countinghouse WITHOUT --debug, --mcpToolCallCost 1, for HTTP metering test...');
    exec('"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ' + PORT +
         ' --authProvider file --authConfigPath ' + AUTH_CONFIG_PATH +
         ' --mcpToolCallCost 1' +
         ' --loadModule ./pre-installed-packages/echo-device-module',
         function(err, stdout, stderr) { console.log(err); });

    redisClient = redis.createClient('redis://127.0.0.1:6379', {db: 0});
    setTimeout(function() { done(); }, 13000);
  });

  after(function(done) {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    redisClient.del(ALICE, function() {
      redisClient.quit(function() {
        exec('pkill -f "framework.js.*' + AUTH_CONFIG_PATH + '"', function() { done(); });
      });
    });
  });

  it('one HTTP invoke-action deducts exactly one unit (previously: zero)', function(done) {
    balance(function(err, before) {
      if (err) return done(err);
      httpInvoke(function(err) {
        if (err) return done(err);
        balance(function(err, after) {
          if (err) return done(err);
          if (after !== before - 1) {
            return done(new Error('HTTP invoke-action was not metered: balance ' + before + ' -> ' + after));
          }
          return done();
        });
      });
    });
  });

  it('five more HTTP invoke-action calls deduct exactly five units', function(done) {
    balance(function(err, before) {
      if (err) return done(err);
      var n = 0;
      (function next() {
        if (n++ === 5) {
          return balance(function(err, after) {
            if (err) return done(err);
            if (after !== before - 5) {
              return done(new Error('expected 5 charges, balance went ' + before + ' -> ' + after));
            }
            return done();
          });
        }
        httpInvoke(function(err) { if (err) return done(err); next(); });
      })();
    });
  });

  it('an MCP tools/call of the same action deducts the same one unit', function(done) {
    balance(function(err, before) {
      if (err) return done(err);
      mcpInvoke(function(err) {
        if (err) return done(err);
        balance(function(err, after) {
          if (err) return done(err);
          if (after !== before - 1) {
            return done(new Error('MCP tools/call charge changed: balance ' + before + ' -> ' + after));
          }
          return done();
        });
      });
    });
  });

  it('a failed HTTP invoke-action is not billed', function(done) {
    balance(function(err, before) {
      if (err) return done(err);
      request(url).post('/devices/' + DEVICE_ID + '/invoke-action')
        .set('X-CH-Key', ALICE)
        .send({serviceID: SERVICE_ID, actionName: ACTION, input: {bar: 'missing required foo'}})
        .end(function(err, res) {
          if (err) return done(err);
          if (res.status === 200) return done(new Error('expected this call to fail validation'));
          setTimeout(function() {
            balance(function(err, after) {
              if (err) return done(err);
              if (after !== before) {
                return done(new Error('a failed call was billed: balance ' + before + ' -> ' + after));
              }
              return done();
            });
          }, 600);
        });
    });
  });

  it('HTTP and MCP draw on the SAME per-tool record, not two parallel ones', function(done) {
    // Seed 2 free calls against the canonical tool identity. If the two entry
    // paths agreed only on "something gets charged" but recorded under
    // different tool strings, exactly one of the two calls below would miss
    // this quota and hit the balance instead.
    var seeded = {};
    seeded[TOOL_ID] = {count: 2};

    redisClient.hmset(ALICE, 'toolPriceRecord', JSON.stringify(seeded), function(err) {
      if (err) return done(err);

      balance(function(err, before) {
        if (err) return done(err);

        httpInvoke(function(err) {
          if (err) return done(err);
          mcpInvoke(function(err) {
            if (err) return done(err);

            balance(function(err, after) {
              if (err) return done(err);
              if (after !== before) {
                return done(new Error('one of the two entry paths missed the shared free-call quota ' +
                                      '(balance ' + before + ' -> ' + after + '), so they are not recording ' +
                                      'under the same tool identity'));
              }

              redisClient.hmget(ALICE, 'toolPriceRecord', function(err, results) {
                if (err) return done(err);
                var record = JSON.parse(results[0]);
                if (record[TOOL_ID] == null || record[TOOL_ID].count !== 0) {
                  return done(new Error('expected the shared quota to be drawn down 2 -> 0, got: ' + results[0]));
                }
                return done();
              });
            });
          });
        });
      });
    });
  });
});
