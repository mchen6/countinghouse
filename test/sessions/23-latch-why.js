'use strict';
// The latch's why (the reviewer's ruling, 2026-11-16, after A's M17 run).
// A session latched by its client's "conditions: no" (N1) was refused with
// the decline's text ("it was declined or left unanswered here, or this
// client's configuration could answer for you"), though the user declined
// nothing. The client line now says why (ch-local's conditions child,
// contract 2's conditionsWhy): a reason from a closed set, and a place under
// the user's home as "~/...", or none. The runtime takes it only as the
// vectors allow, and the refusal for a latched session says it, never
// "declined".
const assert = require('assert');
const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json');
const conditionsWhy = require('../../lib/conditions-why');
const confirm = require('../../lib/settings-confirm');

describe('sessions 23: the latch says why (conditionsWhy)', () => {
  const A = 'a'.repeat(32);
  afterEach(() => confirm.resetForTests());

  it('the runtime takes exactly what the shared vectors accept, and nothing they refuse', () => {
    for (const {why, value} of V.conditionsWhy.accepted) assert.deepStrictEqual(conditionsWhy.check(value), value, why);
    for (const {why, value} of V.conditionsWhy.refused) assert.strictEqual(conditionsWhy.check(value), null, why);
    assert.deepStrictEqual(conditionsWhy.REASONS, V.conditionsWhy.reasons);
  });

  // /code-review of #337, 4: a kind the user declined before the latch fell stays the user's decline
  it('the latch is the cause only of the kinds it locked: a kind declined before it stays declined', () => {
    const a = confirm.confirmations(A);
    a.decline('maxOutputBytes');
    confirm.latch(A, {reason: 'client hook present'});
    assert.deepStrictEqual([a.latchedFor('maxOutputBytes'), a.latchedFor('requestTimeout'), a.latchedFor('enabled.x')], [false, true, true]);
    assert.deepStrictEqual([a.declined('maxOutputBytes'), a.declined('requestTimeout')], [true, true], 'every kind is locked all the same');
  });

  it('what it takes is a copy, and only its two keys', () => {
    const given = {reason: 'client hook present', at: '~/.claude/settings.json'};
    const taken = conditionsWhy.check(given);
    assert.notStrictEqual(taken, given);
    assert.strictEqual(conditionsWhy.check(null), null);
    assert.strictEqual(conditionsWhy.check(undefined), null);
  });

  it('as a sentence: the reason, and its place when there is one', () => {
    assert.strictEqual(conditionsWhy.said({reason: 'project plugin or marketplace', at: '~/.claude/settings.json'}),
      'this client\'s configuration could answer forms by itself (project plugin or marketplace: ~/.claude/settings.json)');
    assert.strictEqual(conditionsWhy.said({reason: 'not an interactive session'}), 'this client\'s configuration could answer forms by itself (not an interactive session)');
    assert.strictEqual(conditionsWhy.said(null), 'this client could not be confirmed');
  });

  // /code-review of #337, 1: the rule the runtime holds is in lib/ (docs/ is not in the package), and it is
  // the shared vectors' rule
  it('the rule the runtime ships with is the shared vectors\' rule', () => {
    const rule = require('../../lib/conditions-why.json');
    assert.deepStrictEqual([rule.reasons, rule.hiddenClass, rule.maxAt], [V.conditionsWhy.reasons, V.conditionsWhy.hiddenClass, 200]);
    assert.ok(!/docs\//.test(require('fs').readFileSync(require.resolve('../../lib/conditions-why'), 'utf8').split('\n').filter((l) => /require\(/.test(l)).join('\n')), 'no require of docs/');
  });

  // /code-review of #337, 3: a place that leaves the home another way is no place
  it('a place with a backslash, or an empty segment, is refused (so no Windows .. and no // absolute path)', () => {
    for (const at of ['~/..\\..\\Users\\bob\\.claude\\settings.json', '~//home/bob/x', '~/a//b', '~/a\\b']) {
      assert.strictEqual(conditionsWhy.check({reason: 'client hook present', at}), null, at);
    }
  });

  it('a latch keeps its why; a session latched with none, or a refused one, has none', () => {
    confirm.latch(A, {reason: 'client hook present', at: '~/.claude/settings.json'});
    const a = confirm.confirmations(A);
    assert.strictEqual(a.latched(), true);
    assert.deepStrictEqual(a.latchedWhy(), {reason: 'client hook present', at: '~/.claude/settings.json'});
    confirm.resetForTests();
    confirm.latch(A, {reason: 'client hook present', at: '/home/someone/.claude/settings.json'});
    assert.deepStrictEqual([confirm.confirmations(A).latched(), confirm.confirmations(A).latchedWhy()], [true, null], 'a path outside the rule is never kept');
    confirm.resetForTests();
    confirm.latch(A);
    assert.deepStrictEqual([confirm.confirmations(A).latched(), confirm.confirmations(A).latchedWhy()], [true, null]);
    // the first latch's why stays: a later one says nothing new
    confirm.resetForTests();
    confirm.latch(A, {reason: 'plugin hook present'});
    confirm.latch(A, {reason: 'client hook present'});
    assert.deepStrictEqual(confirm.confirmations(A).latchedWhy(), {reason: 'plugin hook present'});
    // /code-review of #337, 5: but a latch with no why (or a refused one) takes a later valid one
    confirm.resetForTests();
    confirm.latch(A);
    confirm.latch(A, {reason: 'client hook present', at: '~/.claude/settings.json'});
    assert.deepStrictEqual(confirm.confirmations(A).latchedWhy(), {reason: 'client hook present', at: '~/.claude/settings.json'});
    // a session not latched
    assert.strictEqual(confirm.confirmations('b'.repeat(32)).latched(), false);
  });
});

// The client frame's why reaches the session's client as the rule takes it
// (lib/session-transport/registry.js), and only on a "no".
describe('sessions 23: a client frame keeps its why', () => {
  const {createRegistry} = require('../../lib/session-transport/registry');
  it('a "no" keeps the why the rule takes; a "yes", a failed line or a refused why keeps none; a later frame replaces it', () => {
    const s = createRegistry()._create();
    s._setClient({op: 'client', status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '~/.claude/settings.json'}});
    assert.deepStrictEqual(s.client, {status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '~/.claude/settings.json'}});
    s._setClient({op: 'client', status: 'ok', conditions: 'yes', repo: null, why: {reason: 'client hook present'}});
    assert.deepStrictEqual(s.client, {status: 'ok', conditions: 'yes', repo: null}, 'a yes carries no why, and drops the last');
    s._setClient({op: 'client', status: 'ok', conditions: 'no', repo: null, why: {reason: 'client hook present', at: '/home/x/.claude/settings.json'}});
    assert.deepStrictEqual(s.client, {status: 'ok', conditions: 'no', repo: null}, 'a why the rule refuses is none');
    s._setClient({op: 'client', status: 'failed', why: 'gh did not answer'});
    assert.deepStrictEqual(s.client, {status: 'failed', conditions: 'no', repo: null}, 'a failed line\'s why is its own plain string: not this');
  });
});
