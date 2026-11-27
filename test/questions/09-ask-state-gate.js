'use strict';
// A retry's single-use requestState is spent only once the call has passed
// its gates: a retry refused there -- its key over its budget
// (RATE_LIMIT_EXCEEDED), a charge that can't be recorded (a ledger code) --
// keeps its state, and so does one the server-wide limit refuses
// (RUNTIME_BUSY); the client's next retry with the same state is served
// with its answer, never ASK_STATE_INVALID. Three servers: one with a
// per-key limit of one call a second; one with a server-wide limit of one;
// one whose caller's usage record has a balance that isn't a number (read,
// it marks that key).
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const redis   = require('redis');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort, redisConnectionFor} = require('../helpers/test-env');
const {meterId} = require('../../lib/key-fingerprint');

const ASKS   = path.join(ROOT, 'test', 'fixtures', 'asks-questions');
const FORMS  = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
  'io.modelcontextprotocol/clientInfo': {name: 'test', version: '1.0.0'}};
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const trees  = require('../helpers/test-tmp').forFile(['ch-questions-09-']);

function server(port, keys, extra) {
  const url = `http://127.0.0.1:${port}`;
  const s = {url, server: null, tool: null};
  let nextId = 1;
  s.mcp = (key, method, params) => new Promise((resolve, reject) => {
    const req = request(url).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2026-07-28').set('Mcp-Method', method);
    if (params != null && typeof(params.name) === 'string') req.set('Mcp-Name', params.name);
    req.send({jsonrpc: '2.0', id: nextId++, method, params: Object.assign({_meta: FORMS}, params)})
      .end((err, res) => (err ? reject(err) : resolve(res.body)));
  });
  s.start = async (setupKey) => {
    const base = trees.mkdtemp('ch-questions-09-');
    const auth = path.join(base, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify(Object.fromEntries(keys.map((k) => [k, {userName: k.slice(0, 8), devices: ['*']}]))), {mode: 0o600});
    s.server = await startServer(port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth, '--mcpToolCallCost', '1',
      '--moduleDataPath', path.join(base, 'module_data'), '--loadModule', ASKS, ...extra]);
    let list = null;
    for (let i = 0; i < 120 && s.tool == null; i++) {
      list = await s.mcp(setupKey, 'tools/list', {});
      s.tool = list != null && list.result != null ? ((list.result.tools.find((x) => /probe$/.test(x.name)) || {}).name || null) : null;
      if (s.tool == null) await sleep(250);
    }
    assert.ok(s.tool != null, `the module never listed: ${JSON.stringify(list).slice(0, 600)}\n${s.server.output.slice(-1500)}`);
  };
  s.call = (key, args, extra2 = {}) => s.mcp(key, 'tools/call', Object.assign({name: s.tool, arguments: args}, extra2));
  return s;
}
const accept = (state, content) => ({requestState: state, inputResponses: {answer: {action: 'accept', content}}});
const codeOf = (got) => (got != null && got.result != null && got.result._meta != null ? got.result._meta['countinghouse/code'] : null);
// the retry again, a while apart, until the gate lets it through (bounded):
// the answer it is then given
async function retriedPast(s, key, state, code) {
  let got = null;
  for (let i = 0; i < 10; i++) {
    got = await s.call(key, {what: 'it'}, accept(state, {yes: true}));
    if (codeOf(got) !== code) return got;
    await sleep(1100);
  }
  return got;
}

describe('questions 09: a retry refused at its gates keeps its requestState', function() {
  this.timeout(120000);

  // (server free: the gate a retry passes before its state is spent)
  describe('the retry\'s gate itself (lib/mcp/gateway.js gateRetry)', () => {
    const {gateRetryForTests: gateRetry} = require('../../lib/mcp/gateway');
    const {CountinghouseError} = require('../../lib/countinghouse-error');
    const logger = require('../../lib/logger');
    let realE = null;
    before(() => { realE = logger.E; logger.E = () => {}; });
    after(() => { logger.E = realE; });

    it('passed: the call marked gated; refused: the refusal, not gated; a gate that throws: RUNTIME_BUSY, not gated', async () => {
      const passed = {};
      assert.strictEqual(await gateRetry({callGate: (session, cb) => setImmediate(cb, null)}, passed), null);
      assert.strictEqual(passed.gated, true);
      const refused = {};
      const over = await gateRetry({callGate: (session, cb) => setImmediate(cb, new CountinghouseError('RATE_LIMIT_EXCEEDED'))}, refused);
      assert.strictEqual(over.code, 'RATE_LIMIT_EXCEEDED');
      assert.strictEqual(refused.gated, undefined);
      const threw = {};
      const busy = await gateRetry({callGate: () => { throw new Error('the limiter broke'); }}, threw);
      assert.strictEqual(busy && busy.code, 'RUNTIME_BUSY');
      assert.strictEqual(threw.gated, undefined);
    });
  });

  describe('its key over its budget (RATE_LIMIT_EXCEEDED)', () => {
    const SETUP = `k${crypto.randomBytes(12).toString('hex')}`;
    const CALLER = `k${crypto.randomBytes(12).toString('hex')}`;
    const s = server(testPort(9840), [SETUP, CALLER], ['--apiKeyRateLimit', '1']);
    before(() => s.start(SETUP));
    after(() => stopServer(s.server));

    it('refused over its budget, then retried with the same state: served with its answer', async () => {
      const first = await s.call(CALLER, {what: 'it'});
      assert.strictEqual(first.result && first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 500));
      const refused = await s.call(CALLER, {what: 'it'}, accept(first.result.requestState, {yes: true}));
      assert.strictEqual(codeOf(refused), 'RATE_LIMIT_EXCEEDED', JSON.stringify(refused).slice(0, 500));
      const done = await retriedPast(s, CALLER, first.result.requestState, 'RATE_LIMIT_EXCEEDED');
      assert.ok(done.result != null && done.result.structuredContent != null, `${codeOf(done)}: ${JSON.stringify(done).slice(0, 500)}`);
      assert.deepStrictEqual([done.result.structuredContent.asked, done.result.structuredContent.answer], [true, {yes: true}]);
    });
  });

  describe('the runtime at its limit (RUNTIME_BUSY)', () => {
    const SETUP = `k${crypto.randomBytes(12).toString('hex')}`;
    const CALLER = `k${crypto.randomBytes(12).toString('hex')}`;
    const s = server(testPort(9842), [SETUP, CALLER], ['--globalRateLimit', '1']);
    before(() => s.start(SETUP));
    after(() => stopServer(s.server));

    it('refused for the server-wide limit, then retried with the same state: served with its answer', async () => {
      const first = await s.call(CALLER, {what: 'it'});
      assert.strictEqual(first.result && first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 500));
      const refused = await s.call(CALLER, {what: 'it'}, accept(first.result.requestState, {yes: true}));
      assert.strictEqual(codeOf(refused), 'RUNTIME_BUSY', JSON.stringify(refused).slice(0, 500));
      const done = await retriedPast(s, CALLER, first.result.requestState, 'RUNTIME_BUSY');
      assert.ok(done.result != null && done.result.structuredContent != null, `${codeOf(done)}: ${JSON.stringify(done).slice(0, 500)}`);
      assert.deepStrictEqual([done.result.structuredContent.asked, done.result.structuredContent.answer], [true, {yes: true}]);
    });
  });

  describe('its charge can\'t be recorded (LEDGER_RECORD_INVALID)', () => {
    const SETUP = `k${crypto.randomBytes(12).toString('hex')}`;
    const CALLER = `k${crypto.randomBytes(12).toString('hex')}`;
    const s = server(testPort(9841), [SETUP, CALLER], []);
    let ledger = null;
    const cmd = (name, ...args) => new Promise((resolve, reject) => ledger[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
    before(async () => {
      ledger = redis.createClient(redisConnectionFor(0));
      ledger.on('error', () => {});
      await s.start(SETUP);
    });
    after(async () => {
      stopServer(s.server);
      if (ledger != null) { await cmd('del', meterId(CALLER)).catch(() => {}); ledger.quit(); }
    });

    it('refused while its record can\'t be charged, then repaired and retried with the same state: served with its answer', async () => {
      await cmd('hset', meterId(CALLER), 'balance', 'abc');
      const first = await s.call(CALLER, {what: 'it'});
      assert.strictEqual(first.result && first.result.resultType, 'input_required', JSON.stringify(first).slice(0, 500));
      // (its balance read: the key is marked)
      assert.strictEqual((await request(s.url).get('/balance').set('X-CH-Key', CALLER)).body.code, 'LEDGER_RECORD_INVALID');
      const refused = await s.call(CALLER, {what: 'it'}, accept(first.result.requestState, {yes: true}));
      assert.strictEqual(codeOf(refused), 'LEDGER_RECORD_INVALID', JSON.stringify(refused).slice(0, 500));
      await cmd('hset', meterId(CALLER), 'balance', '10');
      const done = await retriedPast(s, CALLER, first.result.requestState, 'LEDGER_RECORD_INVALID');
      assert.ok(done.result != null && done.result.structuredContent != null, `${codeOf(done)}: ${JSON.stringify(done).slice(0, 500)}`);
      assert.deepStrictEqual([done.result.structuredContent.asked, done.result.structuredContent.answer], [true, {yes: true}]);
    });
  });

  trees.hooks();
});
