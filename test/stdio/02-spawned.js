// --stdio end to end (local-mode spec §2): bin/countinghouse-stdio.js, the
// launcher's pure JavaScript entry, serves MCP over stdin and stdout with one
// module loaded and no Redis service (--redisUrl points at a port nothing
// listens on; unmetered calls never touch it). stdout carries JSON-RPC lines
// only, the logs go to stderr, closing stdin drains and exits 0, and
// --stdio with --port is refused.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');
const KEY = 'stdio-test-key';

function start(home, extra = []) {
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
  return startStdio(['--workerThread', '--loadModule', MODULE, '--authConfigPath', auth,
    '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9749', ...extra], {env: {COUNTINGHOUSE_API_KEY: KEY}});
}

describe('--stdio, spawned: the failure message', () => {
  it('drops the Redis connection noise and keeps the rest', () => {
    const err = [
      '{"level":50,"e":"Redis client error: Redis connection to 127.0.0.1:9749 failed - connect ECONNREFUSED 127.0.0.1:9749"}',
      'Error: connect ECONNREFUSED 127.0.0.1:9749',
      '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1611:16) {',
      "  errno: -4078,", "  code: 'ECONNREFUSED',", "  syscall: 'connect',", "  address: '127.0.0.1',", '  port: 9749', '}',
      '{"level":50,"e":"job queue error: Error: connect ECONNREFUSED 127.0.0.1:9749"}',
      '{"level":50,"e":"module handler-map-module failed to load: the real reason"}'
    ].join('\n');
    assert.strictEqual(withoutRedisNoise(err), '{"level":50,"e":"module handler-map-module failed to load: the real reason"}');
    const traced = ['(node:1) [DEP0169] DeprecationWarning: url.parse()', '    at urlParse (node:url:136:13)', '    at Object.<anonymous> (lib/job-control.js:66:20)'].join('\n');
    assert.strictEqual(withoutRedisNoise(`${err}\n${traced}`).split('\n').slice(1).join('\n'), traced, 'a stack after a non-noise line is kept');
  });
});

describe('--stdio, spawned', function() {
  this.timeout(120000);
  let home;
  let io = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-')); });
  afterEach(async() => {
    if (io != null) await io.stop();
    io = null;
    tmp.remove(home);
  });

  it('serves initialize, tools/list and tools/call, stdout holding JSON-RPC only, and exits 0 when stdin closes', async () => {
    io = start(home);
    const init = await io.request({...INITIALIZE, id: 1});
    assert.ok(init.result && init.result.serverInfo, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    // A notification the gateway does not know is still never answered over stdio.
    io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 99}});
    const tool = await waitForTool(io, /hello/);
    assert.ok(tool, `the module's tool is listed; stderr without the Redis noise: ${withoutRedisNoise(io.err)}`);
    const called = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {name: 'stdio'}}});
    assert.match(JSON.stringify(called.result), /hello stdio/);
    const exit = await io.stop();
    assert.strictEqual(exit.code, 0);
    for (const l of io.lines) {
      const m = JSON.parse(l);
      assert.strictEqual(m.jsonrpc, '2.0', `a stdout line that is not JSON-RPC: ${l.slice(0, 200)}`);
      assert.ok(m.id !== null && m.id !== undefined, `an answer to a notification: ${l.slice(0, 200)}`);
    }
    assert.ok(io.err.length > 0, 'the logs went to stderr');
    // The fixture echoes ctx.caller.apiKey in its own result (id 2); nothing else may hold the key.
    assert.ok(!io.err.includes(KEY), 'the key is never logged');
    for (const l of io.lines) if (JSON.parse(l).id !== 2) assert.ok(!l.includes(KEY), `the key in a stdout line: ${l.slice(0, 200)}`);
  });

  it('--stdio with --port is refused: choose one', () => {
    const r = spawnSync(process.execPath, [ENTRY, '--workerThread', '--port', '9748'], {encoding: 'utf8', timeout: 30000});
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /--stdio and --port: choose one/);
    assert.strictEqual(r.stdout, '');
  });
});
