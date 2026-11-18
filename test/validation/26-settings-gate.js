'use strict';
// Module settings at a call, the main thread's side (the module-level
// configuration design, sections 4.5 and 4.6; lib/settings-gate.js).
// Server-free: devices are worker proxies holding a settings state, their
// verified declared calls as bindings.
// - what a call carries: {v} once the worker was given that version's
//   values, else {v, values}; the ring kept per worker mirrors its four;
// - a task keeps the state of its first pass while its module keeps the same
//   declaration;
// - SETTING_REQUIRED over the declared call graph, or the target alone; a
//   top-level module's wording names its settings (missingSettings), a part's
//   names the top-level module and no setting;
// - ctx.settingRequired's claim: declared and unset -> the runtime's words;
//   set, or undeclared -> a module fault; a part's claim a top-level module
//   passed on -> the part's wording; a hop's claim goes back as it came.
const assert = require('assert');
const options = require('../../lib/cli-options');
const gate = require('../../lib/settings-gate');
const ms = require('../../lib/module-settings');
const {CountinghouseError} = require('../../lib/countinghouse-error');
const callAddress = require('../../lib/call-address');
const WorkerMessage = require('../../lib/worker-message');

const stateWith = (settings, stored = {}, version = 1) => {
  const decl = ms.parseDeclaration({name: 'x', countinghouse: {settings}}).settings;
  return {settings: decl, values: ms.effective(decl, stored, {net: []}).values, version};
};

describe('validation 26: module settings at a call (lib/settings-gate.js)', () => {
  let savedSingle = null;
  before(() => { savedSingle = options.singleIdentity; options.singleIdentity = true; });
  after(() => { options.singleIdentity = savedSingle; });

  describe('what a call carries', () => {
    const wmOf = () => Object.create(WorkerMessage.prototype);
    it('the values until a send of them is noted; then {v}; a version pushed out of the four is sent again', () => {
      const wm = wmOf();
      const st = (v) => stateWith({u: {type: 'string', default: 'x'}}, {}, v);
      const first = gate.toCarry(wm, st(1));
      assert.deepStrictEqual(Object.keys(first).sort(), ['v', 'values']);
      assert.ok(gate.toCarry(wm, st(1)).values != null, 'not noted until it is sent: the values again');
      gate.sent(wm, first);
      assert.deepStrictEqual(gate.toCarry(wm, st(1)), {v: 1});
      for (const v of [2, 3, 4, 5]) gate.sent(wm, gate.toCarry(wm, st(v)));
      assert.ok(gate.toCarry(wm, st(1)).values != null, 'version 1 left the ring: sent again');
      assert.deepStrictEqual(gate.toCarry(wm, st(5)), {v: 5});
    });

    it('a module that declares no settings carries nothing', () => {
      assert.strictEqual(gate.toCarry(wmOf(), null), null);
      assert.strictEqual(gate.toCarry(wmOf(), {settings: null, values: null, version: null}), null);
    });

    it('a task keeps the state its first sent pass had while the declaration is the same; a refused pass pins nothing', () => {
      const first = stateWith({u: {type: 'string'}}, {u: 'a'}, 10);
      const later = stateWith({u: {type: 'string'}}, {u: 'b'}, 11);
      assert.strictEqual(gate.forTask('job-1', first), first, 'nothing pinned yet');
      gate.pin('job-1', first);
      assert.strictEqual(gate.forTask('job-1', later), first, 'the first pass\'s values');
      gate.pin('job-1', later);
      assert.strictEqual(gate.forTask('job-1', later), first, 'a pin is not replaced');
      const changed = stateWith({u: {type: 'string'}, w: {type: 'boolean'}}, {}, 12);
      assert.strictEqual(gate.forTask('job-1', changed), changed, 'another declaration: the current state');
      assert.strictEqual(gate.forTask(null, later), later, 'no task: the current state');
    });

    it('the state is a worker\'s proxy\'s own; a module\'s own object with a settings field is never read', () => {
      const proxy = Object.assign(wmOf(), {settings: stateWith({u: {type: 'string'}})});
      assert.strictEqual(gate.stateOf({}, proxy), proxy.settings);
      const modulesOwn = {moduleName: 'm', settings: {settings: {}, values: {forged: true}}};
      assert.strictEqual(gate.stateOf({moduleManager: {}}, modulesOwn), null);
    });

    it('a module that declares settings, with no state here: refused SETTING_NOT_READY, never run unchecked', () => {
      const idOf = (n) => callAddress.deviceIDForName(n);
      const device = {moduleName: 'm'};
      const dm = {deviceMap: {[idOf('m')]: device}, moduleManager: {},
        packageOfModule: (n) => (n === 'm' ? {name: 'm', countinghouse: {settings: {u: {type: 'string'}}}} : {name: n})};
      require('../../lib/tool-generation').bump();
      const err = gate.requiredRefusal(dm, idOf('m'), true);
      assert.ok(err != null && err.code === 'SETTING_NOT_READY', String(err && err.code));
      // one that declares none runs as before
      dm.packageOfModule = (n) => ({name: n});
      require('../../lib/tool-generation').bump();
      assert.strictEqual(gate.requiredRefusal(dm, idOf('m'), true), null);
    });

    it('whether a module declares settings is read once per tool-set generation', () => {
      const idOf = (n) => callAddress.deviceIDForName(n);
      let reads = 0;
      const dm = {deviceMap: {[idOf('m')]: {moduleName: 'm'}}, moduleManager: {},
        packageOfModule: (n) => { reads += 1; return {name: n, countinghouse: {settings: {u: {type: 'string'}}}}; }};
      require('../../lib/tool-generation').bump();
      gate.requiredRefusal(dm, idOf('m'), true);
      gate.requiredRefusal(dm, idOf('m'), true);
      assert.strictEqual(reads, 1, 'kept within a generation');
      require('../../lib/tool-generation').bump();
      gate.requiredRefusal(dm, idOf('m'), true);
      assert.strictEqual(reads, 2, 'read again after a bump');
    });

    it('a "no" is never kept: asked again, so an answer that changes within a generation cannot fail open', () => {
      const idOf = (n) => callAddress.deviceIDForName(n);
      let declared = false;
      const dm = {deviceMap: {[idOf('m')]: {moduleName: 'm'}}, moduleManager: {},
        packageOfModule: (n) => (declared ? {name: n, countinghouse: {settings: {u: {type: 'string'}}}} : {name: n})};
      require('../../lib/tool-generation').bump();
      assert.strictEqual(gate.requiredRefusal(dm, idOf('m'), true), null);
      declared = true;
      const err = gate.requiredRefusal(dm, idOf('m'), true);
      assert.ok(err != null && err.code === 'SETTING_NOT_READY', 'the new answer, in the same generation');
    });

    it('not ready is a loaded, serving device\'s only: a declaring part not registered yet (spawning, restarting, suspended) is left to its hop\'s own answer', () => {
      const idOf = (n) => callAddress.deviceIDForName(n);
      const DeviceManager = require('../../lib/device-manager');
      // top: a worker's proxy, bound to the part by its verified bindings
      const top = Object.assign(Object.create(WorkerMessage.prototype), {hostModuleName: 'top', settings: null,
        bindings: {[idOf('top')]: {identity: 'k', module: 'top', targets: new Set([`${idOf('part')}|urn:x:serviceID:s|act`])}}});
      const pins = {'@acme/part': {name: '@acme/part', countinghouse: {role: 'part', settings: {r: {type: 'string', required: true}}}}, top: {name: 'top'}};
      const dm = {deviceMap: {[idOf('top')]: top},
        // the part spawning: a live spawn (lifecycle)
        moduleManager: {modules: {}, lifecycle: {live: (n) => (n === '@acme/part' ? {} : null)},
          pinnedDevicePackages: new Map([[idOf('part'), '@acme/part']]), manifestPins: {pinnedOf: (n) => pins[n]}}};
      dm.moduleOfDevice = DeviceManager.prototype.moduleOfDevice.bind(dm);
      dm.packageOfModule = DeviceManager.prototype.packageOfModule.bind(dm);
      // the device manager knows the spawning part by its pins (unstubbed)
      assert.strictEqual(dm.moduleOfDevice(idOf('part')), '@acme/part');
      assert.ok(require('../../lib/module-settings').declaresSettings(dm.packageOfModule('@acme/part')));
      // a spawn that failed, or an unloaded module (nothing live): no answer
      // from its pins, its devices' nor its package.json's
      const live = dm.moduleManager.lifecycle;
      dm.moduleManager.lifecycle = {live: () => null};
      assert.strictEqual(dm.moduleOfDevice(idOf('part')), null);
      assert.ok(!require('../../lib/module-settings').declaresSettings(dm.packageOfModule('@acme/part', {live: true})), 'no stale pin for the gate');
      assert.ok(require('../../lib/module-settings').declaresSettings(dm.packageOfModule('@acme/part')), 'a listing still takes the pin it holds');
      dm.moduleManager.lifecycle = live;
      require('../../lib/tool-generation').bump();
      assert.strictEqual(gate.requiredRefusal(dm, idOf('top'), true), null, 'not refused: the hop answers for it');
      // registered and serving with no state: refused, the top-level module named, never the part
      dm.deviceMap[idOf('part')] = Object.assign(Object.create(WorkerMessage.prototype), {hostModuleName: '@acme/part', settings: null, bindings: {}});
      dm.moduleManager.modules['@acme/part'] = dm.deviceMap[idOf('part')];
      require('../../lib/tool-generation').bump();
      const err = gate.requiredRefusal(dm, idOf('top'), true);
      assert.ok(err != null && err.code === 'SETTING_NOT_READY', String(err && err.code));
      assert.ok(/top/.test(err.message) && !/part/.test(err.message), err.message);
      // a hop's: a claim naming no module, for its calling module
      const hop = gate.requiredRefusal(dm, idOf('part'), false);
      assert.strictEqual(hop.code, 'SETTING_NOT_READY');
      assert.strictEqual(hop.message, 'not ready');
      // passed on by the calling module: the outer call's words, the top named
      const outer = gate.claimAnswer(hop, dm, idOf('top'), undefined, true);
      assert.strictEqual(outer.code, 'SETTING_NOT_READY');
      assert.ok(/top/.test(outer.message) && !/part/.test(outer.message), outer.message);
      // one a module makes up, with no module behind it that declares settings: a module fault
      const forged = gate.claimAnswer(gate.requiredRefusal(dm, idOf('part'), false), dm, idOf('part'), undefined, true);
      assert.strictEqual(forged.code, 'DEVICE_INVOKE_EXCEPTION');
    });
  });

  // a device manager whose devices are named modules: `calls` the modules
  // each one's verified declarations reach
  function dmWith(modules) {
    const deviceMap = {};
    const idOf = (name) => callAddress.deviceIDForName(name);
    for (const [name, m] of Object.entries(modules)) {
      const id = idOf(name);
      deviceMap[id] = Object.assign(Object.create(WorkerMessage.prototype), {hostModuleName: name, settings: m.state || null,
        bindings: {[id]: {identity: 'k', module: name, targets: new Set((m.calls || []).map((c) => `${idOf(c)}|urn:x:serviceID:s|act`))}}});
    }
    return {deviceMap, idOf};
  }

  describe('SETTING_REQUIRED before the handler', () => {
    it('the target\'s own unset required setting: its names, titled, the runtime\'s words, missingSettings', () => {
      const dm = dmWith({'weather-tool': {state: stateWith({defaultRepo: {type: 'string', format: 'repo', required: true, title: 'Default repository'}})}});
      const err = gate.requiredRefusal(dm, dm.idOf('weather-tool'), true);
      assert.strictEqual(err.code, 'SETTING_REQUIRED');
      assert.match(err.message, /weather-tool needs a setting: defaultRepo \(Default repository\)/);
      assert.match(err.message, /Ask the user for the value \(do not guess\)/);
      assert.match(err.message, /ch-local settings set weather-tool\.defaultRepo/);
      assert.deepStrictEqual(err.fields.missingSettings, ['defaultRepo']);
    });

    it('a part\'s, over the call graph: the top-level module named, no setting, no missingSettings', () => {
      const dm = dmWith({
        'top': {state: stateWith({}), calls: ['mid']},
        'mid': {calls: ['part']},
        'part': {state: stateWith({secretRegion: {type: 'string', required: true}})},
      });
      const err = gate.requiredRefusal(dm, dm.idOf('top'), true);
      assert.strictEqual(err.code, 'SETTING_REQUIRED');
      assert.match(err.message, /^top needs a setting: a module this tool calls needs a setting made at the terminal/);
      assert.match(err.message, /ch-local settings modules top/);
      assert.ok(!err.message.includes('secretRegion'), err.message);
      assert.strictEqual(err.fields.missingSettings, null);
    });

    it('a hop: the target alone, not what it calls; refused as the claim (the setting\'s name), for the calling module', () => {
      const dm = dmWith({'top': {calls: ['part']}, 'part': {state: stateWith({r: {type: 'string', required: true}})}});
      assert.strictEqual(gate.requiredRefusal(dm, dm.idOf('top'), false), null);
      const claim = gate.requiredRefusal(dm, dm.idOf('part'), false);
      assert.deepStrictEqual([claim.code, claim.message], ['SETTING_REQUIRED', 'r']);
      // passed on by the top-level module: the outer call answers in the part's wording, no setting named
      const outer = gate.claimAnswer(claim, dm, dm.idOf('top'), dm.deviceMap[dm.idOf('top')].settings, true);
      assert.match(outer.message, /a module this tool calls needs a setting made at the terminal/);
      assert.ok(!/\br\b/.test(outer.message.replace(/needs a setting|terminal|settings modules/g, '')), outer.message);
    });

    it('set, or a default: no refusal; a task\'s pinned state is the one checked', () => {
      const dm = dmWith({'m': {state: stateWith({r: {type: 'string', required: true}})}});
      const set = stateWith({r: {type: 'string', required: true}}, {r: 'eu'});
      assert.strictEqual(gate.requiredRefusal(dm, dm.idOf('m'), true, set), null);
      assert.ok(gate.requiredRefusal(dm, dm.idOf('m'), true) != null);
    });

    it('on a server outside ch-local, the operator\'s file is named, never ch-local', () => {
      options.singleIdentity = false;
      try {
        const dm = dmWith({'m': {state: stateWith({r: {type: 'string', required: true}})}});
        const err = gate.requiredRefusal(dm, dm.idOf('m'), true);
        assert.ok(!/ch-local/.test(err.message) && /--moduleSettings/.test(err.message), err.message);
      } finally { options.singleIdentity = true; }
    });
  });

  describe('the high review\'s cases', () => {
    it('a task run refused SETTING_REQUIRED is never retried', () => {
      assert.strictEqual(require('../../lib/job-control-common').notRetried('SETTING_REQUIRED'), true);
    });

    it('its setting names ride the stored failure, and tasks/result reads them back', () => {
      const common = require('../../lib/job-control-common');
      const err = CountinghouseError.withFields('SETTING_REQUIRED', {module: 'm', settings: 'region', hint: 'h', missingSettings: ['region']});
      const stored = common.failureText(err, null);
      assert.ok(stored.startsWith('SETTING_REQUIRED: m needs a setting'));
      assert.ok(stored.endsWith(`${common.MISSING_SETTINGS}region`), JSON.stringify(stored));
    });

    it('a send with no args attaches no values, so records no version', () => {
      const dmLib = require('../../lib/device-manager');
      const wm = Object.create(WorkerMessage.prototype);
      wm.moduleSpec = null;
      wm.worker = {};   // a live worker (an ended or absent one records nothing)
      wm.sendInvokeActionMessage = () => {};
      const st = stateWith({u: {type: 'string', default: 'x'}}, {}, 77);
      dmLib.sendCounted(wm, {deviceID: 'd', serviceID: 's', actionName: 'a', args: null, settingsState: st}, () => {}, null, null, {deviceMap: {}});
      assert.ok(gate.toCarry(wm, st).values != null, 'not recorded: the values go with the next call');
      const sentArgs = {input: {}};
      dmLib.sendCounted(wm, {deviceID: 'd', serviceID: 's', actionName: 'a', args: sentArgs, settingsState: st}, () => {}, null, null, {deviceMap: {}});
      assert.ok(sentArgs.settings != null && sentArgs.settings.values != null, 'attached');
      assert.deepStrictEqual(gate.toCarry(wm, st), {v: 77}, 'recorded once attached and posted');
      const ended = Object.assign(Object.create(WorkerMessage.prototype), {moduleSpec: null, worker: {}, ended: {code: 'MODULE_UNLOADED'}, sendInvokeActionMessage: () => {}});
      dmLib.sendCounted(ended, {deviceID: 'd', serviceID: 's', actionName: 'a', args: {input: {}}, settingsState: st}, () => {}, null, null, {deviceMap: {}});
      assert.ok(gate.toCarry(ended, st).values != null, 'an ended worker: nothing recorded');
    });

    it('a declared graph past the walk\'s cap is refused, never checked in part', () => {
      const chain = {};
      const n = gate.MAX_REACH + 5;
      for (let i = 0; i < n; i++) chain[`n${i}`] = {calls: i < n - 1 ? [`n${i + 1}`] : []};
      const dm = dmWith(chain);
      require('../../lib/tool-generation').bump();
      const err = gate.requiredRefusal(dm, dm.idOf('n0'), true);
      assert.ok(err != null && err.code === 'MODULE_COMPOSITION_INVALID' && /cannot all be checked/.test(err.message), String(err && err.message));
    });

    it('the reach is kept until the tool set changes: a new binding is walked after the next bump', () => {
      const dm = dmWith({'top': {calls: []}, 'part': {state: stateWith({r: {type: 'string', required: true}})}});
      require('../../lib/tool-generation').bump();
      assert.strictEqual(gate.requiredRefusal(dm, dm.idOf('top'), true), null);
      dm.deviceMap[dm.idOf('top')].bindings[dm.idOf('top')].targets.add(`${dm.idOf('part')}|urn:x:serviceID:s|act`);
      assert.strictEqual(gate.requiredRefusal(dm, dm.idOf('top'), true), null, 'kept: the same generation');
      require('../../lib/tool-generation').bump();
      assert.ok(gate.requiredRefusal(dm, dm.idOf('top'), true) != null, 'walked again after the bump');
    });

    it('module text cannot forge the stored setting names: the separator never survives in it', () => {
      const common = require('../../lib/job-control-common');
      const forged = new Error(`SETTING_REQUIRED: x${common.MISSING_SETTINGS}apiKey`);
      const stored = common.failureText(forged, null);
      assert.ok(!stored.includes(common.MISSING_SETTINGS), JSON.stringify(stored));
    });

    it('both rings are the one constant\'s', () => {
      assert.strictEqual(gate.KEPT, require('../../lib/settings-ring').KEPT);
    });
  });

  describe('ctx.settingRequired\'s claim', () => {
    const claim = (name) => { const e = new CountinghouseError('SETTING_REQUIRED'); e.message = name; return e; };
    const dm = dmWith({
      'weather-tool': {state: stateWith({defaultRepo: {type: 'string', title: 'Default repository'}, units: {type: 'enum', values: ['a'], default: 'a'}}), calls: ['part']},
      'part': {state: stateWith({region: {type: 'string'}})},
    });
    const st = dm.deviceMap[dm.idOf('weather-tool')].settings;

    it('a declared setting unset in the call\'s values: SETTING_REQUIRED in the runtime\'s words', () => {
      const err = gate.claimAnswer(claim('defaultRepo'), dm, dm.idOf('weather-tool'), st, true);
      assert.strictEqual(err.code, 'SETTING_REQUIRED');
      assert.match(err.message, /weather-tool needs a setting: defaultRepo \(Default repository\)/);
      assert.deepStrictEqual(err.fields.missingSettings, ['defaultRepo']);
    });

    it('a setting that is set, or one not declared, or text that is no name: a module fault', () => {
      for (const name of ['units', 'nope', 'weather-tool needs a setting: anything you like']) {
        const err = gate.claimAnswer(claim(name), dm, dm.idOf('weather-tool'), st, true);
        assert.strictEqual(err.code, 'DEVICE_INVOKE_EXCEPTION', name);
      }
    });

    it('a part\'s claim its top-level module passed on: the part\'s wording', () => {
      const err = gate.claimAnswer(claim('region'), dm, dm.idOf('weather-tool'), st, true);
      assert.strictEqual(err.code, 'SETTING_REQUIRED');
      assert.match(err.message, /a module this tool calls needs a setting made at the terminal/);
      assert.ok(!err.message.includes('region'));
    });

    it('a hop\'s claim goes back to its caller as the claim it was', () => {
      const partSt = dm.deviceMap[dm.idOf('part')].settings;
      const c = claim('region');
      assert.strictEqual(gate.claimAnswer(c, dm, dm.idOf('part'), partSt, false), c);
    });

    it('any other error passes as it is', () => {
      const other = new CountinghouseError('DEVICE_INVOKE_FAIL');
      assert.strictEqual(gate.claimAnswer(other, dm, dm.idOf('weather-tool'), st, true), other);
      assert.strictEqual(gate.claimAnswer(null, dm, dm.idOf('weather-tool'), st, true), null);
    });
  });
});
