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

// another process holding the store lock for ms, once it has it
function holdLock(dir, ms) {
  const holder = spawn(process.execPath, ['-e', `
    const {withStoreLock} = require(${JSON.stringify(path.join(ROOT, 'lib', 'store', 'json-file'))});
    withStoreLock(${JSON.stringify(dir)}, () => { process.stdout.write('held\\n'); const t = Date.now(); while (Date.now() - t < ${ms}) {} });
  `], {stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  return new Promise((resolve) => holder.stdout.once('data', () => resolve({holder, exited})));
}

// the store's metering records: meterId -> balance
const balances = (store) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(store, 'metering.json'), 'utf8'));
    return Object.fromEntries(Object.entries(m).map(([k, r]) => [k, r != null ? r.balance : null]));
  } catch (e) {
    return {};
  }
};
const total = (store) => Object.values(balances(store)).reduce((a, b) => a + (Number(b) || 0), 0);
// the balance once it has settled -- the same over three reads a half
// second apart, the store lock free -- never polled for the value expected
// (async metering: test/README, CLAUDE.md)
async function settled(store, ms = 20000) {
  const end = Date.now() + ms;
  let last = null;
  let same = 0;
  while (Date.now() < end) {
    const now = total(store);
    same = (now === last) ? same + 1 : 0;
    last = now;
    if (same >= 2) return now;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the balance did not settle in ${ms} ms (last ${last})`);
}
async function eventually(check, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return false;
}

describe('stdio 50: a routed hop waits for its charge at most METER_PENDING_MS (B-hopcharge)', function() {
  this.timeout(120000);
  let home = null;
  let store = null;
  let io = null;
  let nextId = 10;
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);

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
  });

  it('a charge held by a busy store lock: the hop answers at the bound, billing pending, and the charges land once each when it is free', async () => {
    // (the first case's two charges settled first)
    assert.ok(await eventually(() => Object.keys(balances(store)).length > 0), 'a metering record');
    const before = await settled(store);
    const {holder, exited} = await holdLock(store, 4000);
    let took = null;
    let out = null;
    try {
      const t0 = Date.now();
      const r = await call('tool_chb');
      took = Date.now() - t0;
      assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
      out = toolOutput(r.result);
    } finally {
      await exited;
      if (holder.exitCode == null) holder.kill('SIGKILL');
    }
    // (the observable proof: billing pending is answered only at the bound,
    // while the lock -- held 4 s -- still kept the charge; the time is
    // logged, not asserted)
    console.log(`    [observed] the hop answered after ${took} ms, the lock held 4000 ms`);
    assert.deepStrictEqual([out.part, out.metering], ['own', {billingPending: true}]);
    // once the lock is free: the outer call's charge and the hop's, each once
    assert.strictEqual(await settled(store), before - 2, 'charged exactly twice, once the lock was free: never again');
    assert.match(io.err, /the pending billing landed/);
  });

  // (the reviewer's ruling on #496) a stall allows a caller only a few
  // pending charges: past MAX_PENDING_PER_KEY, a hop waits for its own
  // charge, as before -- billing is never lost to a stall, only delayed
  it('more hops than the allowance with the lock held: the one past it waits for its charge, and every charge lands, once', async () => {
    // (the allowance, 4: checked against the lib's own after the behaviour)
    const MAX_PENDING_PER_KEY = 4;
    const n = MAX_PENDING_PER_KEY + 1;
    const before = await settled(store);
    const {holder, exited} = await holdLock(store, 4000);
    let outs = null;
    try {
      const rs = await Promise.all(Array.from({length: n}, () => call('tool_chb')));
      outs = rs.map((r) => {
        assert.ok(r.result != null && r.result.isError !== true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
        return toolOutput(r.result);
      });
    } finally {
      await exited;
      if (holder.exitCode == null) holder.kill('SIGKILL');
    }
    const pending = outs.filter((o) => o.metering != null && o.metering.billingPending === true).length;
    const waited = outs.filter((o) => o.metering != null && o.metering.charged === 1).length;
    assert.deepStrictEqual([pending, waited], [MAX_PENDING_PER_KEY, 1], JSON.stringify(outs.map((o) => o.metering)));
    // once the lock is free: each outer call's charge and each hop's, once
    assert.strictEqual(await settled(store), before - 2 * n, 'charged exactly once each, once the lock was free: never again');
    assert.strictEqual(require('../../lib/metering/charge-bound').MAX_PENDING_PER_KEY, MAX_PENDING_PER_KEY);
  });

  tmp.hooks();
});
