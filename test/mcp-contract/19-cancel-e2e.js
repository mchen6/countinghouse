// MCP completeness M19, spec section 13, end to end: cancelling a call in
// flight. A composite (m19-outer chain: five 300 ms hops to m19-part slow)
// is cancelled while one hop runs: that hop finishes and is billed exactly
// once, the next is never run, the outer call is not billed, and no answer
// is written; its usage Out record is outcome 'cancelled'. A leaf with no
// hops runs to its end and is billed. A legacy HTTP request's disconnect
// changes nothing. Over stdio, notifications/cancelled by id; an unknown id
// is ignored. Bills are read as the caller's balance (--meter, cost 1 per
// call) and runs from the part's own /data/runs.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {testPort} = require('../helpers/test-env');
const {startStdio} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');
const FX = path.join(ROOT, 'test', 'fixtures');
const MODULES = ['m19-part', 'm19-outer'];
const KEY = 'm19-cancel-key';
const CHAIN = 'm19_outer_outerservice_chain';
const LEAF = 'm19_part_partservice_slowleaf';
const V = '2026-07-28';
const META = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m19-'));
  fs.writeFileSync(path.join(h, 'auth.json'), JSON.stringify({
    [KEY]: {userName: 'm19-cancel', devices: ['*']},
    'm19-outer-internal-key': {userName: 'm19-outer-internal', devices: ['*'], runsModules: ['m19-outer']}
  }));
  return h;
}
const serverArgs = (h, extra = []) => ['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--meter', '--mcpToolCallCost', '1',
  '--usageDir', path.join(h, 'usage'), '--authProvider', 'file', '--authConfigPath', path.join(h, 'auth.json'),
  '--moduleDataPath', path.join(h, 'module_data'), ...MODULES.flatMap((m) => ['--loadModule', path.join(FX, m)]), ...extra];
const runsOf = (h) => {
  try { return fs.readFileSync(path.join(h, 'module_data', 'm19-part', 'data', 'runs'), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; }
};
// the Out records of the usage files (B: assert on the records, not the report)
const outsOf = (h, tool) => {
  const dir = path.join(h, 'usage');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const day of fs.readdirSync(dir)) {
    for (const f of fs.readdirSync(path.join(dir, day))) {
      for (const line of fs.readFileSync(path.join(dir, day, f), 'utf8').split('\n').filter(Boolean)) {
        const r = JSON.parse(line);
        if (r.bytesOut !== undefined && r.tool === tool) out.push(r);
      }
    }
  }
  return out;
};

async function startServer(port, h, extra) {
  const server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(port), ...serverArgs(h, extra)],
    {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  server.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
  server.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
  for (let w = 0; !/countinghouse ready/.test(out); w += 100) {
    if (w > 60000 || server.exitCode != null) throw new Error(`not ready: ${out.slice(-800)}`);
    await tick(100);
  }
  return server;
}
const stop = async (server) => {
  if (server == null) return;
  server.kill('SIGKILL');
  await new Promise((r) => (server.exitCode != null || server.signalCode != null ? r() : server.once('exit', r)));
};

// a tools/call POST; abortAfterMs: the client leaves then; abortWhen: a
// promise after which it leaves. -> {aborted} or {status, body}
function post(port, name, {modern = true, abortAfterMs = null, abortWhen = null} = {}) {
  const params = modern ? {_meta: META, name, arguments: {}} : {name, arguments: {}};
  const payload = JSON.stringify({jsonrpc: '2.0', id: 4, method: 'tools/call', params});
  const headers = {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload),
    ...(modern ? {'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': name} : {})};
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers}, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({status: res.statusCode, body}));
    });
    req.on('error', (e) => { if (abortAfterMs == null && abortWhen == null) reject(e); });
    req.end(payload);
    if (abortAfterMs != null) setTimeout(() => { req.destroy(); resolve({aborted: true}); }, abortAfterMs);
    if (abortWhen != null) abortWhen.then(() => { req.destroy(); resolve({aborted: true}); });
  });
}
// once the first hop has run, and the second is inside its 300 ms: the
// moment to cancel, whatever the path's own latency (a peer channel's
// opening makes its first hop slower than a routed one)
async function secondHopRunning(h) {
  for (let w = 0; runsOf(h).length < 1; w += 20) {
    if (w > 20000) throw new Error('the first hop never ran');
    await tick(20);
  }
  await tick(100);
}
function balance(port) {
  return new Promise((resolve, reject) => {
    http.get({host: '127.0.0.1', port, path: '/balance', headers: {'X-CH-Key': KEY}}, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body).balance));
    }).on('error', reject);
  });
}

describe('mcp-contract 19: cancelling a call in flight (M19), end to end', function() {
  this.timeout(120000);

  for (const [label, port, extra] of [['routed hops', 9587, []], ['direct peer channels', 9588, ['--directPeerChannels']]]) {
    describe(`HTTP, ${label}`, () => {
      const PORT = testPort(port);
      let h;
      let server;
      beforeEach(async () => {
        h = home();
        server = await startServer(PORT, h, extra);
      });
      afterEach(async () => {
        await stop(server);
        fs.rmSync(h, {recursive: true, force: true});
      });

      it('a modern composite cancelled mid-hop: that hop is billed once, the next never runs, the outer call is not billed', async () => {
        const r = await post(PORT, CHAIN, {abortWhen: secondHopRunning(h)});
        assert.strictEqual(r.aborted, true);
        await tick(2000);   // longer than the rest of the chain would take
        const runs = runsOf(h).length;
        assert.strictEqual(runs, 2, `the hop running at the cancel finishes; none after it (${runs} runs)`);
        assert.strictEqual(await balance(PORT), -2, 'two hops billed, once each; the outer call not');
        const [out] = outsOf(h, CHAIN);
        assert.strictEqual(out.outcome, 'cancelled', JSON.stringify(out));
        assert.strictEqual(outsOf(h, CHAIN).length, 1, 'one Out record');
      });

      it('a modern leaf cancelled while it runs: it finishes and is billed; its record says cancelled', async () => {
        const r = await post(PORT, LEAF, {abortAfterMs: 200});
        assert.strictEqual(r.aborted, true);
        await tick(1200);
        assert.deepStrictEqual(runsOf(h), ['leaf']);
        assert.strictEqual(await balance(PORT), -1);
        assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'cancelled');
      });

      it('a legacy request\'s disconnect changes nothing: the chain runs to its end and is billed', async () => {
        const r = await post(PORT, CHAIN, {modern: false, abortWhen: secondHopRunning(h)});
        assert.strictEqual(r.aborted, true);
        await tick(2500);
        assert.strictEqual(runsOf(h).length, 5);
        assert.strictEqual(await balance(PORT), -6, 'five hops and the outer call');
        assert.strictEqual(outsOf(h, CHAIN)[0].outcome, 'ok');
      });

      it('a disconnect after the answer changes nothing', async () => {
        const r = await post(PORT, LEAF);
        assert.strictEqual(r.status, 200);
        await tick(300);
        assert.strictEqual(await balance(PORT), -1);
        assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'ok');
      });
    });
  }

  describe('stdio', () => {
    let h;
    let io;
    beforeEach(async () => {
      h = home();
      io = startStdio(serverArgs(h), {env: {COUNTINGHOUSE_API_KEY: KEY}});
      await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}}});
      for (let w = 0; w < 60000; w += 200) {
        const list = await io.request({jsonrpc: '2.0', id: `l${w}`, method: 'tools/list', params: {}});
        if (list.result.tools.some((t) => t.name === CHAIN)) break;
        await tick(200);
      }
    });
    afterEach(async () => {
      await io.stop();
      fs.rmSync(h, {recursive: true, force: true});
    });

    it('notifications/cancelled by id: no answer line, the chain stops at its next hop', async () => {
      io.notify({jsonrpc: '2.0', id: 21, method: 'tools/call', params: {name: CHAIN, arguments: {}}});
      await secondHopRunning(h);
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 21}});
      await tick(2000);
      assert.strictEqual(runsOf(h).length, 2);
      assert.deepStrictEqual(io.lines.map((l) => JSON.parse(l)).filter((m) => m.id === 21), [], 'no answer');
      assert.strictEqual(outsOf(h, CHAIN)[0].outcome, 'cancelled');
    });

    it('an unknown id, and a cancel for a call already answered, are ignored', async () => {
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'never-sent'}});
      const answer = await io.request({jsonrpc: '2.0', id: 22, method: 'tools/call', params: {name: LEAF, arguments: {}}}, 10000);
      assert.strictEqual(answer.result.isError, false);
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 22}});
      await tick(200);
      assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'ok');
    });
  });
});
