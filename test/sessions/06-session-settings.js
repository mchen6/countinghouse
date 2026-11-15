'use strict';
// B2 Task 1 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md,
// #252): lib/session-settings.js's pure logic, the per-session overrides and
// a session's effective values (the shared-runtime design, #236 section 3).
// Effective = the tighter of the ceiling and the override, else of the
// ceiling and the global default; a loosening is judged against the
// session's current effective value; a terminal tightening drops the
// overrides looser than it. The ceiling and the defaults are given (here a
// test's), so nothing here reads a file.
const assert = require('assert');
const settings = require('../../lib/session-settings');

describe('sessions 06: per-session overrides and effective values (shared runtime B2, Task 1)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  let ceiling;
  let defaults;
  let packs;
  let live;
  beforeEach(() => {
    settings.resetForTests();
    ceiling = {state: 'none'};
    defaults = {maxOutputBytes: 1000, requestTimeout: 30000};
    packs = {};
    live = new Set([A, B]);
    settings.configure({ceiling: () => ceiling, defaultOf: (name) => defaults[name], globalPack: (name) => (name in packs ? packs[name] : null), isLive: (id) => live.has(id)});
  });

  it('one session\'s override is its own: another runs at the default, and has no limits of its own', () => {
    assert.deepStrictEqual(settings.set(A, 'maxOutputBytes', 9000), {old: 1000, new: 9000});
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 9000);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 1000);
    assert.deepStrictEqual(settings.limitsOf(A), {maxOutputBytes: 9000, requestTimeout: 30000});
    assert.ok(Object.isFrozen(settings.limitsOf(A)));
    assert.strictEqual(settings.limitsOf(B), null);
  });

  it('a loosening is judged against the session\'s current value: raising a tightened value back toward the default is one', () => {
    settings.set(A, 'maxOutputBytes', 300);
    assert.strictEqual(settings.isLoosening(A, 'maxOutputBytes', 1000), true, 'back toward the default needs a form');
    assert.strictEqual(settings.isLoosening(A, 'maxOutputBytes', 200), false);
    assert.strictEqual(settings.isLoosening(B, 'maxOutputBytes', 1000), false, 'B is at the default');
    assert.strictEqual(settings.isLoosening(B, 'requestTimeout', 60000), true);
  });

  it('the ceiling bounds an override at every read, so a ceiling lowered under it is followed with no new set (review focus 5)', () => {
    settings.set(A, 'maxOutputBytes', 9000);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 5000}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 5000);
    assert.strictEqual(settings.limitsOf(A).maxOutputBytes, 5000);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 1000, 'a default under the ceiling stays');
  });

  it('a ceiling lowered and raised again never brings back the looser value (review focus 5)', () => {
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 5000}};
    settings.set(A, 'maxOutputBytes', 9000);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 5000);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 20000}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 5000, 'kept as the ceiling bounded it when set');
  });

  it('only a live session sets: an ended (or never settled) id is refused', () => {
    live.delete(A);
    assert.throws(() => settings.set(A, 'maxOutputBytes', 300), /has ended/);
    assert.strictEqual(settings.limitsOf(A), null);
  });

  it('a ceiling that cannot be trusted, or not known now, keeps every session at the default or tighter', () => {
    settings.set(A, 'maxOutputBytes', 9000);
    settings.set(A, 'requestTimeout', 100);
    for (const c of [{state: 'untrusted', problem: 'x'}, undefined]) {
      ceiling = c;
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 1000, JSON.stringify(c));
      assert.strictEqual(settings.effective(A, 'requestTimeout'), 100, 'a tightening still holds');
    }
  });

  it('a terminal tightening drops the overrides looser than it, keeps the tighter ones, and says whose it dropped', () => {
    settings.set(A, 'maxOutputBytes', 9000);
    settings.set(B, 'maxOutputBytes', 300);
    defaults.maxOutputBytes = 2000;
    assert.deepStrictEqual(settings.dropLooser('maxOutputBytes', 2000), [A]);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2000);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 300);
    assert.strictEqual(settings.limitsOf(A), null, 'A has no override left');
    assert.deepStrictEqual(settings.dropLooser('requestTimeout', 10), [], 'none on that setting');
  });

  it('pack overrides: a session\'s own, else the global value', () => {
    packs['pack.ci'] = true;
    settings.set(A, 'pack.ci', false);
    assert.strictEqual(settings.effective(A, 'pack.ci'), false);
    assert.strictEqual(settings.effective(B, 'pack.ci'), true);
    assert.strictEqual(settings.isLoosening(A, 'pack.ci', true), true, 'un-hiding a pack the session turned off needs a form');
    assert.strictEqual(settings.isLoosening(B, 'pack.ci', false), false);
  });

  it('only these settings: locale is the terminal\'s, an unknown name or a bad value is refused', () => {
    assert.throws(() => settings.set(A, 'locale', 'zh-CN'), (e) => e.code === 'SETTING_TERMINAL_ONLY_SHARED' && /ch-local settings set locale/.test(e.message));
    assert.throws(() => settings.set(A, 'nope', 1), (e) => e.code === 'SETTING_UNKNOWN');
    for (const bad of [0, -1, 1.5, '9000', null]) assert.throws(() => settings.set(A, 'maxOutputBytes', bad), (e) => e.code === 'SETTING_OUT_OF_BOUNDS', String(bad));
    assert.throws(() => settings.set(A, 'pack.ci', 'yes'), (e) => e.code === 'SETTING_OUT_OF_BOUNDS');
    assert.throws(() => settings.set('', 'maxOutputBytes', 1), /a session is its id/);
  });

  it('a session\'s overrides go with forget; the others stay', () => {
    settings.set(A, 'maxOutputBytes', 9000);
    settings.set(B, 'maxOutputBytes', 300);
    settings.forget(A);
    assert.strictEqual(settings.limitsOf(A), null);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 300);
  });
});
