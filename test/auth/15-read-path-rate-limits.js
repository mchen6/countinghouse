const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

// Covers audit leftover #6 (7.0.0 / A1): the authenticated *read* paths had
// no rate limiter at all. An authenticated caller could poll GET /balance,
// countinghouse_check_balance and tasks/get|result|list|cancel as fast as it
// liked, one Redis round trip per request, and docs/cross-cutting-matrix.md
// recorded that honestly as "none. Recorded, not fixed".
//
// It also closes a real bypass the matrix did *not* record. MCP task
// creation is rate-limited at lib/mcp/gateway.js (deliberately, at creation
// time -- unbounded queue growth is the resource being protected), but
// POST /devices/:deviceID/add-job creates the very same jobs over HTTP and
// was not limited, so the limit was one route away from being optional. The
// matrix asserted "route stack" for it; there is no rate-limit middleware in
// lib/route-manager.js, and lib/routes/user.js only does userAuth.
//
// Standalone-only, non---debug, same reason as 07/10: --debug resolves every
// key to an isAdmin session, and these limits are per resolved appKey.
const PORT              = 9545;
const url               = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH  = `/tmp/countinghouse-test-auth-15-${process.pid}.json`;
const OPEN_PORT         = 9546;
const openUrl           = `http://127.0.0.1:${OPEN_PORT}`;
const OPEN_CONFIG_PATH  = `/tmp/countinghouse-test-auth-15-open-${process.pid}.json`;

const ALICE = `alice-key-15-${process.pid}`;

// Small on purpose: the limiter's interval is fixed at 1000ms
// (lib/countinghouse-interface.js), so a burst has to overrun the budget
// well inside one second to be deterministic.
const LIMIT = 2;
const BURST = 8;

// echo-device-module's deviceID is deterministic (UUID.v5 over a fixed
// namespace and the module's friendlyName -- lib/call-address.js), the same
// way test/auth/07-task-ownership.js hardcodes it.
const DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';

function authConfig() {
  const config = {};
  config[ALICE] = {userName: 'alice', devices: ['*']};
  return config;
}

// The rolling window is 1s wide and every path in this file shares one
// budget per apiKey (that sharing is the point -- see the add-job test), so
// each case has to start from a drained window or it inherits the previous
// case's burst.
function drain(cb) { setTimeout(cb, 1400); }

function mcpReq(base, key, body, cb) {
  const req = request(base).post('/mcp').set('Content-Type', 'application/json');
  if (key != null) req.set('X-CH-Key', key);
  req.send(body).end(cb);
}

function addJobReq(base, key) {
  return request(base).post(`/devices/${DEVICE_ID}/add-job`)
    .set('X-CH-Key', key)
    .send({serviceID: 'EchoService', actionName: 'echo',
           input: {foo: [{item1: 'x'}], bar: 'y'}, opts: {name: 'rl-test'}});
}

function jobReadReq(base, key, route) {
  return request(base).post(`/devices/${DEVICE_ID}/${route}`)
    .set('X-CH-Key', key)
    .send({id: 'no-such-job', name: 'rl-test'});
}

// Fires `count` requests at once so they land inside one rolling window,
// and hands back every response. Asserting on the *set* rather than on a
// particular request's ordinal keeps this from depending on which of a
// parallel burst redis happens to serve first.
function burst(count, makeReq, cb) {
  const responses = [];
  let pending = count;

  for (let i = 0; i < count; i++) {
    makeReq((err, res) => {
      responses.push({err: err, res: res});
      if (--pending === 0) return cb(responses);
    });
  }
}

function httpDenials(responses) {
  return responses.filter((r) => r.res != null && r.res.status === 429);
}

function mcpDenials(responses) {
  return responses.filter((r) => {
    const body = (r.res != null) ? r.res.body : null;
    return body != null && body.error != null &&
           /rate limit exceeded/.test(String(body.error.message));
  });
}

describe('auth 15: the authenticated read paths are rate limited', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(authConfig()));

    console.log('starting countinghouse WITHOUT --debug, --apiKeyRateLimit, for read-path rate-limit test...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --apiKeyRateLimit ${LIMIT
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${AUTH_CONFIG_PATH}"`, () => { done(); });
  });

  it('GET /balance: a single call within budget still succeeds', (done) => {
    drain(() => {
      request(url).get('/balance').set('X-CH-Key', ALICE).expect(200, done);
    });
  });

  it('GET /balance: a burst is denied with 429 RATE_LIMIT_EXCEEDED', (done) => {
    drain(() => {
      burst(BURST, (cb) => request(url).get('/balance').set('X-CH-Key', ALICE).end(cb), (responses) => {
        const denied = httpDenials(responses);
        if (denied.length === 0) {
          return done(new Error(`no request in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.status))}`));
        }
        const body = denied[0].res.body;
        if (body.code !== 'RATE_LIMIT_EXCEEDED') {
          return done(new Error(`expected code RATE_LIMIT_EXCEEDED, got: ${JSON.stringify(body)}`));
        }
        if (body.balance !== undefined) {
          return done(new Error(`a denied request must not answer with a balance: ${JSON.stringify(body)}`));
        }
        return done();
      });
    });
  });

  it('countinghouse_check_balance: a burst is denied, as a tool error', (done) => {
    drain(() => {
      const body = {jsonrpc: '2.0', id: 1, method: 'tools/call',
                    params: {name: 'countinghouse_check_balance', arguments: {}}};
      burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
        const denied = responses.filter((r) => {
          const result = (r.res != null) ? r.res.body.result : null;
          return result != null && result.isError === true &&
                 result.structuredContent != null &&
                 result.structuredContent.code === 'RATE_LIMIT_EXCEEDED';
        });
        if (denied.length === 0) {
          return done(new Error(`no check_balance call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body))}`));
        }
        return done();
      });
    });
  });

  ['tasks/get', 'tasks/result', 'tasks/cancel'].forEach((method) => {
    it(`${method}: a burst is denied before the job lookup`, (done) => {
      drain(() => {
        const body = {jsonrpc: '2.0', id: 1, method: method, params: {taskId: 'no-such-task'}};
        burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
          if (mcpDenials(responses).length === 0) {
            return done(new Error(`no ${method} call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body.error))}`));
          }
          return done();
        });
      });
    });
  });

  it('tasks/list: a burst is denied', (done) => {
    drain(() => {
      const body = {jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {}};
      burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
        if (mcpDenials(responses).length === 0) {
          return done(new Error(`no tasks/list call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body.error))}`));
        }
        return done();
      });
    });
  });

  ['get-job', 'get-job-history', 'remove-job'].forEach((route) => {
    it(`HTTP /${route}: a burst is denied with 429`, (done) => {
      drain(() => {
        burst(BURST, (cb) => jobReadReq(url, ALICE, route).end(cb), (responses) => {
          const denied = httpDenials(responses);
          if (denied.length === 0) {
            return done(new Error(`no /${route} request in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.status))}`));
          }
          if (denied[0].res.body.code !== 'RATE_LIMIT_EXCEEDED') {
            return done(new Error(`expected code RATE_LIMIT_EXCEEDED, got: ${JSON.stringify(denied[0].res.body)}`));
          }
          return done();
        });
      });
    });
  });

  it('HTTP /add-job: a burst is denied with 429 (was: an unlimited way to queue jobs)', (done) => {
    drain(() => {
      burst(BURST, (cb) => addJobReq(url, ALICE).end(cb), (responses) => {
        const denied = httpDenials(responses);
        if (denied.length === 0) {
          return done(new Error(`no add-job request in a burst of ${BURST} was rate limited -- ` +
                                `MCP task creation is limited, so this would be a bypass: ${JSON.stringify(responses.map((r) => r.res && r.res.status))}`));
        }
        return done();
      });
    });
  });

  // The budget is per apiKey and shared across every path, so cheap reads
  // spend the same allowance job creation draws on. Two /balance reads are
  // fast enough to land well inside the 1s window, which makes this
  // deterministic without depending on how long a bullmq write takes.
  it('the budget is shared: /balance reads exhaust add-job\'s allowance too', (done) => {
    drain(() => {
      let spent = 0;
      const spendOne = () => {
        request(url).get('/balance').set('X-CH-Key', ALICE).end(() => {
          if (++spent < LIMIT) return spendOne();
          return addJobReq(url, ALICE).expect(429, (err, res) => {
            if (err) return done(new Error(`add-job was served after the budget was spent on reads: ${err.message}`));
            return done();
          });
        });
      };
      spendOne();
    });
  });
});

describe('auth 15b: without --apiKeyRateLimit nothing is limited', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    fs.writeFileSync(OPEN_CONFIG_PATH, JSON.stringify(authConfig()));

    console.log('starting countinghouse WITHOUT --apiKeyRateLimit, to check the paths stay open...');
    exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${OPEN_PORT
         } --authProvider file --authConfigPath ${OPEN_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); });
    setTimeout(() => { done(); }, 13000);
  });

  after((done) => {
    try { fs.unlinkSync(OPEN_CONFIG_PATH); } catch (e) {}
    exec(`pkill -f "framework.js.*${OPEN_CONFIG_PATH}"`, () => { done(); });
  });

  // The gate must be inert unless the operator opted in -- this is what
  // makes the change a no-op for an existing deployment that never set the
  // flag, and it is also the fail-open path (no limiter configured => pass).
  it('GET /balance: a burst is served in full', (done) => {
    burst(BURST, (cb) => request(openUrl).get('/balance').set('X-CH-Key', ALICE).end(cb), (responses) => {
      const denied = httpDenials(responses);
      if (denied.length !== 0) {
        return done(new Error(`${denied.length} of ${BURST} were limited with no --apiKeyRateLimit set`));
      }
      return done();
    });
  });

  it('tasks/list: a burst is served in full', (done) => {
    const body = {jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {}};
    burst(BURST, (cb) => mcpReq(openUrl, ALICE, body, cb), (responses) => {
      if (mcpDenials(responses).length !== 0) {
        return done(new Error(`tasks/list was limited with no --apiKeyRateLimit set`));
      }
      return done();
    });
  });
});
