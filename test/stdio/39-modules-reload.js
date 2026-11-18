// M4 Task 3 (module-level configuration, #413 rev 3, section 7.3), spawned:
// the module form's reload, {type: 'reload', names: [...], dirs: {...}},
// over the union of the named top-level modules' closures. A module changes
// version only when every loaded top-level module that holds it is named; a
// reload loads what it adds first, shows the additions together, then
// switches each changed module, a called module before its caller (modules
// in a cycle in the closure's order); all or none. The order is read from
// the runtime's own log lines.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');
const {toolOutput} = require('../helpers/tool-result');

const SVC = (s) => `urn:countinghouse-test:serviceID:${s}`;
function writeModule(dir, {name, version = '1.0.0', role, calls, service, actions, broken = false}) {
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
  for (const [a, src] of Object.entries(actions)) if (!broken) fs.writeFileSync(path.join(dir, 'handlers', service, `${a}.js`), src);
  return dir;
}

describe('stdio 39: the module form\'s reload (M4 Task 3)', function() {
  this.timeout(180000);
  let io = null;
  let home = null;
  let store = null;
  let nextId = 100;
  const call = (name, args = {}) => io.request({jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {name, arguments: args}}, 60000);
  const out = async (name) => toolOutput((await call(name)).result);
  const at = (name, version) => path.join(store, ...name.split('/'), version);
  const short = (name) => name.replace(/^@[^/]+\//, '');
  // a part: answers its own version; it may call others
  const part = (name, version, {calls = [], broken = false} = {}) => writeModule(at(name, version), {name, version, role: 'part', calls: calls.length > 0 ? calls : undefined, service: 'stepService', broken,
    actions: {[`${short(name).replace(/-/g, '_')}_run`]: `module.exports = async (input, ctx) => {
      const via = [];
      for (const c of ${JSON.stringify(calls)}) {
        try { via.push((await ctx.call(c, {})).output.v); } catch (e) { via.push('code:' + (e.code || String(e.message).slice(0, 160))); }
      }
      return {output: {v: '${short(name)}@${version}', via}};
    };\n`}});
  // a scenario: answers what each module it calls answered
  const scenario = (name, version, calls) => writeModule(at(name, version), {name, version, role: 'scenario', calls, service: 'packService',
    actions: {[`t_${short(name).replace(/-/g, '_')}`]: `module.exports = async (input, ctx) => {
      const got = [];
      // a hop's refusal is answered by its code, so the test can tell a
      // retryable MODULE_RELOADING from any other
      for (const c of ${JSON.stringify(calls)}) {
        try {
          const out = (await ctx.call(c, {})).output;
          got.push(out.v);
          // a part's own hop refused: its code, too
          for (const x of (out.via || [])) if (String(x).startsWith('code:')) got.push(x);
        } catch (e) { got.push('code:' + e.code); }
      }
      return {output: {v: '${short(name)}@${version}', got}};
    };\n`}});
  const run = (p) => `${short(p)}/stepService.${short(p).replace(/-/g, '_')}_run`;
  const dirsOf = (pairs) => Object.fromEntries(pairs.map(([n, v]) => [n, at(n, v)]));
  const reload = (names, pairs) => io.control({type: 'reload', names, dirs: dirsOf(pairs)});
  const logFrom = (mark) => io.err.slice(mark).split('\n').filter((l) => /module: reload of /.test(l)).map((l) => {
    const m = /module: reload of [^:]+: (loaded|shown|switching|switched back|unloading) ([^"\\]+)/.exec(l);
    return m != null ? `${m[1]} ${m[2].trim()}` : null;
  }).filter((x) => x != null);

  // --requestTimeout 10: a call that reaches a module's new version before
  // the reload unit's one verdict waits for it, within the composition window
  // (min(25 s, requestTimeout - 2 s), #423); at 4 s the window (2 s) is
  // shorter than a unit's switches on a loaded 2-CPU runner
  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-39-'));
    store = path.join(home, 'module-store');
    io = startStdio(['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--modulePath', path.join(home, 'modules'),
      '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc', '--modulesRoot', store, '--requestTimeout', '10'], {ipc: true});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    io.notify({jsonrpc: '2.0', method: 'notifications/initialized'});
  });
  // what a case loaded for itself, unloaded after it whatever its outcome,
  // and the unload checked: a later case never runs on a runtime left as it
  // was not (the medium review of #435's high fixes, 10)
  const loadedHere = [];
  afterEach(async () => {
    for (const name of loadedHere.splice(0)) {
      const r = await io.control({type: 'unload', name});
      assert.ok(r.ok === true || io.child.exitCode != null, `the cleanup's unload of ${name}: ${JSON.stringify(r)}`);
    }
  });
  after(async () => {
    if (process.env.CH_TEST_39_LOG != null && io != null) fs.writeFileSync(process.env.CH_TEST_39_LOG, io.err);
    if (io != null && io.child.exitCode == null) { io.child.kill(); await io.exited; }
    if (home != null) fs.rmSync(home, {recursive: true, force: true});
  });

  describe('a part two loaded modules hold', () => {
    before(async () => {
      part('@t/ch-step-x', '1.0.0');
      for (const s of ['@t/ch-pack-a', '@t/ch-pack-b']) {
        scenario(s, '1.0.0', [run('@t/ch-step-x')]);
        const r = await io.control({type: 'load', name: s, dirs: dirsOf([[s, '1.0.0'], ['@t/ch-step-x', '1.0.0']])});
        assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
      }
    });

    it('a reload naming one of them, moving the part, is refused PART_VERSION_CONFLICT, and nothing changes', async () => {
      part('@t/ch-step-x', '2.0.0');
      const r = await reload(['@t/ch-pack-a'], [['@t/ch-pack-a', '1.0.0'], ['@t/ch-step-x', '2.0.0']]);
      assert.deepStrictEqual([r.ok, r.code], [false, 'PART_VERSION_CONFLICT'], JSON.stringify(r));
      assert.deepStrictEqual((await out('t_ch_pack_a')).got, ['ch-step-x@1.0.0']);
    });

    it('a reload naming both switches the part once; both answer from it', async () => {
      const mark = io.err.length;
      const r = await reload(['@t/ch-pack-a', '@t/ch-pack-b'], [['@t/ch-pack-a', '1.0.0'], ['@t/ch-pack-b', '1.0.0'], ['@t/ch-step-x', '2.0.0']]);
      assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
      assert.deepStrictEqual(logFrom(mark).filter((l) => l.startsWith('switching')), ['switching @t/ch-step-x']);
      assert.deepStrictEqual((await out('t_ch_pack_a')).got, ['ch-step-x@2.0.0']);
      assert.deepStrictEqual((await out('t_ch_pack_b')).got, ['ch-step-x@2.0.0']);
    });

    it('a failure part-way puts both back: the part at its version, the scenarios as they were', async () => {
      part('@t/ch-step-x', '3.0.0');
      scenario('@t/ch-pack-a', '3.0.0', [run('@t/ch-step-x')]);
      writeModule(at('@t/ch-pack-b', '3.0.0'), {name: '@t/ch-pack-b', version: '3.0.0', role: 'scenario', calls: [run('@t/ch-step-x')], service: 'packService', broken: true,
        actions: {t_ch_pack_b: 'module.exports = async () => ({output: {}});\n'}});
      const r = await reload(['@t/ch-pack-a', '@t/ch-pack-b'], [['@t/ch-pack-a', '3.0.0'], ['@t/ch-pack-b', '3.0.0'], ['@t/ch-step-x', '3.0.0']]);
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.deepStrictEqual(await out('t_ch_pack_a'), {v: 'ch-pack-a@1.0.0', got: ['ch-step-x@2.0.0']});
      assert.deepStrictEqual(await out('t_ch_pack_b'), {v: 'ch-pack-b@1.0.0', got: ['ch-step-x@2.0.0']});
    });
  });

  it('two shared parts with different holders (X by S1 and S2, Y by S2 and S3): one reload naming all three switches both', async () => {
    part('@t/ch-step-p', '1.0.0');
    part('@t/ch-step-q', '1.0.0');
    scenario('@t/ch-pack-s1', '1.0.0', [run('@t/ch-step-p')]);
    scenario('@t/ch-pack-s2', '1.0.0', [run('@t/ch-step-p'), run('@t/ch-step-q')]);
    scenario('@t/ch-pack-s3', '1.0.0', [run('@t/ch-step-q')]);
    const parts = {s1: ['@t/ch-step-p'], s2: ['@t/ch-step-p', '@t/ch-step-q'], s3: ['@t/ch-step-q']};
    for (const s of ['s1', 's2', 's3']) {
      const r = await io.control({type: 'load', name: `@t/ch-pack-${s}`, dirs: dirsOf([[`@t/ch-pack-${s}`, '1.0.0']].concat(parts[s].map((p) => [p, '1.0.0'])))});
      assert.strictEqual(r.ok, true, JSON.stringify(r));
    }
    part('@t/ch-step-p', '2.0.0');
    part('@t/ch-step-q', '2.0.0');
    const mark = io.err.length;
    const r = await reload(['@t/ch-pack-s1', '@t/ch-pack-s2', '@t/ch-pack-s3'], [['@t/ch-pack-s1', '1.0.0'], ['@t/ch-pack-s2', '1.0.0'], ['@t/ch-pack-s3', '1.0.0'],
      ['@t/ch-step-p', '2.0.0'], ['@t/ch-step-q', '2.0.0']]);
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(logFrom(mark).filter((l) => l.startsWith('switching')).sort(), ['switching @t/ch-step-p', 'switching @t/ch-step-q']);
    assert.deepStrictEqual((await out('t_ch_pack_s2')).got, ['ch-step-p@2.0.0', 'ch-step-q@2.0.0']);
  });

  // a reload right after a load (as ch-local's applier can send one): the
  // scenario's own tool is known through its switch, every call answered or
  // MODULE_RELOADING, never "unknown tool" (macOS CI on #433; it fails on
  // master under a CPU throttle, its devices out of the map between its old
  // version's end and its new one's registration)
  it('a reload right after a load: the switched scenario\'s tool is never unknown, each call answered or MODULE_RELOADING', async () => {
    // unloaded in the afterEach, whatever the case's outcome: the tests after it
    // see the runtime as before (the high review of #435, 10)
    loadedHere.push('@t/ch-pack-quick');
    scenario('@t/ch-pack-quick', '1.0.0', []);
    assert.strictEqual((await io.control({type: 'load', name: '@t/ch-pack-quick', dirs: dirsOf([['@t/ch-pack-quick', '1.0.0']])})).ok, true);
    scenario('@t/ch-pack-quick', '2.0.0', []);
    let stop = false;
    const failures = [];
    const loop = (async () => {
      while (!stop) {
        const res = await call('t_ch_pack_quick').catch((e) => ({error: {message: String(e && e.message)}}));
        const o = toolOutput(res.result);
        const text = JSON.stringify(res);
        if ((o == null || o.v == null) && !/MODULE_RELOADING/.test(text)) failures.push(text.slice(0, 200));
      }
    })();
    const r = await reload(['@t/ch-pack-quick'], [['@t/ch-pack-quick', '2.0.0']]);
    stop = true;
    await loop;
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(failures, [], 'a call failed during the switch');
    assert.strictEqual((await out('t_ch_pack_quick')).v, 'ch-pack-quick@2.0.0');
  });

  it('a reload that adds two parts, under load: both load, then are shown together, before any switch; a callee switches before its caller; no call fails', async () => {
    part('@t/ch-step-m', '1.0.0');
    scenario('@t/ch-pack-load', '1.0.0', [run('@t/ch-step-m')]);
    assert.strictEqual((await io.control({type: 'load', name: '@t/ch-pack-load', dirs: dirsOf([['@t/ch-pack-load', '1.0.0'], ['@t/ch-step-m', '1.0.0']])})).ok, true);
    // 2.0.0: the scenario calls m and a new part n; m 2.0.0 calls another new part o
    part('@t/ch-step-n', '1.0.0');
    part('@t/ch-step-o', '1.0.0');
    part('@t/ch-step-m', '2.0.0', {calls: [run('@t/ch-step-o')]});
    scenario('@t/ch-pack-load', '2.0.0', [run('@t/ch-step-m'), run('@t/ch-step-n')]);
    let stop = false;
    const failures = [];
    const loop = (async () => {
      while (!stop) {
        const res = await call('t_ch_pack_load');
        const o = toolOutput(res.result);
        // the design's bar (#413 section 14): no call answers
        // CTX_CALL_UNRESOLVED (a part not there yet) or MODULE_NOT_LISTED (a
        // part still hidden); a hop in flight into a module as it is switched
        // answers MODULE_RELOADING, retryable, as a pack's reload does today
        const text = JSON.stringify(res);
        const hopCodes = (o != null && Array.isArray(o.got)) ? o.got.filter((g) => String(g).startsWith('code:')) : [];
        if ((o == null || o.v == null) && !/MODULE_RELOADING/.test(text)) failures.push(text.slice(0, 300));
        if (hopCodes.some((g) => g !== 'code:MODULE_RELOADING')) failures.push(text.slice(0, 300));
        if (/CTX_CALL_UNRESOLVED|MODULE_NOT_LISTED/.test(text)) failures.push(text.slice(0, 300));
      }
    })();
    const mark = io.err.length;
    const r = await reload(['@t/ch-pack-load'], [['@t/ch-pack-load', '2.0.0'], ['@t/ch-step-m', '2.0.0'], ['@t/ch-step-n', '1.0.0'], ['@t/ch-step-o', '1.0.0']]);
    stop = true;
    await loop;
    assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
    assert.deepStrictEqual(failures, [], 'a call failed during the reload');
    const steps = logFrom(mark);
    const loadedN = steps.indexOf('loaded @t/ch-step-n');
    const loadedO = steps.indexOf('loaded @t/ch-step-o');
    const shown = steps.findIndex((l) => l.startsWith('shown '));
    const switches = steps.filter((l) => l.startsWith('switching'));
    assert.ok(loadedN >= 0 && loadedO >= 0 && shown > Math.max(loadedN, loadedO), steps.join('\n'));
    assert.strictEqual(steps.filter((l) => l.startsWith('shown ')).length, 1, 'shown together, once');
    assert.ok(steps.indexOf(switches[0]) > shown, steps.join('\n'));
    assert.deepStrictEqual(switches, ['switching @t/ch-step-m', 'switching @t/ch-pack-load'], 'the callee first');
    assert.deepStrictEqual(await out('t_ch_pack_load'), {v: 'ch-pack-load@2.0.0', got: ['ch-step-m@2.0.0', 'ch-step-n@1.0.0']});
  });

  it('two modules that call each other switch in the closure\'s order, the same on every run', async () => {
    part('@t/ch-step-c1', '1.0.0', {calls: [run('@t/ch-step-c2')]});
    part('@t/ch-step-c2', '1.0.0', {calls: []});
    scenario('@t/ch-pack-cycle', '1.0.0', [run('@t/ch-step-c1')]);
    assert.strictEqual((await io.control({type: 'load', name: '@t/ch-pack-cycle', dirs: dirsOf([['@t/ch-pack-cycle', '1.0.0'], ['@t/ch-step-c1', '1.0.0'], ['@t/ch-step-c2', '1.0.0']])})).ok, true);
    const orders = [];
    for (const v of ['2.0.0', '3.0.0']) {
      // c1 and c2 call each other from 2.0.0 on (c2's handler never calls back: the calls declaration is the graph)
      writeModule(at('@t/ch-step-c1', v), {name: '@t/ch-step-c1', version: v, role: 'part', calls: [run('@t/ch-step-c2')], service: 'stepService',
        actions: {ch_step_c1_run: `module.exports = async (input, ctx) => ({output: {v: 'ch-step-c1@${v}', via: [(await ctx.call('${run('@t/ch-step-c2')}', {})).output.v]}});\n`}});
      writeModule(at('@t/ch-step-c2', v), {name: '@t/ch-step-c2', version: v, role: 'part', calls: [run('@t/ch-step-c1')], service: 'stepService',
        actions: {ch_step_c2_run: `module.exports = async () => ({output: {v: 'ch-step-c2@${v}', via: []}});\n`}});
      const mark = io.err.length;
      const r = await reload(['@t/ch-pack-cycle'], [['@t/ch-pack-cycle', '1.0.0'], ['@t/ch-step-c1', v], ['@t/ch-step-c2', v]]);
      assert.strictEqual(r.ok, true, `${JSON.stringify(r)}\n${io.err.slice(-1500)}`);
      orders.push(logFrom(mark).filter((l) => l.startsWith('switching')));
    }
    assert.deepStrictEqual(orders[0], orders[1]);
    assert.strictEqual(orders[0].length, 2);
  });
});

// the reload's window, server-free: a reloading device's record keeps its
// spec and its module's package.json, per device, until that device
// registers again or the reload ends without it (lib/module-manager.js
// markEndedDevices; lib/device-manager.js getAllDeviceSpecs, packageOfModule,
// keepsDecision; the high review of #435)
describe('stdio 39: a reloading device keeps its tool listed', () => {
  const DeviceManager = require('../../lib/device-manager');
  const ModuleManager = require('../../lib/module-manager');
  const NAME = '@t/ch-pack-two';
  const pkg = {name: NAME, countinghouse: {role: 'scenario'}};
  const spec = (id, v) => ({device: {friendlyName: id, version: v}});
  const dmOf = (deviceMap, mm) => ({deviceMap, moduleManager: mm});
  const specs = (dm) => DeviceManager.prototype.getAllDeviceSpecs.call(Object.assign(Object.create(DeviceManager.prototype), dm));
  const call = (fn, dm, ...a) => DeviceManager.prototype[fn].call(Object.assign(Object.create(DeviceManager.prototype), dm), ...a);
  it('per device: kept while out of the map, gone once that device registers or the reload settles', () => {
    const mm = {supervisor: null, modules: {}, endedDevices: {}};
    ModuleManager.prototype.markEndedDevices.call(mm, ['d-a', 'd-b'], NAME, 'MODULE_RELOADING', {specs: {'d-a': spec('a', 1), 'd-b': spec('b', 1)}, packageInfo: pkg});
    assert.deepStrictEqual(Object.keys(specs(dmOf({}, mm))).sort(), ['d-a', 'd-b'], 'both kept');
    // d-a back (its record cleared, as on deviceonline); d-b still reloading
    delete mm.endedDevices['d-a'];
    const back = specs(dmOf({'d-a': {spec: spec('a', 2), moduleName: NAME}}, mm));
    assert.deepStrictEqual(back, {'d-a': spec('a', 2), 'd-b': spec('b', 1)}, 'per device: the one still reloading stays listed');
    // its package.json answers while the module is out of the map: a scenario stays one
    assert.strictEqual(call('packageOfModule', dmOf({}, mm), NAME).countinghouse.role, 'scenario');
    // and its #400 decision stays while it is kept
    assert.strictEqual(call('keepsDecision', dmOf({}, mm), 'd-b'), true);
    assert.strictEqual(call('keepsDecision', dmOf({}, mm), 'd-other'), false);
    // marked again with nothing for it: it keeps what it had
    ModuleManager.prototype.markEndedDevices.call(mm, ['d-b'], NAME, 'MODULE_RELOADING', {specs: {}, packageInfo: null});
    assert.deepStrictEqual(mm.endedDevices['d-b'].spec, spec('b', 1));
    // the reload ends without d-b (renamed away, say): settled, never listed beside the new one
    ModuleManager.prototype.settleEndedDevices.call(Object.assign(mm, {emit: () => {}}), NAME);
    assert.deepStrictEqual(specs(dmOf({'d-a': {spec: spec('a', 2), moduleName: NAME}}, mm)), {'d-a': spec('a', 2)});
    assert.strictEqual(call('keepsDecision', dmOf({}, mm), 'd-b'), false, 'and its decision may go');
  });
  it('a reload of a restarting module takes the supervisor\'s kept specs into its records first; a running one\'s old exit is not', () => {
    // d-r still kept listed (restarting); d-old is from an earlier exit of a module running again
    const supervisor = {previousSpecs: (n) => (n === NAME ? {'d-r': spec('r', 1), 'd-old': spec('old', 0)} : {}), retainedSpecs: () => ({'d-r': spec('r', 1)}), packageInfoOf: () => pkg};
    const mm = {supervisor, modules: {}, endedDevices: {}, markEndedDevices: ModuleManager.prototype.markEndedDevices};
    ModuleManager.prototype.keepRetainedForReload.call(mm, NAME);
    assert.deepStrictEqual(mm.endedDevices['d-r'], {code: 'MODULE_RELOADING', name: NAME, spec: spec('r', 1), packageInfo: pkg});
    assert.strictEqual(mm.endedDevices['d-old'], undefined);
  });
  it('a settled record keeps nothing, and a later mark with no spec never brings an old one back', () => {
    const mm = {supervisor: null, modules: {}, endedDevices: {}, emit: () => {}};
    ModuleManager.prototype.markEndedDevices.call(mm, ['d-s'], NAME, 'MODULE_RELOADING', {specs: {'d-s': spec('s', 1)}, packageInfo: pkg});
    ModuleManager.prototype.settleEndedDevices.call(mm, NAME);
    assert.deepStrictEqual(mm.endedDevices['d-s'], {code: 'MODULE_UNLOADED', name: NAME});
    ModuleManager.prototype.markEndedDevices.call(mm, ['d-s'], NAME, 'MODULE_RELOADING', {specs: {}, packageInfo: null});
    assert.deepStrictEqual(mm.endedDevices['d-s'], {code: 'MODULE_RELOADING', name: NAME});
    assert.deepStrictEqual(specs(dmOf({}, mm)), {}, 'not listed');
  });
  it('a unit\'s switch holds its records unsettled through a rollback; the unit\'s end settles a module that never came back', () => {
    const {unitDone} = require('../../lib/modules-in-place');
    const settled = [];
    const mm = {modules: {'@t/back': {}}, settleHeld: new Set(['@t/gone', '@t/back']), settleEndedDevices: (n) => settled.push(n), releaseDiscovery: () => {}};
    unitDone(mm, null, {names: new Set(['@t/gone', '@t/back'])});
    assert.deepStrictEqual(settled, ['@t/gone'], 'only the one not back');
    assert.strictEqual(mm.settleHeld.size, 0);
  });
  it('an in-process reload\'s purge marks each device reloading, with its own package.json', () => {
    // (the purge logs each device: a logger, as sessions 15 sets one)
    require('../../lib/logger').createLogger();
    const instance = {};
    const device = {module: instance, moduleName: NAME, spec: spec('ip', 1), packageInfo: pkg};
    const mm = {supervisor: null, modules: {}, endedDevices: {}, markEndedDevices: ModuleManager.prototype.markEndedDevices};
    const dm = Object.assign(Object.create(DeviceManager.prototype), {deviceMap: {'d-ip': device}, moduleManager: mm, emit: () => {}, peerChannelBroker: null});
    const options = require('../../lib/cli-options');
    const saved = options.workerThread;
    options.workerThread = false;
    try {
      DeviceManager.prototype.onPurgeDevice.call(dm, instance, ModuleManager.RELOAD_IN_MAIN_THREAD, () => {});
    } finally {
      options.workerThread = saved;
    }
    assert.deepStrictEqual(mm.endedDevices['d-ip'], {code: 'MODULE_RELOADING', name: NAME, spec: spec('ip', 1), packageInfo: pkg});
    assert.strictEqual(dm.deviceMap['d-ip'], undefined);
  });
});
