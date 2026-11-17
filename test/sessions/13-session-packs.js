'use strict';
// Shared runtime B3, Task 1 (docs/superpowers/plans/2026-11-16-shared-runtime-b3-session-packs.md):
// which packs a session lists, on the main thread (lib/session-packs.js).
// Server-free: the store is configured with stand-ins for the pack records,
// the device map, the session settings' stored overrides and the sessions.
//
// Membership follows the stored override: a session is in a pack's set
// exactly when its stored override for that pack is on. A module is listed
// to a session when any pack that owns it is; a module no pack owns, and a
// device whose module is not known, is listed to every session.
const assert = require('assert');
const packs = require('../../lib/session-packs');

describe('sessions 13: which packs a session lists (shared runtime B3, Task 1)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  // the stand-ins
  let records;       // pack -> Set of module names
  let devices;       // deviceID -> module name
  let overrides;     // session -> Map(pack -> boolean)
  let open;          // the open sessions
  let shared;
  let hear;          // the store's onOverrideChange listener
  let emptied;
  let changed;
  const configure = () => packs.configure({
    records: () => [...records].map(([pack, modules]) => ({pack, modules: [...modules]})),
    moduleOf: (deviceID) => (devices.has(deviceID) ? devices.get(deviceID) : null),
    overridesOf: (id) => new Map(overrides.get(id) || []),
    onOverrideChange: (fn) => { hear = fn; },
    openSessions: () => [...open],
    shared: () => shared
  });
  // a session's stored override changes, by whatever road, and the settings store says so
  const override = (id, pack, value) => {
    if (!overrides.has(id)) overrides.set(id, new Map());
    if (value === undefined) overrides.get(id).delete(pack); else overrides.get(id).set(pack, value);
    hear(id);
  };
  beforeEach(() => {
    records = new Map([['ci', new Set(['ci-scenario', 'log-read'])], ['docs', new Set(['docs-scenario', 'log-read'])]]);
    devices = new Map([['dev-ci', 'ci-scenario'], ['dev-read', 'log-read'], ['dev-docs', 'docs-scenario'], ['dev-other', 'loose-module']]);
    overrides = new Map();
    open = new Set([A, B, C]);
    shared = true;
    emptied = [];
    changed = [];
    packs.resetForTests();
    configure();
    packs.onEmpty((p) => emptied.push(p));
    packs.onChange((id) => changed.push(id));
  });

  it('a session with the pack on lists it, its scenario and its part; one with none lists none of them', () => {
    override(A, 'ci', true);
    assert.deepStrictEqual([packs.lists(A, 'ci'), packs.listsModule(A, 'ci-scenario'), packs.listsDevice(A, 'dev-ci'), packs.listsDevice(A, 'dev-read')], [true, true, true, true]);
    assert.deepStrictEqual([packs.lists(B, 'ci'), packs.listsModule(B, 'ci-scenario'), packs.listsDevice(B, 'dev-ci'), packs.listsDevice(B, 'dev-read')], [false, false, false, false]);
  });

  it('a part owned by the session\'s pack and by a global pack is listed to everyone who lists either', () => {
    packs.setGlobal('docs', true);
    override(A, 'ci', true);
    assert.strictEqual(packs.listsDevice(B, 'dev-read'), true, 'docs is global');
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false, 'ci is A\'s');
  });

  it('an off override hides a global pack from that session only', () => {
    packs.setGlobal('ci', true);
    override(B, 'ci', false);
    assert.deepStrictEqual([packs.lists(A, 'ci'), packs.lists(B, 'ci'), packs.lists(C, 'ci')], [true, false, true]);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false);
    assert.deepStrictEqual(packs.packsOffOf(B), ['ci']);
  });

  it('every way an override goes makes the session leave the set: off, cleared; onEmpty once, when the last leaves a pack that is not global', () => {
    override(A, 'ci', true);
    override(B, 'ci', true);
    assert.deepStrictEqual([...packs.audienceOf('ci')].sort(), [A, B].sort());
    override(A, 'ci', false);                 // set to off
    assert.deepStrictEqual([...packs.audienceOf('ci')], [B]);
    assert.deepStrictEqual(emptied, []);
    override(B, 'ci', undefined);             // cleared (clear, a ceiling seen without it, dropPack: each a stored change)
    assert.deepStrictEqual([...packs.audienceOf('ci')], []);
    assert.deepStrictEqual(emptied, ['ci']);
    // never for a global pack
    packs.setGlobal('docs', true);
    override(A, 'docs', true);
    override(A, 'docs', undefined);
    assert.deepStrictEqual(emptied, ['ci']);
  });

  it('forget takes the session out of every set, and empties what it alone held', () => {
    override(A, 'ci', true);
    override(A, 'docs', true);
    override(B, 'docs', true);
    open.delete(A);
    packs.forget(A);
    assert.deepStrictEqual(emptied, ['ci']);
    assert.deepStrictEqual([...packs.audienceOf('docs')], [B]);
  });

  it('a module no pack owns, and a device whose module is not known, is listed to every session', () => {
    override(A, 'ci', true);
    assert.deepStrictEqual([packs.listsDevice(B, 'dev-other'), packs.listsModule(B, 'loose-module'), packs.listsDevice(B, 'dev-never')], [true, true, true]);
  });

  it('a session of null lists only the global packs', () => {
    packs.setGlobal('docs', true);
    override(A, 'ci', true);
    assert.deepStrictEqual([packs.lists(null, 'ci'), packs.lists(null, 'docs'), packs.listsDevice(null, 'dev-ci'), packs.listsDevice(null, 'dev-docs')], [false, true, false, true]);
  });

  it('a run whose session has ended lists the global packs but those it had turned off, and no this-session pack', () => {
    packs.setGlobal('docs', true);
    override(A, 'ci', true);
    assert.strictEqual(packs.listsDeviceFor({packsOff: []}, 'dev-docs'), true);
    assert.strictEqual(packs.listsDeviceFor({packsOff: ['docs']}, 'dev-docs'), false);
    assert.strictEqual(packs.listsDeviceFor({packsOff: []}, 'dev-ci'), false, 'A\'s pack is no ended run\'s');
    assert.strictEqual(packs.listsDeviceFor({packsOff: ['ci']}, 'dev-other'), true, 'a module no pack owns');
  });

  it('the cached view is dropped by every event that can change it, and a reload\'s new part is not listed to B', () => {
    override(A, 'ci', true);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false);   // cached
    // the pack becomes global
    packs.setGlobal('ci', true);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), true);
    packs.setGlobal('ci', false);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false);
    // B's own override changes
    override(B, 'ci', true);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), true);
    override(B, 'ci', undefined);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false);
    // a reload adds a part
    records.get('ci').add('new-part');
    devices.set('dev-new', 'new-part');
    packs.packChanged('ci');
    assert.deepStrictEqual([packs.listsDevice(A, 'dev-new'), packs.listsDevice(B, 'dev-new')], [true, false]);
    // the pack is unloaded: no set, not global
    packs.setGlobal('ci', true);
    packs.packGone('ci');
    assert.deepStrictEqual([packs.isGlobal('ci'), [...packs.audienceOf('ci')]], [false, []]);
    // a session's end
    override(C, 'docs', true);
    assert.strictEqual(packs.listsDevice(C, 'dev-docs'), true);
    overrides.delete(C);
    packs.forget(C);
    assert.strictEqual(packs.listsDevice(C, 'dev-docs'), false);
  });

  it('onChange names the session whose view changed, or null when every view may have', () => {
    override(A, 'ci', true);
    packs.setGlobal('docs', true);
    packs.packChanged('ci');
    packs.forget(B);
    assert.deepStrictEqual(changed, [A, null, null, B]);
  });

  it('none() is true until a session has a pack override (every loaded pack global)', () => {
    packs.setGlobal('ci', true);
    packs.setGlobal('docs', true);
    assert.strictEqual(packs.none(), true);
    override(A, 'ci', true);
    assert.strictEqual(packs.none(), false);
    override(A, 'ci', undefined);
    assert.strictEqual(packs.none(), true);
    override(B, 'docs', false);
    assert.strictEqual(packs.none(), false, 'an off override is one');
  });

  // /code-review of #340, 2: fail closed. A pack still loaded that no session lists and that isn't global
  // (its unload asked, or failed) is hidden from every session, so none() must not short-circuit the filter
  it('none() is false while a loaded pack is neither global nor any session\'s: it stays hidden', () => {
    packs.setGlobal('ci', true);
    packs.setGlobal('docs', true);
    assert.strictEqual(packs.none(), true, 'every loaded pack global, no override: nothing to filter');
    packs.setGlobal('ci', false);
    assert.strictEqual(packs.none(), false);
    assert.strictEqual(packs.listsDevice(B, 'dev-ci'), false);
    packs.packGone('ci');
    records.delete('ci');
    packs.packChanged('ci');
    assert.strictEqual(packs.none(), true, 'gone: nothing left to hide');
  });

  // /code-review of #340, 7 and 8: a call's check is one boolean while nothing is filtered, and a view is
  // built from the records once per change, not per question
  it('none() reads no session\'s overrides, and the records are read once per change', () => {
    packs.setGlobal('ci', true);
    packs.setGlobal('docs', true);
    let overrideReads = 0;
    let recordReads = 0;
    packs.configure({
      records: () => { recordReads += 1; return [...records].map(([pack, modules]) => ({pack, modules: [...modules]})); },
      moduleOf: (deviceID) => (devices.has(deviceID) ? devices.get(deviceID) : null),
      overridesOf: (id) => { overrideReads += 1; return new Map(overrides.get(id) || []); },
      onOverrideChange: (fn) => { hear = fn; }, openSessions: () => [...open], shared: () => shared
    });
    for (let i = 0; i < 100; i++) packs.none();
    assert.strictEqual(overrideReads, 0, 'none() is a counter, not a walk of the sessions');
    for (let i = 0; i < 100; i++) packs.listsDeviceFor({packsOff: []}, 'dev-ci');
    const afterRun = recordReads;
    assert.ok(afterRun <= 1, `the owners of each module are kept: ${afterRun} reads`);
    packs.packChanged('ci');
    packs.listsDeviceFor({packsOff: []}, 'dev-ci');
    assert.strictEqual(recordReads, afterRun + 1, 'read again after a change');
  });

  it('outside shared mode every question answers listed, and none() is true', () => {
    override(A, 'ci', true);
    shared = false;
    assert.deepStrictEqual([packs.lists(B, 'ci'), packs.listsModule(B, 'ci-scenario'), packs.listsDevice(B, 'dev-ci'), packs.listsDeviceFor({packsOff: ['ci']}, 'dev-ci'), packs.none()],
      [true, true, true, true, true]);
  });

  it('audienceOf a global pack is every open session but the ones that turned it off; of a session pack, its set; always a copy', () => {
    packs.setGlobal('docs', true);
    override(B, 'docs', false);
    assert.deepStrictEqual([...packs.audienceOf('docs')].sort(), [A, C].sort());
    override(A, 'ci', true);
    const a = packs.audienceOf('ci');
    a.add(B);
    assert.deepStrictEqual([...packs.audienceOf('ci')], [A]);
  });
});
