const fs      = require('fs');
const {deviceIDForName} = require('../../lib/call-address');
const waitForReady = require('../helpers/wait-for-ready');
const request = require('supertest');
const {toolErrorCode} = require('../helpers/tool-result');
const {testPort, redisFlag, startShell, stopAll} = require('../helpers/test-env');

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
const PORT              = testPort(9545);
const url               = `http://127.0.0.1:${PORT}`;
const AUTH_CONFIG_PATH  = `/tmp/countinghouse-test-auth-15-${process.pid}.json`;
const OPEN_PORT         = testPort(9546);
const openUrl           = `http://127.0.0.1:${OPEN_PORT}`;
const OPEN_CONFIG_PATH  = `/tmp/countinghouse-test-auth-15-open-${process.pid}.json`;

const ALICE = `alice-key-15-${process.pid}`;

// Small on purpose: the limiter's interval is fixed at 1000ms
// (lib/countinghouse-interface.js), so a burst has to overrun the budget
// well inside one second to be deterministic.
const LIMIT = 2;
const BURST = 8;

// echo-device-module's deviceID: deviceIDForName of its friendlyName
// (lib/call-address.js), the one derivation.
const DEVICE_ID = deviceIDForName('echo-device');

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

// a key over its budget on /mcp: every limiter's answer, -32000 with the
// limit's code (sent as 429 with Retry-After for a single request: A-rpc429)
const isKeyLimited = (answer) => answer != null && answer.error != null && answer.error.code === -32000 &&
  answer.error.data != null && answer.error.data['countinghouse/code'] === 'RATE_LIMIT_EXCEEDED';
function mcpDenials(responses) {
  return responses.filter((r) => {
    const body = (r.res != null) ? r.res.body : null;
    if (!isKeyLimited(body)) return false;
    // (a single request's limit is its 429, with when to retry)
    if (r.res.status !== 429 || r.res.headers['retry-after'] == null) throw new Error(`a limited answer sent as ${r.res.status}, Retry-After ${r.res.headers['retry-after']}`);
    return true;
  });
}

describe('auth 15: the authenticated read paths are rate limited', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    fs.writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(authConfig()), {mode: 0o600});

    console.log('starting countinghouse WITHOUT --debug, --apiKeyRateLimit, for read-path rate-limit test...');
    waitForReady(startShell(`"./bin/countinghouse"${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider file --authConfigPath ${AUTH_CONFIG_PATH
         } --apiKeyRateLimit ${LIMIT
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); }), done);
  });

  after((done) => {
    try { fs.unlinkSync(AUTH_CONFIG_PATH); } catch (e) {}
    stopAll(done);
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
                 result.structuredContent === undefined &&
                 toolErrorCode(result) === 'RATE_LIMIT_EXCEEDED';
        });
        if (denied.length === 0) {
          return done(new Error(`no check_balance call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body))}`));
        }
        return done();
      });
    });
  });

  // #482's high, round 3, 2: the task-creation limiter's refusal is the
  // typed one every other limiter answers, with its retry hint
  it('a task-augmented tools/call: a burst is denied as the typed RATE_LIMIT_EXCEEDED, with countinghouse/retryAfter', (done) => {
    drain(() => {
      const body = {jsonrpc: '2.0', id: 1, method: 'tools/call',
                    params: {name: 'echo_device_echoservice_echo', arguments: {foo: [{item1: 'x'}], bar: 'y'}, task: {}}};
      burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
        const denied = responses.map((r) => (r.res != null ? r.res.body.result : null))
          .filter((result) => result != null && result.isError === true && toolErrorCode(result) === 'RATE_LIMIT_EXCEEDED');
        if (denied.length === 0) {
          return done(new Error(`no task-augmented call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body))}`));
        }
        for (const result of denied) {
          if (result._meta['countinghouse/kind'] !== 'caller' || result._meta['countinghouse/retryAfter'] !== 1) {
            return done(new Error(`a refusal without its kind or hint: ${JSON.stringify(result)}`));
          }
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

  // M18's bounds audit: the 2026-07-28 task methods (M15's handleModernTask)
  // and a stored result's read (M6, countinghouse://r/) are limited before
  // any lookup too
  const MODERN_V = '2026-07-28';
  const modernReq = (method, params, name) => (cb) => {
    const body = {jsonrpc: '2.0', id: 1, method, params: Object.assign({_meta: {'io.modelcontextprotocol/protocolVersion': MODERN_V,
      'io.modelcontextprotocol/clientCapabilities': {extensions: {'io.modelcontextprotocol/tasks': {}}}}}, params)};
    request(url).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', ALICE)
      .set('MCP-Protocol-Version', MODERN_V).set('Mcp-Method', method).set('Mcp-Name', name).send(body).end(cb);
  };
  const NEVER = `t-${'0'.repeat(32)}`;
  [['tasks/get', {taskId: NEVER}], ['tasks/update', {taskId: NEVER, inputResponses: {}}], ['tasks/cancel', {taskId: NEVER}]].forEach(([method, params]) => {
    it(`2026-07-28 ${method}: a burst is denied before the task lookup`, (done) => {
      drain(() => {
        burst(BURST, modernReq(method, params, NEVER), (responses) => {
          if (mcpDenials(responses).length === 0) {
            return done(new Error(`no ${method} call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body))}`));
          }
          return done();
        });
      });
    });
  });

  it('resources/read of a stored result (countinghouse://r/): a burst is denied before the store is read', (done) => {
    drain(() => {
      const body = {jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri: `countinghouse://r/${'A'.repeat(43)}`}};
      burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
        const denied = mcpDenials(responses);
        if (denied.length === 0) {
          return done(new Error(`no read in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body.error))}`));
        }
        // (its data as every rate-limit error's: #482's high, round 3, 6)
        for (const r of denied) {
          const data = r.res.body.error.data;
          if (data == null || data['countinghouse/code'] !== 'RATE_LIMIT_EXCEEDED' || data['countinghouse/kind'] !== 'caller' || data['countinghouse/retryAfter'] !== 1) {
            return done(new Error(`a read's refusal without its code, kind or hint: ${JSON.stringify(r.res.body.error)}`));
          }
        }
        return done();
      });
    });
  });

  // #482's high, round 3, 6: a resource read refused by the limiter (a probe
  // of a URI never served, as a limited read of a module's resource) says the
  // code, its kind and when to retry, as every rate-limit error's data does
  it('resources/read of a URI never served: a burst is denied with the code, its kind and the hint in its data', (done) => {
    drain(() => {
      const body = {jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri: 'countinghouse://m/no-such-module-15/x'}};
      burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
        const denied = responses.filter((r) => r.res != null && r.res.body.error != null && r.res.body.error.data != null &&
          r.res.body.error.data['countinghouse/code'] === 'RATE_LIMIT_EXCEEDED');
        if (denied.length === 0) {
          return done(new Error(`no probe in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body.error))}`));
        }
        for (const r of denied) {
          const data = r.res.body.error.data;
          if (data['countinghouse/kind'] !== 'caller' || data['countinghouse/retryAfter'] !== 1) {
            return done(new Error(`a probe's refusal without its kind or hint: ${JSON.stringify(r.res.body.error)}`));
          }
        }
        return done();
      });
    });
  });

  // F3-3 (the Fable pass over the MCP surface): the lists a legacy batch could multiply
  ['tools/list', 'prompts/list'].forEach((method) => {
    it(`${method}: a burst is denied`, (done) => {
      drain(() => {
        const body = {jsonrpc: '2.0', id: 1, method, params: {}};
        burst(BURST, (cb) => mcpReq(url, ALICE, body, cb), (responses) => {
          if (mcpDenials(responses).length === 0) {
            return done(new Error(`no ${method} call in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.body.error))}`));
          }
          return done();
        });
      });
    });
  });

  it('tools/list with no key is answered as before (the built-ins), not refused', (done) => {
    drain(() => {
      mcpReq(url, null, {jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}, (err, res) => {
        if (err) return done(err);
        if (res.body == null || res.body.result == null || !Array.isArray(res.body.result.tools)) return done(new Error(`no list: ${JSON.stringify(res.body)}`));
        return done();
      });
    });
  });

  it('a legacy batch of list requests spends the budget once per request', (done) => {
    drain(() => {
      const batch = Array.from({length: BURST}, (_, i) => ({jsonrpc: '2.0', id: i + 1, method: 'tools/list', params: {}}));
      mcpReq(url, ALICE, batch, (err, res) => {
        if (err) return done(err);
        const answers = Array.isArray(res.body) ? res.body : [];
        if (answers.length !== BURST) return done(new Error(`${answers.length} answers: ${JSON.stringify(res.body).slice(0, 300)}`));
        // (a batch stays 200; its limited messages carry the limit's shape)
        if (res.status !== 200 || !answers.some(isKeyLimited)) {
          return done(new Error(`no list in a batch of ${BURST} was rate limited`));
        }
        return done();
      });
    });
  });

  it('a legacy batch of more than 32 messages is refused whole: 400, -32600, none of it run', (done) => {
    drain(() => {
      const batch = Array.from({length: 33}, (_, i) => ({jsonrpc: '2.0', id: i + 1, method: 'ping'}));
      mcpReq(url, ALICE, batch, (err, res) => {
        if (err) return done(err);
        if (res.status !== 400 || res.body == null || res.body.error == null || res.body.error.code !== -32600 || !/at most 32/.test(res.body.error.message)) {
          return done(new Error(`${res.status} ${JSON.stringify(res.body).slice(0, 300)}`));
        }
        return done();
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

  // The one device-scoped read the 7.0.0 work left out: it sat behind
  // userAuth like its neighbours, and docs/cross-cutting-matrix.md recorded
  // its rate-limit cell as "none".
  it('HTTP GET /package-info: a single call within budget still succeeds', (done) => {
    drain(() => {
      request(url).get(`/devices/${DEVICE_ID}/package-info`).set('X-CH-Key', ALICE)
        .expect(200, (err, res) => {
          if (err) return done(err);
          if (typeof res.body.name !== 'string' || typeof res.body.version !== 'string') {
            return done(new Error(`expected a package name and version, got: ${JSON.stringify(res.body)}`));
          }
          return done();
        });
    });
  });

  it('HTTP GET /package-info: a burst is denied with 429 RATE_LIMIT_EXCEEDED', (done) => {
    drain(() => {
      burst(BURST, (cb) => request(url).get(`/devices/${DEVICE_ID}/package-info`).set('X-CH-Key', ALICE).end(cb), (responses) => {
        const denied = httpDenials(responses);
        if (denied.length === 0) {
          return done(new Error(`no /package-info request in a burst of ${BURST} was rate limited: ${JSON.stringify(responses.map((r) => r.res && r.res.status))}`));
        }
        const body = denied[0].res.body;
        if (body.code !== 'RATE_LIMIT_EXCEEDED') {
          return done(new Error(`expected code RATE_LIMIT_EXCEEDED, got: ${JSON.stringify(body)}`));
        }
        if (body.name !== undefined || body.version !== undefined) {
          return done(new Error(`a denied request must not answer with package info: ${JSON.stringify(body)}`));
        }
        return done();
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
    fs.writeFileSync(OPEN_CONFIG_PATH, JSON.stringify(authConfig()), {mode: 0o600});

    console.log('starting countinghouse WITHOUT --apiKeyRateLimit, to check the paths stay open...');
    waitForReady(startShell(`"./bin/countinghouse"${redisFlag()} --workerThread --bindAddr 127.0.0.1 --port ${OPEN_PORT
         } --authProvider file --authConfigPath ${OPEN_CONFIG_PATH
         } --loadModule ./pre-installed-packages/echo-device-module`,
         (err, stdout, stderr) => { console.log(err); }), done);
  });

  after((done) => {
    try { fs.unlinkSync(OPEN_CONFIG_PATH); } catch (e) {}
    stopAll(done);
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
