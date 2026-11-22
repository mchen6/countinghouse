'use strict';
// A session's open subscriptions/listen streams on the shared runtime
// (lib/session-transport/session-listens.js), under the review of #249,
// server free: a stream opened for a session that has already gone (it
// detached or ended while the listen's key was being checked) is closed at
// once and never registered; a second listen with the same id is refused; a
// cancel or a detach closes only that session's.
const assert = require('assert');
const EventEmitter = require('events');
const {createSessionListens} = require('../../lib/session-transport/session-listens');

function fakeRegistry() {
  const r = new EventEmitter();
  r.rows = new Map();
  r.get = (id) => r.rows.get(id) || null;
  r.add = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.connected = true;
    s.sent = [];
    s.notify = (m) => s.sent.push(m);
    r.rows.set(id, s);
    r.emit('session', s);
    return s;
  };
  return r;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('session-transport 05: a session\'s listens (#249 review)', () => {
  it('a stream for a session gone during the key check closes at once and is never kept', async() => {
    const registry = fakeRegistry();
    const closed = [];
    const ls = createSessionListens({registry, closeSession: (id) => closed.push(id)});
    const s = registry.add('a');
    s.connected = false;                 // it detached meanwhile
    let fired = 0;
    ls.streamFor(s, {id: 1}).onClose(() => { fired += 1; });
    await tick();
    assert.strictEqual(fired, 1);
    assert.strictEqual(ls.count('a'), 0);
    s.connected = true;
    registry.rows.delete('a');           // or it ended
    ls.streamFor(s, {id: 2}).onClose(() => { fired += 1; });
    await tick();
    assert.strictEqual(fired, 2);
    assert.strictEqual(ls.count('a'), 0);
  });

  it('a second listen with the same id is a duplicate; another id is not', () => {
    const registry = fakeRegistry();
    const ls = createSessionListens({registry, closeSession: () => {}});
    const s = registry.add('a');
    ls.streamFor(s, {id: 7}).onClose(() => {});
    assert.strictEqual(ls.duplicate(s, {id: 7}), true);
    assert.strictEqual(ls.duplicate(s, {id: '7'}), false, '"7" is not 7');
    assert.strictEqual(ls.duplicate(registry.add('b'), {id: 7}), false, 'another session\'s');
  });

  // (the final pass's gateway part, A13) a listen that ends itself (its
  // tasks done, its key revoked) releases its id: one opened again with that
  // id is no duplicate. A release that isn't the stream's own entry any more
  // drops nothing.
  it('a listen that ends itself releases its id, so the id may be opened again', () => {
    const registry = fakeRegistry();
    const ls = createSessionListens({registry, closeSession: () => {}});
    const s = registry.add('a');
    const first = ls.streamFor(s, {id: 7});
    first.onClose(() => {});
    assert.strictEqual(ls.duplicate(s, {id: 7}), true);
    first.release();
    assert.strictEqual(ls.duplicate(s, {id: 7}), false);
    assert.strictEqual(ls.count('a'), 0);
    // reopened: the old stream's release no longer touches the new one
    const second = ls.streamFor(s, {id: 7});
    second.onClose(() => {});
    first.release();
    assert.strictEqual(ls.duplicate(s, {id: 7}), true);
  });

  it('a cancel closes that listen; a detach closes every listen of that session only', () => {
    const registry = fakeRegistry();
    const closed = [];
    const ls = createSessionListens({registry, closeSession: (id) => closed.push(id)});
    const a = registry.add('a');
    const b = registry.add('b');
    const fired = [];
    ls.streamFor(a, {id: 1}).onClose(() => fired.push('a1'));
    ls.streamFor(a, {id: 2}).onClose(() => fired.push('a2'));
    ls.streamFor(b, {id: 1}).onClose(() => fired.push('b1'));
    ls.cancel(a, 1);
    assert.deepStrictEqual(fired, ['a1']);
    a.emit('detach');
    assert.deepStrictEqual(fired, ['a1', 'a2']);
    assert.deepStrictEqual(closed, ['a']);
    assert.strictEqual(ls.count('a'), 0);
    assert.strictEqual(ls.count('b'), 1);
    b.emit('end');
    assert.deepStrictEqual(fired, ['a1', 'a2', 'b1']);
  });

  it('the hub allows 2 listens per session and at least as many in all as the listener has sessions', () => {
    const {MAX_PER_SESSION, MAX_TOTAL} = require('../../lib/mcp/subscriptions');
    const {MAX_SESSIONS} = require('../../lib/session-transport/listener');
    assert.strictEqual(MAX_PER_SESSION, 2);
    assert.ok(MAX_TOTAL >= MAX_SESSIONS, `${MAX_TOTAL} < ${MAX_SESSIONS}`);
  });
});
