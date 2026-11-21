'use strict';
// One rate-limit shape on /mcp (A-rpc429, from #482's merge): a key over its
// budget on tools/list or a tasks/* method answers as the limit on keys that
// don't resolve does (lib/unauth-limit.js): a JSON-RPC error -32000, the
// catalogue's message, data {countinghouse/code, countinghouse/kind,
// countinghouse/retryAfter}; a single request is sent with its code's
// catalogue status (429, or 503 for RUNTIME_BUSY) and Retry-After from its own
// hint; a batch stays 200, with Retry-After the longest hint. Before: -32603,
// 'rate limit exceeded', 200, no Retry-After. In process: the /mcp route on
// an Express app of its own, the key resolved by --debug (no debug key), the
// per-key limiter a stub. No server, no Redis.
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const optionsScope = require('../helpers/options-scope');
const {CountinghouseError, setRetryAfter} = require('../../lib/countinghouse-error');

const KEY = 'rpc-limit-test-key';
// the key's limiter: over budget, 1.5 s left of a 60 s window
const overBudget = {rateLimit: (k, cb) => cb(null, {limited: true, timeLeft: 1500, windowMs: 60000})};
const legacy = (method, params = {}, id = 1) => ({jsonrpc: '2.0', id, method, params});

describe('mcp-contract 43: one rate-limit shape on /mcp (A-rpc429)', () => {
  let kept;
  let app;
  before(function() {
    // (the libs' first load under its own bound, not a case's 2 s)
    this.timeout(10000);
    require('../../lib/mcp/gateway');
    // (--debug with no debug key: any key resolves; set here, never at load)
    kept = optionsScope.snapshot();
    require('../../lib/cli-options').setOptions({debug: true, debugKey: null});
    app = express();
    app.use(express.json());
    app.use('/mcp', require('../../lib/routes/mcp')(null, overBudget));
  });
  after(() => optionsScope.restore(kept));

  const post = (body) => request(app).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', KEY).send(body);
  const limited = (answer) => {
    assert.strictEqual(answer.error.code, -32000, JSON.stringify(answer));
    assert.strictEqual(answer.error.message, require('../../lib/error-catalogue').CODES.RATE_LIMIT_EXCEEDED.en);
    assert.deepStrictEqual(answer.error.data, {'countinghouse/code': 'RATE_LIMIT_EXCEEDED', 'countinghouse/kind': 'caller', 'countinghouse/retryAfter': 2});
  };

  it('tools/list over the key\'s budget: 429, Retry-After from the limiter\'s hint, -32000 with the limit\'s data', async () => {
    const res = await post(legacy('tools/list', {}, 11));
    assert.strictEqual(res.status, 429, res.text);
    assert.strictEqual(res.headers['retry-after'], '2');
    assert.strictEqual(res.body.id, 11);
    limited(res.body);
  });

  it('a tasks/* method over the key\'s budget: the same', async () => {
    const res = await post(legacy('tasks/get', {taskId: 'x'}, 12));
    assert.strictEqual(res.status, 429, res.text);
    assert.strictEqual(res.headers['retry-after'], '2');
    limited(res.body);
  });

  it('a batch: 200, each limited message answered in the limit\'s shape, Retry-After the longest hint', async () => {
    const res = await post([legacy('tools/list', {}, 21), legacy('tasks/get', {taskId: 'x'}, 22)]);
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.headers['retry-after'], '2');
    assert.deepStrictEqual(res.body.map((a) => a.id).sort(), [21, 22]);
    for (const a of res.body) limited(a);
  });

  it('the shape and its status: RUNTIME_BUSY is 503, RATE_LIMIT_EXCEEDED and UNAUTH_RATE_LIMITED 429; Retry-After the answer\'s own hint', () => {
    const {limitAnswer, answerLimit} = require('../../lib/mcp/error-data');
    const sent = (answer) => {
      const r = {headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }};
      return [answerLimit(r, answer), r.code, r.headers['Retry-After']];
    };
    const busy = limitAnswer(1, setRetryAfter(new CountinghouseError('RUNTIME_BUSY'), 1000, 1000));
    assert.deepStrictEqual([busy.error.code, busy.error.data['countinghouse/code'], busy.error.data['countinghouse/kind']], [-32000, 'RUNTIME_BUSY', 'runtime']);
    assert.deepStrictEqual(sent(busy), [true, 503, '1']);
    assert.deepStrictEqual(sent(limitAnswer(2, setRetryAfter(new CountinghouseError('RATE_LIMIT_EXCEEDED'), 1500, 60000))), [true, 429, '2']);
    assert.deepStrictEqual(sent(limitAnswer(3, setRetryAfter(new CountinghouseError('UNAUTH_RATE_LIMITED'), 3000, 60000))), [true, 429, '3']);
  });

  it('an answer that only carries a limit\'s code (not -32000), or another -32000, is never sent as the limit', () => {
    const {answerLimit} = require('../../lib/mcp/error-data');
    const r = {set() { throw new Error('a header was set'); }, status() { throw new Error('a status was set'); }, json() { throw new Error('sent'); }};
    // (a resource read's error, its tool result's _meta copied: -32603)
    assert.strictEqual(answerLimit(r, {jsonrpc: '2.0', id: 1, error: {code: -32603, message: 'x', data: {'countinghouse/code': 'RATE_LIMIT_EXCEEDED', 'countinghouse/retryAfter': 9}}}), false);
    assert.strictEqual(answerLimit(r, {jsonrpc: '2.0', id: 1, error: {code: -32000, message: 'x', data: {'countinghouse/code': 'SOMETHING_ELSE'}}}), false);
    assert.strictEqual(answerLimit(r, {jsonrpc: '2.0', id: 1, result: {}}), false);
  });
});
