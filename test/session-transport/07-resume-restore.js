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
// the resume and gone tells only (the idle and busy ones are 08's)
const keep = (push) => (m) => { if (m.type === 'session-resume' || m.type === 'session-gone') push(m); };

describe('session-transport 07: resume across a runtime restart (#255, N3)', () => {
  it('a resume token is 256 random bits, and its hash is plain SHA-256', () => {
    const told = [];
    const reg = createRegistry({tell: keep((m) => told.push(m))});
    const s = reg._create();
    const token = reg._issue(s);
    assert.match(token, /^rt_[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(Buffer.from(token.slice(3), 'base64url').length, 32);
    assert.deepStrictEqual(told, [{type: 'session-resume', session: s.id, hash: sha(token)}]);
  });

  it('the new hash is told before the token is returned to be sent', () => {
    const order = [];
    const reg = createRegistry({tell: keep((m) => order.push(`tell ${m.hash}`))});
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
    const reg = createRegistry({tell: keep((m) => told.push(m)), reconnectWindowMs: 50});
    reg._restore([{session: 'b'.repeat(32), resume: sha('rt_x')}]);
    assert.strictEqual(reg._count(), 1);
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(reg._count(), 0);
    assert.deepStrictEqual(told, [{type: 'session-gone', session: 'b'.repeat(32)}]);
    assert.strictEqual(reg._resume('rt_x'), null);
  });

  it('a session that ends is told gone; a restored one resumed is announced at its first settle', () => {
    const told = [];
    const reg = createRegistry({tell: keep((m) => told.push(m))});
    const s = reg._create();
    reg._issue(s);
    // (its shim left: a 'closed' end, the runtime stopping, tells none: session-transport 10)
    s._end('bye');
    assert.deepStrictEqual(told.map((m) => m.type), ['session-resume', 'session-gone']);
    const r = createRegistry({tell: () => {}});
    r._restore([{session: 'c'.repeat(32), resume: sha('rt_y')}]);
    const back = r._resume('rt_y');
    assert.strictEqual(back._announced === true, false, 'not announced until it settles');
    assert.strictEqual(r.get('c'.repeat(32)), null, 'nor B\'s until then');
  });

  it('a hash is removed only by the session it belongs to (#262 review, L1)', async() => {
    // even if two sessions were ever given one hash, the one that ends never
    // strands the other
    const reg = createRegistry({tell: () => {}, reconnectWindowMs: 50});
    reg._restore([{session: 'e'.repeat(32), resume: sha('rt_shared')}]);
    const other = reg._create();
    other._tokenHash = sha('rt_shared');
    reg._byToken.set(sha('rt_shared'), other);   // the later one owns it now
    await new Promise((r) => setTimeout(r, 120));   // the restored one's window ends
    assert.strictEqual(reg._resume('rt_shared'), other, 'the survivor still resumes by it');
  });

  it('the registry emits gone with the id when any session is forgotten, a restored one never resumed included (#262 review, L2)', async() => {
    const reg = createRegistry({tell: () => {}, reconnectWindowMs: 50});
    const gone = [];
    reg.on('gone', (id) => gone.push(id));
    reg._restore([{session: 'f'.repeat(32), resume: sha('rt_never')}]);
    const s = reg._create();
    s._end();
    await new Promise((r) => setTimeout(r, 120));
    assert.deepStrictEqual(gone, [s.id, 'f'.repeat(32)]);
  });
});
