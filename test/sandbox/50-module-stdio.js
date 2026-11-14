// A module's stdout and stderr, and its worker's own log, reach the operator
// bounded (the review of #186). Under audit and enforce the module writes to
// runtime-owned streams (lib/worker-stdio.js), never to Node's own, which
// hold its port to the main thread; what it writes crosses as messages, and
// the main thread cuts lines at 8 KiB, strips control characters and keeps
// 256 KiB a minute per stream, saying once a minute what it dropped
// (lib/worker-output.js). The worker's own log crosses as 'log' records
// under a budget of their own, in every mode; under off the module's output
// is left as it was.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {ROOT, startServer, stopServer, mcpCall, post} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');

const KEY = 'k';
const PORT = 9790;
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'stdout-flood');

// The server's main thread's CPU time, in ms (Linux).
const mainCpu = (pid) => {
  const st = fs.readFileSync(`/proc/${pid}/task/${pid}/stat`, 'utf8');
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) * 10;
};
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of ['enforce', 'audit']) {
  describe(`sandbox 50: a module's output, bounded (--moduleSandbox ${mode})`, function() {
    this.timeout(180000);
    let server = null;
    let base = null;
    const call = async (action, args) => toolOutput(await mcpCall(PORT, KEY, `stdout_flood_outservice_${action.toLowerCase()}`, args || {}));
    const lines = () => server.output.split('\n');

    before(async () => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-module-stdio-'));
      server = await startServer(PORT, ['--workerThread', '--moduleSandbox', mode, '--debug', '--debugKey', KEY,
        '--moduleDataPath', path.join(base, 'data'), '--loadModule', FIXTURE]);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('module code finds neither Node\'s own stdio streams nor a port, by any route the review named', async () => {
      assert.deepStrictEqual((await call('routes')).found, []);
      await settle(300);
      // _rawDebug went through the module's stderr: named, its escape gone
      assert.ok(lines().some((l) => l === 'stdout-flood: stdout-flood raw [31mdebug[0m'), server.output.slice(-2000));
    });

    it('each line is named, cut at 8 KiB and stripped of control characters; \\t is kept', async () => {
      await call('say');
      await settle(300);
      assert.ok(lines().includes('stdout-flood: stdout-flood says [31mred[0m on stdout'), server.output.slice(-2000));
      assert.ok(lines().includes('stdout-flood: stdout-flood says ]0;title on stderr'));
      const long = lines().find((l) => l.startsWith('stdout-flood: LLLL'));
      assert.ok(long != null && long.endsWith('…') && Buffer.byteLength(long) <= 8 * 1024 + 'stdout-flood: '.length, String(long && long.length));
      assert.ok(!/\x1b|\x07/.test(server.output), 'no escape reached the log');
    });

    it('10 MB to stdout: the main thread\'s CPU stays bounded; at most 256 KiB is written, and one line says what was dropped', async () => {
      const before = mainCpu(server.pid);
      await call('flood', {mb: 10});
      await settle(1000);
      const spent = mainCpu(server.pid) - before;
      assert.ok(spent < 1000, `main thread CPU ${spent} ms`);
      const written = lines().filter((l) => l.startsWith('stdout-flood: xxxx')).reduce((n, l) => n + Buffer.byteLength(l), 0);
      assert.ok(written <= 256 * 1024 + 4096, `${written} bytes written`);
      // the worker reports what it dropped within a second; the main thread
      // says it at the end of the minute, or when the worker ends
      await settle(1000);
      assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'stdout-flood'})).status, 200);
      await settle(1000);
      const drops = lines().filter((l) => /^stdout-flood: \d+ bytes of stdout dropped$/.test(l));
      assert.strictEqual(drops.length, 1, drops.join('\n'));
      assert.ok(Number(drops[0].match(/(\d+) bytes/)[1]) > 9 * 1024 * 1024, drops[0]);
    });
  });
}

describe('sandbox 50: the worker\'s own log, bounded in every mode (--moduleSandbox off)', function() {
  this.timeout(180000);
  let server = null;
  let base = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-module-stdio-'));
    server = await startServer(PORT, ['--workerThread', '--moduleSandbox', 'off', '--debug', '--debugKey', KEY,
      '--moduleDataPath', path.join(base, 'data'), '--loadModule', FIXTURE]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('records past 1 MiB a minute are dropped and counted in one line; each is named by the main thread', async () => {
    const r = toolOutput(await mcpCall(PORT, KEY, 'stdout_flood_outservice_logflood', {n: 400}));
    assert.strictEqual(r.reached, true);
    await settle(500);
    const records = server.output.split('\n').filter((l) => l.includes('stdout-flood log '));
    assert.ok(records.length > 100 && records.length < 400, `${records.length} records written`);
    assert.ok(records.every((l) => JSON.parse(l).module === 'stdout-flood'), records[0]);
    assert.strictEqual((await post(PORT, KEY, '/unload-module', {name: 'stdout-flood'})).status, 200);
    await settle(1000);
    assert.match(server.output, /stdout-flood: \d+ log records \(\d+ bytes\) dropped/);
  });
});
