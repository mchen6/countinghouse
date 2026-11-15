'use strict';
// B1 Task 2, spawned: --stdio is one session, and every call it serves
// carries it on the main thread only. The client's own call's token and each
// hop's (routed, and over a direct peer channel) hold the session's id; no
// message the main thread posts to a worker or a channel port names it. The
// runtime preloads test/fixtures/session-probe-preload.js. (Two sessions
// reaching one module, and ctx.caller.id alike for both, come with C1 part 2,
// which hands the gateway its sessions.)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {redisArgs} = require('../helpers/test-env');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'session-probe-preload.js');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'hop-input-caller');
// sandbox 54's keys: the client's, and the caller's runsModules binding
const AUTH = path.join(ROOT, 'test', 'sandbox', '48-auth.json');
const KEY = 'hop-input-key';

// the local store (its job runner, lib/job-control-local.js) on both hops,
// and Redis (BullMQ's, lib/job-control.js) on the routed one
[['routed', 'local'], ['peer', 'local'], ['routed', 'redis']].forEach(([route, store]) => {
  describe(`sessions 03: --stdio's one session on each call, main thread only (B1 Task 2, ${route} hop, ${store} store)`, function() {
    this.timeout(120000);
    let io = null;
    let home = null;
    let probe = null;
    before(async () => {
      home = tmp.mkdtemp('ch-b1-03-');
      probe = path.join(home, 'probe.jsonl');
      const storeArgs = store === 'local' ? ['--store', 'local', '--storePath', path.join(home, 'store')] : redisArgs();
      io = startStdio(['--workerThread', ...storeArgs, '--modulePath', path.join(home, 'modules'),
        '--moduleDataPath', path.join(home, 'module_data'), '--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, ...(route === 'peer' ? ['--directPeerChannels'] : [])],
      {env: {NODE_OPTIONS: `--require ${PRELOAD}`, CH_TEST_SESSION_PROBE: probe, COUNTINGHOUSE_API_KEY: KEY}});
      const init = await io.request({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'test', version: '1'}}});
      assert.ok(init.result != null, JSON.stringify(init));
    });
    after(() => { if (io != null) io.child.kill('SIGKILL'); io = null; if (home) fs.rmSync(home, {recursive: true, force: true}); });

    it('the call\'s token and its hop\'s hold the session; nothing posted to a worker or a port names it', async () => {
      const list = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}});
      const tool = list.result.tools.find((t) => /hop.input.caller/i.test(t.name) && /(^|_)call$/.test(t.name));
      assert.ok(tool != null, JSON.stringify(list.result.tools.map((t) => t.name)));
      const r = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: tool.name, arguments: {action: 'big', args: {n: 10}}}});
      assert.ok(r.result != null && r.result.isError !== true, JSON.stringify(r).slice(0, 800) + io.err.slice(-1500));
      const lines = fs.readFileSync(probe, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const issued = lines.filter((l) => l.kind === 'issue');
      assert.ok(issued.some((l) => !l.hop && l.ours), `the client's call's token: ${JSON.stringify(issued)}`);
      assert.ok(issued.some((l) => l.hop && l.ours), `its hop's token: ${JSON.stringify(issued)}`);
      assert.deepStrictEqual(issued.filter((l) => !l.ours), [], 'every token of this call is the session\'s');
      // the probe saw the call itself go to its worker (and on a routed hop,
      // the hop's to the callee's): the messages a session could ride on
      const invokes = lines.filter((l) => l.kind !== 'issue' && l.command === 'invoke-action').length;
      assert.ok(invokes >= (route === 'routed' ? 2 : 1), `invoke-action posts seen: ${invokes}; ${JSON.stringify([...new Set(lines.map((l) => `${l.via}:${l.command}`))])}`);
      assert.deepStrictEqual(lines.filter((l) => l.kind === 'leak'), [], 'no worker or port is told the session');
    });

    it('a task the session creates: its run\'s token and its hop\'s hold the session (B1 Task 3); still nothing posted names it', async () => {
      const seen = fs.readFileSync(probe, 'utf8').trim().split('\n').length;
      const list = await io.request({jsonrpc: '2.0', id: 10, method: 'tools/list', params: {}});
      const tool = list.result.tools.find((t) => /hop.input.caller/i.test(t.name) && /(^|_)call$/.test(t.name));
      const created = await io.request({jsonrpc: '2.0', id: 11, method: 'tools/call', params: {name: tool.name, arguments: {action: 'big', args: {n: 10}}, task: {}}});
      assert.ok(created.result != null && created.result.task != null, JSON.stringify(created).slice(0, 600) + io.err.slice(-1500));
      let status = null;
      for (let i = 12; i < 160 && status !== 'completed' && status !== 'failed'; i++) {
        const got = await io.request({jsonrpc: '2.0', id: i, method: 'tasks/get', params: {taskId: created.result.task.taskId}});
        assert.ok(got.result != null, `tasks/get: ${JSON.stringify(got).slice(0, 400)}`);
        status = got.result.status;
        if (status !== 'completed') await new Promise((r) => setTimeout(r, 100));
      }
      assert.strictEqual(status, 'completed', io.err.slice(-1500));
      const lines = fs.readFileSync(probe, 'utf8').trim().split('\n').slice(seen).map((l) => JSON.parse(l));
      const issued = lines.filter((l) => l.kind === 'issue');
      assert.ok(issued.some((l) => l.job && l.ours), `the run's token: ${JSON.stringify(issued)}`);
      assert.ok(issued.some((l) => l.hop && l.ours), `its hop's token: ${JSON.stringify(issued)}`);
      assert.deepStrictEqual(issued.filter((l) => !l.ours), [], 'every token of the task is the session\'s');
      assert.deepStrictEqual(lines.filter((l) => l.kind === 'leak'), [], 'no worker or port is told the session');
    });
  });
});
