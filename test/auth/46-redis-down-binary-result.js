// #16's rule (with Redis down, calls answer, and billing resumes after) for a
// result with a binary value (the back-sweep, 11-18). tools/call stores such a
// value while it shapes the result (lib/mcp/result-content.js), on the blob
// store's db 13 client. That client was node_redis' default: with Redis down
// the call waited until Redis came back, and after an hour the client closed
// for good, so every such call failed until a restart. Now the client is
// lib/redis-resilient.js's and the write has a deadline.
//
// Redis "down" is a TCP proxy this test owns, as in auth 42.
const assert = require('assert');
const fs     = require('fs');
const net    = require('net');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort, redisUrlFor} = require('../helpers/test-env');
const {mkdtemp} = require('../helpers/test-tmp');

const PORT       = testPort(9667);
const REAL_REDIS = (() => { const u = new URL(redisUrlFor()); return {host: u.hostname, port: Number(u.port) || 6379}; })();
const CALLER     = `blob-down-${process.pid}`;
const BINARY     = 'mcp_conformance_shapeservice_binary_out';
const PLAIN      = 'mcp_conformance_shapeservice_string_out';
const ANSWER_MS  = 5000;

// (a port of its own each run, kept across down and up: a fixed one would
// let a leaked client of an earlier run reconnect through it)
function redisProxy() {
  const sockets = new Set();
  let server = null;
  let port = 0;
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  return {
    up: () => new Promise((resolve, reject) => {
      server = net.createServer((client) => {
        const upstream = net.connect(REAL_REDIS);
        track(client); track(upstream);
        client.pipe(upstream); upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
    }),
    down: () => new Promise((resolve) => { sockets.forEach((s) => s.destroy()); server.close(() => resolve()); }),
    port: () => port
  };
}

function timedCall(tool, capMs) {
  const t0 = Date.now();
  return Promise.race([
    mcpCall(PORT, CALLER, tool, {}).then((r) => ({ms: Date.now() - t0, r}), (e) => ({ms: Date.now() - t0, e})),
    new Promise((resolve) => setTimeout(() => resolve(null), capMs))
  ]);
}
const linked = (r) => r != null && r.isError !== true && JSON.stringify(r.content || []).includes('resource_link');
const uriOf = (r) => ((r.content || []).find((b) => b.type === 'resource_link') || {}).uri;
// resources/read, as the caller (its JSON-RPC answer whole)
function readResource(uri) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'resources/read', params: {uri}});
    const req = require('http').request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': CALLER, 'Content-Length': Buffer.byteLength(body)}}, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`not JSON: ${out.slice(0, 300)}`)); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
let storedUri = null;

describe('auth 46: with Redis down a call whose result has a binary value answers, and stores again once Redis is back', function() {
  this.timeout(120000);
  const proxy = redisProxy();
  let proxyUp = false;
  let server = null;
  let dir = null;

  before(async () => {
    dir = mkdtemp('blob-down-');
    const authPath = path.join(dir, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[CALLER]: {userName: 'blob-down', devices: ['*']}}));
    await proxy.up();
    proxyUp = true;
    // every binary value stored, never inline
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
      '--redisUrl', `redis://127.0.0.1:${proxy.port()}`, '--store', 'redis', '--inlineContentBytes', '0',
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'mcp-conformance-module')]);
  });
  after(async () => {
    stopServer(server);
    if (proxyUp) await proxy.down();
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });

  it('stores the value while Redis is up', async () => {
    const c = await timedCall(BINARY, 10000);
    assert.ok(c != null && linked(c.r), JSON.stringify(c).slice(0, 600));
    storedUri = uriOf(c.r);
    assert.ok(typeof storedUri === 'string', JSON.stringify(c.r).slice(0, 600));
  });

  it(`answers within ${ANSWER_MS} ms once Redis is down: RESULT_STORE_UNAVAILABLE, and a call with no binary value answers as before`, async () => {
    await proxy.down();
    proxyUp = false;
    await new Promise((r) => setTimeout(r, 300));   // the server's clients see the connection drop
    const c = await timedCall(BINARY, ANSWER_MS);
    assert.notStrictEqual(c, null, `no answer within ${ANSWER_MS} ms with Redis down\n${server.output.slice(-1500)}`);
    assert.ok(/RESULT_STORE_UNAVAILABLE/.test(JSON.stringify(c)), JSON.stringify(c).slice(0, 600));
    const plain = await timedCall(PLAIN, ANSWER_MS);
    assert.ok(plain != null && plain.r != null && plain.r.isError !== true, JSON.stringify(plain).slice(0, 600));
    // a stored value's read says the store is unavailable, never "not
    // found": the URI still holds (the medium on the blob-store PR, 1)
    const read = await readResource(storedUri);
    assert.ok(read.error != null && read.error.code === -32603 && read.error.data != null && read.error.data.code === 'RESULT_STORE_UNAVAILABLE', JSON.stringify(read).slice(0, 400));
  });

  it('stores again once Redis is back (the client reconnected)', async () => {
    await proxy.up();
    proxyUp = true;
    await new Promise((r) => setTimeout(r, 3000));   // longer than the capped reconnect delay
    const c = await timedCall(BINARY, 10000);
    assert.ok(c != null && linked(c.r), JSON.stringify(c).slice(0, 600));
    const read = await readResource(storedUri);
    assert.ok(read.result != null && Array.isArray(read.result.contents), JSON.stringify(read).slice(0, 400));
  });
});
