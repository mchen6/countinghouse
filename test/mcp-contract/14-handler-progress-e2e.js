// MCP completeness M21, spec section 6, end to end: a handler's own
// progress, ctx.job.progress(n) outside a task, reaches the client as
// notifications/progress with total 100, on the call's own stream (HTTP SSE,
// stdio lines, a session's own connection). Only the outer call's handler
// counts: a part's report is dropped, and once the outer handler reports, its
// hops' ticks stop. Fixtures: test/fixtures/progress-part (it reports) and
// progress-outer (a composite calling it).
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
const MODULES = ['progress-part', 'progress-outer'];
const PART = 'progress_part_partservice_';
const OUTER = 'progress_outer_outerservice_';
const KEY = 'm21-progress-key';
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-m21-'));
  const auth = {[KEY]: {userName: 'm21-progress', devices: ['*']},
    'progress-outer-internal-key': {userName: 'progress-outer-internal', devices: ['*'], runsModules: ['progress-outer']}};
  fs.writeFileSync(path.join(h, 'auth.json'), JSON.stringify(auth));
  return h;
}
const serverArgs = (h) => ['--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'), '--authProvider', 'file',
  '--authConfigPath', path.join(h, 'auth.json'), '--moduleDataPath', path.join(h, 'module_data'), ...MODULES.flatMap((m) => ['--loadModule', path.join(FX, m)])];
const progressOf = (msgs) => msgs.filter((m) => m.method === 'notifications/progress');
const reportsOf = (notes) => notes.map((n) => [n.params.progress, n.params.total]);

describe('mcp-contract 14: a handler\'s own progress (M21), end to end', function() {
  this.timeout(120000);

  describe('HTTP', () => {
    const PORT = testPort(9582);
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

    // -> {type, body, events, answer, notes}
    function post(name, token) {
      const params = {name, arguments: {}};
      if (token != null) params._meta = {progressToken: token};
      const payload = JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/call', params});
      return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}}, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            const type = String(res.headers['content-type'] || '');
            const events = /event-stream/.test(type) ? body.split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => JSON.parse(e.slice(6))) : [JSON.parse(body)];
            const answer = events[events.length - 1];
            assert.strictEqual(answer.id, 7, JSON.stringify(events).slice(0, 600));
            assert.ok(answer.result != null && answer.result.isError === false, JSON.stringify(answer).slice(0, 400));
            resolve({type, events, answer, notes: progressOf(events.slice(0, -1))});
          });
        });
        req.on('error', reject);
        req.end(payload);
      });
    }

    it('a handler reporting 10, 50, 90: each reaches the client with total 100, then the answer', async () => {
      const r = await post(`${PART}work`, 'w-1');
      assert.match(r.type, /text\/event-stream/);
      assert.deepStrictEqual(reportsOf(r.notes), [[10, 100], [50, 100], [90, 100]]);
      for (const n of r.notes) assert.strictEqual(n.params.progressToken, 'w-1');
    });

    it('100,000 reports at once reach the client as a handful, increasing, and the call answers', async () => {
      const r = await post(`${PART}flood`, 'f-1');
      assert.ok(r.notes.length >= 1 && r.notes.length <= 4, `${r.notes.length} notifications`);
      let last = -1;
      for (const [n, total] of reportsOf(r.notes)) { assert.ok(n > last); assert.strictEqual(total, 100); last = n; }
    });

    it('values outside 0..100, and non-numbers, never reach the client: plain JSON', async () => {
      const r = await post(`${PART}bad`, 'b-1');
      assert.match(r.type, /application\/json/);
    });

    it('a report after the answer is dropped; the server goes on', async () => {
      const r = await post(`${PART}late`, 'l-1');
      assert.match(r.type, /application\/json/);
      await tick(300);
      assert.match((await post(`${PART}late`, null)).type, /application\/json/);
    });

    it('no progress token: plain JSON, as before', async () => {
      const r = await post(`${PART}work`, null);
      assert.match(r.type, /application\/json/);
    });

    it('outside a task ctx.job is still an object: id null, info an error', async () => {
      const r = await post(`${PART}jobshape`, null);
      const out = r.answer.result.structuredContent;
      assert.strictEqual(out.id, null);
      assert.match(out.infoError, /not a task/);
    });

    it('wantsProgress in the arguments, top level or nested, reaches the handler as sent: tools/call and invoke-action', async () => {
      const input = {wantsProgress: true, nested: {wantsProgress: true, deeper: [{wantsProgress: 1}]}};
      const viaMcp = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: `${PART}echo`, arguments: input}});
        const req = http.request({host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}}, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({type: String(res.headers['content-type'] || ''), body: JSON.parse(body)}));
        });
        req.on('error', reject);
        req.end(payload);
      });
      assert.match(viaMcp.type, /application\/json/, 'no token: plain JSON, whatever the input says');
      assert.deepStrictEqual(viaMcp.body.result.structuredContent, input);
      const device = require('../../lib/call-address').deviceIDForName('progress-part');
      const viaHttp = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({serviceID: 'urn:countinghouse-test:serviceID:partService', actionName: 'echo', input, wantsProgress: true});
        const req = http.request({host: '127.0.0.1', port: PORT, path: `/devices/${device}/invoke-action`, method: 'POST',
          headers: {'Content-Type': 'application/json', 'X-CH-Key': KEY, 'Content-Length': Buffer.byteLength(payload)}}, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(body)}));
        });
        req.on('error', reject);
        req.end(payload);
      });
      assert.strictEqual(viaHttp.status, 200, JSON.stringify(viaHttp.body));
      assert.deepStrictEqual(viaHttp.body.output != null ? viaHttp.body.output : viaHttp.body, input);
    });

    it('a composite that reports after its hops have ticked: ticks + n of ticks + 100, still increasing, not swallowed', async () => {
      const r = await post(`${OUTER}hopsthenreport`, 'c-3');
      const ticks = r.notes.filter((n) => !('total' in n.params));
      const reports = r.notes.filter((n) => 'total' in n.params);
      assert.ok(ticks.length >= 1, 'the hop ticks first');
      assert.strictEqual(reports.length, 1, JSON.stringify(r.notes));
      const [{params}] = reports;
      assert.ok(params.total > 100, JSON.stringify(params));
      assert.strictEqual(params.total - params.progress, 75, 'ticks + 25 of ticks + 100');
      assert.ok(params.progress > ticks[ticks.length - 1].params.progress);
    });

    it('a composite that reports nothing: its hops\' ticks only, never the part\'s own values', async () => {
      const r = await post(`${OUTER}wrap`, 'c-1');
      assert.ok(r.notes.length >= 1, 'the hop ticks');
      for (const n of r.notes) assert.ok(!('total' in n.params), `a part's report reached the client: ${JSON.stringify(n.params)}`);
    });

    it('a composite that reports: its own value only; its hop ticks stop and its part\'s values are dropped', async () => {
      const r = await post(`${OUTER}wrapreporting`, 'c-2');
      assert.deepStrictEqual(reportsOf(r.notes), [[20, 100]]);
    });
  });

  describe('stdio', () => {
    it('the handler\'s reports are lines before the answer\'s line, none after', async () => {
      const h = home();
      const io = startStdio(serverArgs(h), {env: {COUNTINGHOUSE_API_KEY: KEY}});
      try {
        await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 't', version: '1'}}});
        for (let w = 0; w < 60000; w += 200) {
          const list = await io.request({jsonrpc: '2.0', id: `l${w}`, method: 'tools/list', params: {}});
          if (list.result.tools.some((t) => t.name === `${PART}work`)) break;
          await tick(200);
        }
        const answer = await io.request({jsonrpc: '2.0', id: 9, method: 'tools/call', params: {_meta: {progressToken: 9}, name: `${PART}work`, arguments: {}}}, 60000);
        assert.strictEqual(answer.result.isError, false);
        await tick(300);
        const msgs = io.lines.map((l) => JSON.parse(l));
        const at = msgs.findIndex((m) => m.id === 9);
        assert.deepStrictEqual(reportsOf(progressOf(msgs.slice(0, at))), [[10, 100], [50, 100], [90, 100]]);
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
      const nm = path.join(h, 'pack', 'node_modules');
      fs.cpSync(path.join(FX, 'progress-part'), path.join(nm, 'progress-part'), {recursive: true});
      const pkgFile = path.join(nm, 'progress-part', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
      fs.writeFileSync(pkgFile, JSON.stringify(pkg));
      child = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--store', 'local', '--storePath', path.join(h, 'store'),
        '--modulePath', path.join(h, 'modules'), '--moduleDataPath', path.join(h, 'module_data'), '--controlChannel', 'ipc',
        '--sessionSocket', path.join(run, 's'), '--loadModule', path.join(nm, 'progress-part')],
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

    it('the handler\'s reports reach its own session\'s connection, before its answer, none after', async () => {
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
      shim.message(s.c, {seq: 31}, JSON.stringify({jsonrpc: '2.0', id: 31, method: 'tools/call',
        params: {_meta: Object.assign({progressToken: 's-1'}, META), name: 'work', arguments: {}}}));
      for (let w = 0; w < 60000 && !got.some((g) => g.seq === 31); w += 50) await tick(50);
      const at = got.findIndex((g) => g.seq === 31);
      assert.ok(at >= 0, 'answered');
      assert.strictEqual(got[at].msg.result.isError, false, JSON.stringify(got[at].msg).slice(0, 300));
      await tick(300);
      assert.deepStrictEqual(reportsOf(progressOf(got.slice(0, at).filter((g) => g.seq == null).map((g) => g.msg))), [[10, 100], [50, 100], [90, 100]]);
      assert.deepStrictEqual(progressOf(got.slice(at + 1).map((g) => g.msg)), [], 'nothing after its answer');
      s.c.end();
    });
  });
});
