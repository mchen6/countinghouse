// A client that lists the tools right after initialize gets the modules given
// with --loadModule, not only the built-ins (reviewer, 2026-11-13; dogfooding:
// Claude Code listed at 10.7 s and saw only countinghouse_usage_report, and,
// with no tools.listChanged declared and no notification sent, never listed
// again; a /mcp reconnect respawns the server and hits the same race).
// Under --stdio:
// - initialize answers at once, and declares tools.listChanged;
// - tools/list, and tools/call of a module's tool, wait for the startup
//   discovery of the --loadModule modules (loaded or failed, failing
//   composition verification included; test/composition/19), bounded (20 s;
//   the suite shortens it with COUNTINGHOUSE_TEST_STDIO_READY_BOUND_MS); a
//   call of a built-in tool does not wait; the client leaving opens the gate;
// - once a client has listed, a change to the tool list it was shown sends
//   exactly one notifications/tools/list_changed.
// slow-load-module takes about 3 s to load in its own worker;
// fails-load-module throws when loaded. The local store: no Redis, no port.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {mkdtemp, remove} = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const SLOW = path.join(ROOT, 'test', 'fixtures', 'slow-load-module');
const FAILS = path.join(ROOT, 'test', 'fixtures', 'fails-load-module');
const KEY = 'stdio-04-key';
const SETTLE_MS = 250;   // lib/route-manager.js STDIO_CHANGE_SETTLE_MS

function start(home, env = {}, modules = [SLOW]) {
  const auth = path.join(home, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({[KEY]: {userName: 'stdio-04', devices: ['*']}}));
  return startStdio(['--workerThread', '--authConfigPath', auth, '--store', 'local', '--storePath', path.join(home, 'store'),
    '--moduleDataPath', path.join(home, 'module_data'), '--modulePath', path.join(home, 'modules'), ...modules.flatMap((m) => ['--loadModule', m])],
  {env: {COUNTINGHOUSE_API_KEY: KEY, ...env}});
}

const notifications = (io) => io.lines.filter((l) => /"method":"notifications\/tools\/list_changed"/.test(l));
const names = (answer) => answer.result.tools.map((t) => t.name).sort();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('stdio 04: the tools wait for the modules being loaded, and a later change is announced', function() {
  this.timeout(120000);
  let home = null;
  let io = null;
  beforeEach(() => { home = mkdtemp('stdio-04-'); });
  afterEach(async () => {
    if (io != null) { io.child.kill('SIGKILL'); await io.exited; }
    io = null;
    remove(home);
  });

  it('a tools/list sent right after initialize is answered with the module that was still loading', async () => {
    io = start(home);
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(!/slow-load-module@1\.0\.0 loaded/.test(io.err), 'initialize answered before the module had loaded');
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    const listed = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list'}, 60000);
    assert.ok(names(listed).some((n) => /slow_load_module/.test(n)), JSON.stringify(names(listed)));
    assert.strictEqual(init.result.capabilities.tools.listChanged, true);
    await sleep(SETTLE_MS * 4);
    assert.deepStrictEqual(notifications(io), [], 'nothing changed after that list');
  });

  it('a tools/call sent right after initialize, before any list, reaches the module that was still loading', async () => {
    io = start(home);
    await io.request(INITIALIZE, 30000);
    const called = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'slow_load_module_slowservice_ping', arguments: {}}}, 60000);
    assert.ok(called.result != null && called.result.isError !== true, JSON.stringify(called).slice(0, 600));
    assert.match(JSON.stringify(called.result), /pong/);
  });

  it('a call of a built-in tool does not wait for the modules', async () => {
    io = start(home);
    await io.request(INITIALIZE, 30000);
    const called = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'countinghouse_usage_report', arguments: {}}}, 60000);
    assert.ok(called.result != null, JSON.stringify(called).slice(0, 600));
    assert.ok(!/slow-load-module@1\.0\.0 loaded/.test(io.err), 'answered before the module had loaded');
  });

  it('a module that fails to load does not hold tools/list for the bound', async () => {
    io = start(home, {}, [FAILS]);
    await io.request(INITIALIZE, 30000);
    const t0 = Date.now();
    const listed = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list'}, 60000);
    assert.ok(Date.now() - t0 < 15000, `answered after ${Date.now() - t0} ms, as if the failed module were still awaited`);
    assert.ok(!names(listed).some((n) => /fails_load_module/.test(n)), JSON.stringify(names(listed)));
  });

  it('a client that leaves while tools/list is held does not keep the process alive', async () => {
    io = start(home);
    await io.request(INITIALIZE, 30000);
    io.notify({jsonrpc: '2.0', id: 2, method: 'tools/list'});
    const t0 = Date.now();
    io.child.stdin.end();
    const {code} = await io.exited;
    assert.ok(Date.now() - t0 < 2500, `exited ${Date.now() - t0} ms after stdin closed`);
    assert.ok(!/slow-load-module@1\.0\.0 loaded/.test(io.err), 'it did not wait for the module');
    assert.strictEqual(code, 0);
  });

  it('a module still loading when the bound runs out appears later with exactly one list_changed', async () => {
    io = start(home, {COUNTINGHOUSE_TEST_STDIO_READY_BOUND_MS: '500'});
    await io.request(INITIALIZE, 30000);
    const first = await io.request({jsonrpc: '2.0', id: 2, method: 'tools/list'}, 60000);
    assert.ok(!names(first).some((n) => /slow_load_module/.test(n)), `the bound let the list go first: ${JSON.stringify(names(first))}`);
    for (const until = Date.now() + 60000; notifications(io).length === 0 && Date.now() < until;) await sleep(100);
    assert.strictEqual(notifications(io).length, 1, io.err.slice(-2000));
    const again = await io.request({jsonrpc: '2.0', id: 3, method: 'tools/list'}, 60000);
    assert.ok(names(again).some((n) => /slow_load_module/.test(n)), JSON.stringify(names(again)));
    await sleep(1500);
    assert.strictEqual(notifications(io).length, 1, 'exactly one');
  });
});
