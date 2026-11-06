// The main thread dispatched redisAPI.client[op] for whatever op a worker's
// rediscommand message named. Module code can send that message itself, and
// an op such as 'constructor' replaced the main thread's Redis client,
// breaking Redis for every module (review R1-3). Ops are now checked against
// the supported commands first.
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

describe('sandbox 20: a forged rediscommand op', function() {
  this.timeout(120000);
  let server = null;
  before(async () => {
    server = await startServer(9664, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'enforce',
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'redis-forge')]);
  });
  after(() => stopServer(server));

  ['constructor', '__proto__', 'toString', '__defineGetter__', 'flushall'].forEach((op) => {
    it(`'${op}' is refused, and Redis still works afterwards`, async () => {
      const r = await mcpCall(9664, 'k', 'redis_forge_forgeservice_forge', {op: op});
      const out = toolOutput(r);
      assert.ok(/^error: .*not a supported redis command/i.test(String(out.forged)), JSON.stringify(out) + server.output.slice(-1500));
      assert.strictEqual(out.after, 'still works', JSON.stringify(out));
    });
  });

  it('a supported command still works through the same message', async () => {
    const r = await mcpCall(9664, 'k', 'redis_forge_forgeservice_forge', {op: 'get'});
    const out = toolOutput(r);
    assert.ok(/^ok: /.test(String(out.forged)), JSON.stringify(out));
    assert.strictEqual(out.after, 'still works');
  });
});
