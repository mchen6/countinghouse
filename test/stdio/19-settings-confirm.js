'use strict';
// lib/settings-confirm.js (part 3 P2, Task 2): a loosening asked for in
// conversation is staged server-side under a random nonce; requestState
// carries the nonce and an HMAC, under this start's own key, of the exact
// staged change and the MCP session that staged it. The retry must match it
// all, be unused and be under 120 s old. One pending change at a time; a
// decline locks that setting for the start.
const assert = require('assert');
const {Confirmations} = require('../../lib/settings-confirm');

describe('stdio 19: staging a confirmation: the nonce, the HMAC, single use (part 3 P2)', () => {
  const MiB = 1024 * 1024;
  let clock = 1000000;
  const now = () => clock;
  const change = {name: 'maxOutputBytes', old: 8 * MiB, next: 16 * MiB, client: {name: 'claude-code', version: '2.0.0'}, session: 's1'};
  const retry = {name: 'maxOutputBytes', next: 16 * MiB, session: 's1'};
  let c;
  beforeEach(() => { clock = 1000000; c = new Confirmations({now}); });

  it('the retry that matches applies once; again, it is used', () => {
    const {requestState, replaced} = c.stage(change);
    assert.strictEqual(replaced, null);
    assert.match(requestState, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const ok = c.verify(requestState, retry);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(Object.assign({}, ok.staged, {at: undefined}), Object.assign({}, change, {at: undefined}));
    assert.deepStrictEqual(c.verify(requestState, retry), {ok: false, code: 'SETTING_CONFIRMATION_USED'});
  });

  it('the same state twice in one tick: exactly one applies', () => {
    const {requestState} = c.stage(change);
    const results = [c.verify(requestState, retry), c.verify(requestState, retry)];
    assert.deepStrictEqual(results.map((r) => r.ok), [true, false]);
  });

  it('a state that is not the one staged, or not for this change, session or start, is invalid', () => {
    const {requestState} = c.stage(change);
    const [nonce, mac] = requestState.split('.');
    const flip = (s) => s.slice(0, -1) + (s.slice(-1) === 'A' ? 'B' : 'A');
    for (const bad of [`${nonce}.${flip(mac)}`, `${flip(nonce)}.${mac}`, requestState.slice(0, -1), '', '.', `${nonce}.`, 'x'.repeat(600), null, 42, {}]) {
      assert.deepStrictEqual(c.verify(bad, retry), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'}, String(bad).slice(0, 40));
    }
    // another value, another setting, another MCP session: the HMAC does not match
    assert.deepStrictEqual(c.verify(requestState, Object.assign({}, retry, {next: 17 * MiB})), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    assert.deepStrictEqual(c.verify(requestState, Object.assign({}, retry, {name: 'requestTimeout'})), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    assert.deepStrictEqual(c.verify(requestState, Object.assign({}, retry, {session: 's2'})), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    // none of those used it up
    assert.strictEqual(c.verify(requestState, retry).ok, true);
  });

  it('one spelling only: a state differing in its padding bits alone is invalid', () => {
    const {requestState} = c.stage(change);
    const [nonce, mac] = requestState.split('.');
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = ABC.indexOf(mac.slice(-1));
    // the same top four bits, other padding bits: the same bytes, another string
    const twin = `${nonce}.${mac.slice(0, -1)}${ABC[(last & ~3) | ((last & 3) ^ 1)]}`;
    assert.deepStrictEqual(Buffer.from(twin.split('.')[1], 'base64url'), Buffer.from(mac, 'base64url'), 'premise: it decodes alike');
    assert.deepStrictEqual(c.verify(twin, retry), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    assert.strictEqual(c.verify(requestState, retry).ok, true);
  });

  it('another start (another key) refuses this start\'s state', () => {
    const {requestState} = c.stage(change);
    const other = new Confirmations({now});
    other.stage(change);
    assert.deepStrictEqual(other.verify(requestState, retry), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
  });

  it('after 120 s it has expired, and is then gone', () => {
    const {requestState} = c.stage(change);
    clock += 120001;
    assert.deepStrictEqual(c.verify(requestState, retry), {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'});
    assert.deepStrictEqual(c.verify(requestState, retry), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    // at exactly 120 s it has not
    const again = c.stage(change);
    clock += 120000;
    assert.strictEqual(c.verify(again.requestState, retry).ok, true);
  });

  it('one pending change: a second staging replaces the first, which is then invalid', () => {
    const first = c.stage(change);
    const second = c.stage(Object.assign({}, change, {next: 32 * MiB}));
    assert.strictEqual(second.replaced.next, 16 * MiB);
    assert.deepStrictEqual(c.verify(first.requestState, retry), {ok: false, code: 'SETTING_CONFIRMATION_INVALID'});
    assert.strictEqual(c.verify(second.requestState, Object.assign({}, retry, {next: 32 * MiB})).ok, true);
  });

  it('a decline locks that setting\'s kind, and only that one, for the start; any pack locks every pack', () => {
    assert.strictEqual(c.declined('maxOutputBytes'), false);
    c.decline('maxOutputBytes');
    assert.strictEqual(c.declined('maxOutputBytes'), true);
    assert.strictEqual(c.declined('requestTimeout'), false);
    c.decline('pack.ci-failure-triage');
    assert.strictEqual(c.declined('pack.other'), true, 'a decline on any pack locks packs');
    assert.strictEqual(new Confirmations({now}).declined('maxOutputBytes'), false, 'a new start forgets it');
  });

  it('two expiries of a kind lock it too', () => {
    for (let i = 0; i < 2; i++) {
      const {requestState} = c.stage(change);
      clock += 120001;
      assert.strictEqual(c.verify(requestState, retry).code, 'SETTING_CONFIRMATION_EXPIRED');
      assert.strictEqual(c.declined('maxOutputBytes'), i === 1, `after ${i + 1}`);
    }
  });

  it('three forms a start: each staging counts one', () => {
    assert.strictEqual(c.formsLeft(), 3);
    c.stage(change);
    c.stage(change);
    assert.strictEqual(c.formsLeft(), 1);
    c.stage(change);
    assert.strictEqual(c.formsLeft(), 0);
    assert.throws(() => c.stage(change), /no forms left/);
  });

  it('the staged change holds the values given, not the objects (a caller changing its own copy later changes nothing)', () => {
    const mine = Object.assign({}, change, {client: {name: 'claude-code', version: '2.0.0'}});
    const {requestState} = c.stage(mine);
    mine.client.name = 'other';
    mine.next = 64 * MiB;
    const ok = c.verify(requestState, retry);
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual([ok.staged.next, ok.staged.client.name], [16 * MiB, 'claude-code']);
  });
});
