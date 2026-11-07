// When a module's worker ends -- a reload, an unload, a crash, with the
// sandbox on or off -- what it had in flight fails at once with a code that
// says why, instead of waiting for the request timeout (calls) or never
// settling at all (tasks). The codes: MODULE_RELOADING for a reload,
// MODULE_UNLOADED for an unload or a crash with no supervisor to restart it
// (the module stays down), MODULE_RESTARTING for a crash the supervisor
// restarts. Calls the worker answers before it ends still get their answer.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
const {toolErrorCode} = require('../helpers/tool-result');
const {deviceIDForName} = require('../../lib/call-address');

const KEY     = 'worker-end-key';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'worker-end');
const DEVICE  = deviceIDForName('worker-end');
const SERVICE = 'urn:countinghouse-test:serviceID:endService';
const tool    = (action) => `worker_end_endservice_${action}`;
const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));
// Prompt means well inside the 30 s request timeout a dropped call used to wait for.
const PROMPT_MS = 8000;

const mcp = (port, method, params) => request(`http://127.0.0.1:${port}`).post('/mcp').set('X-CH-Key', KEY)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method, params}).then((r) => r.body);

async function ensureLoaded(port) {
  const up = async () => (await mcpCall(port, KEY, tool('ping'), {}, {allowUnknownTool: true})).isError === false;
  if (await up()) return;
  await post(port, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
  await waitFor(up, 20000, 'worker-end to answer ping');
}

// Starts a call that will be in flight, and times it.
function inFlight(port, action) {
  const started = Date.now();
  return mcpCall(port, KEY, tool(action), {}).then((r) => ({r: r, ms: Date.now() - started}));
}

async function runningTask(port) {
  const created = await mcp(port, 'tools/call', {name: tool('hang'), arguments: {}, task: {}});
  const taskId = created.result.task.taskId;
  await waitFor(async () => (await mcp(port, 'tasks/get', {taskId})).result.status === 'working', 10000, 'the task to start');
  return taskId;
}

async function settledTask(port, taskId) {
  return waitFor(async () => {
    const got = (await mcp(port, 'tasks/get', {taskId})).result;
    return (got.status === 'failed' || got.status === 'completed') ? got : null;
  }, PROMPT_MS, `task ${taskId} to settle`);
}

describe('sandbox 23: work in flight when a worker ends fails at once, with why', function() {
  this.timeout(120000);

  describe('under audit (the supervisor restarts crashes)', () => {
    const PORT = 9607;
    let server = null;
    before(async () => { server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', FIXTURE]); });
    beforeEach(() => ensureLoaded(PORT));
    after(() => stopServer(server));

    it('a reload fails a call in flight with MODULE_RELOADING', async () => {
      const call = inFlight(PORT, 'hang');
      await sleep(300);
      await post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_RELOADING', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
    });

    it('an unload fails a call in flight with MODULE_UNLOADED', async () => {
      const call = inFlight(PORT, 'hang');
      await sleep(300);
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'worker-end'})).status, 200);
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_UNLOADED', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
    });

    it('a crash the supervisor restarts fails a call in flight with MODULE_RESTARTING, as before', async () => {
      const call = inFlight(PORT, 'hang');
      await sleep(300);
      await mcpCall(PORT, KEY, tool('crash'), {}).catch(() => null);
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_RESTARTING', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
    });

    // Drained when the worker ends, not when the unload is sent: a reply
    // the worker posts before it handles the unload is the real answer.
    it('a call the worker answers before it handles the reload still gets its answer', async () => {
      const call = inFlight(PORT, 'busy');
      await sleep(100);
      await post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
      const {r} = await call;
      assert.strictEqual(r.isError, false, JSON.stringify(r));
      // Shaped with the schema in effect when the call started
      // (mcp-contract/06), though the module is mid-reload when it answers.
      assert.deepStrictEqual(r.structuredContent, {ok: true});
    });

    it('a worker that ends before acknowledging an unload is cleaned up once, and its call fails MODULE_UNLOADED', async () => {
      const mark = server.output.length;
      const call = inFlight(PORT, 'die');
      await sleep(100);
      const unloaded = await post(PORT, KEY, '/unload-module', {name: 'worker-end'});
      assert.strictEqual(unloaded.status, 200, JSON.stringify(unloaded.body));
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_UNLOADED', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
      await sleep(500);
      const since = server.output.slice(mark);
      assert.strictEqual((since.match(/module: worker-end unloaded due to reason/g) || []).length, 1, since.slice(0, 2000));
      const names = (await mcp(PORT, 'tools/list', {})).result.tools.map((t) => t.name);
      assert.ok(!names.some((n) => n.startsWith('worker_end_')), JSON.stringify(names));
    });

    it('a reload fails a running task with MODULE_RELOADING, promptly', async () => {
      const taskId = await runningTask(PORT);
      await post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
      const got = await settledTask(PORT, taskId);
      assert.strictEqual(got.status, 'failed', JSON.stringify(got));
      const res = await mcp(PORT, 'tasks/result', {taskId});
      assert.strictEqual(toolErrorCode(res.result), 'MODULE_RELOADING', JSON.stringify(res));
    });

    it('an unload fails a running job with MODULE_UNLOADED and does not retry it', async () => {
      const added = await post(PORT, KEY, `/devices/${DEVICE}/add-job`, {serviceID: SERVICE, actionName: 'hang', input: {},
        opts: {name: 'worker-end-unload', attempts: 3}});
      assert.strictEqual(added.status, 200, JSON.stringify(added.body));
      const id = added.body.id;
      await waitFor(async () => (await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id})).body.state === 'active', 10000, 'the job to start');
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'worker-end'})).status, 200);
      const job = await waitFor(async () => {
        const b = (await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id})).body;
        return b.state === 'failed' ? b : null;
      }, PROMPT_MS, 'the job to fail');
      assert.match(job.job.failedReason, /^MODULE_UNLOADED: /);
      await sleep(1500);
      const after = (await post(PORT, KEY, `/devices/${DEVICE}/get-job`, {id})).body;
      assert.strictEqual(after.state, 'failed');
      assert.strictEqual(after.job.attemptsMade, 1, JSON.stringify(after.job));
    });
  });

  describe('under --moduleSandbox off (no supervisor: a crashed module stays down)', () => {
    const PORT = 9608;
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off', '--loadModule', FIXTURE]);
    });
    beforeEach(() => ensureLoaded(PORT));
    after(() => stopServer(server));

    it('a crash fails a call in flight with MODULE_UNLOADED', async () => {
      const call = inFlight(PORT, 'hang');
      await sleep(300);
      await mcpCall(PORT, KEY, tool('crash'), {}).catch(() => null);
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_UNLOADED', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
    });

    it('a crash fails a running task with MODULE_UNLOADED', async () => {
      const taskId = await runningTask(PORT);
      await mcpCall(PORT, KEY, tool('crash'), {}).catch(() => null);
      const got = await settledTask(PORT, taskId);
      assert.strictEqual(got.status, 'failed', JSON.stringify(got));
      assert.match(got.statusMessage, /^MODULE_UNLOADED: /);
    });

    it('a reload fails a call in flight with MODULE_RELOADING', async () => {
      const call = inFlight(PORT, 'hang');
      await sleep(300);
      await post(PORT, KEY, '/load-module', {path: FIXTURE, name: 'worker-end'});
      const {r, ms} = await call;
      assert.strictEqual(toolErrorCode(r), 'MODULE_RELOADING', JSON.stringify(r));
      assert.ok(ms < PROMPT_MS, `took ${ms} ms`);
    });
  });

  describe('a message sent to a worker that has ended', function() {
    this.timeout(5000);
    it('is answered at once with the code the worker ended with, not posted into the void', (done) => {
      const WorkerMessage = require('../../lib/worker-message');
      const posted = [];
      const wm = new WorkerMessage({postMessage: (m) => posted.push(m), on: () => {}, once: () => {}});
      wm.ended = {code: 'MODULE_UNLOADED', name: 'worker-end', reason: 'unloaded'};
      wm.sendInvokeActionMessage({deviceID: DEVICE, serviceID: SERVICE, actionName: 'ping', args: {}}, (err) => {
        try {
          assert.strictEqual(err && err.code, 'MODULE_UNLOADED');
          assert.deepStrictEqual(posted, []);
          return done();
        } catch (e) { return done(e); }
      });
    });
  });
});
