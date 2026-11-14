// R2-1's gate: nothing a module can reach holds an API key, a user name or
// the Redis URL -- not ctx, not its job info or recordUsage result, not
// globalThis (process.env, CHUtil, the worker's device manager and its peer
// channel state). Checked through every way a call reaches a module: MCP,
// HTTP invoke-action (with X-CH-Key), a task, and a peer hop from a composite
// bound to an internal identity, whose own view is checked too.
//
// On since R2-1's last task removed the old fields (Task 5); before it, it
// failed, listing where each value was found. A walk that ran out of budget
// would prove nothing, so a view must not have.
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT = 9631;
const URL  = `http://127.0.0.1:${PORT}`;
const hex  = () => crypto.randomBytes(8).toString('hex');
const ALICE = `alice-key-${hex()}`;
const BOB   = `bob-key-${hex()}`;
const INTERNAL = `kdc-internal-key-${hex()}`;
const NAMES = {alice: `alice-${hex()}`, bob: `bob-${hex()}`, internal: `kdc-internal-${hex()}`};
const NEEDLES = [ALICE, BOB, INTERNAL, NAMES.alice, NAMES.bob, NAMES.internal, 'redis://'];
const reversed = NEEDLES.map((n) => n.split('').reverse().join(''));
const ID_SHAPE = /^u_[A-Za-z0-9_-]{22}$/;

const DUMP = 'key_dump_dumpservice_dump';
const VIA  = 'key_dump_caller_callerservice_viacall';
const DEVICE = deviceIDForName('key-dump');
const SERVICE = 'urn:countinghouse-test:serviceID:dumpService';

const mcp = (key, method, params) => request(URL).post('/mcp').set('X-CH-Key', key)
  .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method, params}).then((r) => r.body);

// What a view found, by needle name, for the failure message.
function describeHits(view) {
  return (view.hits || []).map((h) => (h.key != null ? `property ${h.key} at ${h.path}` : `${NEEDLES[h.needle] === 'redis://' ? 'redis://' : ['alice key', 'bob key', 'internal key', 'alice name', 'bob name', 'internal name'][h.needle]} at ${h.path}`));
}

function assertClean(view, label) {
  const names = Array.from(new Set((view.accessors || []).map((p) => p.slice(p.lastIndexOf('.') + 1)))).sort();
  console.log(`    [${label}] visited ${view.visited}, budget exhausted: ${view.budgetExhausted}, depth-capped: ${view.depthCapped}, ` +
    `accessors skipped: ${view.accessorCount} (names: ${names.join(', ')})`);
  assert.strictEqual(view.budgetExhausted, false, `${label}: the walk ran out of budget, so it proves nothing`);
  assert.strictEqual(view.hitCount, 0, `${label}: ${view.hitCount} found:\n  ${describeHits(view).join('\n  ')}`);
  assert.deepStrictEqual(Object.keys(view.caller || {}).sort(), ['id', 'isAdmin'], `${label}: ctx.caller is ${JSON.stringify(Object.keys(view.caller || {}))}`);
  assert.match(view.caller.id, ID_SHAPE);
  assert.strictEqual(view.caller.isAdmin, false);
}

describe('auth 30: no API key, user name or Redis URL reaches a module', function() {
  this.timeout(120000);
  let base = null;
  let server = null;

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-key-dump-'));
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({
      [ALICE]: {userName: NAMES.alice, devices: ['*']},
      [BOB]: {userName: NAMES.bob, devices: ['*']},
      [INTERNAL]: {userName: NAMES.internal, devices: ['*'], runsModules: ['key-dump-caller']}
    }));
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'key-dump'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'key-dump-caller')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('over MCP', async () => {
    const r = await mcp(ALICE, 'tools/call', {name: DUMP, arguments: {reversed}});
    assert.strictEqual(r.result && r.result.isError, false, JSON.stringify(r).slice(0, 500));
    assertClean(r.result.structuredContent, 'MCP');
  });

  it('over HTTP invoke-action, with the key in X-CH-Key', async () => {
    const r = await request(URL).post(`/devices/${DEVICE}/invoke-action`).set('X-CH-Key', BOB)
      .send({serviceID: SERVICE, actionName: 'dump', input: {reversed}});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 500));
    assertClean(r.body.output || r.body, 'HTTP');
  });

  it('as a task', async () => {
    const created = await mcp(ALICE, 'tools/call', {name: DUMP, arguments: {reversed}, task: {}});
    const taskId = created.result.task.taskId;
    let status = null;
    for (let i = 0; i < 100 && status !== 'completed' && status !== 'failed'; i++) {
      await new Promise((ok) => setTimeout(ok, 100));
      status = (await mcp(ALICE, 'tasks/get', {taskId})).result.status;
    }
    assert.strictEqual(status, 'completed');
    const res = await mcp(ALICE, 'tasks/result', {taskId});
    assertClean(res.result.structuredContent || JSON.parse(res.result.content[0].text), 'task');
  });

  // #153's review (1): a part listening on its own peer channel's port sees
  // every invoke that crosses it; none carries a key. The first call opens
  // the channel and starts the listener; the second crosses it.
  it('on the peer channel\'s port, as a part listening on it sees each invoke', async () => {
    await mcp(ALICE, 'tools/call', {name: VIA, arguments: {reversed}});
    const r = await mcp(ALICE, 'tools/call', {name: VIA, arguments: {reversed}});
    assert.strictEqual(r.result && r.result.isError, false, JSON.stringify(r).slice(0, 500));
    const out = r.result.structuredContent || JSON.parse(r.result.content[0].text);
    assert.ok(out.callee.portMessages > 0, `the listener saw no message: ${JSON.stringify(out.callee).slice(0, 300)}`);
    assertClean(out.callee, 'peer port');
  });

  it('through a peer hop from a composite bound to an internal identity, and in the composite itself', async () => {
    const r = await mcp(ALICE, 'tools/call', {name: VIA, arguments: {reversed}});
    assert.strictEqual(r.result && r.result.isError, false, JSON.stringify(r).slice(0, 500));
    const out = r.result.structuredContent || JSON.parse(r.result.content[0].text);
    const failures = [];
    [[out.callee, 'peer callee'], [out.self, 'composite']].forEach(([view, label]) => {
      try { assertClean(view, label); } catch (e) { failures.push(e.message); }
    });
    assert.deepStrictEqual(failures, []);
  });
});
