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
const HASH = 'f'.repeat(64);
const plan = (over = {}) => Object.assign({id: 'd1', type: 'restore',
  sessions: [{session: ID, resume: HASH, state: {overrides: [{name: 'maxOutputBytes', value: 1048576, loosening: false, over: null, version: null}], locks: [], formsLeft: 3}}],
  declines: [{kind: 'maxOutputBytes', at: 1700000000000}], reset: []}, over);
const ov = (over = {}) => Object.assign({name: 'maxOutputBytes', value: 1048576, loosening: false, over: null, version: null}, over);
const st = (state) => plan({sessions: [{session: ID, resume: HASH, state}]});
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('session-transport 06: ch-local daemon\'s restore (#255 review)', () => {
  it('applies the plan-shaped restore: importTable gets the sessions and the declines', () => {
    const got = [];
    const r = createRestore({importTable: (t) => got.push(t)});
    assert.deepStrictEqual(r.handle(plan()), {sessions: 1});
    assert.deepStrictEqual(got, [{sessions: plan().sessions, declines: plan().declines, reset: [], packsDropped: [], kindsMapped: 0, kindsDropped: [], declinesDropped: 0}], 'resume included: the runtime splits it from B\'s state');
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
      plan({sessions: [{session: 'not-hex', resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: [], locks: [], formsLeft: 3, nonce: 'x'}}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: [], locks: []}}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: {}, locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}, mac: 'x'}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: ['x'.repeat(70 * 1024)], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}, {session: ID, resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: Array.from({length: MAX_SESSIONS + 1}, (_, i) => ({session: i.toString(16).padStart(32, '0'), resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}))}),
      plan({declines: [{kind: '', at: 1}]}),
      plan({declines: [{kind: 'x'.repeat(65), at: 1}]}),
      plan({declines: [{kind: 'enabled', at: Infinity}]}),
      plan({declines: [{kind: 'enabled', at: -5}]}),
      plan({declines: [{kind: 'enabled', at: 1.5}]}),
      plan({declines: [{kind: 'enabled', at: 1e300}]}),
      plan({declines: [{kind: 'enabled', at: Date.now() + 31 * 365 * 24 * 3600 * 1000}]}),
      plan({declines: [{kind: 'enabled', at: 1, session: ID}]}),
      plan({declines: Array.from({length: MAX_DECLINES + 1}, () => ({kind: 'enabled', at: 1}))}),
      // a state of no shape at all (#449's high review, round 3, 3: refused,
      // never a TypeError)
      plan({sessions: [{session: ID, resume: HASH, state: null}]}),
      plan({sessions: [{session: ID, resume: HASH, state: []}]}),
      plan({sessions: [{session: ID, resume: HASH, state: 'x'}]}),
      st({overrides: [], locks: null, formsLeft: 3}),
      st({overrides: [], locks: ['pack'], formsLeft: 3, unanswered: null}),
      // B2's exact shapes (#252 rev 2)
      st({overrides: [], locks: [], formsLeft: 4}),
      st({overrides: [], locks: [], formsLeft: 1.5}),
      st({overrides: [], locks: ['enabled', 'enabled'], formsLeft: 3}),
      st({overrides: [], locks: [7], formsLeft: 3}),
      st({overrides: [], locks: ['other-kind'], formsLeft: 3}),
      st({overrides: [ov({name: 'secret'})], locks: [], formsLeft: 3}),
      // M5a: a pack's on or off is never a session's own. A pack.<n> override
      // not of the old shape refuses (a well-formed one is dropped: below)
      st({overrides: [ov({name: 'pack.Bad_Name'})], locks: [], formsLeft: 3}),
      st({overrides: [ov(), ov()], locks: [], formsLeft: 3}),
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
      plan({declines: [{kind: 7, at: 1}]}),
      plan({declines: [{kind: 'other kind', at: 1}]}),
      // the resume hash (N3): exactly 64 lowercase hex, always present
      plan({sessions: [{session: ID, state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: 'F'.repeat(64), state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: 'f'.repeat(63), state: {overrides: [], locks: [], formsLeft: 3}}]}),
      plan({sessions: [{session: ID, resume: 7, state: {overrides: [], locks: [], formsLeft: 3}}]}),
      // two rows sharing a resume hash (#262 review, L1)
      plan({sessions: [{session: ID, resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}, {session: 'b'.repeat(32), resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}]})
    ];
    for (const m of bad) {
      const got = [];
      const r = createRestore({importTable: (t) => got.push(t)});
      assert.strictEqual(code(() => r.handle(m)), 'CONTROL_BAD_RESTORE', JSON.stringify(m).slice(0, 160));
      assert.strictEqual(got.length, 0);
      assert.strictEqual(r.done(), false, 'a refused restore leaves the way open for a good one');
    }
  });

  it('takes B2\'s exact shapes: a confirmed cap loosening, a tightening, locks and forms left', () => {
    const r = createRestore({});
    const state = {overrides: [ov({name: 'requestTimeout', value: 120000, loosening: true, over: 30000}), ov()],
      locks: ['maxOutputBytes', 'enabled'], formsLeft: 0};
    assert.deepStrictEqual(r.handle(st(state)), {sessions: 1});
  });

  it('with no importTable yet (before B2) the table is validated and counted, and the restore is done', () => {
    const r = createRestore({});
    assert.deepStrictEqual(r.handle(plan()), {sessions: 1});
    assert.strictEqual(r.done(), true);
  });

  // #438's high review, 2: one session's stale pack override is that row's
  // alone: dropped, the row's rest and every other row taken, and the
  // session named for importTable to tell once
  it('a well-formed pack override from before M5a is dropped from its row; the rest of the table is taken', () => {
    const got = [];
    const r = createRestore({importTable: (t) => got.push(t)});
    const other = {session: 'b'.repeat(32), resume: 'b'.repeat(64), state: {overrides: [ov({name: 'requestTimeout', value: 120000, loosening: true, over: 30000})], locks: [], formsLeft: 3}};
    const stale = {session: ID, resume: HASH, state: {overrides: [ov(), ov({name: 'pack.weather', value: false, version: '1.0.0'}), ov({name: 'pack.ci-failure-triage', value: true, loosening: true, version: '1.2.3'})], locks: ['enabled'], formsLeft: 2}};
    assert.deepStrictEqual(r.handle(plan({sessions: [stale, other], reset: []})), {sessions: 2});
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual(got[0].sessions[0].state, {overrides: [ov()], locks: ['enabled'], formsLeft: 2});
    assert.deepStrictEqual(got[0].sessions[1], other, 'another session\'s loosening is kept');
    assert.deepStrictEqual(got[0].packsDropped, [{session: ID, names: ['weather', 'ci-failure-triage']}]);
    // what the daemon sent is bounded before anything is dropped: a name
    // twice, and a state over its size, refuse as before
    const twice = {session: ID, resume: HASH, state: {overrides: [ov({name: 'pack.weather', value: false, version: '1.0.0'}), ov({name: 'pack.weather', value: true, version: '1.0.1'})], locks: [], formsLeft: 3}};
    assert.strictEqual(code(() => createRestore({}).handle(plan({sessions: [twice], reset: []}))), 'CONTROL_BAD_RESTORE');
    const big = {session: ID, resume: HASH, state: {overrides: Array.from({length: 600}, (_, i) => ov({name: `pack.p${i}`, value: false, version: `1.0.0-${'x'.repeat(60)}`})), locks: [], formsLeft: 3}};
    assert.ok(Buffer.byteLength(JSON.stringify(big.state)) > 64 * 1024);
    assert.strictEqual(code(() => createRestore({}).handle(plan({sessions: [big], reset: []}))), 'CONTROL_BAD_RESTORE');
    // the vectors' dropped rows
    const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').restoreRows;
    for (const c of V.dropped) {
      const seen = [];
      createRestore({importTable: (t) => seen.push(t)}).handle(plan({sessions: [c.row], reset: []}));
      assert.deepStrictEqual(seen[0].sessions[0].state, c.taken, c.why);
      assert.deepStrictEqual(seen[0].packsDropped, [{session: c.row.session, names: c.packs}], c.why);
    }
  });

  it('the shared vectors\' restoreRows: each accepted row is taken, each refused one refuses the restore (one shape for restore.js, the daemon and B2)', () => {
    const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').restoreRows;
    const r = createRestore({});
    assert.deepStrictEqual(r.handle(plan({sessions: V.accepted, reset: []})), {sessions: V.accepted.length});
    for (const c of V.refused) {
      // refused, and for the reason the case names, never by another rule
      let message = null;
      try { createRestore({}).handle(plan({sessions: [c.row], reset: []})); } catch (e) { assert.strictEqual(e.code, 'CONTROL_BAD_RESTORE', c.why); message = e.message; }
      assert.ok(message != null, `${c.why}: refused`);
      assert.ok(typeof(c.reason) === 'string' && message.includes(c.reason), `${c.why}: for its own reason (${c.reason}), not "${message}"`);
    }
  });

  // #449's high review, 2: a table written under a runtime before M5b holds
  // the kind pack; it is the kind enabled now, per row, so the session's
  // tightenings stay, and the runtime says so once
  it('the kind pack is taken as enabled, per row and per decline, deduped, and said once', () => {
    const got = [];
    const said = [];
    const r = createRestore({importTable: (t) => got.push(t), log: (m) => said.push(m)});
    const B = 'b'.repeat(32);
    const C = 'c'.repeat(32);
    const rows = [
      {session: ID, resume: HASH, state: {overrides: [ov()], locks: ['pack', 'maxOutputBytes'], formsLeft: 2}},
      // pack and enabled both locked: one enabled
      {session: B, resume: 'b'.repeat(64), state: {overrides: [], locks: ['enabled', 'pack'], formsLeft: 3}},
      // pack unanswered and enabled locked: the lock wins
      {session: C, resume: 'c'.repeat(64), state: {overrides: [], locks: ['enabled'], formsLeft: 1, unanswered: ['pack', 'requestTimeout']}}
    ];
    const declines = [{kind: 'pack', at: 1700000000000}, {kind: 'module', at: 1700000000001}];
    assert.deepStrictEqual(r.handle(plan({sessions: rows, declines, reset: [B]})), {sessions: 3});
    const t = got[0];
    assert.deepStrictEqual(t.sessions.map((x) => x.state), [
      {overrides: [ov()], locks: ['enabled', 'maxOutputBytes'], formsLeft: 2},
      {overrides: [], locks: ['enabled'], formsLeft: 3},
      {overrides: [], locks: ['enabled'], formsLeft: 1, unanswered: ['requestTimeout']}
    ]);
    assert.deepStrictEqual(t.declines, [{kind: 'enabled', at: 1700000000000}, {kind: 'module', at: 1700000000001}]);
    assert.strictEqual(t.kindsMapped, 4, 'three rows and one decline');
    assert.deepStrictEqual(t.reset, [B]);
    assert.strictEqual(said.length, 1, 'said once');
    assert.ok(/pack/.test(said[0]) && /enabled/.test(said[0]) && /\b4\b/.test(said[0]), said[0]);
    // nothing to say when nothing was mapped
    const quiet = [];
    createRestore({log: (m) => quiet.push(m)}).handle(plan());
    assert.deepStrictEqual(quiet, []);
    // what the daemon sent is checked as sent: pack twice is a lock twice
    assert.strictEqual(code(() => createRestore({}).handle(st({overrides: [], locks: ['pack', 'pack'], formsLeft: 3}))), 'CONTROL_BAD_RESTORE');
  });

  // #449's high review, round 3, 5: a row naming a kind this runtime has
  // none of keeps everything else (its known locks, its spent forms: the
  // session's tightenings); only the unknown kinds go, said once
  it('a row with an unknown kind keeps the row, less those kinds; a decline of one is dropped; said once', () => {
    const got = [];
    const said = [];
    const r = createRestore({importTable: (t) => got.push(t), log: (m) => said.push(m)});
    const B = 'b'.repeat(32);
    const C = 'c'.repeat(32);
    const unknown = {session: B, resume: 'b'.repeat(64), state: {overrides: [ov()], locks: ['locale', 'maxOutputBytes'], formsLeft: 1}};
    const unanswered = {session: C, resume: 'c'.repeat(64), state: {overrides: [], locks: [], formsLeft: 2, unanswered: ['theme', 'module']}};
    const good = plan().sessions[0];
    const declines = [{kind: 'locale', at: 1}, {kind: 'enabled', at: 2}];
    assert.deepStrictEqual(r.handle(plan({sessions: [unknown, good, unanswered], declines, reset: [B, ID]})), {sessions: 3});
    assert.deepStrictEqual(got[0].sessions.map((x) => x.state), [
      {overrides: [ov()], locks: ['maxOutputBytes'], formsLeft: 1},
      good.state,
      {overrides: [], locks: [], formsLeft: 2, unanswered: ['module']}]);
    assert.deepStrictEqual(got[0].kindsDropped, [{session: B, kinds: ['locale']}, {session: C, kinds: ['theme']}]);
    assert.deepStrictEqual(got[0].declines, [{kind: 'enabled', at: 2}]);
    assert.strictEqual(got[0].declinesDropped, 1);
    assert.deepStrictEqual(got[0].reset, [B, ID], 'every row is taken, so reset as sent');
    assert.strictEqual(said.length, 1, 'said once');
    assert.ok(/locale/.test(said[0]) && /theme/.test(said[0]), said[0]);
    // a stale pack override in such a row: dropped and told, the row kept
    const both = {session: B, resume: 'b'.repeat(64), state: {overrides: [ov({name: 'pack.weather', value: false, version: '1.0.0'})], locks: ['locale'], formsLeft: 3}};
    const seen = [];
    createRestore({importTable: (x) => seen.push(x)}).handle(plan({sessions: [both, good], reset: []}));
    assert.deepStrictEqual(seen[0].packsDropped, [{session: B, names: ['weather']}]);
    assert.deepStrictEqual(seen[0].sessions[0].state, {overrides: [], locks: [], formsLeft: 3});
    // any other problem in that row still refuses the whole restore, as does
    // an unknown kind twice
    assert.strictEqual(code(() => createRestore({}).handle(st({overrides: [], locks: ['locale'], formsLeft: 4}))), 'CONTROL_BAD_RESTORE');
    assert.strictEqual(code(() => createRestore({}).handle(st({overrides: [], locks: ['locale', 'locale'], formsLeft: 3}))), 'CONTROL_BAD_RESTORE');
  });

  it('the shared vectors\' mapped and kindsDropped rows', () => {
    const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').restoreRows;
    assert.ok(V.mapped.length >= 3 && V.kindsDropped.length >= 2);
    for (const c of V.mapped) {
      const seen = [];
      createRestore({importTable: (t) => seen.push(t)}).handle(plan({sessions: [c.row], reset: []}));
      assert.deepStrictEqual(seen[0].sessions[0].state, c.taken, c.why);
    }
    for (const c of V.kindsDropped) {
      const seen = [];
      createRestore({importTable: (t) => seen.push(t)}).handle(plan({sessions: [c.row], reset: []}));
      assert.deepStrictEqual(seen[0].sessions[0].state, c.taken, c.why);
      assert.deepStrictEqual(seen[0].kindsDropped, [{session: c.row.session, kinds: c.kinds}], c.why);
    }
  });

  it('reset lists restored sessions that lost loosenings: each a row\'s id, once; passed to importTable; required', () => {
    const got = [];
    const r = createRestore({importTable: (t) => got.push(t)});
    r.handle(plan({reset: [ID]}));
    assert.deepStrictEqual(got[0].reset, [ID]);
    for (const reset of [['b'.repeat(32)], [ID, ID], 'x', [7], undefined]) {
      const m = plan({reset});
      if (reset === undefined) delete m.reset;
      assert.strictEqual(code(() => createRestore({}).handle(m)), 'CONTROL_BAD_RESTORE', JSON.stringify(reset));
    }
  });
});
