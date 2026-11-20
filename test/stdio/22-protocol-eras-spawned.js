'use strict';
// MCP 2026-07-28 over real stdio (#229): a client that probes with
// server/discover, as the stdio transport page tells a modern client to
// ("probe with server/discover and fall back on any error that is not a
// recognized modern error"), gets a discovery result, not -32601, so it stays
// modern. Its requests are served without initialize, each result carrying
// resultType; an initialize still opens a legacy session.
const assert = require('assert');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE, MODERN_META} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

// a module the session's key may call, as stdio 02 runs it
const MODULE = path.join(__dirname, '..', 'fixtures', 'handler-map-module');
const KEY = 'stdio-22-key';
function startWithModule(home) {
  const auth = path.join(home, 'auth.json');
  require('fs').writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
  return startStdio(['--workerThread', '--loadModule', MODULE, '--authConfigPath', auth, '--moduleDataPath', path.join(home, 'module_data'),
    '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`], {env: {COUNTINGHOUSE_API_KEY: KEY}});
}
function start(home) {
  return startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data')]);
}

describe('stdio 22: 2026-07-28 discovery and versioning, spawned (#229)', function() {
  this.timeout(120000);
  let home;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-s22-'); });
  afterEach(async() => { if (io != null) await io.stop(); io = null; tmp.remove(home); });

  it('server/discover first, then tools/list with no initialize: both resultType complete', async() => {
    io = start(home);
    const found = await io.request({jsonrpc: '2.0', id: 1, method: 'server/discover', params: {_meta: MODERN_META}}, 30000);
    assert.ok(found.result != null, `${JSON.stringify(found)}; ${withoutRedisNoise(io.err)}`);
    assert.strictEqual(found.result.resultType, 'complete');
    assert.deepStrictEqual(found.result.supportedVersions, ['2026-07-28']);
    assert.strictEqual(found.result._meta['io.modelcontextprotocol/serverInfo'].name, 'countinghouse');
    const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {_meta: MODERN_META}}, 30000);
    assert.strictEqual(list.result.resultType, 'complete', JSON.stringify(list));
    assert.ok(Array.isArray(list.result.tools));
    // caching hints (server/utilities/caching: "Servers MUST include caching
    // hints" on tools/list): the list changes in place and per key
    assert.strictEqual(list.result.ttlMs, 0);
    assert.strictEqual(list.result.cacheScope, 'private');
    assert.strictEqual(list.result._meta['io.modelcontextprotocol/serverInfo'].name, 'countinghouse');
  });

  it('a modern tools/call with params.task runs as an ordinary call, never a task (#232)', async() => {
    io = startWithModule(home);
    const tool = await waitForTool(io, /hello/);
    assert.ok(tool != null, withoutRedisNoise(io.err));
    const r = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {_meta: MODERN_META, name: tool.name,
      arguments: {name: 'stdio'}, task: {ttl: 60000}}}, 60000);
    assert.strictEqual(r.result.task, undefined, JSON.stringify(r));
    assert.notStrictEqual(r.result.resultType, 'task');
    assert.strictEqual(r.result.resultType, 'complete');
    assert.match(JSON.stringify(r.result.content), /hello stdio/);
  });

  it('an unsupported version over stdio: -32022 naming the supported ones', async() => {
    io = start(home);
    const meta = Object.assign({}, MODERN_META, {'io.modelcontextprotocol/protocolVersion': '2099-01-01'});
    const r = await io.request({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: meta}}, 30000);
    assert.strictEqual(r.error.code, -32022, JSON.stringify(r));
    assert.deepStrictEqual(r.error.data, {supported: ['2026-07-28'], requested: '2099-01-01'});
  });

  it('initialize still opens a legacy session: its version echoed, results without resultType', async() => {
    io = start(home);
    const init = await io.request({...INITIALIZE, id: 1}, 30000);
    assert.strictEqual(init.result.protocolVersion, '2025-11-25', JSON.stringify(init));
    assert.deepStrictEqual(init.result.capabilities.tools, {listChanged: true});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}, 30000);
    assert.strictEqual(list.result.resultType, undefined);
  });
});
