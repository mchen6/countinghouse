'use strict';
// ch-local daemon's 'restore' on the shared runtime
// (lib/session-transport/restore.js), server free, under the review of
// #255: the plan's shape is applied; it runs once, and never after the
// safety net or the listen; a payload of any other shape is refused whole,
// with nothing imported.
const assert = require('assert');
const {createRestore, MAX_DECLINES} = require('../../lib/session-transport/restore');
const {MAX_SESSIONS} = require('../../lib/session-transport/listener');

const ID = 'a'.repeat(32);
const plan = (over = {}) => Object.assign({id: 'd1', type: 'restore',
  sessions: [{session: ID, state: {overrides: [{name: 'maxOutputBytes', value: 1024, loosening: false, over: null, version: null}], locks: [], formsLeft: 3}}],
  declines: [{kind: 'maxOutputBytes', at: 1700000000000}]}, over);
const ov = (over = {}) => Object.assign({name: 'maxOutputBytes', value: 1024, loosening: false, over: null, version: null}, over);
const st = (state) => plan({sessions: [{session: ID, state}]});
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('session-transport 06: ch-local daemon\'s restore (#255 review)', () => {
  it('applies the plan-shaped restore: importTable gets the sessions and the declines', () => {
    const got = [];
    const r = createRestore({importTable: (t) => got.push(t)});
    assert.deepStrictEqual(r.handle(plan()), {sessions: 1});
    assert.deepStrictEqual(got, [{sessions: plan().sessions, declines: plan().declines}]);
    assert.strictEqual(r.done(), true);
  });

  it('a second restore is refused CONTROL_RESTORE_DONE, and imports nothing', () => {
    const got = [];
    const r = createRestore({importTable: (t) => got.push(t)});
    r.handle(plan());
    assert.strictEqual(code(() => r.handle(plan())), 'CONTROL_RESTORE_DONE');
    assert.strictEqual(got.length, 1);
  });

  it('a restore after the safety net, or once the listen has started, is refused', () => {
    const got = [];
    const a = createRestore({importTable: (t) => got.push(t)});
    a.close();   // the net fired, or listen() began
    assert.strictEqual(code(() => a.handle(plan())), 'CONTROL_RESTORE_DONE');
    assert.strictEqual(got.length, 0);
  });

  it('refuses whole any other shape: keys, counts, ids, state keys, sizes, declines', () => {
    const bad = [
      plan({extra: 1}),
      plan({sessions: {}}),
      plan({declines: 'x'}),
      plan({sessions: [{session: 'not-hex', state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, state: {overrides: [], locks: [], formsLeft: 3, nonce: 'x'}}]}),
      plan({sessions: [{session: ID, state: {overrides: [], locks: []}}]}),
      plan({sessions: [{session: ID, state: {overrides: {}, locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, state: {overrides: [], locks: [], formsLeft: 3}, mac: 'x'}]}),
      plan({sessions: [{session: ID, state: {overrides: ['x'.repeat(70 * 1024)], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, state: {overrides: [], locks: [], formsLeft: 3}}, {session: ID, state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: Array.from({length: MAX_SESSIONS + 1}, (_, i) => ({session: i.toString(16).padStart(32, '0'), state: {overrides: [], locks: [], formsLeft: 3}}))}),
      plan({declines: [{kind: '', at: 1}]}),
      plan({declines: [{kind: 'x'.repeat(65), at: 1}]}),
      plan({declines: [{kind: 'pack', at: Infinity}]}),
      plan({declines: [{kind: 'pack', at: -5}]}),
      plan({declines: [{kind: 'pack', at: 1.5}]}),
      plan({declines: [{kind: 'pack', at: 1e300}]}),
      plan({declines: [{kind: 'pack', at: Date.now() + 31 * 365 * 24 * 3600 * 1000}]}),
      plan({declines: [{kind: 'pack', at: 1, session: ID}]}),
      plan({declines: Array.from({length: MAX_DECLINES + 1}, () => ({kind: 'pack', at: 1}))}),
      // B2's exact shapes (#252 rev 2)
      st({overrides: [], locks: [], formsLeft: 4}),
      st({overrides: [], locks: [], formsLeft: 1.5}),
      st({overrides: [], locks: ['pack', 'pack'], formsLeft: 3}),
      st({overrides: [], locks: ['other'], formsLeft: 3}),
      st({overrides: [ov({name: 'secret'})], locks: [], formsLeft: 3}),
      st({overrides: [ov({name: 'pack.Bad_Name'})], locks: [], formsLeft: 3}),
      st({overrides: [ov(), ov()], locks: [], formsLeft: 3}),
      st({overrides: Array.from({length: 65}, (_, i) => ov({name: `pack.p${i}`, value: true, version: '1.0.0'})), locks: [], formsLeft: 3}),
      st({overrides: [ov({value: 0})], locks: [], formsLeft: 3}),
      st({overrides: [ov({value: true})], locks: [], formsLeft: 3}),
      st({overrides: [ov({name: 'pack.one', value: 1, version: '1.0.0'})], locks: [], formsLeft: 3}),
      st({overrides: [ov({loosening: 'yes'})], locks: [], formsLeft: 3}),
      st({overrides: [ov({loosening: true, over: null})], locks: [], formsLeft: 3}),
      st({overrides: [ov({over: 5})], locks: [], formsLeft: 3}),
      st({overrides: [ov({version: '1.0.0'})], locks: [], formsLeft: 3}),
      st({overrides: [ov({name: 'pack.one', value: true, version: null})], locks: [], formsLeft: 3}),
      st({overrides: [ov({name: 'pack.one', value: true, version: '1.0.0 && x'})], locks: [], formsLeft: 3}),
      st({overrides: [ov({mac: 'x'})], locks: [], formsLeft: 3}),
      plan({declines: [{kind: 'other', at: 1}]})
    ];
    for (const m of bad) {
      const got = [];
      const r = createRestore({importTable: (t) => got.push(t)});
      assert.strictEqual(code(() => r.handle(m)), 'CONTROL_BAD_RESTORE', JSON.stringify(m).slice(0, 160));
      assert.strictEqual(got.length, 0);
      assert.strictEqual(r.done(), false, 'a refused restore leaves the way open for a good one');
    }
  });

  it('takes B2\'s exact shapes: a confirmed cap loosening, a pack turned on, locks and forms left', () => {
    const r = createRestore({});
    const state = {overrides: [ov({name: 'requestTimeout', value: 120000, loosening: true, over: 30000}), ov({name: 'pack.ci-failure-triage', value: true, version: '1.2.3'})],
      locks: ['maxOutputBytes', 'pack'], formsLeft: 0};
    assert.deepStrictEqual(r.handle(st(state)), {sessions: 1});
  });

  it('with no importTable yet (before B2) the table is validated and counted, and the restore is done', () => {
    const r = createRestore({});
    assert.deepStrictEqual(r.handle(plan()), {sessions: 1});
    assert.strictEqual(r.done(), true);
  });
});
