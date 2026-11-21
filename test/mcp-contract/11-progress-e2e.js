// MCP completeness M9, spec section 6, end to end: a composite's hops are
// progress ticks, delivered on the call's own stream. examples/log-triage
// (4 files: 10 hops per call).
//   HTTP: the POST's answer becomes SSE lazily, only when the request's
//     Accept allows it and a notification is due; otherwise plain JSON, as
//     before. The answer is the stream's last event.
//   stdio: progress lines before the answer's line.
//   The shared runtime: headerless frames on the request's own session
//     connection, so one session's progress never reaches another, even
//     with the same progressToken at once (the reviewer's condition).
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
const EX = path.join(ROOT, 'examples', 'log-triage');
const PARTS = ['log-read', 'pii-redact', 'error-cluster', 'log-triage'];
const TRIAGE = 'log_triage_triageservice_triage';
const LEAF = 'log_read_readservice_list';
const ARGS = {dir: '/data/files', maxFiles: 4};
const KEY = 'm9-progress-key';
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m9-'));
  require(path.join(EX, 'generate-logs.js')).generate({dir: path.join(h, 'module_data', 'log-read', 'data', 'files'), files: 4, lines: 100, seed: 1});
  const auth = {[KEY]: {userName: 'm9-progress', devices: ['*']},
    'log-triage-internal-perf-key': {userName: 'log-triage-internal', devices: ['*'], runsModules: ['log-triage']}};
  fs.writeFileSync(path.join(h, 'auth.json'), JSON.stringify(auth), {mode: 0o600});
  return h;
}
const serverArgs = (h) => ['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--authProvider', 'file',
  '--authConfigPath', path.join(h, 'auth.json'), '--moduleDataPath', path.join(h, 'module_data'), ...PARTS.flatMap((m) => ['--loadModule', path.join(EX, m)])];
const progressOf = (msgs) => msgs.filter((m) => m.method === 'notifications/progress');
function assertProgress(notes, token) {
  assert.ok(notes.length >= 1, 'at least one tick');
  let last = 0;
  for (const n of notes) {
    assert.strictEqual(n.params.progressToken, token);
    assert.ok(n.params.progress > last, JSON.stringify(notes));
    assert.ok(!('message' in n.params), 'no message: an unlisted part is never named');
    assert.ok(!('total' in n.params), 'hop ticks have no total');
    last = n.params.progress;
  }
}

describe('mcp-contract 11: progress on the call\'s own stream (M9), end to end', function() {
  this.timeout(120000);

  describe('HTTP', () => {
    const PORT = testPort(9580);
    let h;
    let server;
    before(async () => {
      h = home();
      server = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(PORT), ...serverArgs(h)],
        {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
      let out = '';
      server.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
      server.stderr.on('data', (d) => { out = (out + d).slice(-20000); });
      for (let w = 0; !/countinghouse ready/.test(out); w += 100) {
        if (w > 60000 || server.exitCode != null) throw new Error(`not ready: ${out.slice(-800)}`);
        await tick(100);
      }
    });
    after(() => {
      if (server != null) server.kill('SIGKILL');
      if (h != null) fs.rmSync(h, {recursive: true, force: true});
    });

    // -> {status, type, body, events}; abortAfterEvent: close the POST then
    function post(params, {accept = 'application/json, text/event-stream', abortAfterEvent = false} = {}) {
      const payload = JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/call', params});
      return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: accept, 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}}, (res) => {
          let body = '';
          res.on('data', (c) => {
            body += c;
            if (abortAfterEvent && /\n\n/.test(body)) { req.destroy(); resolve({aborted: true}); }
          });
          res.on('end', () => {
            const type = String(res.headers['content-type'] || '');
            const events = /event-stream/.test(type) ? body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice(6))) : null;
            resolve({status: res.statusCode, type, body, events});
          });
        });
        req.on('error', (e) => { if (!abortAfterEvent) reject(e); });
        req.end(payload);
      });
    }

    it('with a token and an Accept that allows SSE: increasing ticks, then the answer as the last event', async () => {
      const r = await post({_meta: {progressToken: 'h-1'}, name: TRIAGE, arguments: ARGS});
      assert.match(r.type, /text\/event-stream/);
      const answer = r.events[r.events.length - 1];
      assert.strictEqual(answer.id, 7);
      assert.strictEqual(answer.result.isError, false, JSON.stringify(answer).slice(0, 400));
      assertProgress(progressOf(r.events), 'h-1');
      assert.deepStrictEqual(r.events.slice(0, -1).filter((e) => e.method !== 'notifications/progress'), [], 'only progress before the answer');
    });

    for (const [why, params, accept] of [
      ['no token', {name: TRIAGE, arguments: ARGS}, undefined],
      ['an Accept without text/event-stream', {_meta: {progressToken: 'h-2'}, name: TRIAGE, arguments: ARGS}, 'application/json'],
      ['a token of 257 characters', {_meta: {progressToken: 'x'.repeat(257)}, name: TRIAGE, arguments: ARGS}, undefined],
      ['a token in arguments, not params._meta', {name: TRIAGE, arguments: Object.assign({}, ARGS, {_meta: {progressToken: 'h-3'}})}, undefined],
      ['a leaf call (no hops)', {_meta: {progressToken: 'h-4'}, name: LEAF, arguments: {dir: '/data/files'}}, undefined]
    ]) {
      it(`${why}: plain JSON, as before`, async () => {
        const r = await post(params, accept != null ? {accept} : {});
        assert.match(r.type, /application\/json/, `${why}: ${r.type}`);
        assert.strictEqual(JSON.parse(r.body).id, 7);
      });
    }

    it('the client closing the POST mid-stream ends the notifications; the server goes on', async () => {
      const r = await post({_meta: {progressToken: 'h-5'}, name: TRIAGE, arguments: ARGS}, {abortAfterEvent: true});
      assert.strictEqual(r.aborted, true);
      await tick(500);
      const next = await post({name: TRIAGE, arguments: ARGS});
      assert.strictEqual(JSON.parse(next.body).result.isError, false);
    });
  });

  describe('stdio', () => {
    it('progress lines come before the answer\'s line', async () => {
      const h = home();
      const io = startStdio(serverArgs(h), {env: {COUNTINGHOUSE_API_KEY: KEY}});
      try {
        await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}}});
        for (let w = 0; w < 60000; w += 200) {
          const list = await io.request({jsonrpc: '2.0', id: `l${w}`, method: 'tools/list', params: {}});
          if (list.result.tools.some((t) => t.name === TRIAGE)) break;
          await tick(200);
        }
        const answer = await io.request({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {_meta: {progressToken: 9}, name: TRIAGE, arguments: ARGS}}, 60000);
        assert.strictEqual(answer.result.isError, false);
        const msgs = io.lines.map((l) => JSON.parse(l));
        const at = msgs.findIndex((m) => m.id === 9);
        assertProgress(progressOf(msgs.slice(0, at)), 9);
        assert.deepStrictEqual(progressOf(msgs.slice(at + 1)), [], 'nothing after the answer');
      } finally {
        await io.stop();
        fs.rmSync(h, {recursive: true, force: true});
      }
    });
  });

  describe('the shared runtime (the session transport)', () => {
    if (process.platform === 'win32') return;
    let h;
    let child;
    let run;
    before(async () => {
      h = home();
      run = path.join(h, 'run', 'daemon');
      fs.mkdirSync(run, {recursive: true});
      fs.chmodSync(path.join(h, 'run'), 0o700);
      fs.chmodSync(run, 0o700);
      // installed as a pack is: the scenario and its parts side by side
      const nm = path.join(h, 'pack', 'node_modules');
      for (const m of PARTS) fs.cpSync(path.join(EX, m), path.join(nm, m), {recursive: true});
      const pkgFile = path.join(nm, 'log-triage', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'}); // its calls kept
      fs.writeFileSync(pkgFile, JSON.stringify(pkg));
      child = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'),
        '--modulePath', path.join(h, 'modules'), '--moduleDataPath', path.join(h, 'module_data'), '--controlChannel', 'ipc',
        '--sessionSocket', path.join(run, 's'), ...PARTS.flatMap((m) => ['--loadModule', path.join(nm, m)])],
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
    after(() => {
      if (child != null) child.kill('SIGKILL');
      if (h != null) fs.rmSync(h, {recursive: true, force: true});
    });

    async function open() {
      const secret = handshake.parseSecret(fs.readFileSync(path.join(run, 'secret'), 'utf8'));
      const s = await shim.session(path.join(run, 's'), secret);
      const got = [];
      (async () => {
        for (;;) {
          const m = await shim.readM(s.c, 60000);
          if (m == null) return;
          got.push({seq: m.header != null ? m.header.seq : null, msg: JSON.parse(m.line.toString('utf8'))});
        }
      })();
      return {s, got};
    }
    async function call(sess, seq, token) {
      shim.message(sess.s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call',
        params: {_meta: Object.assign({progressToken: token}, META), name: 'triage', arguments: ARGS}}));
      for (let w = 0; w < 60000 && !sess.got.some((g) => g.seq === seq); w += 50) await tick(50);
      const at = sess.got.findIndex((g) => g.seq === seq);
      assert.ok(at >= 0, 'answered');
      assert.strictEqual(sess.got[at].msg.result.isError, false, JSON.stringify(sess.got[at].msg).slice(0, 300));
      return at;
    }
    const notesOf = (sess) => progressOf(sess.got.filter((g) => g.seq == null).map((g) => g.msg));

    it('a session\'s progress reaches its own connection only: another, idle, hears nothing', async () => {
      const a = await open();
      const b = await open();
      await call(a, 11, 'same');
      await tick(300);
      assertProgress(notesOf(a), 'same');
      assert.deepStrictEqual(notesOf(b), []);
      a.s.c.end();
      b.s.c.end();
    });

    it('two sessions calling at once with the same progressToken each get their own, before their own answer, none after', async () => {
      const a = await open();
      const b = await open();
      const [atA, atB] = await Promise.all([call(a, 21, 'same'), call(b, 22, 'same')]);
      await tick(300);
      for (const [sess, at] of [[a, atA], [b, atB]]) {
        const before = progressOf(sess.got.slice(0, at).filter((g) => g.seq == null).map((g) => g.msg));
        assertProgress(before, 'same');
        assert.deepStrictEqual(progressOf(sess.got.slice(at + 1).map((g) => g.msg)), [], 'nothing after its answer');
        assert.strictEqual(notesOf(sess).length, before.length, 'no other session\'s notes on this connection');
      }
      a.s.c.end();
      b.s.c.end();
    });
  });
});
