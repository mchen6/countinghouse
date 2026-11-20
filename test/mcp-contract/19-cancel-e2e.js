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
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

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
// the part's own /data: a line per run's start ('start', 'start-leaf') and
// end ('slow', 'leaf'), and the hold file a test names a run in
const dataOf = (h) => path.join(h, 'module_data', 'm19-part', 'data');
const linesOf = (h) => {
  try { return fs.readFileSync(path.join(dataOf(h), 'runs'), 'utf8').split('\n').filter(Boolean); } catch (e) { return []; }
};
const runsOf = (h) => linesOf(h).filter((l) => !l.startsWith('start'));
const startsOf = (h) => linesOf(h).filter((l) => l === 'start');
// #335: every case acts on what it sees, never on timing. A run named in
// /data/hold (a hop's number, or `leaf`) waits there until it's released,
// so a cancel always lands while that run is known to be running.
const hold = (h, at) => { fs.mkdirSync(dataOf(h), {recursive: true}); fs.writeFileSync(path.join(dataOf(h), 'hold'), String(at)); };
const release = (h) => fs.rmSync(path.join(dataOf(h), 'hold'), {force: true});
async function until(ok, what, ms = 30000) {
  for (let w = 0; !(await ok()); w += 20) {
    if (w > ms) throw new Error(`never: ${what}`);
    await tick(20);
  }
}
// The cancel's way to the server (a socket's close, a stdin line) has no
// signal of its own here, so the held run is released only after this long:
// generous, and never a race, as nothing can finish while it's held.
const CANCEL_LANDS_MS = 1000;
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
// the second hop has started, and is held (hold(h, 2) first): the moment to
// cancel, whatever the path's own latency
const secondHopHeld = (h) => until(() => startsOf(h).length >= 2 && runsOf(h).length === 1, 'the second hop started');
const leafHeld = (h) => until(() => linesOf(h).includes('start-leaf'), 'the leaf started');
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

  for (const [label, PORT, extra] of [['routed hops', testPort(9587), []], ['direct peer channels', testPort(9588), ['--directPeerChannels']]]) {
    describe(`HTTP, ${label}`, () => {
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
        hold(h, 2);
        const r = await post(PORT, CHAIN, {abortWhen: secondHopHeld(h)});
        assert.strictEqual(r.aborted, true);
        await tick(CANCEL_LANDS_MS);
        release(h);
        // the outer call's end writes its Out record: the chain has stopped
        await until(() => outsOf(h, CHAIN).length === 1, 'the outer call ended');
        assert.strictEqual(runsOf(h).length, 2, `the hop running at the cancel finishes (${linesOf(h)})`);
        assert.strictEqual(startsOf(h).length, 2, `none after it (${linesOf(h)})`);
        await until(async () => (await balance(PORT)) === -2, 'two hops billed, once each; the outer call not', 10000);
        const [out] = outsOf(h, CHAIN);
        assert.strictEqual(out.outcome, 'cancelled', JSON.stringify(out));
        assert.strictEqual(outsOf(h, CHAIN).length, 1, 'one Out record');
      });

      it('a modern leaf cancelled while it runs: it finishes and is billed; its record says cancelled', async () => {
        hold(h, 'leaf');
        const r = await post(PORT, LEAF, {abortWhen: leafHeld(h)});
        assert.strictEqual(r.aborted, true);
        await tick(CANCEL_LANDS_MS);
        release(h);
        await until(() => outsOf(h, LEAF).length === 1, 'the leaf call ended');
        assert.deepStrictEqual(runsOf(h), ['leaf']);
        await until(async () => (await balance(PORT)) === -1, 'the leaf billed', 10000);
        assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'cancelled');
      });

      it('a legacy request\'s disconnect changes nothing: the chain runs to its end and is billed', async () => {
        hold(h, 2);
        const r = await post(PORT, CHAIN, {modern: false, abortWhen: secondHopHeld(h)});
        assert.strictEqual(r.aborted, true);
        await tick(CANCEL_LANDS_MS);
        release(h);
        await until(() => outsOf(h, CHAIN).length === 1, 'the outer call ended');
        assert.strictEqual(runsOf(h).length, 5);
        await until(async () => (await balance(PORT)) === -6, 'five hops and the outer call billed', 10000);
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
      hold(h, 2);
      io.notify({jsonrpc: '2.0', id: 21, method: 'tools/call', params: {name: CHAIN, arguments: {}}});
      await secondHopHeld(h);
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 21}});
      await tick(CANCEL_LANDS_MS);
      release(h);
      await until(() => outsOf(h, CHAIN).length === 1, 'the outer call ended');
      assert.strictEqual(runsOf(h).length, 2, `the hop running at the cancel finishes (${linesOf(h)})`);
      assert.strictEqual(startsOf(h).length, 2, `none after it (${linesOf(h)})`);
      assert.deepStrictEqual(io.lines.map((l) => JSON.parse(l)).filter((m) => m.id === 21), [], 'no answer');
      assert.strictEqual(outsOf(h, CHAIN)[0].outcome, 'cancelled');
    });

    // spec section 13, "Not covered": a call that became a task, cancelled
    // before its CreateTaskResult is written, has its job removed (the
    // client never learned its id); nothing is answered
    it('a legacy task-augmented call cancelled before its answer: no answer, and no job left', async () => {
      // one write, so the two lines are taken together, as a client sending a
      // cancel at once would have them; a cancel that came after its task's
      // job had started would let it run to its end, as documented
      io.child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: 23, method: 'tools/call', params: {name: LEAF, arguments: {}, task: {}}})}\n` +
        `${JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 23}})}\n`);
      await tick(2000);
      assert.deepStrictEqual(io.lines.map((l) => JSON.parse(l)).filter((m) => m.id === 23), [], 'no answer');
      const list = await io.request({jsonrpc: '2.0', id: 24, method: 'tasks/list', params: {}}, 10000);
      assert.deepStrictEqual(list.result.tasks, [], JSON.stringify(list.result));
    });

    // the other side of the task case (the review of #314): a cancel that
    // comes after its task's answer names nothing in flight (the client has
    // the task's id, and tasks/cancel is its way): the job runs to its end
    it('a cancel after a task\'s answer changes nothing: the job runs to its end and is counted', async () => {
      const created = await io.request({jsonrpc: '2.0', id: 26, method: 'tools/call', params: {name: LEAF, arguments: {}, task: {}}}, 10000);
      const taskId = created.result.task.taskId;
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 26}});
      let status = null;
      for (let w = 0; w < 10000 && status !== 'completed'; w += 100) {
        status = (await io.request({jsonrpc: '2.0', id: `g${w}`, method: 'tasks/get', params: {taskId}}, 5000)).result.status;
        if (status !== 'completed') await tick(100);
      }
      assert.strictEqual(status, 'completed');
      assert.deepStrictEqual(runsOf(h), ['leaf']);
      assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'ok', 'counted as the run it was');
    });

    // the review of #314: the client's slot is freed at the cancel, but the
    // process waits for a cancelled call still running (up to the request
    // timeout), so its bill is never lost to a shutdown
    it('stdin closed right after a cancel: the process waits for the cancelled leaf, and its record lands', async () => {
      // the leaf held, so it can't end before the process is asked to; it is
      // released well after stdin closes, and the process must wait for it
      hold(h, 'leaf');
      io.notify({jsonrpc: '2.0', id: 25, method: 'tools/call', params: {name: LEAF, arguments: {}}});
      await leafHeld(h);
      io.notify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 25}});
      await tick(50);
      const closedAt = Date.now();
      io.child.stdin.end();
      const exited = new Promise((r) => (io.child.exitCode != null ? r() : io.child.once('exit', r)));
      await tick(CANCEL_LANDS_MS);
      assert.strictEqual(io.child.exitCode, null, 'still waiting for the held leaf');
      release(h);
      await exited;
      assert.ok(Date.now() - closedAt >= CANCEL_LANDS_MS, `the process waited for the leaf (${Date.now() - closedAt} ms)`);
      assert.deepStrictEqual(runsOf(h), ['leaf']);
      assert.strictEqual(outsOf(h, LEAF)[0].outcome, 'cancelled', 'its Out record was written before the exit');
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

  // the shared runtime: notifications/cancelled names a request of the same
  // session only; the cancelled call's seq gets the control op `cancelled`
  // (the shim forgets it), and no answer
  describe('the shared runtime (the session transport)', () => {
    if (process.platform === 'win32') return;
    let h;
    let child;
    let run;
    beforeEach(async () => {
      h = home();
      run = path.join(h, 'run', 'daemon');
      fs.mkdirSync(run, {recursive: true});
      fs.chmodSync(path.join(h, 'run'), 0o700);
      fs.chmodSync(run, 0o700);
      // installed as a pack is: the scenario, its part under its node_modules
      const nm = path.join(h, 'pack', 'node_modules');
      for (const m of MODULES) fs.cpSync(path.join(FX, m), path.join(nm, m), {recursive: true});
      const pkgFile = path.join(nm, 'm19-outer', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
      fs.writeFileSync(pkgFile, JSON.stringify(pkg));
      child = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'),
        '--usageDir', path.join(h, 'usage'), '--modulePath', path.join(h, 'modules'), '--moduleDataPath', path.join(h, 'module_data'),
        '--controlChannel', 'ipc', '--sessionSocket', path.join(run, 's'), ...MODULES.flatMap((m) => ['--loadModule', path.join(nm, m)])],
      {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: ''})});
      let out = '';
      child.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
      child.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
      child.on('message', (m) => { if (m != null && m.type === 'ready') child.send({id: 'r1', type: 'restore', sessions: [], declines: []}); });
      for (let w = 0; !/countinghouse ready/.test(out) || !fs.existsSync(path.join(run, 's')); w += 100) {
        if (w > 60000 || child.exitCode != null) throw new Error(`not ready: ${out.slice(-800)}`);
        await tick(100);
      }
    });
    afterEach(async () => {
      await stop(child);
      fs.rmSync(h, {recursive: true, force: true});
    });

    async function open() {
      const secret = handshake.parseSecret(fs.readFileSync(path.join(run, 'secret'), 'utf8'));
      const s = await shim.session(path.join(run, 's'), secret);
      const answers = [];
      (async () => {
        for (;;) {
          const m = await shim.readM(s.c, 60000);
          if (m == null) return;
          answers.push({seq: m.header != null ? m.header.seq : null, msg: JSON.parse(m.line.toString('utf8'))});
        }
      })();
      return {s, answers};
    }
    const callChain = (sess, seq) => shim.message(sess.s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call',
      params: {_meta: META, name: 'chain', arguments: {}}}));
    const cancelId = (sess, id) => shim.message(sess.s.c, null, JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: id}}));

    it('a session cancels its own call: the shim is told `cancelled` on its seq, no answer comes, the chain stops at its next hop', async () => {
      const a = await open();
      hold(h, 2);
      callChain(a, 41);
      await secondHopHeld(h);
      cancelId(a, 41);
      // the runtime's own word that the cancel landed: only then is the hop let go
      const op = await a.s.c.json('C', 5000);
      assert.deepStrictEqual(op, {op: 'cancelled', seq: 41});
      release(h);
      await until(() => outsOf(h, 'chain').concat(outsOf(h, CHAIN)).length === 1, 'the outer call ended');
      assert.strictEqual(runsOf(h).length, 2, `the hop running at the cancel finishes (${linesOf(h)})`);
      assert.strictEqual(startsOf(h).length, 2, `none after it (${linesOf(h)})`);
      assert.deepStrictEqual(a.answers.filter((x) => x.seq === 41), [], 'no answer on its seq');
      // a scenario's tool is its bare action name on the shared runtime
      const [out] = outsOf(h, 'chain').concat(outsOf(h, CHAIN));
      assert.strictEqual(out.outcome, 'cancelled', JSON.stringify(out));
      a.s.c.end();
    });

    it('another session naming the same request id changes nothing: the call runs to its end and is answered', async () => {
      const a = await open();
      const b = await open();
      hold(h, 2);
      callChain(a, 42);
      await secondHopHeld(h);
      cancelId(b, 42);
      await tick(CANCEL_LANDS_MS);
      release(h);
      await until(() => a.answers.some((x) => x.seq === 42), 'answered', 15000);
      const answer = a.answers.find((x) => x.seq === 42);
      assert.ok(answer != null, 'answered');
      assert.strictEqual(answer.msg.result.isError, false, JSON.stringify(answer.msg).slice(0, 300));
      assert.strictEqual(runsOf(h).length, 5);
      a.s.c.end();
      b.s.c.end();
    });
  });
});
