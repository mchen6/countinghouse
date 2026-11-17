'use strict';
// Shared runtime B3, Task 2: pack overrides under the ceiling
// (lib/session-settings.js). A session's stored pack.<n> is the one record of
// "this session has this pack on". A ceiling that stops allowing it drops it
// for good (a ceiling raised again does not bring it back without a new
// confirmation); an unload drops every session's "on" and keeps each "off";
// every road a stored pack override changes by is said (onChange), so
// lib/session-packs.js's membership follows it.
const assert = require('assert');
const settings = require('../../lib/session-settings');
const sessionPacks = require('../../lib/session-packs');

describe('sessions 14: pack overrides under the ceiling (shared runtime B3, Task 2)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let ceiling;
  let live;
  let changed;
  const ALLOWS_CI = {state: 'trusted', ceiling: {packs: ['ci', 'docs']}};
  beforeEach(() => {
    settings.resetForTests();
    sessionPacks.resetForTests();
    ceiling = ALLOWS_CI;
    live = new Set([A, B]);
    changed = [];
    settings.configure({ceiling: () => ceiling, defaultOf: () => 8 * 1024 * 1024, isLive: (id) => live.has(id), ceilingMemoMs: 0});
    settings.onChange((id) => changed.push(id));
  });
  const on = (id, n) => settings.set(id, `pack.${n}`, true, {loosening: true, version: '1.0.0'});
  const off = (id, n) => settings.set(id, `pack.${n}`, false, {version: '1.0.0'});

  it('a ceiling seen without the pack drops the session\'s "on" for good, and says so', () => {
    on(A, 'ci');
    changed.length = 0;
    ceiling = {state: 'trusted', ceiling: {packs: ['docs']}};
    settings.ceilingSeen(ceiling);
    assert.deepStrictEqual(changed, [A]);
    assert.deepStrictEqual(settings.packOverridesOf(A), new Map());
    // raised again: the session's value is the global one, not its old "on"
    ceiling = ALLOWS_CI;
    settings.ceilingSeen(ceiling);
    assert.strictEqual(settings.effective(A, 'pack.ci'), false, 'not global: off');
  });

  it('conversation turned off, or a ceiling that cannot be trusted, drops it too; a stale one (unknown) drops nothing', () => {
    on(A, 'ci');
    settings.ceilingSeen(undefined);
    assert.strictEqual(settings.packOverridesOf(A).get('ci'), true, 'stale: kept');
    settings.ceilingSeen({state: 'trusted', ceiling: {conversation: false}});
    assert.strictEqual(settings.packOverridesOf(A).has('ci'), false);
    on(B, 'docs');
    settings.ceilingSeen({state: 'untrusted', file: 'x', problem: 'y'});
    assert.strictEqual(settings.packOverridesOf(B).has('docs'), false);
  });

  it('an "off" override is never dropped by a ceiling', () => {
    off(A, 'ci');
    settings.ceilingSeen({state: 'trusted', ceiling: {packs: []}});
    assert.strictEqual(settings.packOverridesOf(A).get('ci'), false);
  });

  it('dropPack drops that pack\'s "on" overrides only, says so for each, and keeps every "off"', () => {
    on(A, 'ci');
    on(A, 'docs');
    off(B, 'ci');
    changed.length = 0;
    assert.deepStrictEqual(settings.dropPack('pack.ci'), [A]);
    assert.deepStrictEqual(changed, [A]);
    assert.deepStrictEqual([...settings.packOverridesOf(A)], [['docs', true]]);
    assert.deepStrictEqual([...settings.packOverridesOf(B)], [['ci', false]]);
    assert.throws(() => settings.dropPack('maxOutputBytes'), /pack/);
  });

  it('with the session-packs store listening, a ceiling\'s drop takes the session out of the set and empties it', () => {
    const emptied = [];
    sessionPacks.configure({
      records: () => [{pack: 'ci', modules: ['ci-scenario']}], moduleOf: () => 'ci-scenario',
      overridesOf: (id) => settings.packOverridesOf(id), onOverrideChange: (fn) => settings.onChange(fn),
      openSessions: () => [...live], shared: () => true});
    sessionPacks.onEmpty((p) => emptied.push(p));
    on(A, 'ci');
    assert.deepStrictEqual([...sessionPacks.audienceOf('ci')], [A]);
    settings.ceilingSeen({state: 'trusted', ceiling: {packs: []}});
    assert.deepStrictEqual([[...sessionPacks.audienceOf('ci')], emptied], [[], ['ci']]);
  });

  // /code-review of #340, 10: what session-packs reads is what effective() says: an "on" the ceiling in
  // force no longer allows is not on, before ceilingSeen has dropped it
  it('session-packs lists an "on" only while the ceiling in force allows it, as effective() says, before ceilingSeen drops it', () => {
    sessionPacks.configure({records: () => [{pack: 'ci', modules: ['ci-scenario']}], moduleOf: () => 'ci-scenario', overridesOf: settings.packOverridesOf,
      onOverrideChange: settings.onChange, openSessions: () => [...live], shared: () => true, allowsOn: settings.packOnAllowed});
    on(A, 'ci');
    assert.deepStrictEqual([settings.effective(A, 'pack.ci'), sessionPacks.lists(A, 'ci'), sessionPacks.listsDevice(A, 'd')], [true, true, true]);
    ceiling = {state: 'trusted', ceiling: {packs: ['docs']}};   // read now (memo 0), not yet seen
    sessionPacks.packChanged('ci');                              // (a view kept from before is the next finding's: a ceiling read is no event)
    assert.deepStrictEqual([settings.effective(A, 'pack.ci'), sessionPacks.lists(A, 'ci'), sessionPacks.listsDevice(A, 'd')], [false, false, false]);
    assert.deepStrictEqual([...sessionPacks.audienceOf('ci')], [A], 'membership follows the stored value: no unload from a read');
  });

  it('clear says so for a pack override too', () => {
    on(A, 'ci');
    changed.length = 0;
    settings.clear(A, 'pack.ci');
    assert.deepStrictEqual(changed, [A]);
  });

  it('with no override, a pack\'s value follows session-packs\' global value by default', () => {
    settings.resetForTests();
    settings.configure({ceiling: () => ceiling, defaultOf: () => 8 * 1024 * 1024, isLive: (id) => live.has(id), ceilingMemoMs: 0});
    assert.strictEqual(settings.effective(A, 'pack.ci'), false);
    sessionPacks.setGlobal('ci', true);
    assert.strictEqual(settings.effective(A, 'pack.ci'), true);
  });
});
