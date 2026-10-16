// Each limit ends the worker with its own reason, and the module restarts;
// the message rate rejects without killing.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');

const KEY  = 'aabbcc';
const HOG  = path.join(ROOT, 'test', 'fixtures', 'sandbox-hog');
const tool = (action) => `sandbox_hog_hogservice_${action}`;

async function lastReason(port) {
  const r = await post(port, KEY, '/get-module-device-list', {name: 'sandbox-hog'});
  const s = r.body != null ? r.body.sandbox : null;
  return s != null && s.exits.length > 0 ? s.exits[s.exits.length - 1].reason : null;
}

describe('sandbox 08: resource limits', function() {
  this.timeout(120000);
  let server = null;
  beforeEach(async () => {
    server = await startServer(9613, ['--debug', '--debugKey', KEY, '--workerThread', '--moduleMessageRate', '50', '--loadModule', HOG]);
  });
  afterEach(() => stopServer(server));

  [['heap', 'heap limit'], ['external', 'external memory limit'], ['block', 'blocked event loop']].forEach(([action, reason]) => {
    it(`${action}: ends the worker with "${reason}" and restarts it`, async () => {
      mcpCall(9613, KEY, tool(action), {}).catch(() => {});
      const got = await waitFor(() => lastReason(9613), 20000, `exit reason for ${action}`);
      assert.strictEqual(got, reason);
      await waitFor(async () => (await mcpCall(9613, KEY, tool('ping'), {})).isError === false, 15000, 'ping after restart');
    });
  });

  it('a call in flight when the worker is killed gets MODULE_RESTARTING, not a timeout', async () => {
    const t0 = Date.now();
    const r = await mcpCall(9613, KEY, tool('block'), {});
    assert.strictEqual(r.structuredContent.code, 'MODULE_RESTARTING', JSON.stringify(r));
    assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  });

  it('the message rate rejects excess messages without killing the module', async () => {
    const r = await mcpCall(9613, KEY, tool('flood'), {});
    assert.strictEqual(r.isError, false, JSON.stringify(r));
    assert.ok(r.structuredContent.output.limited > 0, JSON.stringify(r.structuredContent));
    assert.strictEqual((await mcpCall(9613, KEY, tool('ping'), {})).isError, false);
    assert.strictEqual(await lastReason(9613), null);
  });
});
