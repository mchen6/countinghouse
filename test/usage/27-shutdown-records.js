'use strict';
// B-shutdown-usage, on a running server: a task's pass and a direct
// tools/call both still running when the server is stopped -- SIGTERM (exit
// 143) or SIGINT (exit 0, as before) -- each leave a cancelled Out record in
// the usage directory, on either job runner (the local store's, BullMQ's).
// POSIX signals: not on Windows, where a signal ends a process outright.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const tmp = require('../helpers/test-tmp').forFile(['ch-usage-27-']);

const SLOW = 'echo_device_timeouttestservice_testtimeout';
// a legacy JSON-RPC request -> its parsed answer
let nextId = 1;
const rpc = (port, method, params, key) => new Promise((resolve, reject) => {
  const data = JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params});
  const rq = http.request({host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(data), 'X-CH-Key': key}}, (r) => {
    let t = '';
    r.on('data', (c) => { t += c; });
    r.on('end', () => { try { resolve(JSON.parse(t)); } catch (e) { resolve({raw: t}); } });
  });
  rq.on('error', reject);
  rq.end(data);
});
const {readUsage} = require('../../lib/usage/read');
// the records as the report reads them (none when nothing was written)
const recordsUnder = (dir) => (fs.existsSync(dir) ? readUsage(dir) : []);

const posix = process.platform === 'win32' ? describe.skip : describe;
[['the local store (its own runner)', true, testPort(9820)], ['Redis (the BullMQ runner)', false, testPort(9821)]].forEach(([label, local, port]) => {
  posix(`usage 27: stopped while a task and a direct call run, ${label} (B-shutdown-usage)`, function() {
    this.timeout(90000);
    const KEY = `k${require('crypto').randomBytes(12).toString('hex')}`;
    let server = null;
    afterEach(() => { if (server != null) stopServer(server); server = null; });

    const start = async (dir) => {
      const auth = path.join(dir, 'auth.json');
      fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'u', devices: ['*']}}), {mode: 0o600});
      server = await startServer(port, ['--workerThread', '--authProvider', 'file', '--authConfigPath', auth, '--usageDir', path.join(dir, 'usage'),
        '--moduleDataPath', path.join(dir, 'data'), '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module'),
        ...(local ? ['--store', 'local', '--storePath', path.join(dir, 'store')] : [])]);
      return server;
    };
    // both held by the slow action: the direct call first (its answer never
    // awaited), then the task; once the task's pass is working, a list
    // answered after both proves the direct call was dispatched before it
    const hold = async () => {
      const direct = rpc(port, 'tools/call', {name: SLOW, arguments: {}}, KEY).catch(() => null);
      const created = await rpc(port, 'tools/call', {name: SLOW, arguments: {}, task: {}}, KEY);
      assert.ok(created.result != null && created.result.task != null, JSON.stringify(created));
      const taskId = created.result.task.taskId;
      const end = Date.now() + 20000;
      let status = null;
      while (Date.now() < end) {
        status = ((await rpc(port, 'tasks/get', {taskId}, KEY)).result || {}).status;
        if (status === 'working') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.strictEqual(status, 'working', 'the task never started');
      await rpc(port, 'tools/list', {}, KEY);
      // (not returned: an async function returning a promise waits for it,
      // and the direct call answers only when its device times out)
      direct.then(() => undefined);
    };
    const exitOf = (s) => new Promise((resolve) => (s.exitCode != null || s.signalCode != null ? resolve({code: s.exitCode, signal: s.signalCode}) : s.once('exit', (code, signal) => resolve({code, signal}))));

    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 0]]) {
      it(`${signal}: exits ${code}, and both calls are recorded cancelled`, async () => {
        const dir = tmp.mkdtemp('ch-usage-27-');
        const s = await start(dir);
        await hold();
        process.kill(s.pid, signal);
        const ended = await exitOf(s);
        assert.deepStrictEqual(ended, {code, signal: null}, s.output.slice(-1500));
        const outs = recordsUnder(path.join(dir, 'usage')).filter((r) => r.tool === SLOW && r.bytesOut !== undefined);
        assert.deepStrictEqual(outs.map((r) => r.outcome), ['cancelled', 'cancelled'], JSON.stringify(outs));
        assert.ok(outs.every((r) => r.bytesOut === 0 && r.ms >= 0 && r.code === undefined), JSON.stringify(outs));
      });
    }
    tmp.hooks();
  });
});
