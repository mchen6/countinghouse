'use strict';
// C1: the listener under the security review of #245 (bc34f7d2), in
// process. A frame kind is checked against the connection's stage at its
// head, before any payload is buffered. A connection that is refused,
// ended or malformed is closed for good: nothing after it in the same chunk
// is acted on, and nothing a peer sends can throw out of the listener. The
// listener's own bytes are compared to the conformance vectors.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const frames = require('../../lib/session-transport/frames');
const handshake = require('../../lib/session-transport/handshake');
const {createRegistry} = require('../../lib/session-transport/registry');
const {createListener} = require('../../lib/session-transport/listener');
const shim = require('./helpers/shim');
const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};
const C = (obj) => frames.encode('C', JSON.stringify(obj));
const M = (header, line) => frames.encode('M', frames.encodeM(header, Buffer.from(line, 'utf8')));
const head = (kind, length) => { const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(length, 1); return h; };

describe('session-transport 03: the listener against hostile peers (#245 review)', function() {
  this.timeout(20000);
  if (process.platform === 'win32') return;
  let dir;
  let sock;
  let secret;
  let registry;
  let listener;
  let dispatched;
  let opened;
  let crashes;
  const onCrash = (e) => crashes.push(e);

  async function start(extra = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-st3-'));
    sock = path.join(dir, 's');
    secret = handshake.newSecret();
    registry = createRegistry(Object.assign({reconnectWindowMs: 300, askTimeoutMs: 300}, extra.registry || {}));
    opened = [];
    registry.on('session', (s) => opened.push(s));
    dispatched = [];
    listener = createListener(Object.assign({
      path: sock, secret, registry, runtimeVersion: '8.0.0-test', maxToRuntime: 8 * 1024 * 1024, maxToShim: 1 << 20,
      tokenMac: (s) => handshake.tokenMac(s, 'the-daemon-token'),
      onMessage: (s, message, reply) => {
        dispatched.push({s, message});
        if (message.id !== undefined) reply({jsonrpc: '2.0', id: message.id, result: {ok: true, params: message.params}});
      }
    }, extra.listener || {}));
    await listener.listen();
  }
  beforeEach(() => { crashes = []; process.on('uncaughtException', onCrash); });
  afterEach(async() => {
    process.removeListener('uncaughtException', onCrash);
    if (listener != null) await listener.close();
    listener = null;
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    assert.deepStrictEqual(crashes.map(String), [], 'nothing a peer sent threw out of the listener');
  });

  describe('a frame kind the stage does not allow is refused at its head', () => {
    it('an M head of 8 MiB after HELLO closes at once, buffering nothing', async() => {
      await start({listener: {preAuthDeadlineMs: 10000}});
      const c = await shim.connect(sock);
      c.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      assert.ok(await c.next('P') != null);
      c.raw(head('M', 8 * 1024 * 1024));
      assert.ok(await until(() => c.closed(), 500), 'closed from the head, long before the deadline');
    });

    it('a C before WELCOME, an A before HELLO, and an H after HELLO each close', async() => {
      await start();
      const a = await shim.connect(sock);
      a.raw(C({op: 'client', status: 'ok'}));
      assert.ok(await until(() => a.closed(), 500));
      const b = await shim.connect(sock);
      b.send('A', {mc: Buffer.alloc(32).toString('base64')});
      assert.ok(await until(() => b.closed(), 500));
      const d = await shim.connect(sock);
      d.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      await d.next('P');
      d.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      assert.ok(await until(() => d.closed(), 500));
    });

    it('a malformed M sent through the listener closes it', async() => {
      await start();
      const a = await shim.session(sock, secret);
      a.c.raw(Buffer.from(V.messages.malformed.headerLongerThanPayload, 'hex'));
      assert.ok(await until(() => a.c.closed(), 500));
    });
  });

  describe('nothing after a terminal frame in the same chunk is acted on', () => {
    it('a failed client frame, then an ok one: own-runtime, no session, no crash', async() => {
      await start();
      const a = await shim.attach(sock, secret);
      a.c.raw(Buffer.concat([C({op: 'client', status: 'failed', why: 'x'}), C({op: 'client', status: 'ok', conditions: 'yes', repo: null, token: null})]));
      assert.deepStrictEqual(await a.c.json('C'), {op: 'own-runtime', reason: 'conditions-failed'});
      assert.ok(await until(() => a.c.closed()));
      assert.strictEqual(opened.length, 0);
    });

    it('bye, then an M: the M is not dispatched', async() => {
      await start();
      const a = await shim.session(sock, secret);
      a.c.raw(Buffer.concat([C({op: 'bye'}), M({seq: 1}, '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')]));
      assert.ok(await until(() => a.c.closed()));
      await tick(50);
      assert.strictEqual(dispatched.length, 0);
    });

    it('a malformed M, then a valid one: neither is dispatched', async() => {
      await start();
      const a = await shim.session(sock, secret);
      a.c.raw(Buffer.concat([Buffer.from(V.messages.malformed.seqNotAnInteger, 'hex'), M({seq: 2}, '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')]));
      assert.ok(await until(() => a.c.closed()));
      await tick(50);
      assert.strictEqual(dispatched.length, 0);
    });

    it('BAD_PROOF, then a good AUTH in the same chunk: no session is created', async() => {
      await start();
      const c = await shim.connect(sock);
      const nc = handshake.newChallenge();
      c.send('H', {protocol: 1, nc: nc.toString('base64')});
      const prove = await c.json('P');
      const ns = Buffer.from(prove.ns, 'base64');
      const bad = {mc: handshake.clientMac(handshake.newSecret(), 1, ns, nc).toString('base64')};
      const good = {mc: handshake.clientMac(secret, 1, ns, nc).toString('base64')};
      c.raw(Buffer.concat([frames.encode('A', JSON.stringify(bad)), frames.encode('A', JSON.stringify(good))]));
      assert.strictEqual((await c.json('R')).code, 'BAD_PROOF');
      assert.strictEqual(await c.next('W', 300), null, 'no WELCOME');
      assert.ok(await until(() => c.closed()));
      assert.strictEqual(registry.all().length, 0);
    });

    it('a control payload that is not UTF-8 closes the connection', async() => {
      await start();
      const a = await shim.attach(sock, secret);
      a.c.raw(frames.encode('C', Buffer.from([0x7b, 0x22, 0x6f, 0x70, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])));
      assert.ok(await until(() => a.c.closed()));
      assert.strictEqual(opened.length, 0);
    });
  });

  describe('sessions', () => {
    it('a resumed, announced session that gets own-runtime is detached, and its window ends it', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const detached = new Promise((r) => s.once('detach', r));
      a.c.end();
      await detached;
      const b = await shim.attach(sock, secret, {resume: a.welcome.resumeToken});
      assert.strictEqual(b.welcome.session, s.id);
      b.c.send('C', {op: 'client', status: 'ok', conditions: 'yes', repo: null, token: handshake.tokenMac(secret, 'another-token').toString('base64')});
      assert.deepStrictEqual(await b.c.json('C'), {op: 'own-runtime', reason: 'token'});
      assert.ok(await until(() => s.connected === false));
      const ended = new Promise((r) => s.once('end', r));
      await ended;
    });

    it('an unsettled session is not in get() or all(), and notify, record and askConditions do nothing to it', async() => {
      await start();
      const a = await shim.attach(sock, secret);
      assert.strictEqual(registry.get(a.welcome.session), null);
      assert.deepStrictEqual(registry.all(), []);
      // reach the unsettled session through the registry's own table, as
      // the listener holds it, and use B's surface on it
      const s = registry._byId.get(a.welcome.session);
      s.notify({jsonrpc: '2.0', method: 'notifications/message'});
      s.record({kind: 'value'});
      s.forget();
      const asked = s.askConditions();
      assert.strictEqual(await a.c.next(null, 200), null, 'nothing written to an unsettled connection');
      a.c.send('C', {op: 'client', status: 'ok', conditions: 'yes', repo: null, token: null});
      assert.deepStrictEqual(await a.c.json('C'), {op: 'settled'});
      assert.strictEqual(await asked, null);
      assert.strictEqual(registry.get(a.welcome.session), opened[0]);
      a.c.end();
    });

    it('a welcomed connection that never sends client is closed at the deadline, freeing its slot', async() => {
      await start({listener: {welcomedDeadlineMs: 300, maxSessions: 1}});
      const a = await shim.attach(sock, secret);
      assert.ok(a.welcome != null);
      assert.ok(await until(() => a.c.closed(), 2000), 'closed at the deadline');
      const b = await shim.session(sock, secret);
      assert.deepStrictEqual(b.settled, {op: 'settled'}, 'the slot is free again');
      b.c.end();
    });

    it('a resumed session dropping before it settles emits detach once', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const detaches = [];
      s.on('detach', () => detaches.push(1));
      a.c.end();
      await until(() => detaches.length === 1);
      const b = await shim.attach(sock, secret, {resume: a.welcome.resumeToken});
      assert.strictEqual(b.welcome.session, s.id);
      b.c.end();
      await tick(150);
      assert.strictEqual(detaches.length, 1, 'no second detach without an attach between');
    });

    it('a replay is taken once per connection, and one of more than 64 entries closes', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const seen = [];
      s.on('replay', (e) => seen.push(e));
      a.c.send('C', {op: 'replay', entries: [{n: 1}]});
      a.c.send('C', {op: 'replay', entries: [{n: 2}]});
      await tick(100);
      assert.deepStrictEqual(seen, [[{n: 1}]]);
      const b = await shim.session(sock, secret);
      b.c.send('C', {op: 'replay', entries: Array.from({length: 65}, (_, i) => ({n: i}))});
      assert.ok(await until(() => b.c.closed()));
      a.c.end();
    });

    // (a shim that, on a new session holding records, sends replay before
    // its first client frame: the welcomed connection is closed, never
    // settled; the session it opened ends with it, so the next attach's
    // resume is refused and it opens a new session again)
    it('a welcomed connection whose first frame is a replay, then its client frame, is closed unsettled; its session ends, its resume refused', async() => {
      await start();
      const a = await shim.attach(sock, secret);
      assert.ok(a.welcome != null, 'welcomed');
      a.c.send('C', {op: 'replay', entries: [{kind: 'value', name: 'maxOutputBytes', value: 1048576}]});
      a.c.send('C', {op: 'client', status: 'ok', conditions: 'yes', repo: null, token: null});
      // (closed with nothing sent: no settled, no own-runtime)
      assert.strictEqual(await a.c.next(null, 2000), null, 'no frame before the close');
      assert.ok(a.c.closed(), 'closed');
      assert.strictEqual(opened.length, 0, 'never announced: no session, no replay applied');
      assert.strictEqual(registry._byId.has(a.welcome.session), false, 'the session ended with its connection');
      const b = await shim.attach(sock, secret, {resume: a.welcome.resumeToken});
      assert.strictEqual(b.refused != null && b.refused.code, 'RESUME_REFUSED', JSON.stringify(b.refused));
      b.c.end();
      // (the same frames with client first settle, and the replay is heard)
      const c = await shim.session(sock, secret);
      assert.strictEqual(c.settled.op, 'settled');
      const seen = [];
      opened[0].on('replay', (e) => seen.push(e));
      c.c.send('C', {op: 'replay', entries: [{kind: 'value', name: 'maxOutputBytes', value: 1048576}]});
      assert.ok(await until(() => seen.length === 1));
      c.c.end();
    });

    it('past the session limit, a handshake is refused BUSY, as the vector has it', async() => {
      await start({listener: {maxSessions: 1}});
      const a = await shim.session(sock, secret);
      const b = await shim.connect(sock);
      const nc = handshake.newChallenge();
      b.send('H', {protocol: 1, nc: nc.toString('base64')});
      const prove = await b.json('P');
      b.send('A', {mc: handshake.clientMac(secret, 1, Buffer.from(prove.ns, 'base64'), nc).toString('base64')});
      const r = await b.next('R');
      assert.strictEqual(Buffer.concat([Buffer.from('R'), Buffer.alloc(4)]).length, 5);
      assert.strictEqual(frames.encode('R', r.payload).toString('hex'), V.handshake.refusedCodes.BUSY.hex);
      a.c.end();
    });

    it('drain: live sessions are sent drain, and a new handshake is refused SHUTTING_DOWN', async() => {
      await start();
      const a = await shim.session(sock, secret);
      listener.drain();
      assert.deepStrictEqual(await a.c.json('C'), {op: 'drain'});
      const b = await shim.attach(sock, secret);
      assert.strictEqual(JSON.stringify(b.refused), V.handshake.refusedCodes.SHUTTING_DOWN.json);
      a.c.end();
    });

    it('a peer that never reads is closed once its unwritten bytes pass the bound', async() => {
      await start({listener: {maxWriteBuffer: 64 * 1024}});
      const a = await shim.session(sock, secret);
      a.c.sock.pause();
      const s = opened[0];
      for (let i = 0; i < 4000 && s.connected; i++) s.notify({jsonrpc: '2.0', method: 'notifications/message', params: {data: 'x'.repeat(1000)}});
      assert.ok(await until(() => s.connected === false), 'closed past the bound');
    });
  });

  describe('the listener\'s bytes are the vectors\'', () => {
    it('REFUSED BAD_PROOF, PROTOCOL and RESUME_REFUSED', async() => {
      await start();
      const raw = async(opts) => {
        const a = await shim.attach(sock, secret, opts);
        return a.refused;
      };
      assert.strictEqual(JSON.stringify(await raw({wrongSecret: handshake.newSecret()})), V.handshake.refusedCodes.BAD_PROOF.json);
      assert.strictEqual(JSON.stringify(await raw({protocol: 2})), V.handshake.refusedCodes.PROTOCOL.json);
      assert.strictEqual(JSON.stringify(await raw({resume: 'rt_unknown'})), V.handshake.refusedCodes.RESUME_REFUSED.json);
    });

    it('settled, own-runtime, drain, record, forget and conditions? as their vectors', async() => {
      await start();
      const a = await shim.session(sock, secret);
      assert.strictEqual(JSON.stringify(a.settled), V.control.settled.json);
      const s = opened[0];
      s.record({kind: 'value', name: 'maxOutputBytes', value: 1048576});
      assert.strictEqual(JSON.stringify(await a.c.json('C')), V.control.record.json);
      s.forget();
      assert.strictEqual(JSON.stringify(await a.c.json('C')), V.control.forget.json);
      s.askConditions();
      const q = await a.c.json('C');
      assert.deepStrictEqual(Object.keys(q), Object.keys(JSON.parse(V.control.conditionsAsk.json)));
      listener.drain();
      assert.strictEqual(JSON.stringify(await a.c.json('C')), V.control.drain.json);
      const t = await shim.session(sock, secret, {status: 'ok', conditions: 'no', repo: null, token: handshake.tokenMac(secret, 'other').toString('base64')});
      assert.strictEqual(t.refused != null ? 'refused' : JSON.stringify(t.settled), 'refused', 'drained: refused');
      a.c.end();
    });

    it('own-runtime (token) and (conditions-failed) as their vectors', async() => {
      await start();
      const t = await shim.session(sock, secret, {status: 'ok', conditions: 'no', repo: null, token: handshake.tokenMac(secret, 'other').toString('base64')});
      assert.strictEqual(JSON.stringify(t.settled), V.control.ownRuntimeToken.json);
      const f = await shim.session(sock, secret, {status: 'failed', why: 'x'});
      assert.strictEqual(JSON.stringify(f.settled), V.control.ownRuntimeConditions.json);
    });

    it('the too-large answer is the vector\'s, and with an id too big to carry it names id null', async() => {
      await start({listener: {maxToShim: 400}});
      const a = await shim.session(sock, secret);
      shim.message(a.c, {seq: 9}, `{"jsonrpc":"2.0","id":7,"method":"x","params":"${'x'.repeat(500)}"}`);
      const m = await shim.readM(a.c);
      assert.strictEqual(m.line.toString('utf8'), V.tooLargeAnswer.json);
      shim.message(a.c, {seq: 10}, `{"jsonrpc":"2.0","id":"${'i'.repeat(500)}","method":"x"}`);
      const big = await shim.readM(a.c);
      assert.deepStrictEqual(big.header, {seq: 10});
      assert.strictEqual(JSON.parse(big.line).id, null);
      a.c.end();
    });
  });

  it('a refused connection stays in the pre-auth count until it is gone, so a flood is held to the pool', async() => {
    await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 10000}});
    const net = require('net');
    const conns = [];
    for (let i = 0; i < 80; i++) {
      const c = net.createConnection({path: sock, allowHalfOpen: true});
      let closed = false;
      c.on('close', () => { closed = true; });
      c.on('error', () => {});
      c.on('data', () => {});
      await new Promise((r) => c.once('connect', r));
      c.write(frames.encode('H', JSON.stringify({protocol: 2, nc: handshake.newChallenge().toString('base64')})));
      conns.push({c, closed: () => closed});
    }
    // the server holds at most 64, counted server side, well within the 1 s
    // grace a connection refused its HELLO by shut() would otherwise keep its
    // socket for (unbounded, all 80 would be held now): each one past the
    // pool evicted one already refused (F1-6), or was refused itself (which
    // of the two, timing decides: 02 pins each)
    await tick(300);
    const held = await new Promise((r) => listener.server.getConnections((e, n) => r(n)));
    assert.ok(held <= 64, `${held} held`);
    for (const x of conns) x.c.destroy();
  });

  it('a maxToRuntime that is not a non-negative integer is refused when the listener is made', () => {
    assert.throws(() => createListener({path: '/nonexistent/s', secret: Buffer.alloc(32), registry: createRegistry(), maxToRuntime: NaN, maxToShim: 1 << 20, onMessage: () => {}}), /maxToRuntime/);
  });

  it('a cap that is not a non-negative integer is refused when the decoder is made', () => {
    assert.throws(() => frames.createDecoder({caps: {M: NaN}, onFrame: () => {}, onError: () => {}}), /cap/);
    assert.throws(() => frames.createDecoder({caps: {M: -1}, onFrame: () => {}, onError: () => {}}), /cap/);
  });
});
