'use strict';
// ch-local daemon's idle stop (C3, the review of #262), server free: the
// registry tells 'busy' when its first session appears and 'idle' when its
// last is forgotten. A session that is detached within its window, or
// restored and not yet resumed, still counts.
const assert = require('assert');
const crypto = require('crypto');
const {createRegistry} = require('../../lib/session-transport/registry');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const states = (told) => told.filter((m) => m.type === 'idle' || m.type === 'busy').map((m) => m.type);

describe('session-transport 08: idle and busy, for the daemon\'s idle stop (#262 review)', () => {
  it('busy at the first session, idle once the last is forgotten, and nothing in between', () => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m)});
    const a = reg._create();
    const b = reg._create();
    a._end();
    assert.deepStrictEqual(states(told), ['busy']);
    b._end();
    assert.deepStrictEqual(states(told), ['busy', 'idle']);
  });

  it('a detached session still counts until its window expires', async() => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m), reconnectWindowMs: 60});
    const s = reg._create();
    s._attach({notify() {}, control() {}});
    s._detach();
    assert.strictEqual(reg.idle(), false);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(reg.idle(), true);
    assert.deepStrictEqual(states(told), ['busy', 'idle']);
  });

  it('a restored session not yet resumed counts as busy until its window expires', async() => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m), reconnectWindowMs: 60});
    reg._restore([{session: 'd'.repeat(32), resume: sha('rt_z')}]);
    assert.strictEqual(reg.idle(), false);
    assert.deepStrictEqual(states(told), ['busy']);
    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(reg.idle(), true);
    assert.deepStrictEqual(states(told), ['busy', 'idle']);
  });
});
