'use strict';
// B2 Task 1 (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md,
// #252, #266; #268's review): lib/session-settings.js's pure logic, the
// per-session overrides and a session's effective values (#236 section 3).
// The ceiling, the defaults and liveness are given (here a test's); the
// bounds are the settings tool's own. Nothing here reads a file.
const assert = require('assert');
const settings = require('../../lib/session-settings');

const MiB = 1024 * 1024;

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
    defaults = {maxOutputBytes: 8 * MiB, requestTimeout: 30000};
    packs = {};
    live = new Set([A, B]);
    settings.configure({ceiling: () => ceiling, defaultOf: (name) => defaults[name], globalPack: (name) => (name in packs ? packs[name] : null), isLive: (id) => live.has(id)});
  });
  const loosen = (id, name, value) => settings.set(id, name, value, {loosening: true, over: defaults[name]});

  it('one session\'s override is its own: another runs at the default, and has no limits of its own', () => {
    assert.deepStrictEqual(loosen(A, 'maxOutputBytes', 16 * MiB), {old: 8 * MiB, new: 16 * MiB});
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
    assert.deepStrictEqual(settings.limitsOf(A), {maxOutputBytes: 16 * MiB, requestTimeout: 30000});
    assert.ok(Object.isFrozen(settings.limitsOf(A)));
    assert.strictEqual(settings.limitsOf(B), null);
  });

  it('a looser value needs its mark ({loosening, over}); a tightening needs none', () => {
    assert.throws(() => settings.set(A, 'maxOutputBytes', 16 * MiB), /needs \{loosening: true, over\}/);
    assert.throws(() => settings.set(A, 'maxOutputBytes', 16 * MiB, {loosening: true}), /names the default it was confirmed over/);
    assert.deepStrictEqual(settings.set(A, 'maxOutputBytes', 2 * MiB), {old: 8 * MiB, new: 2 * MiB});
    assert.strictEqual(settings.isLoosening(A, 'maxOutputBytes', 8 * MiB), true, 'back toward the default is a loosening');
    assert.deepStrictEqual(settings.overridesOf(A), [{name: 'maxOutputBytes', value: 2 * MiB, loosening: false, over: null, version: null}]);
  });

  it('a ceiling lowered and raised again never brings back the looser value (review focus 5; #268 review 1)', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 12 * MiB}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 12 * MiB);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 64 * MiB}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 12 * MiB, 'clamped where the lower ceiling was seen');
    // untrusted, then none: held at the default, and kept there
    loosen(B, 'maxOutputBytes', 16 * MiB);
    ceiling = {state: 'untrusted', problem: 'x'};
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
    ceiling = {state: 'none'};
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB);
  });

  it('a ceiling that turns conversation off, or forbids the setting, bounds it at the default (#268 review 2)', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    loosen(B, 'requestTimeout', 60000);
    ceiling = {state: 'trusted', ceiling: {conversation: false}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
    ceiling = {state: 'trusted', ceiling: {forbid: ['requestTimeout']}};
    assert.strictEqual(settings.effective(B, 'requestTimeout'), 30000);
  });

  it('an unknown ceiling (a stale cache) keeps every cap at the default or tighter', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    settings.set(A, 'requestTimeout', 10000);
    ceiling = undefined;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
    assert.strictEqual(settings.effective(A, 'requestTimeout'), 10000, 'a tightening still holds');
  });

  it('an unmarked tightening is held to the default when it drops; a loosening confirmed over a higher default ends (#268 review 3)', () => {
    settings.set(A, 'maxOutputBytes', 6 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
    defaults.maxOutputBytes = 8 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB, 'never looser than it was held to');
    loosen(B, 'maxOutputBytes', 16 * MiB);   // over 8 MiB
    defaults.maxOutputBytes = 4 * MiB;
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 4 * MiB);
    assert.strictEqual(settings.limitsOf(B), null, 'the loosening is gone');
  });

  it('a terminal tightening drops the overrides looser than it, and says whose', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    settings.set(B, 'maxOutputBytes', 2 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.deepStrictEqual(settings.dropLooser('maxOutputBytes', 4 * MiB), [A]);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 2 * MiB);
  });

  it('values within the settings tool\'s own bounds only; bad input throws (#268 review 4, 7)', () => {
    for (const bad of [1e308, 2 ** 60, 0, -1, MiB / 2, 257 * MiB, MiB + 0.5, '2000', NaN, Infinity, null]) {
      assert.throws(() => settings.set(A, 'maxOutputBytes', bad), (e) => e.code === 'SETTING_OUT_OF_BOUNDS', String(bad));
    }
    assert.throws(() => settings.set(A, 'requestTimeout', 999999), (e) => e.code === 'SETTING_OUT_OF_BOUNDS');
    assert.throws(() => settings.isLoosening(A, 'maxOutputBytes', NaN), (e) => e.code === 'SETTING_OUT_OF_BOUNDS');
    assert.throws(() => settings.isLoosening(A, 'nope', 1), (e) => e.code === 'SETTING_UNKNOWN');
    assert.throws(() => settings.dropLooser('maxOutputBytes', NaN), /positive whole number/);
    assert.throws(() => settings.dropLooser('pack.ci', 1), /only a cap/);
  });

  it('names are strings, ids are 32 hex, at most 64 overrides (#268 review 5, 6)', () => {
    for (const bad of [['pack.ci'], {toString: () => 'pack.ci'}, 7]) assert.throws(() => settings.set(A, bad, true, {version: '1.0.0'}), /named by a string/);
    for (const id of ['x', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(200)]) assert.throws(() => settings.set(id, 'requestTimeout', 10000), /32-hex id/);
    for (let i = 0; i < 64; i++) settings.set(A, `pack.p${i}`, false, {version: '1.0.0'});
    assert.throws(() => settings.set(A, 'pack.p64', false, {version: '1.0.0'}), (e) => e.code === 'SETTING_OUT_OF_BOUNDS');
    settings.set(A, 'pack.p3', true, {loosening: true, version: '1.0.1'});   // an existing name is still changed
  });

  it('onChange hears a set, a clamp and a drop', () => {
    const heard = [];
    settings.onChange((id) => heard.push(id));
    loosen(A, 'maxOutputBytes', 16 * MiB);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 12 * MiB}};
    settings.effective(A, 'maxOutputBytes');
    defaults.maxOutputBytes = 4 * MiB;
    settings.dropLooser('maxOutputBytes', 4 * MiB);
    assert.deepStrictEqual(heard, [A, A, A]);
  });

  it('pack overrides: always with their version; an "on" only where the ceiling allows the pack', () => {
    packs['pack.ci'] = true;
    assert.throws(() => settings.set(A, 'pack.ci', false), /names its plain version/);
    for (const v of ['', 'latest', '^1.2.0', '1.2', '1.2.0 ', 'v1.2.0']) assert.throws(() => settings.set(A, 'pack.ci', false, {version: v}), /plain version/, v);
    settings.set(A, 'pack.ci', false, {version: '1.2.0'});
    assert.strictEqual(settings.effective(A, 'pack.ci'), false);
    assert.strictEqual(settings.effective(B, 'pack.ci'), true);
    assert.strictEqual(settings.isLoosening(A, 'pack.ci', true), true, 'un-hiding a pack the session turned off is a loosening');
    packs['pack.ci'] = false;
    settings.set(B, 'pack.ci', true, {loosening: true, version: '1.2.0'});
    ceiling = {state: 'trusted', ceiling: {packs: ['other']}};
    assert.strictEqual(settings.effective(B, 'pack.ci'), false, 'not in the ceiling\'s packs');
  });

  it('locale is the terminal\'s; an ended session sets nothing; forget leaves the others', () => {
    assert.throws(() => settings.set(A, 'locale', 'zh-CN'), (e) => e.code === 'SETTING_TERMINAL_ONLY_SHARED' && /ch-local settings set locale/.test(e.message));
    live.delete(A);
    assert.throws(() => settings.set(A, 'requestTimeout', 10000), /has ended/);
    settings.set(B, 'requestTimeout', 10000);
    settings.forget(A);
    assert.strictEqual(settings.effective(B, 'requestTimeout'), 10000);
  });
});
