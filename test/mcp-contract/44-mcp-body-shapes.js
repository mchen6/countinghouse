'use strict';
// POST /mcp's answers to a body that is no request (the final pass's gateway
// part, A13): JSON-RPC 2.0's own, never REST's shape or a bare 202.
// - an empty batch, `[]`: one Invalid Request error (-32600), as the spec
//   says, where it answered 202 with no body, as if every message had been a
//   notification;
// - a body that is not JSON: a Parse error (-32700) in JSON-RPC's shape,
//   where the app's error handler answered REST's {code, message, kind}.
// In-process: the route and the app's error handler on express, as
// route-manager mounts them (mcp-contract 43's way).
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const optionsScope = require('../helpers/options-scope');

describe('mcp-contract 44: POST /mcp answers a body that is no request in JSON-RPC\'s shape (A13)', () => {
  let kept;
  let app;
  before(function() {
    this.timeout(10000);
    require('../../lib/mcp/gateway');
    kept = optionsScope.snapshot();
    require('../../lib/cli-options').setOptions({debug: true, debugKey: null});
    app = express();
    app.use(express.json());
    app.use('/mcp', require('../../lib/routes/mcp')(null, {rateLimit: (k, cb) => cb(null, {limited: false})}));
    // (route-manager's own last handler, the one every route's body error reaches)
    app.use(require('../../lib/route-manager').bodyErrorHandler);
  });
  after(() => { if (kept != null) optionsScope.restore(kept); });

  const post = (raw) => request(app).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', 'k').send(raw);

  it('an empty batch is one Invalid Request error, -32600, never a bare 202', async () => {
    const res = await post('[]');
    assert.strictEqual(res.status, 400, `${res.status} ${res.text}`);
    assert.deepStrictEqual([res.body.jsonrpc, res.body.id, res.body.error && res.body.error.code], ['2.0', null, -32600], res.text);
  });

  it('a body that is not JSON is a Parse error, -32700, in JSON-RPC\'s shape', async () => {
    const res = await post('{"jsonrpc": "2.0", "id": 1, "method": ');
    assert.strictEqual(res.status, 400, `${res.status} ${res.text}`);
    assert.deepStrictEqual([res.body.jsonrpc, res.body.id, res.body.error && res.body.error.code], ['2.0', null, -32700], res.text);
    assert.strictEqual(res.body.code, undefined, 'never REST\'s shape');
    assert.ok(res.headers['mcp-protocol-version'] != null, 'the protocol header, as the route sets it');
  });

  // (the medium on PR 2) JSON that is no request: Invalid Request, not Parse error
  it('a body that is JSON but no object or array is Invalid Request, -32600', async () => {
    for (const raw of ['123', '"x"']) {
      const res = await post(raw);
      assert.strictEqual(res.status, 400, `${raw}: ${res.text}`);
      assert.strictEqual(res.body.error && res.body.error.code, -32600, `${raw}: ${res.text}`);
    }
  });

  // (#531's high, L6) Express routes /MCP to /mcp: the answer is the same
  it('POST /MCP, as Express routes it, answers in JSON-RPC\'s shape too', async () => {
    const res = await request(app).post('/MCP').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream').set('X-CH-Key', 'k').send('{bad');
    assert.strictEqual(res.status, 400, res.text);
    assert.strictEqual(res.body.error && res.body.error.code, -32700, res.text);
  });

  it('a REST route\'s body error keeps REST\'s shape', async () => {
    const rest = express();
    rest.use(express.json());
    rest.post('/devices/x/invoke-action', (req, res) => res.json({}));
    rest.use(require('../../lib/route-manager').bodyErrorHandler);
    const res = await request(rest).post('/devices/x/invoke-action').set('Content-Type', 'application/json').send('{bad');
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(res.body, {code: 'REQUEST_INVALID', message: 'request body could not be read', kind: 'caller'});
  });
});
