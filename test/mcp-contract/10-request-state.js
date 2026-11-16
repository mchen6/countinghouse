'use strict';
// MCP completeness M12 (docs/superpowers/specs/2026-11-15-mcp-completeness-design.md,
// section 8), server-free: requestState, which a client carries from an
// input_required answer to its retry (2026-07-28's MRTR). It is the
// client's to send, so the attacker's to write: `v1.<payload>.<mac>`, the
// payload a nonce, an expiry, the pending question's key, the round and
// the earlier rounds' answers; the MAC binds it to the caller, the
// session, the method, the tool and the call's arguments. Single use is
// the server's: a nonce is remembered until its state expires. A state that
// fails any check is refused, with nothing that tells which.
const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const rs = require('../../lib/request-state');

const LIB = path.join(__dirname, '..', '..', 'lib');

const MIN = 60 * 1000;

describe('mcp-contract 10: requestState, the shared helper (MCP completeness M12)', () => {
  const key = crypto.randomBytes(32);
  const now = 1800000000000;
  const QUESTION = 'c'.repeat(64);
  const binding = (over = {}) => Object.assign({caller: 'u_AbCdEfGhIjKlMnOpQrStUv', session: '', method: 'tools/call', tool: 'ch_pack_service_act',
    arguments: {name: 'report.txt', n: 1, deep: {b: [1, 2], a: null}}}, over);
  const content = (over = {}) => Object.assign({question: QUESTION, round: 1, answers: {}}, over);
  const payloadOf = (state) => JSON.parse(Buffer.from(state.split('.')[1], 'base64url').toString('utf8'));
  // a state under the right key whose payload is anything: what only the
  // key's holder could make (a later version, or a bug), still checked
  const forged = (payload, b = binding()) => {
    const p = Buffer.from(typeof(payload) === 'string' ? payload : JSON.stringify(payload), 'utf8').toString('base64url');
    return `v1.${p}.${rs.macOf(key, [rs.LABEL, p, b.caller, b.session, b.method, b.tool, rs.argumentsHash(b.arguments)])}`;
  };
  const refused = (state, b = binding(), at = now) => {
    const v = rs.verify(key, state, b, {now: at});
    assert.strictEqual(v.ok, false, JSON.stringify(v));
    // one answer, whatever failed: nothing of the state comes back
    assert.deepStrictEqual(Object.keys(v).sort(), ['ok', 'why']);
    return v;
  };

  describe('a state', () => {
    it('is v1.<payload>.<mac>: a 16-byte nonce, an expiry 5 minutes out, the question, the round, the earlier answers', () => {
      const state = rs.mint(key, content({round: 2, answers: {[QUESTION]: {approve: true}}}), binding(), {now});
      assert.match(state, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      const p = payloadOf(state);
      assert.deepStrictEqual(Object.keys(p).sort(), ['a', 'e', 'n', 'q', 'r']);
      assert.match(p.n, /^[A-Za-z0-9_-]{22}$/);
      assert.strictEqual(Buffer.from(p.n, 'base64url').length, 16);
      assert.strictEqual(p.e, now + 5 * MIN);
      assert.strictEqual(rs.TTL_MS, 5 * MIN);
      assert.deepStrictEqual([p.q, p.r, p.a], [QUESTION, 2, {[QUESTION]: {approve: true}}]);
      // nothing of the caller, the session or the arguments is in it
      assert.ok(!Buffer.from(state.split('.')[1], 'base64url').toString('utf8').includes('report.txt'));
      assert.notStrictEqual(rs.mint(key, content(), binding(), {now}), rs.mint(key, content(), binding(), {now}), 'a fresh nonce each time');
    });

    it('verifies for the request it was made for, and gives back what it carries', () => {
      const state = rs.mint(key, content({round: 3, answers: {x: {n: 1}}}), binding(), {now});
      const v = rs.verify(key, state, binding(), {now: now + 4 * MIN});
      assert.deepStrictEqual(v, {ok: true, nonce: payloadOf(state).n, expiresAt: now + 5 * MIN, question: QUESTION, round: 3, answers: {x: {n: 1}}});
    });

    it('the arguments are bound by their canonical form: key order does not matter, any value does', () => {
      const state = rs.mint(key, content(), binding(), {now});
      assert.strictEqual(rs.verify(key, state, binding({arguments: {deep: {a: null, b: [1, 2]}, n: 1, name: 'report.txt'}}), {now}).ok, true);
      for (const args of [{name: 'report.txt', n: 2, deep: {b: [1, 2], a: null}}, {name: 'report.txt', n: 1, deep: {b: [2, 1], a: null}},
        {name: 'report.txt', n: 1}, {name: 'report.txt', n: 1, deep: {b: [1, 2], a: null}, extra: 1}, {}, null, undefined]) {
        refused(state, binding({arguments: args}));
      }
      assert.match(rs.argumentsHash({b: 1, a: 2}), /^[0-9a-f]{64}$/);
      assert.strictEqual(rs.argumentsHash({b: 1, a: 2}), rs.argumentsHash({a: 2, b: 1}));
      // no arguments and empty arguments are one call
      assert.strictEqual(rs.argumentsHash(undefined), rs.argumentsHash({}));
      assert.strictEqual(rs.argumentsHash(null), rs.argumentsHash({}));
    });

    it('is good only for its caller, its session, its method and its tool', () => {
      const state = rs.mint(key, content(), binding({session: 'a'.repeat(32)}), {now});
      assert.strictEqual(rs.verify(key, state, binding({session: 'a'.repeat(32)}), {now}).ok, true);
      for (const over of [{caller: 'u_AbCdEfGhIjKlMnOpQrStUw'}, {session: 'b'.repeat(32)}, {session: ''}, {method: 'prompts/get'}, {tool: 'ch_pack_service_other'}]) {
        refused(state, binding(Object.assign({session: 'a'.repeat(32)}, over)));
      }
      // fields cannot be shifted into one another (the MAC is over a JSON array)
      const shifted = rs.mint(key, content(), binding({caller: 'u_a', session: 'bc'}), {now});
      refused(shifted, binding({caller: 'u_ab', session: 'c'}));
    });

    it('is good only under its key', () => {
      const state = rs.mint(key, content(), binding(), {now});
      assert.strictEqual(rs.verify(crypto.randomBytes(32), state, binding(), {now}).ok, false);
    });

    it('expires: good until its expiry, refused from it on', () => {
      const state = rs.mint(key, content(), binding(), {now});
      assert.strictEqual(rs.verify(key, state, binding(), {now: now + 5 * MIN - 1}).ok, true);
      refused(state, binding(), now + 5 * MIN);
      refused(state, binding(), now + 60 * MIN);
    });

    it('anything changed in it is refused, and so is anything that is not one', () => {
      const state = rs.mint(key, content(), binding(), {now});
      const [v, p, m] = state.split('.');
      const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
      const other = Buffer.from(JSON.stringify(Object.assign(payloadOf(state), {r: 2})), 'utf8').toString('base64url');
      for (const bad of [`v2.${p}.${m}`, `${p}.${m}`, `${v}.${p}`, `${v}.${p}.${m}.x`, `${v}.${flip(p, 5)}.${m}`, `${v}.${p}.${flip(m, 7)}`, `${v}.${other}.${m}`,
        `${v}.${p}.${m.slice(0, 42)}`, `${v}.${p}.${m}=`, ` ${state}`, `${state}\n`, `${v}.${p}+.${m}`, '', 'v1..', null, undefined, 7, {}, [state]]) {
        refused(bad);
      }
      // base64url's last character carries padding bits: another spelling of the same MAC bytes is not the MAC
      const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const same = last[(last.indexOf(m[42]) ^ 1)];
      assert.ok(Buffer.from(m.slice(0, 42) + same, 'base64url').equals(Buffer.from(m, 'base64url')), 'the same 32 bytes');
      refused(`${v}.${p}.${m.slice(0, 42)}${same}`);
    });

    it('a state over 16 KiB is refused before any work, and none is made', () => {
      const big = `v1.${'A'.repeat(17 * 1024)}.${'A'.repeat(43)}`;
      refused(big);
      assert.strictEqual(rs.MAX_STATE_BYTES, 16 * 1024);
      // the earlier answers are at most 8 KiB
      assert.throws(() => rs.mint(key, content({answers: {x: {text: 'y'.repeat(8 * 1024)}}}), binding(), {now}), /answers/);
      assert.ok(rs.mint(key, content({answers: {x: {text: 'y'.repeat(7 * 1024)}}}), binding(), {now}).length <= 16 * 1024);
    });

    it('what it is made from is checked: the question, the round, the answers, the binding', () => {
      for (const bad of [{question: ''}, {question: 'x'.repeat(129)}, {question: 7}, {round: 0}, {round: 1.5}, {round: 17}, {round: '1'}, {answers: null}, {answers: []}, {answers: 'x'}]) {
        assert.throws(() => rs.mint(key, content(bad), binding(), {now}), /request-state/, JSON.stringify(bad));
      }
      for (const bad of [{caller: ''}, {caller: null}, {session: null}, {method: ''}, {tool: 7}]) {
        assert.throws(() => rs.mint(key, content(), binding(bad), {now}), /request-state/, JSON.stringify(bad));
        // and a retry with such a binding verifies nothing
        refused(rs.mint(key, content(), binding(), {now}), binding(bad));
      }
      assert.throws(() => rs.mint(Buffer.alloc(8), content(), binding(), {now}), /request-state/, 'a short key');
    });

    it('a payload of any other shape is refused, though its MAC is right', () => {
      const good = {n: 'A'.repeat(22), e: now + MIN, q: QUESTION, r: 1, a: {}};
      assert.strictEqual(rs.verify(key, forged(good), binding(), {now}).ok, true, 'the control');
      for (const bad of [Object.assign({}, good, {x: 1}), (({a, ...rest}) => rest)(good), Object.assign({}, good, {n: 'short'}), Object.assign({}, good, {n: 7}),
        Object.assign({}, good, {e: String(now + MIN)}), Object.assign({}, good, {e: now + MIN + 0.5}), Object.assign({}, good, {e: now + 6 * MIN}),
        Object.assign({}, good, {q: ''}), Object.assign({}, good, {r: 0}), Object.assign({}, good, {r: 17}), Object.assign({}, good, {a: []}), Object.assign({}, good, {a: null}),
        [good], 'not json', '"a string"', 'null']) {
        refused(forged(bad));
      }
    });
  });

  describe('single use, the server\'s', () => {
    it('a verified state is consumed once: its nonce is remembered until it expires', async () => {
      const used = new rs.UsedNonces();
      const v = rs.verify(key, rs.mint(key, content(), binding(), {now}), binding(), {now});
      assert.strictEqual(await rs.consume(used, v), true);
      assert.strictEqual(await rs.consume(used, v), false, 'a replay');
      assert.strictEqual(await rs.consume(used, v), false);
      // another state of the same request is its own
      const w = rs.verify(key, rs.mint(key, content(), binding(), {now}), binding(), {now});
      assert.strictEqual(await rs.consume(used, w), true);
    });

    it('nothing but a verified state is consumed', async () => {
      const used = new rs.UsedNonces();
      for (const bad of [null, undefined, {ok: false, why: 'x'}, {ok: true}, {ok: true, nonce: 'short', expiresAt: now + MIN}, {ok: true, nonce: 'A'.repeat(22), expiresAt: 'soon'}]) {
        assert.strictEqual(await rs.consume(used, bad), false, JSON.stringify(bad));
      }
      assert.strictEqual(used.size, 0);
    });

    it('the memory of used nonces: each kept until its own expiry, then dropped', () => {
      const used = new rs.UsedNonces();
      assert.strictEqual(used.use('n1', now + MIN, now), true);
      assert.strictEqual(used.use('n2', now + 5 * MIN, now), true);
      assert.strictEqual(used.use('n1', now + MIN, now + 30 * 1000), false);
      assert.strictEqual(used.size, 2);
      // past n1's expiry it is forgotten (its state is refused as expired anyway)
      assert.strictEqual(used.use('n3', now + 6 * MIN, now + 2 * MIN), true);
      assert.strictEqual(used.size, 2, 'n2 and n3');
      assert.strictEqual(used.use('n2', now + 5 * MIN, now + 2 * MIN), false);
      // a nonce already past its expiry is not remembered, and not "first use" either
      assert.strictEqual(used.use('late', now, now + 1), false);
    });

    it('it is bounded, and full it refuses: it never forgets a nonce still good to make room', () => {
      const used = new rs.UsedNonces({max: 3});
      for (const n of ['a', 'b', 'c']) assert.strictEqual(used.use(n, now + MIN, now), true);
      assert.strictEqual(used.use('d', now + MIN, now), false, 'full: refused');
      assert.strictEqual(used.use('a', now + MIN, now), false, 'and a is still remembered');
      // room again once some expire
      assert.strictEqual(used.use('e', now + 3 * MIN, now + MIN), true);
      assert.strictEqual(used.size, 1);
    });
  });

  // The key is derived from the identity secret, so every process that
  // shares the secret verifies a state, and a restart strands no dialog.
  // Each case is a child process with its own secret: identity keeps one
  // per process.
  describe('the key, derived from the identity secret', () => {
    const SECRET = crypto.randomBytes(32).toString('hex');
    const inChild = (body, {secret = SECRET, init = true} = {}) => {
      const script = `
        const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
        const rs = require(${JSON.stringify(path.join(LIB, 'request-state'))});
        const out = (v) => process.stdout.write('OUT ' + JSON.stringify(v) + '\\n');
        const run = () => { try { ${body} } catch (e) { out({threw: e.message}); } };
        ${init ? `identity.init({moduleDataPath: ${JSON.stringify(path.join(os.tmpdir(), 'ch-identity-unused'))}}).then(run, (e) => { process.stderr.write(e.message); process.exit(1); });` : 'run();'}`;
      const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000,
        env: Object.assign({}, process.env, {COUNTINGHOUSE_IDENTITY_SECRET: secret})});
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
      assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
      return JSON.parse(line.slice(4));
    };
    const B = {caller: 'u_AbCdEfGhIjKlMnOpQrStUv', session: '', method: 'tools/call', tool: 't', arguments: {a: 1}};

    it('is HKDF-SHA256 of the secret under a label of its own, 32 bytes: another label, or another secret, another key', () => {
      const got = inChild('out({key: identity.derivedKey("countinghouse-request-state-key/1").toString("hex"), other: identity.derivedKey("some-other-use/1").toString("hex"), mine: rs.key().toString("hex")});');
      const want = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET, 'hex'), Buffer.alloc(0), 'countinghouse-request-state-key/1', 32)).toString('hex');
      assert.strictEqual(got.key, want);
      assert.strictEqual(got.mine, want, 'request-state\'s own');
      assert.match(got.other, /^[0-9a-f]{64}$/);
      assert.notStrictEqual(got.other, want);
      assert.notStrictEqual(got.key, SECRET, 'never the secret itself');
      const elsewhere = inChild('out({key: rs.key().toString("hex")});', {secret: crypto.randomBytes(32).toString('hex')});
      assert.notStrictEqual(elsewhere.key, want);
    });

    it('follows the secret: loaded again as another one (a test, or the --hardened parent\'s check), the key is that one\'s', () => {
      const OTHER = crypto.randomBytes(32).toString('hex');
      const got = inChild(`
        const first = rs.key().toString('hex');
        process.env.COUNTINGHOUSE_IDENTITY_SECRET = ${JSON.stringify(OTHER)};
        identity.initSync({moduleDataPath: ${JSON.stringify(path.join(os.tmpdir(), 'ch-identity-unused'))}});
        out({first, second: rs.key().toString('hex')});`);
      const of = (secret) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), rs.KEY_LABEL, 32)).toString('hex');
      assert.deepStrictEqual(got, {first: of(SECRET), second: of(OTHER)});
    });

    it('a state made by one process verifies in another that shares the secret, and in none that does not', () => {
      const made = inChild(`out({state: rs.mint(rs.key(), {question: 'q', round: 1, answers: {}}, ${JSON.stringify(B)})});`);
      assert.match(made.state, /^v1\./);
      const check = `out(rs.verify(rs.key(), ${JSON.stringify(made.state)}, ${JSON.stringify(B)}));`;
      assert.strictEqual(inChild(check).ok, true, 'after a restart, or on another server of the same deployment');
      assert.strictEqual(inChild(check, {secret: crypto.randomBytes(32).toString('hex')}).ok, false);
    });

    it('there is no key before the secret is loaded, none for a label that is not one, and none in a worker', () => {
      assert.match(inChild('out({key: rs.key().toString("hex")});', {init: false}).threw, /not initialized/);
      for (const label of ['""', 'null', '7', '"x".repeat(200)']) assert.match(inChild(`out({key: identity.derivedKey(${label}).toString("hex")});`).threw, /label/);
      const worker = inChild(`
        const {Worker} = require('worker_threads');
        const w = new Worker(${JSON.stringify(`
          const {parentPort} = require('worker_threads');
          try { require(${JSON.stringify(path.join(LIB, 'identity'))}).derivedKey('countinghouse-request-state-key/1'); parentPort.postMessage('a key'); }
          catch (e) { parentPort.postMessage(e.message); }`)}, {eval: true});
        w.on('message', (m) => { out({said: m}); w.terminate(); });`);
      assert.match(worker.said, /main thread only/);
    });
  });

  describe('the mechanics the settings dialog shares', () => {
    it('macOf is an HMAC-SHA256 over one JSON array, base64url: no two lists of fields give the same bytes', () => {
      const m = rs.macOf(key, ['label', 'a', 'bc']);
      assert.match(m, /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(m, crypto.createHmac('sha256', key).update(JSON.stringify(['label', 'a', 'bc'])).digest('base64url'));
      assert.notStrictEqual(m, rs.macOf(key, ['label', 'ab', 'c']));
      assert.notStrictEqual(m, rs.macOf(key, ['label', 'a', 'bc', '']));
    });

    it('sameMac compares the canonical strings, in constant time: equal only when the same characters', () => {
      const m = rs.macOf(key, ['x']);
      assert.strictEqual(rs.sameMac(m, m), true);
      assert.strictEqual(rs.sameMac(m, rs.macOf(key, ['y'])), false);
      assert.strictEqual(rs.sameMac(m, m.slice(0, 42)), false);
      assert.strictEqual(rs.sameMac(m, `${m}A`), false);
      for (const bad of [null, undefined, 7, {}, Buffer.from(m)]) assert.strictEqual(rs.sameMac(m, bad), false);
    });

    // The dialog's single use is its server-held staging (a form answered is
    // gone); what it remembers of nonces only makes an answer's text exact:
    // a replay is told "used", a late answer "expired", not "no state of
    // ours". So this memory may forget, oldest first, where UsedNonces never does.
    it('RecentNonces is a short memory: the last ones added, oldest out; it is not what makes anything single use', () => {
      const recent = new rs.RecentNonces(3);
      for (const n of ['a', 'b', 'c']) recent.add(n);
      assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((n) => recent.has(n)), [true, true, true, false]);
      recent.add('d');
      assert.deepStrictEqual(['a', 'b', 'c', 'd'].map((n) => recent.has(n)), [false, true, true, true]);
      assert.strictEqual(recent.size, 3);
      // the same one again takes no second place
      recent.add('d');
      assert.deepStrictEqual(['b', 'c', 'd'].map((n) => recent.has(n)), [true, true, true]);
      assert.strictEqual(new rs.RecentNonces().max, 64);
    });

    it('newNonce is 16 random bytes, base64url', () => {
      const n = rs.newNonce();
      assert.match(n, /^[A-Za-z0-9_-]{22}$/);
      assert.notStrictEqual(n, rs.newNonce());
    });
  });
});
