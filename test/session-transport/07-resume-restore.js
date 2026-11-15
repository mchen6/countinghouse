'use strict';
// Resume across a runtime restart (the review of #255, N3), server free: the
// registry tells ch-local daemon each session's resume hash, plain SHA-256
// of a 256-bit token, before the WELCOME carrying that token can leave, and
// it tells the daemon when the session is gone. A runtime handed the daemon's
// copy resumes a session by its newest token only.
const assert = require('assert');
const crypto = require('crypto');
const {createRegistry} = require('../../lib/session-transport/registry');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

describe('session-transport 07: resume across a runtime restart (#255, N3)', () => {
  it('a resume token is 256 random bits, and its hash is plain SHA-256', () => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m)});
    const s = reg._create();
    const token = reg._issue(s);
    assert.match(token, /^rt_[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(Buffer.from(token.slice(3), 'base64url').length, 32);
    assert.deepStrictEqual(told, [{type: 'session-resume', session: s.id, hash: sha(token)}]);
  });

  it('the new hash is told before the token is returned to be sent', () => {
    const order = [];
    const reg = createRegistry({tell: (m) => order.push(`tell ${m.hash}`)});
    const s = reg._create();
    const token = reg._issue(s);
    order.push(`sent ${sha(token)}`);
    assert.deepStrictEqual(order, [`tell ${sha(token)}`, `sent ${sha(token)}`]);
  });

  it('a rotation, then a restore from the daemon\'s copy, accepts only the new token', () => {
    const daemon = new Map();
    const a = createRegistry({tell: (m) => { if (m.type === 'session-resume') daemon.set(m.session, m.hash); }});
    const s = a._create();
    const first = a._issue(s);
    const second = a._issue(s);   // the resume's rotation
    const b = createRegistry({tell: () => {}});
    b._restore([...daemon].map(([session, resume]) => ({session, resume})));
    assert.strictEqual(b._resume(first), null, 'the rotated-out token resumes nothing');
    const back = b._resume(second);
    assert.ok(back != null);
    assert.strictEqual(back.id, s.id, 'the same session id');
    assert.strictEqual(b._resume(`rt_${'A'.repeat(43)}`), null);
  });

  it('a restored session not resumed within the reconnect window ends, and the daemon is told it is gone', async() => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m), reconnectWindowMs: 50});
    reg._restore([{session: 'b'.repeat(32), resume: sha('rt_x')}]);
    assert.strictEqual(reg._count(), 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(reg._count(), 0);
    assert.deepStrictEqual(told, [{type: 'session-gone', session: 'b'.repeat(32)}]);
    assert.strictEqual(reg._resume('rt_x'), null);
  });

  it('a session that ends is told gone; a restored one resumed is announced at its first settle', () => {
    const told = [];
    const reg = createRegistry({tell: (m) => told.push(m)});
    const s = reg._create();
    reg._issue(s);
    s._end();
    assert.deepStrictEqual(told.map((m) => m.type), ['session-resume', 'session-gone']);
    const r = createRegistry({tell: () => {}});
    r._restore([{session: 'c'.repeat(32), resume: sha('rt_y')}]);
    const back = r._resume('rt_y');
    assert.strictEqual(back._announced === true, false, 'not announced until it settles');
    assert.strictEqual(r.get('c'.repeat(32)), null, 'nor B\'s until then');
  });
});
