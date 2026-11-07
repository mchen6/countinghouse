// A composite's hop still in flight when the inner module reloads: the outer
// call fails promptly with a code, the next call works on the new worker,
// and only the hop that completed is billed. With direct peer channels (the
// default) the channel is invalidated and the hop fails PEER_GONE; without
// them the hop goes through the main thread, where the inner worker's
// in-flight work is failed as the worker ends (MODULE_RELOADING).
//
// A callee's own coded error reaches the composite's caller with its code
// when the code is one of the runtime's (lib/error-info.en-US.json), on
// either path; any other code is a callee crash to the caller
// (DEVICE_INVOKE_EXCEPTION), so a callee cannot pass a made-up code off as
// a runtime one.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');

const INNER = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const OUTER = path.join(ROOT, 'test', 'fixtures', 'worker-end-caller');
// The composing module's identity is the debug key too (as in composition
// 04), so every hop and the outer call bill the one balance read here.
const KEY   = 'worker-end-caller-internal';
const OUTER_TOOL = 'worker_end_caller_callerservice_pingthenhang';
const PROMPT_MS  = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const balance = (port) => request(`http://127.0.0.1:${port}`).get('/balance').set('X-CH-Key', KEY).then((r) => r.body.balance);

[{label: 'with direct peer channels', port: 9609, flags: [], reloadCode: 'PEER_GONE'},
  {label: 'without direct peer channels', port: 9610, flags: ['--no-directPeerChannels'], reloadCode: 'MODULE_RELOADING'}].forEach((variant) => {
  describe(`composition 15: a composite's in-flight hop when its inner module reloads, ${variant.label}`, function() {
    this.timeout(120000);
    let base = null;
    let server = null;

    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-composite-reload-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[KEY]: {userName: 'worker-end-caller-internal', devices: ['*'], runsModules: ['worker-end-caller']}}));
      server = await startServer(variant.port, ['--workerThread', '--debug', '--debugKey', KEY, '--mcpToolCallCost', '1',
        '--authConfigPath', authPath, '--loadModule', INNER, '--loadModule', OUTER].concat(variant.flags));
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('fails promptly with a code, bills only the completed hop, and the next call reaches the new worker', async () => {
      const before = await balance(variant.port);
      const started = Date.now();
      const call = mcpCall(variant.port, KEY, OUTER_TOOL, {});
      await sleep(800);
      await post(variant.port, KEY, '/load-module', {path: INNER, name: 'worker-end'});
      const r = await call;
      const ms = Date.now() - started;
      assert.strictEqual(r.isError, true, JSON.stringify(r));
      assert.strictEqual(toolErrorCode(r), variant.reloadCode, JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
      // Billing is recorded asynchronously; give it a fixed window.
      await sleep(1500);
      assert.strictEqual(before - (await balance(variant.port)), 1, 'only the completed ping hop is billed');
      await waitFor(async () => (await mcpCall(variant.port, KEY, 'worker_end_endservice_ping', {}, {allowUnknownTool: true})).isError === false,
        20000, 'the reloaded inner module to answer');
    });

    it('a callee\'s runtime error code reaches the caller', async () => {
      const r = await mcpCall(variant.port, KEY, 'worker_end_caller_callerservice_callfailcatalogue', {});
      assert.strictEqual(toolErrorCode(r), 'DEVICE_INVOKE_FAIL', JSON.stringify(r));
    });

    it('a callee\'s made-up error code does not: the caller sees a callee crash', async () => {
      const r = await mcpCall(variant.port, KEY, 'worker_end_caller_callerservice_callfailmadeup', {});
      assert.strictEqual(toolErrorCode(r), 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(r));
    });
  });
});
