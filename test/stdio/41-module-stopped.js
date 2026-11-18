// M4 Task 6 (module-level configuration, #413 rev 3, section 7.3, "When the
// runtime stops a module by itself"), spawned: on a runtime with a control
// channel, a module the supervisor gives up on (three exits, or a restart
// the sandbox refuses) has every unit that holds it unloaded by the runtime
// itself, and only then is ch-local told module-stopped, once per top-level
// module. A module that only restarts, and recovers, is never told stopped;
// an unload while it restarts keeps it gone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput, toolErrorCode} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
function writeModule(dir, {name, version = '1.0.0', role, calls, service, actions}) {
  fs.mkdirSync(path.join(dir, 'handlers', service), {recursive: true});
  const ch = {};
  if (role != null) ch.role = role;
  if (calls != null) ch.calls = calls;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version, countinghouse: ch}));
  const actionList = Object.keys(actions).map((a) => ({name: a, description: `${a} of ${name}`,
    input: {schema: `/${service}/${a}/input`}, output: {schema: `/${service}/${a}/output`}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name.replace(/^@[^/]+\//, ''), manufacturer: 't', modelDescription: name,
    serviceList: {[SVC(service)]: {actionList}}}}));
  const schemas = {};
  for (const a of Object.keys(actions)) schemas[a] = {input: {type: 'object'}, output: {type: 'object'}};
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({[service]: schemas}));
  for (const [a, src] of Object.entries(actions)) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}
const EXIT = 'module.exports = async () => { setTimeout(() => process.exit(3), 50); return {output: {exiting: true}}; };\n';
const PING = 'module.exports = async () => ({output: {pong: true}});\n';

describe('stdio 41: a module the runtime gives up on is unloaded, then told stopped (M4 Task 6)', function() {
  this.timeout(180000);
  let nextId = 100;
  const started = [];
  const call = (io, name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const listed = async (io) => (await io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/list'}, 60000)).result.tools.map((t) => t.name).filter((n) => n.startsWith('t_')).sort();
  const until = async (test, ms = 20000) => {
    const end = Date.now() + ms;
    while (!(await test()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    return test();
  };
  const stopped = (io) => io.told.filter((m) => m.type === 'module-stopped');
  // the module answers its ping itself (not MODULE_RESTARTING, whose result
  // carries its own structured content)
  const pongs = async (io, tool) => { const o = toolOutput((await call(io, tool)).result); return o != null && o.pong === true; };
  async function start(extra = []) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-41-'));
    const store = path.join(home, 'module-store');
    const io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', store, '--requestTimeout', '4'].concat(extra), {ipc: true});
    started.push({io, home});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
    return {io, home, store};
  }
  afterEach(async () => {
    for (const {io, home} of started.splice(0)) {
      if (io.child.exitCode == null) { io.child.kill(); await io.exited; }
      fs.rmSync(home, {recursive: true, force: true});
    }
  });
  const crashModule = (store, name = '@t/ch-pack-crash') => writeModule(path.join(store, ...name.split('/'), '1.0.0'), {name, role: 'scenario', service: 'crashService',
    actions: {[`t_${name.replace(/^@t\/ch-pack-/, '')}_ping`]: PING, [`t_${name.replace(/^@t\/ch-pack-/, '')}_exit`]: EXIT}});
  const load = (io, name, dirs) => io.control({type: 'load', name, dirs});
  // the worker ended and its restart is under way, then up again
  const crashOnce = async (io, tool, ping) => {
    await call(io, tool);
    await until(async () => toolErrorCode((await call(io, ping)).result) === 'MODULE_RESTARTING', 5000);
  };

  it('it fails once, then recovers: nothing is told, and a later unload unloads it', async () => {
    const {io, store} = await start();
    const dir = crashModule(store);
    assert.strictEqual((await load(io, '@t/ch-pack-crash', {'@t/ch-pack-crash': dir})).ok, true);
    await crashOnce(io, 't_crash_exit', 't_crash_ping');
    assert.ok(await until(async () => pongs(io, 't_crash_ping')), 'recovered');
    assert.deepStrictEqual(stopped(io), []);
    assert.strictEqual((await io.control({type: 'unload', name: '@t/ch-pack-crash'})).ok, true);
    assert.deepStrictEqual(await listed(io), []);
  });

  it('three exits: the runtime unloads the unit itself, then tells module-stopped once; a call answers as for a module not loaded; a load of the name is taken again', async () => {
    const {io, store} = await start();
    const dir = crashModule(store);
    assert.strictEqual((await load(io, '@t/ch-pack-crash', {'@t/ch-pack-crash': dir})).ok, true);
    for (let i = 0; i < 3; i++) {
      assert.ok(await until(async () => pongs(io, 't_crash_ping'), 10000), `up again before exit ${i + 1}`);
      await call(io, 't_crash_exit');
      if (i < 2) await until(async () => toolErrorCode((await call(io, 't_crash_ping')).result) === 'MODULE_RESTARTING', 5000);
    }
    assert.ok(await until(async () => stopped(io).length > 0), `${JSON.stringify(io.told)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(stopped(io), [{type: 'module-stopped', name: '@t/ch-pack-crash', code: 'MODULE_SUSPENDED', when: 'restart'}]);
    assert.deepStrictEqual(await listed(io), []);
    const code = toolErrorCode((await call(io, 't_crash_ping')).result);
    assert.notStrictEqual(code, 'MODULE_SUSPENDED');
    // its name is free again
    const again = await load(io, '@t/ch-pack-crash', {'@t/ch-pack-crash': dir});
    assert.strictEqual(again.ok, true, JSON.stringify(again));
    assert.deepStrictEqual(await listed(io), ['t_crash_exit', 't_crash_ping']);
    assert.strictEqual(stopped(io).length, 1, 'told once');
  });

  it('a part two units hold gives up: both units are unloaded, and each is told', async () => {
    const {io, store} = await start();
    const partDir = writeModule(path.join(store, '@t', 'ch-step-crash', '1.0.0'), {name: '@t/ch-step-crash', role: 'part', service: 'stepService',
      actions: {ping: PING, boom: EXIT}});
    const caller = (n) => writeModule(path.join(store, '@t', `ch-pack-${n}`, '1.0.0'), {name: `@t/ch-pack-${n}`, role: 'scenario', calls: ['ch-step-crash/stepService.boom', 'ch-step-crash/stepService.ping'], service: 'packService',
      actions: {[`t_${n}_boom`]: "module.exports = async (input, ctx) => { try { await ctx.call('ch-step-crash/stepService.boom', {}); } catch (e) { /* the part ends */ } return {output: {}}; };\n",
        [`t_${n}_ping`]: "module.exports = async (input, ctx) => ({output: (await ctx.call('ch-step-crash/stepService.ping', {})).output});\n"}});
    for (const n of ['one', 'two']) {
      const r = await load(io, `@t/ch-pack-${n}`, {[`@t/ch-pack-${n}`]: caller(n), '@t/ch-step-crash': partDir});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    }
    for (let i = 0; i < 3; i++) {
      assert.ok(await until(async () => pongs(io, 't_one_ping'), 10000), `the part up again before exit ${i + 1}`);
      await call(io, 't_one_boom');
      if (i < 2) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(await until(async () => stopped(io).length === 2), `${JSON.stringify(io.told)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(stopped(io).map((m) => m.name).sort(), ['@t/ch-pack-one', '@t/ch-pack-two']);
    assert.deepStrictEqual(await listed(io), []);
  });

  it('while it restarts, an unload from ch-local is taken, and the restart does not bring it back', async () => {
    const {io, store} = await start();
    const dir = crashModule(store);
    assert.strictEqual((await load(io, '@t/ch-pack-crash', {'@t/ch-pack-crash': dir})).ok, true);
    await call(io, 't_crash_exit');
    await until(async () => toolErrorCode((await call(io, 't_crash_ping')).result) === 'MODULE_RESTARTING', 5000);
    assert.strictEqual((await io.control({type: 'unload', name: '@t/ch-pack-crash'})).ok, true);
    // past its first backoff (1 s)
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepStrictEqual(await listed(io), []);
    assert.deepStrictEqual(stopped(io), [], 'an unload ch-local asked for is not a stop it is told');
  });

  it('a restart the sandbox refuses (enforce): unloaded, then told stopped with the refusal\'s code', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-41p-'));
    const policy = path.join(home, 'policy.json');
    fs.writeFileSync(policy, JSON.stringify({modules: {'@t/ch-pack-crash': {approve: 'as-declared'}}}));
    const {io, store} = await start(['--moduleSandbox', 'enforce', '--modulePolicy', policy]);
    const dir = crashModule(store);
    assert.strictEqual((await load(io, '@t/ch-pack-crash', {'@t/ch-pack-crash': dir})).ok, true);
    // the restart's tree check now refuses it (native build files)
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{}');
    await call(io, 't_crash_exit');
    assert.ok(await until(async () => stopped(io).length > 0), `${JSON.stringify(io.told)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(stopped(io).map((m) => [m.name, m.code, m.when]), [['@t/ch-pack-crash', 'MODULE_SANDBOX_REFUSED', 'restart']]);
    assert.deepStrictEqual(await listed(io), []);
    fs.rmSync(home, {recursive: true, force: true});
  });
});
