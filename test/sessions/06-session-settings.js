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
    settings.configure({ceiling: () => ceiling, defaultOf: (name) => defaults[name], globalPack: (name) => (name in packs ? packs[name] : null), isLive: (id) => live.has(id),
      ceilingMemoMs: 0});   // every read asks: the cases change the ceiling between reads
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

  it('a ceiling seen lowered and raised again never brings back the looser value (review focus 5; #268 review 1)', () => {
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

  it('a loosening set above the ceiling in force is stored at it: a ceiling raised later never lets it past (#268 re-check, 1)', () => {
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 13 * MiB}};
    assert.deepStrictEqual(loosen(A, 'maxOutputBytes', 32 * MiB), {old: 8 * MiB, new: 13 * MiB});
    assert.strictEqual(settings.overridesOf(A)[0].value, 13 * MiB, 'stored at the ceiling, not as asked');
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 64 * MiB}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 13 * MiB);
  });

  it('a loosening with no usable ceiling now is refused: untrusted, not known, forbidding it, conversation off (#268 re-check, 1)', () => {
    for (const c of [{state: 'untrusted', problem: 'x'}, undefined, {state: 'trusted', ceiling: {forbid: ['maxOutputBytes']}}, {state: 'trusted', ceiling: {conversation: false}}]) {
      ceiling = c;
      assert.throws(() => loosen(A, 'maxOutputBytes', 16 * MiB), /no loosening without a usable ceiling/, JSON.stringify(c));
      assert.deepStrictEqual(settings.overridesOf(A), [], JSON.stringify(c));
    }
    assert.deepStrictEqual(settings.set(A, 'maxOutputBytes', 2 * MiB), {old: 8 * MiB, new: 2 * MiB}, 'a tightening still sets');
  });

  it('a loosening confirmed over a default above today\'s is refused, so none lies dormant (#268 re-check, 2)', () => {
    assert.throws(() => settings.set(A, 'maxOutputBytes', 16 * MiB, {loosening: true, over: 12 * MiB}), /over the default in force/);
    assert.deepStrictEqual(settings.overridesOf(A), []);
  });

  it('a ceiling seen while one session\'s clamp throws is seen again in full at the next read (#268 re-check, 3)', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    loosen(B, 'requestTimeout', 60000);
    ceiling = {state: 'untrusted', problem: 'x'};
    defaults.requestTimeout = 'not a number';
    assert.throws(() => settings.effective(A, 'maxOutputBytes'), /no default for requestTimeout/);
    defaults.requestTimeout = 30000;
    settings.effective(A, 'maxOutputBytes');   // the same ceiling, seen again
    ceiling = {state: 'none'};
    assert.strictEqual(settings.effective(B, 'requestTimeout'), 30000, 'B was clamped too');
  });

  it('the ceiling is read once per memo window on the call path; one seen changed replaces it at once (#271 review, 5)', () => {
    let reads = 0;
    settings.configure({ceiling: () => { reads += 1; return ceiling; }, defaultOf: (name) => defaults[name], isLive: (id) => live.has(id), ceilingMemoMs: 60000});
    loosen(A, 'maxOutputBytes', 16 * MiB);
    reads = 0;
    for (let i = 0; i < 100; i++) settings.limitsOf(A);
    assert.strictEqual(reads, 0, 'within the window, no read');
    const lower = {state: 'trusted', ceiling: {maxOutputBytes: 12 * MiB}};
    settings.ceilingSeen(lower);   // the settings tool's re-read
    assert.strictEqual(settings.limitsOf(A).maxOutputBytes, 12 * MiB, 'at once');
    assert.strictEqual(reads, 0);
  });

  it('the memo\'s age is on a monotonic clock, and a negative one (a clock gone back) is expired (#271 re-check)', () => {
    let reads = 0;
    let t = 1000000;
    settings.configure({ceiling: () => { reads += 1; return ceiling; }, defaultOf: (name) => defaults[name], isLive: (id) => live.has(id), ceilingMemoMs: 1000, nowMs: () => t});
    loosen(A, 'maxOutputBytes', 16 * MiB);
    reads = 0;
    settings.limitsOf(A);
    assert.strictEqual(reads, 0, 'within the window');
    t += 1000;
    settings.limitsOf(A);
    assert.strictEqual(reads, 1, 'past it, read again');
    t -= 60000;
    settings.limitsOf(A);
    assert.strictEqual(reads, 2, 'a clock gone back: read again, not served from the memo');
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

  it('an unmarked tightening is bounded by the default while it is lower; a loosening confirmed over a higher default is bounded by it (#268 review 3)', () => {
    settings.set(A, 'maxOutputBytes', 6 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
    defaults.maxOutputBytes = 8 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 6 * MiB, 'its own tightening again, never above the default');
    loosen(B, 'maxOutputBytes', 16 * MiB);   // over 8 MiB
    defaults.maxOutputBytes = 4 * MiB;
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 4 * MiB, 'bounded; a terminal tightening also drops it (dropLooser)');
  });

  it('a stale or unknown ceiling at a read bounds the value and leaves the store intact (#268 re-check, a)', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    ceiling = undefined;   // the cache is stale
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 8 * MiB);
    ceiling = {state: 'none'};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 16 * MiB, 'the loosening was never reset by the stale read');
    assert.strictEqual(settings.overridesOf(A)[0].value, 16 * MiB);
  });

  it('an idle session is clamped when a lower ceiling is seen, by any read or the settings tool\'s re-read (#268 re-check, a)', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 12 * MiB}};
    settings.effective(B, 'maxOutputBytes');   // B's read sees the change; A is never read meanwhile
    ceiling = {state: 'trusted', ceiling: {maxOutputBytes: 64 * MiB}};
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 12 * MiB);
    // the settings tool's re-read says it the same way
    loosen(B, 'requestTimeout', 90000);
    settings.ceilingSeen({state: 'trusted', ceiling: {requestTimeout: 60000}});
    ceiling = {state: 'none'};
    assert.strictEqual(settings.effective(B, 'requestTimeout'), 60000);
  });

  it('over is never below the default now; a default that isn\'t a number throws (#268 re-check, b, c)', () => {
    settings.set(A, 'maxOutputBytes', 16 * MiB, {loosening: true, over: 1});
    assert.strictEqual(settings.overridesOf(A)[0].over, 8 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB, 'over 8 MiB, so a lower default bounds it');
    defaults.maxOutputBytes = 'lots';
    assert.throws(() => settings.effective(A, 'maxOutputBytes'), /no default for maxOutputBytes/);
  });

  it('a terminal tightening drops the overrides looser than it, and says whose', () => {
    loosen(A, 'maxOutputBytes', 16 * MiB);
    settings.set(B, 'maxOutputBytes', 2 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.deepStrictEqual(settings.dropLooser('maxOutputBytes', 4 * MiB), [A]);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB);
    assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 2 * MiB);
  });

  // #296's review: only a confirmed loosening is dropped. A session's own
  // tightening above the new default is its own choice: kept, held to the
  // default while that is lower, and in force again when the default rises.
  it('a tightening of a default drops no session\'s own tightening, though it is above the new default', () => {
    settings.set(A, 'maxOutputBytes', 6 * MiB);
    defaults.maxOutputBytes = 4 * MiB;
    assert.deepStrictEqual(settings.dropLooser('maxOutputBytes', 4 * MiB), []);
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 4 * MiB, 'held to the default');
    assert.deepStrictEqual(settings.overridesOf(A).map((o) => [o.value, o.loosening]), [[6 * MiB, false]]);
    defaults.maxOutputBytes = 8 * MiB;
    assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 6 * MiB, 'its own again');
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

  // an "on" names the version confirmed, an "off" the one it was off at: the state's wire
  it('pack overrides: always with their plain version, on or off; an "on" only where the ceiling allows the pack', () => {
    packs['pack.ci'] = true;
    for (const v of [undefined, '', 'latest', '^1.2.0', '1.2', '1.2.0 ', 'v1.2.0']) assert.throws(() => settings.set(B, 'pack.docs', true, {loosening: true, version: v}), /plain version/, String(v));
    assert.throws(() => settings.set(A, 'pack.ci', false), /plain version/);
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
