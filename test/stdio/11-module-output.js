// --stdio, where stdout is the MCP channel: a module's output never reaches
// it (the review of #186). Under enforce the module writes to runtime-owned
// streams, and what it writes reaches stderr named, cut and bounded
// (lib/worker-stdio.js, lib/worker-output.js); a 10 MB flood leaves stdout
// holding JSON-RPC only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, waitForTool, INITIALIZE} = require('../helpers/stdio-client');
const tmp = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const MODULE = path.join(ROOT, 'test', 'fixtures', 'stdout-flood');
const KEY = 'stdio-output-key';

describe('--stdio: a module\'s output goes to stderr, bounded (--moduleSandbox enforce)', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-out-')); });
  after(async () => {
    if (io != null) await io.stop();
    tmp.remove(home);
  });

  it('a line on each stream and a 10 MB flood: stdout holds JSON-RPC only; stderr has the lines named, and at most 256 KiB of the flood', async () => {
    const auth = path.join(home, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio', devices: ['*']}}));
    io = startStdio(['--workerThread', '--moduleSandbox', 'enforce', '--debug', '--loadModule', MODULE, '--authConfigPath', auth,
      '--moduleDataPath', path.join(home, 'module_data'), '--redisUrl', 'redis://127.0.0.1:9749'], {env: {COUNTINGHOUSE_API_KEY: KEY}});
    await io.request({...INITIALIZE, id: 1});
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const say = await waitForTool(io, /say$/);
    const flood = await waitForTool(io, /flood$/);
    await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: say.name, arguments: {}}});
    await io.request({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: flood.name, arguments: {mb: 10}}});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const run = io;
    io = null;
    const exit = await run.stop();
    assert.strictEqual(exit.code, 0);
    assert.ok(run.lines.length >= 3);
    for (const l of run.lines) assert.strictEqual(JSON.parse(l).jsonrpc, '2.0', l.slice(0, 200));
    const err = run.err;
    assert.ok(err.includes('stdout-flood: stdout-flood says [31mred[0m on stdout'), err.slice(-2000));
    assert.ok(err.includes('stdout-flood: stdout-flood says ]0;title on stderr'));
    const flooded = err.split('\n').filter((l) => l.startsWith('stdout-flood: xxxx')).reduce((n, l) => n + Buffer.byteLength(l), 0);
    assert.ok(flooded <= 256 * 1024 + 4096, `${flooded} bytes of the flood on stderr`);
  });
});
