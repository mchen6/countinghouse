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

const stateWith = (settings, stored = {}, version = 1) => {
  const decl = ms.parseDeclaration({name: 'x', countinghouse: {settings}}).settings;
  return {settings: decl, values: ms.effective(decl, stored, {net: []}).values, version};
};

describe('validation 26: module settings at a call (lib/settings-gate.js)', () => {
  let savedSingle = null;
  before(() => { savedSingle = options.singleIdentity; options.singleIdentity = true; });
  after(() => { options.singleIdentity = savedSingle; });

  describe('what a call carries', () => {
    it('the values once per version per worker; a version pushed out of the four is sent again', () => {
      const wm = {};
      const st = (v) => stateWith({u: {type: 'string', default: 'x'}}, {}, v);
      assert.deepStrictEqual(Object.keys(gate.carried(wm, st(1))).sort(), ['v', 'values']);
      assert.deepStrictEqual(gate.carried(wm, st(1)), {v: 1});
      for (const v of [2, 3, 4, 5]) gate.carried(wm, st(v));
      assert.ok(gate.carried(wm, st(1)).values != null, 'version 1 left the ring: sent again');
      assert.deepStrictEqual(gate.carried(wm, st(5)), {v: 5});
    });

    it('a module that declares no settings carries nothing', () => {
      assert.strictEqual(gate.carried({}, null), null);
      assert.strictEqual(gate.carried({}, {settings: null, values: null, version: null}), null);
    });

    it('a task keeps its first pass\'s state while the declaration is the same; a new declaration takes the new state', () => {
      const first = stateWith({u: {type: 'string'}}, {u: 'a'}, 10);
      const later = stateWith({u: {type: 'string'}}, {u: 'b'}, 11);
      assert.strictEqual(gate.forTask('job-1', first), first);
      assert.strictEqual(gate.forTask('job-1', later), first, 'the first pass\'s values');
      const changed = stateWith({u: {type: 'string'}, w: {type: 'boolean'}}, {}, 12);
      assert.strictEqual(gate.forTask('job-1', changed), changed);
      assert.strictEqual(gate.forTask(null, later), later, 'no task: the current state');
    });
  });

  // a device manager whose devices are named modules: `calls` the modules
  // each one's verified declarations reach
  function dmWith(modules) {
    const deviceMap = {};
    const idOf = (name) => callAddress.deviceIDForName(name);
    for (const [name, m] of Object.entries(modules)) {
      const id = idOf(name);
      deviceMap[id] = {hostModuleName: name, settings: m.state || null,
        bindings: {[id]: {identity: 'k', module: name, targets: new Set((m.calls || []).map((c) => `${idOf(c)}|urn:x:serviceID:s|act`))}}};
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

    it('a hop: the target alone, not what it calls', () => {
      const dm = dmWith({'top': {calls: ['part']}, 'part': {state: stateWith({r: {type: 'string', required: true}})}});
      assert.strictEqual(gate.requiredRefusal(dm, dm.idOf('top'), false), null);
      assert.ok(gate.requiredRefusal(dm, dm.idOf('part'), false) != null);
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
