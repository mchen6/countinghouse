// MCP completeness M13 (the design, section 8): ctx.ask in a real worker.
// Spawned, --stdio: no port. The fixture's handler asks its one declared
// question and says in its result what came of asking
// (test/fixtures/asks-questions).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, waitForTool, withoutRedisNoise, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');
const {testPort} = require('../helpers/test-env');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'asks-questions');
const KEY = 'stdio-test-key';

describe('--stdio, spawned: a handler\'s ctx.ask (MCP completeness M13)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  beforeEach(() => { home = tmp.mkdtemp('ch-ask-'); });
  afterEach(async () => {
    if (io != null) await io.stop();
    io = null;
    tmp.remove(home);
  });
  const start = (extra = []) => {
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
    io = startStdio(['--workerThread', '--loadModule', FIXTURE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', `redis://127.0.0.1:${testPort(9749)}`, ...extra], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    return io;
  };
  const listed = async () => {
    const tool = await waitForTool(io, /askservice_probe$/);
    assert.ok(tool != null, `the module never listed; stderr without the Redis noise:\n${withoutRedisNoise(io.err)}`);
    return tool;
  };

  // a legacy call has no one to ask: the worker's ask reaches the main
  // thread, which answers ASK_UNAVAILABLE, and the handler falls back
  for (const mode of ['audit', 'enforce']) {
    it(`a legacy call's ctx.ask is answered by the main thread: no one to ask, and the handler falls back (${mode})`, async () => {
      start(['--moduleSandbox', mode]);
      const init = await io.request({...INITIALIZE, id: 1});
      assert.ok(init.result != null, JSON.stringify(init));
      const tool = await listed();
      const got = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: tool.name, arguments: {what: 'it'}}});
      assert.ok(got.result != null && got.result.isError !== true, JSON.stringify(got).slice(0, 600));
      assert.deepStrictEqual(got.result.structuredContent, {asked: false, code: 'ASK_UNAVAILABLE', runs: 1});
    });
  }
});
