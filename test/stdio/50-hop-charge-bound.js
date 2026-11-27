'use strict';
// B-hopcharge (release 1, from #484): a routed ctx.call hop (lib/device-
// manager.js) waits for its charge at most METER_PENDING_MS, as a peer hop
// does. Under --store local --meter the charge is the store's update(),
// which waits for a busy store lock up to 10 s: with another process holding
// the lock, the hop answers at the bound with its billing pending
// ({billingPending: true}, what the peer path gives a module), and the
// charge, issued once, lands once the lock is free -- the outer call's and
// the hop's, exactly two.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');
const {withStoreLock} = require('../../lib/store/json-file');
const tmp = require('../helpers/test-tmp').forFile(['ch-stdio-50-'], {base: require('os').tmpdir()});

const ROOT = path.resolve(__dirname, '..', '..');
const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;

function writeModule(dir, {name, role, calls, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: ch}));
  const actionList = Object.keys(actions).map((a) => ({name: a, description: `${a} of ${name}`,
    input: {schema: `/${service}/${a}/input`}, output: {schema: `/${service}/${a}/output`}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test',
    modelDescription: name, serviceList: {[SVC(service)]: {actionList}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object', [service]: schemas}));
  for (const [a, src] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}

// another process holding the store lock until the test releases it (a
// file appears), never past 30 s (so a test that fails can't wedge it):
// the lock is held until what the test observes, never for a fixed time
function holdLock(dir) {
  const release = path.join(dir, '..', `release-${process.pid}-${Date.now()}`);
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const {withStoreLock} = require(${JSON.stringify(path.join(ROOT, 'lib', 'store', 'json-file'))});
    const nap = new Int32Array(new SharedArrayBuffer(4));
    withStoreLock(${JSON.stringify(dir)}, () => {
      process.stdout.write('held\\n');
      const t = Date.now();
      while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() - t < 30000) Atomics.wait(nap, 0, 0, 10);
    });
  `], {stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  const free = async () => {
    fs.writeFileSync(release, '');
    await exited;
    fs.rmSync(release, {force: true});
  };
  return new Promise((resolve) => holder.stdout.once('data', () => resolve({holder, free})));
}

// How many charges have landed: one unit a charge, from nothing. Read under
// the store lock, so never while the runtime renames a new ledger into
// place: on Windows a rename over a file another process has open can be
// refused, and a charge whose write fails is not tried again -- the test's
// own read would lose the charge it looks for. What withStoreLock throws is
// the lock's (still busy after its wait: read again); a ledger that can't
// be read or counted is thrown marked {ledger: true}, never taken as busy.
const landedIn = (store) => {
  let bad = null;
  const n = withStoreLock(store, () => {
    try {
      let m = {};
      try {
        m = JSON.parse(fs.readFileSync(path.join(store, 'metering.json'), 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      let landed = 0;
      for (const [k, r] of Object.entries(m)) {
        if (r == null || typeof r.balance !== 'number') throw new Error(`metering record ${k} has no numeric balance: ${JSON.stringify(r)}`);
        landed -= r.balance;
      }
      return landed;
    } catch (e) {
      bad = e;
      return null;
    }
  });
  if (bad != null) throw Object.assign(bad, {ledger: true});
  return n;
};
async function eventually(check, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 100)); }
  return false;
}

describe('stdio 50: a routed hop waits for its charge at most METER_PENDING_MS (B-hopcharge)', function() {
  this.timeout(120000);
  let home = null;
  let store = null;
  let io = null;
  let nextId = 10;
  // every charge issued so far: two a successful call, the outer call's and
  // its hop's, each issued before its call is answered (lib/mcp/gateway.js
  // respond, lib/device-manager.js boundedCharge)
  let issued = 0;
  const landedLines = () => (io.err.match(/the pending billing landed/g) || []).length;
  // the ledger once it has settled: every charge issued has landed, each a
  // write of its own -- seen, never timed: a charge that met a busy lock
  // retries on a timer of its own (lib/store/json-file.js update), so a
  // balance that stands still for a while may be between two of them. The
  // wait is for a lower bound (charges landed), never for the value the
  // case asserts (async metering: CLAUDE.md): after it, two requests are
  // answered by the runtime's main thread and the ledger is read again and
  // compared as an equality, so one too many that has landed by then fails
  // as one too few does. A charge made twice that lands later still is
  // caught by the last case, which reads the ledger once nothing writes it.
  async function settled() {
    let n = 0;
    let busy = null;   // (a store lock still busy after the read's own wait: read again)
    const all = await eventually(() => {
      try { n = landedIn(store); } catch (e) { if (e.ledger === true) throw e; busy = e; return false; }
      return n >= issued;
    }, 30000);
    assert.ok(all, `${n} of ${issued} charges landed (${busy != null ? busy.message : 'the lock was free'})\n${io.err.slice(-1500)}`);
    for (let i = 0; i < 2; i++) await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 30000);
    return landedIn(store);
  }
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000)
    .then((r) => { if (r.result != null && r.result.isError !== true) issued += 2; return r; });

  before(async () => {
    home = tmp.mkdtemp('ch-stdio-50-');
    store = path.join(home, 'store');
    // <home>/packs/<scenario>/<version>/node_modules/{<scenario>, <part>}, as ch-local installs a unit
    const nm = path.join(home, 'packs', 'ch-chb-pack', '1.0.0', 'node_modules');
    const part = writeModule(path.join(nm, 'ch-chb-part'), {name: 'ch-chb-part', role: 'part', service: 'ownService',
      actions: {run: 'module.exports = async () => ({output: {part: "own"}});\n'}});
    const scenario = writeModule(path.join(nm, 'ch-chb-pack'), {name: 'ch-chb-pack', role: 'scenario', service: 'hopService', calls: ['ch-chb-part/ownService.run'],
      actions: {tool_chb: 'module.exports = async (input, ctx) => { const r = await ctx.call("ch-chb-part/ownService.run", {}, {detail: true}); return {output: {part: r.data.output.part, metering: r.platformMetering != null ? r.platformMetering : null}}; };\n'}});
    // the routed path (no direct peer channels), metered in the local store
    io = startStdio(['--workerThread', '--no-directPeerChannels', '--store', 'local', '--storePath', store, '--meter', '--mcpToolCallCost', '1', '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--modulesRoot', path.join(home, 'packs'), '--loadModule', scenario, '--partDir', part]);
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    let tools = [];
    for (let n = 0; n < 300 && !tools.includes('tool_chb'); n++) {
      tools = (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 30000)).result.tools.map((t) => t.name);
      if (!tools.includes('tool_chb')) await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(tools.includes('tool_chb'), `${JSON.stringify(tools)}\n${io.err.slice(-2000)}`);
  });
  after(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
  });

  it('a charge as fast as the store: the hop\'s own charge, as before', async () => {
    const r = await call('tool_chb');
    assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    const out = toolOutput(r.result);
    assert.strictEqual(out.part, 'own');
    assert.ok(out.metering != null && out.metering.billingPending !== true && out.metering.charged === 1, JSON.stringify(out));
    assert.strictEqual(await settled(), issued, 'the outer call\'s charge and the hop\'s, each once');
  });

  it('a charge held by a busy store lock: the hop answers at the bound, billing pending, and the charges land once each when it is free', async () => {
    const lines = landedLines();
    const {holder, free} = await holdLock(store);
    let out = null;
    try {
      // (answered while the lock is still held: only the bound answers it)
      const r = await call('tool_chb');
      assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
      out = toolOutput(r.result);
    } finally {
      await free();
      if (holder.exitCode == null) holder.kill('SIGKILL');
    }
    assert.deepStrictEqual([out.part, out.metering], ['own', {billingPending: true}]);
    // once the lock is free: the outer call's charge and the hop's, each once
    assert.strictEqual(await settled(), issued, 'charged exactly twice, once the lock was free: never again');
    assert.ok(await eventually(() => landedLines() > lines), `the pending hop's outcome is logged\n${io.err.slice(-1500)}`);
    assert.strictEqual(landedLines(), lines + 1, 'once');
  });

  // (the reviewer's ruling on #496) a stall allows a caller only a few
  // pending charges: past MAX_PENDING_PER_KEY, a hop waits for its own
  // charge, as before -- billing is never lost to a stall, only delayed
  it('more hops than the allowance with the lock held: the one past it waits for its charge, and every charge lands, once', async () => {
    // (the allowance, 4: checked against the lib's own after the behaviour)
    const MAX_PENDING_PER_KEY = 4;
    const n = MAX_PENDING_PER_KEY + 1;
    const lines = landedLines();
    const {holder, free} = await holdLock(store);
    const outs = [];
    let all = null;
    try {
      const calls = Array.from({length: n}, () => call('tool_chb').then((r) => {
        assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
        outs.push(toolOutput(r.result));
      }));
      all = Promise.all(calls);
      // (a failed call's rejection is the test's, never an unhandled one)
      all.catch(() => undefined);
      // the lock held until the allowance has answered pending and the one
      // past it is seen waiting for its own charge -- observed, not timed
      assert.ok(await eventually(() => outs.length === MAX_PENDING_PER_KEY && /charges pending; waiting for it/.test(io.err), 30000),
        `${outs.length} answered\n${io.err.slice(-1500)}`);
      assert.strictEqual(outs.length, MAX_PENDING_PER_KEY, 'the one past the allowance still waits while the lock is held');
    } finally {
      await free();
      if (holder.exitCode == null) holder.kill('SIGKILL');
    }
    await all;
    const pending = outs.filter((o) => o.metering != null && o.metering.billingPending === true).length;
    const waited = outs.filter((o) => o.metering != null && o.metering.charged === 1).length;
    assert.deepStrictEqual([pending, waited], [MAX_PENDING_PER_KEY, 1], JSON.stringify(outs.map((o) => o.metering)));
    // once the lock is free: each outer call's charge and each hop's, once
    assert.strictEqual(await settled(), issued, 'charged exactly once each, once the lock was free: never again');
    assert.ok(await eventually(() => landedLines() >= lines + MAX_PENDING_PER_KEY), `${landedLines() - lines} pending charges logged\n${io.err.slice(-1500)}`);
    assert.strictEqual(landedLines(), lines + MAX_PENDING_PER_KEY, 'each pending charge\'s outcome is logged, once');
    assert.strictEqual(require('../../lib/metering/charge-bound').MAX_PENDING_PER_KEY, MAX_PENDING_PER_KEY);
  });

  // (nothing writes the ledger any more: what it holds is final)
  it('the whole ledger once the runtime has exited: two charges a call, none lost and none twice', async () => {
    const ended = await io.stop(30000);
    // (the ledger first: a slow exit is told apart from a lost or double charge)
    assert.strictEqual(landedIn(store), issued, `the ledger (the runtime ended ${JSON.stringify(ended)})`);
    assert.strictEqual(ended.code, 0, `${JSON.stringify(ended)}\n${io.err.slice(-1500)}`);
  });

  tmp.hooks();
});
