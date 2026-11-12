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
const {spawn, spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'handler-map-module');
const KEY = 'stdio-test-key';

function start(home, extra = []) {
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
  const child = spawn(process.execPath, [ENTRY, '--workerThread', '--loadModule', MODULE, '--authConfigPath', auth,
    '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9749', ...extra],
  {env: {...process.env, COUNTINGHOUSE_API_KEY: KEY}, stdio: ['pipe', 'pipe', 'pipe']});
  const io = {child, out: '', err: '', waiters: []};
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { io.out += d; io.waiters.forEach((w) => w()); });
  child.stderr.on('data', (d) => { io.err += d; });
  return io;
}

const lines = (io) => io.out.split('\n').filter((l) => l !== '');

// The server's stderr for a failure message, without the Redis connection
// noise this test causes on purpose (--redisUrl points where nothing
// answers, so every Redis client and the job queue retry and log). Without
// this the 2000-character tail held only that noise, and on Windows (issue
// #40) the real reason the module never listed was cut off.
const REDIS_NOISE = /ECONNREFUSED|Redis client error|Redis connection to|job queue error|^\s+(at |code:|errno:|syscall:|address:|port:|\[)|^Error: connect|^\s*[{}]\s*$/;
function diagnostic(err, max = 4000) {
  const kept = err.split('\n').filter((l) => l.trim() !== '' && !REDIS_NOISE.test(l)).join('\n');
  return kept.length > max ? `…${kept.slice(-max)}` : kept;
}
function request(io, message, timeoutMs = 15000) {
  io.child.stdin.write(`${JSON.stringify(message)  }\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${message.method}; stderr without the Redis noise: ${diagnostic(io.err)}`)), timeoutMs);
    const check = () => {
      const found = lines(io).map((l) => JSON.parse(l)).find((r) => r.id === message.id);
      if (found) { clearTimeout(timer); resolve(found); }
    };
    io.waiters.push(check);
    check();
  });
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
    assert.strictEqual(diagnostic(err), '{"level":50,"e":"module handler-map-module failed to load: the real reason"}');
  });
});

describe('--stdio, spawned', function() {
  this.timeout(60000);
  let home;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-')); });
  afterEach(() => { fs.rmSync(home, {recursive: true, force: true}); });

  // Issue #40 (step 4): on Windows the module's boot stops after "file broker:
  // <module> spawn walk", so its tool is never listed. The same start with the
  // sandbox off (no file broker) says whether the broker is where it stops.
  it('lists and calls the module with the sandbox off as well (the #40 bisection)', async () => {
    const io = start(home, ['--moduleSandbox', 'off']);
    await request(io, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '0'}}});
    let tool = null;
    for (let i = 0; i < 60 && tool == null; i++) {
      const list = await request(io, {jsonrpc: '2.0', id: 100 + i, method: 'tools/list'});
      tool = (list.result.tools || []).find((x) => /hello/.test(x.name)) || null;
      if (tool == null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(tool, `the module's tool is listed with the sandbox off; stderr without the Redis noise: ${diagnostic(io.err)}`);
    const called = await request(io, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {name: 'stdio'}}});
    assert.match(JSON.stringify(called.result), /hello stdio/);
    const exit = new Promise((resolve) => io.child.on('exit', (code) => resolve(code)));
    io.child.stdin.end();
    assert.strictEqual(await exit, 0);
  });

  it('serves initialize, tools/list and tools/call, stdout holding JSON-RPC only, and exits 0 when stdin closes', async () => {
    const io = start(home);
    const init = await request(io, {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '0'}}});
    assert.ok(init.result && init.result.serverInfo, JSON.stringify(init));
    io.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'})}\n`);
    // A notification the gateway does not know is still never answered over stdio.
    io.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 99}})}\n`);
    let tool = null;
    for (let i = 0; i < 60 && tool == null; i++) {
      const list = await request(io, {jsonrpc: '2.0', id: 100 + i, method: 'tools/list'});
      tool = (list.result.tools || []).find((t) => /hello/.test(t.name)) || null;
      if (tool == null) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(tool, `the module's tool is listed; stderr without the Redis noise: ${diagnostic(io.err)}`);
    const called = await request(io, {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {name: 'stdio'}}});
    assert.match(JSON.stringify(called.result), /hello stdio/);
    const exit = new Promise((resolve) => io.child.on('exit', (code) => resolve(code)));
    io.child.stdin.end();
    assert.strictEqual(await exit, 0);
    for (const l of lines(io)) {
      const m = JSON.parse(l);
      assert.strictEqual(m.jsonrpc, '2.0', `a stdout line that is not JSON-RPC: ${l.slice(0, 200)}`);
      assert.ok(m.id !== null && m.id !== undefined, `an answer to a notification: ${l.slice(0, 200)}`);
    }
    assert.ok(io.err.length > 0, 'the logs went to stderr');
    // The fixture echoes ctx.caller.apiKey in its own result (id 2); nothing else may hold the key.
    assert.ok(!io.err.includes(KEY), 'the key is never logged');
    for (const l of lines(io)) if (JSON.parse(l).id !== 2) assert.ok(!l.includes(KEY), `the key in a stdout line: ${l.slice(0, 200)}`);
  });

  it('--stdio with --port is refused: choose one', () => {
    const r = spawnSync(process.execPath, [ENTRY, '--workerThread', '--port', '9748'], {encoding: 'utf8', timeout: 30000});
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /--stdio and --port: choose one/);
    assert.strictEqual(r.stdout, '');
  });
});
