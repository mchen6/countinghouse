'use strict';
// MCP 2026-07-28 discovery and versioning (#229), server-free: the gateway
// called directly (stdio's path) and the /mcp route mounted on an Express app
// of its own (HTTP's path). Nothing here reaches a module, so no runtime runs.
//
// The revision removes initialize ("Make MCP stateless: remove the
// initialize/notifications/initialized handshake") and says of server/discover
// "Servers MUST implement it". A request carrying modern per-request _meta is
// served statelessly by this revision; an initialize selects legacy semantics
// (basic/versioning.md). Over HTTP the MCP-Protocol-Version, Mcp-Method and
// Mcp-Name headers must match the body (-32020, 400); an unsupported version
// is -32022 with data {supported, requested} (400); an unknown method is 404
// with -32601 (basic/transports/streamable-http.md); every result carries
// resultType (schema: "Servers implementing this protocol version MUST include
// this field").
const assert = require('assert');
const express = require('express');
const request = require('supertest');
const gateway = require('../../lib/mcp/gateway');
const era = require('../../lib/mcp/era');

const V = '2026-07-28';
const META = {
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': {name: 'eras-test', version: '0'}
};
const modern = (method, params = {}, id = 1) => ({jsonrpc: '2.0', id, method, params: Object.assign({_meta: META}, params)});
const viaGateway = (message, opts) => new Promise((resolve, reject) => {
  gateway.handle(message, null, null, (err, res, info) => (err != null ? reject(err) : resolve({res, info})), opts);
});

describe('MCP 2026-07-28 discovery and versioning (#229)', () => {
  describe('the gateway (stdio)', () => {
    it('server/discover: resultType complete, the supported versions, capabilities and serverInfo', async() => {
      const {res} = await viaGateway(modern('server/discover'));
      assert.strictEqual(res.error, undefined, JSON.stringify(res));
      assert.strictEqual(res.result.resultType, 'complete');
      assert.deepStrictEqual(res.result.supportedVersions, [V]);
      assert.strictEqual(typeof(res.result.capabilities.tools), 'object');
      assert.deepStrictEqual(res.result._meta['io.modelcontextprotocol/serverInfo'], {name: 'countinghouse', version: require('../../package.json').version});
    });

    it('server/discover without the required _meta is malformed: -32602', async() => {
      const {res} = await viaGateway({jsonrpc: '2.0', id: 2, method: 'server/discover', params: {}});
      assert.strictEqual(res.error.code, -32602, JSON.stringify(res));
    });

    it('a modern request without clientCapabilities is malformed: -32602', async() => {
      const meta = Object.assign({}, META);
      delete meta['io.modelcontextprotocol/clientCapabilities'];
      const {res} = await viaGateway({jsonrpc: '2.0', id: 3, method: 'server/discover', params: {_meta: meta}});
      assert.strictEqual(res.error.code, -32602, JSON.stringify(res));
    });

    it('an unsupported version: -32022 with data {supported, requested}', async() => {
      const meta = Object.assign({}, META, {'io.modelcontextprotocol/protocolVersion': '1900-01-01'});
      const {res} = await viaGateway({jsonrpc: '2.0', id: 4, method: 'server/discover', params: {_meta: meta}});
      assert.strictEqual(res.error.code, -32022, JSON.stringify(res));
      assert.deepStrictEqual(res.error.data, {supported: [V], requested: '1900-01-01'});
    });

    it('ping is removed in 2026-07-28: a modern one is unknown (-32601, 404); a legacy one still answers {}', async() => {
      const now = await viaGateway(modern('ping', {}, 5));
      assert.strictEqual(now.res.error.code, -32601, JSON.stringify(now.res));
      assert.strictEqual(now.info && now.info.status, 404);
      const legacy = await viaGateway({jsonrpc: '2.0', id: 6, method: 'ping'});
      assert.deepStrictEqual(legacy.res.result, {});
    });

    it('discover carries its caching hints and serverInfo', async() => {
      const {res} = await viaGateway(modern('server/discover', {}, 9));
      assert.strictEqual(res.result.ttlMs, 0);
      assert.strictEqual(res.result.cacheScope, 'public');
    });

    it('initialize stays the legacy path: it echoes a legacy version, with no resultType', async() => {
      const {res} = await viaGateway({jsonrpc: '2.0', id: 7, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'legacy', version: '0'}}});
      assert.strictEqual(res.result.protocolVersion, '2025-11-25');
      assert.strictEqual(res.result.resultType, undefined);
    });

    // (the final pass's gateway part, A13) a task's ttlMs: the job timeout
    // and the result's retention under --store local, or null where there is
    // no bound: Redis keeps a finished job, and --jobTimeout 0 is no timeout.
    // It said 0 there, a task already expired.
    it('a task\'s ttlMs is null with no bound (Redis, or --jobTimeout 0), else the timeout plus the retention', () => {
      const o = require('../../lib/cli-options');
      const kept = {store: o.store, jobTimeout: o.jobTimeout, jobResultTtl: o.jobResultTtl};
      const ttl = require('../../lib/mcp/gateway').taskTtlMsFor;
      try {
        Object.assign(o, {store: 'local', jobTimeout: 0, jobResultTtl: 0});
        assert.strictEqual(ttl(), null, 'no timeout');
        Object.assign(o, {jobResultTtl: 5000});
        assert.strictEqual(ttl(), null, 'no timeout, a retention');
        Object.assign(o, {jobTimeout: 1000, jobResultTtl: 500});
        assert.strictEqual(ttl(), 1500);
        Object.assign(o, {store: 'redis'});
        assert.strictEqual(ttl(), null);
        // (the medium on PR 2) a result kept forever (--jobResultTtl 0) is no
        // bound either; and a cancel's tombstone still expires under
        // --jobTimeout 0, after the retention, as it did
        Object.assign(o, {store: 'local', jobTimeout: 60000, jobResultTtl: 0});
        assert.strictEqual(ttl(), null, 'kept forever');
        const tomb = require('../../lib/mcp/gateway').tombstoneTtlMsFor;
        Object.assign(o, {store: 'local', jobTimeout: 0, jobResultTtl: 3600000});
        assert.strictEqual(tomb(), 3600000);
        // (#531's high, L3) and a cancelled task says that ttl, where its
        // tombstone expires; none where nothing bounds it
        const view = require('../../lib/mcp/gateway').cancelledTaskView;
        const T = {createdAt: '2026-11-21T00:00:00.000Z', cancelledAt: '2026-11-21T00:00:01.000Z'};
        assert.strictEqual(view('t1', T).ttlMs, 3600000);
        Object.assign(o, {store: 'local', jobTimeout: 0, jobResultTtl: 0});
        assert.strictEqual(view('t1', T).ttlMs, null);
        Object.assign(o, {store: 'redis', jobTimeout: 60000, jobResultTtl: 3600000});
        assert.strictEqual(view('t1', T).ttlMs, null);
      } finally {
        Object.assign(o, kept);
      }
    });

    // (the final pass's gateway part, A11) a version that isn't a legacy one
    // is not echoed: a client that then sent it in MCP-Protocol-Version would
    // be read as modern, and refused
    it('initialize echoes only a legacy version: any other is answered with the server\'s legacy one', async() => {
      for (const [asked, answered] of [['2025-03-26', '2025-03-26'], ['2026-07-28', '2025-11-25'], ['2099-01-01', '2025-11-25'], ['bogus', '2025-11-25']]) {
        const {res} = await viaGateway({jsonrpc: '2.0', id: 9, method: 'initialize', params: {protocolVersion: asked, capabilities: {}, clientInfo: {name: 'c', version: '0'}}});
        assert.strictEqual(res.result.protocolVersion, answered, asked);
      }
    });

    it('a modern unknown method: -32601, and HTTP would answer it 404', async() => {
      // roots/list is a client's method: no server here serves it (resources/list is, since M6)
      const {res, info} = await viaGateway(modern('roots/list', {}, 8));
      assert.strictEqual(res.error.code, -32601);
      assert.strictEqual(info && info.status, 404);
    });

    it('a notification gets no answer, whatever its method', async() => {
      const {res} = await viaGateway({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 1}});
      assert.strictEqual(res, null);
    });

    it('any message without an id is a notification: an id-less ping or logging/setLevel gets no answer', async() => {
      assert.strictEqual((await viaGateway({jsonrpc: '2.0', method: 'ping'})).res, null);
      assert.strictEqual((await viaGateway({jsonrpc: '2.0', method: 'logging/setLevel', params: {level: 'info'}})).res, null);
    });

    it('id null is an invalid request: -32600', async() => {
      const {res} = await viaGateway({jsonrpc: '2.0', id: null, method: 'ping'});
      assert.strictEqual(res.error.code, -32600, JSON.stringify(res));
    });
  });

  describe('tasks for a modern request: the extension, not the legacy methods (#232, M15)', () => {
    const options = require('../../lib/cli-options');
    let workerThread;
    before(() => { workerThread = options.workerThread; options.workerThread = true; });
    after(() => { options.workerThread = workerThread; });

    it('server/discover advertises the tasks extension, not the legacy tasks capability; a legacy initialize still has that', async() => {
      const now = await viaGateway(modern('server/discover', {}, 20));
      assert.strictEqual(now.res.result.capabilities.tasks, undefined, JSON.stringify(now.res.result.capabilities));
      assert.deepStrictEqual(now.res.result.capabilities.extensions, {'io.modelcontextprotocol/tasks': {}});
      const legacy = await viaGateway({jsonrpc: '2.0', id: 21, method: 'initialize', params: {protocolVersion: '2025-11-25', capabilities: {}}});
      assert.ok(legacy.res.result.capabilities.tasks != null);
    });

    it('modern tasks/result and tasks/list are unknown methods: -32601, 404', async() => {
      for (const method of ['tasks/result', 'tasks/list']) {
        const {res, info} = await viaGateway(modern(method, {taskId: 'x'}, 22));
        assert.strictEqual(res.error.code, -32601, `${method}: ${JSON.stringify(res)}`);
        assert.strictEqual(info && info.status, 404, method);
      }
    });

    // M15: the extension's methods, for a request that does not declare it
    // (mcp-contract 27 has the rest)
    it('modern tasks/get, tasks/update and tasks/cancel without the extension declared are the gate\'s -32021', async() => {
      for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
        const {res} = await viaGateway(modern(method, {taskId: 'x'}, 23));
        assert.strictEqual(res.error.code, -32021, `${method}: ${JSON.stringify(res)}`);
      }
    });
  });

  describe('the client a request names (P2)', () => {
    const clientInfo = require('../../lib/mcp/client-info');
    afterEach(() => clientInfo.resetForTests());
    const CC = {name: 'claude-code', version: '2.1.323'};

    it('a modern request uses only its own _meta: no client borrowed from a legacy initialize', () => {
      clientInfo.record(CC);
      const ctx = clientInfo.contextOf({_meta: {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}}}, true);
      assert.strictEqual(ctx.clientInfo, null);
      assert.deepStrictEqual(ctx.capabilities, {elicitation: {}});
    });

    it('a legacy request has no capabilities to form with, whatever its _meta says', () => {
      clientInfo.record(CC);
      const ctx = clientInfo.contextOf({_meta: {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}}}, false);
      assert.deepStrictEqual(ctx.clientInfo, CC);
      assert.strictEqual(ctx.capabilities, null);
    });
  });

  describe('the Mcp-Name value encoding', () => {
    it('decodes the base64 sentinel form, and leaves a plain value as it is', () => {
      assert.strictEqual(era.decodeHeaderValue(`=?base64?${Buffer.from('héllo').toString('base64')}?=`), 'héllo');
      assert.strictEqual(era.decodeHeaderValue('countinghouse_settings'), 'countinghouse_settings');
    });
  });

  describe('the /mcp route (HTTP)', () => {
    let app;
    before(() => {
      app = express();
      app.use(express.json());
      app.use('/mcp', require('../../lib/routes/mcp')(null, null));
    });
    const post = (body, headers) => {
      let r = request(app).post('/mcp').set('Content-Type', 'application/json').set('Accept', 'application/json, text/event-stream');
      for (const [k, v] of Object.entries(headers || {})) r = r.set(k, v);
      return r.send(body);
    };
    const H = (method, extra) => Object.assign({'MCP-Protocol-Version': V, 'Mcp-Method': method}, extra);

    it('server/discover with matching headers: 200 and the discovery result', async() => {
      const res = await post(modern('server/discover'), H('server/discover'));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.result.resultType, 'complete');
      assert.deepStrictEqual(res.body.result.supportedVersions, [V]);
      assert.strictEqual(res.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'countinghouse');
    });

    it('a modern request without MCP-Protocol-Version: 400, -32020', async() => {
      const res = await post(modern('server/discover'), {'Mcp-Method': 'server/discover'});
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, -32020);
    });

    it('MCP-Protocol-Version unlike the body\'s: 400, -32020', async() => {
      const res = await post(modern('server/discover'), H('server/discover', {'MCP-Protocol-Version': '2025-11-25'}));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, -32020);
    });

    it('Mcp-Method missing, or unlike the body\'s method: 400, -32020', async() => {
      const none = await post(modern('server/discover'), {'MCP-Protocol-Version': V});
      assert.strictEqual(none.status, 400);
      assert.strictEqual(none.body.error.code, -32020);
      const other = await post(modern('server/discover'), H('tools/list'));
      assert.strictEqual(other.status, 400);
      assert.strictEqual(other.body.error.code, -32020);
    });

    it('tools/call without Mcp-Name, or with one (encoded) unlike params.name: 400, -32020', async() => {
      const call = modern('tools/call', {name: 'countinghouse_settings', arguments: {action: 'get'}});
      const none = await post(call, H('tools/call'));
      assert.strictEqual(none.status, 400);
      assert.strictEqual(none.body.error.code, -32020);
      const other = await post(call, H('tools/call', {'Mcp-Name': `=?base64?${Buffer.from('another_tool').toString('base64')}?=`}));
      assert.strictEqual(other.status, 400);
      assert.strictEqual(other.body.error.code, -32020);
    });

    it('an unsupported version: 400, -32022 with data {supported, requested}', async() => {
      const meta = Object.assign({}, META, {'io.modelcontextprotocol/protocolVersion': '1900-01-01'});
      const res = await post({jsonrpc: '2.0', id: 1, method: 'server/discover', params: {_meta: meta}}, H('server/discover', {'MCP-Protocol-Version': '1900-01-01'}));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, -32022);
      assert.deepStrictEqual(res.body.error.data, {supported: [V], requested: '1900-01-01'});
    });

    it('missing required _meta: 400, -32602', async() => {
      const res = await post({jsonrpc: '2.0', id: 1, method: 'server/discover', params: {}}, H('server/discover'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, -32602);
    });

    it('a modern unknown method: 404, -32601; a legacy one stays 200', async() => {
      const now = await post(modern('roots/list'), H('roots/list'));
      assert.strictEqual(now.status, 404);
      assert.strictEqual(now.body.error.code, -32601);
      const legacy = await post({jsonrpc: '2.0', id: 1, method: 'roots/list'});
      assert.strictEqual(legacy.status, 200);
      assert.strictEqual(legacy.body.error.code, -32601);
    });

    it('a modern version in the header makes the request modern: a body without _meta is 400, -32602', async() => {
      const res = await post({jsonrpc: '2.0', id: 1, method: 'ping'}, H('tools/list'));
      assert.strictEqual(res.status, 400, JSON.stringify(res.body));
      assert.strictEqual(res.body.error.code, -32602);
      const legacy = await post({jsonrpc: '2.0', id: 2, method: 'ping'}, {'MCP-Protocol-Version': '2025-11-25'});
      assert.strictEqual(legacy.status, 200);
      assert.deepStrictEqual(legacy.body.result, {});
    });

    it('an id-less request over HTTP is a notification: 202, no body', async() => {
      const res = await post({jsonrpc: '2.0', method: 'logging/setLevel', params: {level: 'info'}});
      assert.strictEqual(res.status, 202);
      assert.deepStrictEqual(res.body, {});
    });

    it('a modern request inside a batch: 400, -32600 (one message per POST)', async() => {
      const res = await post([modern('server/discover')], H('server/discover'));
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error.code, -32600);
    });

    it('a notification: 202 and no body', async() => {
      const res = await post({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 1}}, {'MCP-Protocol-Version': V});
      assert.strictEqual(res.status, 202);
    });
  });
});
