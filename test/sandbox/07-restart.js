// Unexpected worker exits restart with backoff and suspend; calls meanwhile
// get MODULE_RESTARTING / MODULE_SUSPENDED; the tool stays listed; operator
// actions never count (Review Focus 4); off keeps today's behaviour.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');

const KEY  = 'aabbcc';
const HOG  = path.join(ROOT, 'test', 'fixtures', 'sandbox-hog');
const tool = (action) => `sandbox_hog_hogservice_${action}`;

async function status(port) {
  const r = await post(port, KEY, '/get-module-device-list', {name: 'sandbox-hog'});
  return r.body != null ? r.body.sandbox : null;
}

async function listed(port) {
  const r = await new Promise((resolve, reject) => {
    require('supertest')(`http://127.0.0.1:${port}`).post('/mcp').set('X-CH-Key', KEY)
      .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}})
      .end((err, res) => (err ? reject(err) : resolve(res.body.result.tools.map((t) => t.name))));
  });
  return r.indexOf(tool('ping')) !== -1;
}

const pingOk = (port) => async () => {
  const r = await mcpCall(port, KEY, tool('ping'), {});
  return r.isError === false;
};

describe('sandbox 07: restart and suspend', function() {
  this.timeout(120000);

  describe('under audit', () => {
    let server = null;
    before(async () => {
      server = await startServer(9611, ['--debug', '--debugKey', KEY, '--workerThread', '--loadModule', HOG]);
    });
    after(() => stopServer(server));

    it('restarts a module whose worker exited, and answers MODULE_RESTARTING meanwhile with the tool still listed', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      const during = await waitFor(async () => {
        const r = await mcpCall(9611, KEY, tool('ping'), {});
        return r.isError === true && r.structuredContent.code === 'MODULE_RESTARTING' ? r : null;
      }, 5000, 'MODULE_RESTARTING');
      assert.ok(during);
      assert.strictEqual(await listed(9611), true);
      await waitFor(pingOk(9611), 15000, 'ping after restart');
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits[0].reason, 'exit code 3');
    });

    it('suspends after the third exit in the window', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      // the exit lands 50 ms after the reply: ping only once the worker is down
      await waitFor(async () => ((await status(9611)) || {}).state === 'restarting', 5000, 'restarting');
      await waitFor(pingOk(9611), 15000, 'second restart');
      await mcpCall(9611, KEY, tool('exit'), {});
      const s = await waitFor(async () => {
        const st = await status(9611);
        return st != null && st.state === 'suspended' ? st : null;
      }, 10000, 'suspended');
      assert.strictEqual(s.exits.length, 3);
      const r = await mcpCall(9611, KEY, tool('ping'), {});
      assert.strictEqual(r.structuredContent.code, 'MODULE_SUSPENDED');
      assert.strictEqual(await listed(9611), true);
      assert.ok(server.output.includes('module sandbox: sandbox-hog suspended'), server.output.slice(-2000));
    });

    it('an operator restart clears the suspension', async () => {
      await post(9611, KEY, '/restart-module', {path: HOG, name: 'sandbox-hog', version: '1.0.0'});
      await waitFor(pingOk(9611), 15000, 'ping after operator restart');
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits.length, 0);
    });

    // Review Focus 4.
    it('operator restarts, reloads and loads never count, even mid-restart', async () => {
      await mcpCall(9611, KEY, tool('exit'), {});
      await waitFor(async () => ((await status(9611)) || {}).state === 'restarting', 5000, 'restarting');
      await post(9611, KEY, '/restart-module', {path: HOG, name: 'sandbox-hog', version: '1.0.0'});
      await waitFor(pingOk(9611), 15000, 'ping');
      for (let i = 0; i < 3; i++) {
        await post(9611, KEY, '/reload-module', {path: HOG});
        await waitFor(pingOk(9611), 15000, `ping after reload ${i}`);
      }
      const s = await status(9611);
      assert.strictEqual(s.state, 'running');
      assert.strictEqual(s.exits.length, 0);
    });
  });

  describe('under off', () => {
    let server = null;
    before(async () => {
      server = await startServer(9612, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleSandbox', 'off', '--loadModule', HOG]);
    });
    after(() => stopServer(server));

    it('a module whose worker exited stays down, as before', async () => {
      await mcpCall(9612, KEY, tool('exit'), {});
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const r = await mcpCall(9612, KEY, tool('ping'), {});
      assert.notStrictEqual(r.isError, false, JSON.stringify(r));
    });
  });
});
