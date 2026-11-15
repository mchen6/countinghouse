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

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'session-probe-preload.js');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'hop-input-caller');
// sandbox 54's keys: the client's, and the caller's runsModules binding
const AUTH = path.join(ROOT, 'test', 'sandbox', '48-auth.json');
const KEY = 'hop-input-key';

['routed', 'peer'].forEach((route) => {
  describe(`sessions 03: --stdio's one session on each call, main thread only (B1 Task 2, ${route} hop)`, function() {
    this.timeout(120000);
    let io = null;
    let home = null;
    let probe = null;
    before(async () => {
      home = tmp.mkdtemp('ch-b1-03-');
      probe = path.join(home, 'probe.jsonl');
      io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
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
      assert.ok(lines.some((l) => l.kind === 'post'), 'the probe saw the posts');
      assert.deepStrictEqual(lines.filter((l) => l.kind === 'leak'), [], 'no worker or port is told the session');
    });
  });
});
