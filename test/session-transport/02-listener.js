'use strict';
// C1: the runtime's session listener and registry (design section 1, the
// wire contract; the session interface agreed with B for B1), in process,
// on a Unix socket in a private temporary directory. The test's shim
// (helpers/shim.js) speaks contract 2. Timeouts are shortened by options.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const handshake = require('../../lib/session-transport/handshake');
const frames = require('../../lib/session-transport/frames');
const {createRegistry} = require('../../lib/session-transport/registry');
const {createListener} = require('../../lib/session-transport/listener');
const shim = require('./helpers/shim');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};

describe('session-transport 02: the listener and the registry', function() {
  this.timeout(20000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let dir;
  let sock;
  let secret;
  let registry;
  let listener;
  let dispatched;
  let opened;

  async function start(extra = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-st-'));
    sock = path.join(dir, 's');
    secret = handshake.newSecret();
    registry = createRegistry(Object.assign({reconnectWindowMs: 300}, extra.registry || {}));
    opened = [];
    registry.on('session', (s) => opened.push(s));
    dispatched = [];
    listener = createListener(Object.assign({
      path: sock, secret, registry, runtimeVersion: '8.0.0-test', maxToRuntime: 1 << 20, maxToShim: 1 << 20,
      tokenMac: null,
      onMessage: (s, message, reply) => {
        dispatched.push({s, message});
        if (message.id !== undefined && message.method === 'echo') reply({jsonrpc: '2.0', id: message.id, result: {echo: message.params}});
      }
    }, extra.listener || {}));
    await listener.listen();
  }
  afterEach(async() => {
    if (listener != null) await listener.close();
    listener = null;
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });

  describe('the handshake', () => {
    it('proves the secret, welcomes, and opens one session with an opaque id', async() => {
      await start();
      const a = await shim.session(sock, secret);
      assert.strictEqual(a.proveOk, true, 'PROVE checks against the secret');
      assert.match(a.welcome.session, /^[0-9a-f]{32}$/);
      assert.strictEqual(a.welcome.runtimeVersion, '8.0.0-test');
      assert.strictEqual(a.welcome.maxToRuntime, 1 << 20);
      assert.strictEqual(typeof(a.welcome.resumeToken), 'string');
      assert.deepStrictEqual(a.settled, {op: 'settled'});
      assert.strictEqual(opened.length, 1);
      assert.strictEqual(opened[0].id, a.welcome.session);
      assert.strictEqual(opened[0].connected, true);
      assert.deepStrictEqual(opened[0].client, {status: 'ok', conditions: 'yes', repo: null});
      a.c.end();
    });

    it('refuses a wrong proof with BAD_PROOF, and opens nothing', async() => {
      await start();
      const a = await shim.attach(sock, secret, {wrongSecret: handshake.newSecret()});
      assert.strictEqual(a.refused.code, 'BAD_PROOF');
      assert.ok(await until(() => a.c.closed()));
      assert.strictEqual(opened.length, 0);
    });

    it('refuses another protocol, naming the supported ones', async() => {
      await start();
      const a = await shim.attach(sock, secret, {protocol: 2});
      assert.strictEqual(a.refused.code, 'PROTOCOL');
      assert.deepStrictEqual(a.refused.supported, [1]);
    });

    it('closes a connection that sends more than 512 bytes before a complete HELLO', async() => {
      await start();
      const c = await shim.connect(sock);
      c.raw(Buffer.concat([Buffer.from([0x48, 0, 0, 0x01, 0xfb]), Buffer.alloc(300, 0x20)]));
      await tick(50);
      assert.strictEqual(c.closed(), false, 'under the bound: still open');
      c.raw(Buffer.alloc(300, 0x20));
      assert.ok(await until(() => c.closed()));
    });

    it('closes on an M or C frame before WELCOME, and on an M before settled', async() => {
      await start();
      const c = await shim.connect(sock);
      shim.message(c, {seq: 1}, '{"jsonrpc":"2.0","id":1,"method":"echo"}');
      assert.ok(await until(() => c.closed()));
      const a = await shim.attach(sock, secret);
      shim.message(a.c, {seq: 1}, '{"jsonrpc":"2.0","id":1,"method":"echo"}');
      assert.ok(await until(() => a.c.closed()));
      assert.strictEqual(dispatched.length, 0);
    });

    // (F1-6, ruled: a full pre-auth pool evicts its oldest connection that
    // has sent no bytes, else refuses the new one -- one in its handshake is
    // never evicted; each still has its deadline)
    it('a full pool evicts its oldest silent connection; one in its handshake is kept, and welcomed', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 20000}});
      // the first, in its handshake: HELLO sent, PROVE back
      const first = await shim.connect(sock);
      const nc = handshake.newChallenge();
      first.send('H', {protocol: 1, nc: nc.toString('base64')});
      const prove = await first.json('P');
      assert.ok(prove != null, 'PROVE');
      const conns = [];
      for (let i = 0; i < 63; i++) conns.push(await shim.connect(sock));
      const newest = await shim.connect(sock);
      assert.ok(await until(() => conns[0].closed(), 2000), 'the oldest silent one is evicted');
      // (taken: its HELLO answered)
      newest.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      assert.ok(await newest.json('P') != null, 'the new one is taken');
      // the one in its handshake completes it
      const ns = Buffer.from(prove.ns, 'base64');
      first.send('A', {mc: handshake.clientMac(secret, 1, ns, nc).toString('base64')});
      const w = await first.next(null);
      assert.strictEqual(w != null ? w.kind : null, 'W', 'welcomed');
      // its slot is free: a new one is taken -- its HELLO answered
      const later = await shim.connect(sock);
      later.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      assert.ok(await later.json('P') != null, 'taken once there is room');
      for (const c of conns.concat([first, later, newest])) c.end();
    });

    it('a full pool whose every connection has sent bytes refuses the new one, keeping them all', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 20000}});
      const conns = [];
      for (let i = 0; i < 64; i++) {
        // (bytes the server has read: its HELLO answered with PROVE)
        const c = await shim.connect(sock);
        c.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
        assert.ok(await c.json('P') != null, `PROVE ${i}`);
        conns.push(c);
      }
      const newest = await shim.connect(sock);
      assert.ok(await until(() => newest.closed(), 2000), 'the new one is refused');
      assert.ok(conns.every((c) => !c.closed()), 'every one that sent bytes is kept');
      for (const c of conns) c.end();
    });

    // (63 whose bytes were read, then one refused -- an unknown protocol, its
    // REFUSED read by a half-open client that never ends its side, so its
    // socket stays in the server's 1 s grace -- the server's own sockets
    // kept, to stub the refused one's)
    const refusedAt64 = async(stubPending) => {
      // (the refused connection's server socket, taken as it is accepted;
      // and whether it is still open the moment the 65th is accepted)
      const at = {capture: false, serverSide: null, count: 0, aliveAt65: null};
      listener.server.prependListener('connection', (s) => {
        at.count += 1;
        if (at.capture) { at.serverSide = s; at.capture = false; }
        if (at.count === 65 && at.serverSide != null) at.aliveAt65 = !at.serverSide.destroyed;
      });
      const conns = [];
      for (let i = 0; i < 63; i++) {
        const c = await shim.connect(sock);
        c.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
        assert.ok(await c.json('P') != null, `PROVE ${i}`);
        conns.push(c);
      }
      at.capture = true;
      const refused = net.createConnection({path: sock, allowHalfOpen: true});
      let gotRefused = false;
      refused.on('error', () => {});
      refused.on('data', () => { gotRefused = true; });
      await new Promise((r) => refused.once('connect', r));
      refused.write(frames.encode('H', JSON.stringify({protocol: 99, nc: handshake.newChallenge().toString('base64')})));
      assert.ok(await until(() => gotRefused, 2000), 'REFUSED');
      const serverSide = at.serverSide;
      assert.ok(serverSide != null, 'its server socket');
      // (its REFUSED not yet written out, as a peer that reads nothing leaves it)
      if (stubPending) Object.defineProperty(serverSide, 'writableLength', {get: () => 1, configurable: true});
      return {conns, refused, serverSide, at};
    };
    it('a full pool evicts one it has already refused before one whose bytes it read', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 20000}});
      const {conns, refused, at} = await refusedAt64(false);
      const newest = await shim.connect(sock);
      // (the refused one was still in its grace as the 65th was accepted)
      assert.ok(await until(() => at.aliveAt65 != null, 2000) && at.aliveAt65 === true, 'the refused one still held at the 65th');
      newest.send('H', {protocol: 1, nc: handshake.newChallenge().toString('base64')});
      // (taken only by evicting the refused one: every other was read; a
      // half-open client sees no close of its own, so that is the proof)
      assert.ok(await newest.json('P') != null, 'the new one is taken, the refused one evicted');
      assert.ok(conns.every((c) => !c.closed()), 'every one whose bytes were read is kept');
      for (const c of conns.concat([newest])) c.end();
      refused.destroy();
    });

    it('one refused whose REFUSED is not yet written out is not evicted: the new one is refused', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 20000}});
      const {conns, refused, serverSide, at} = await refusedAt64(true);
      const newest = await shim.connect(sock);
      assert.ok(await until(() => at.aliveAt65 != null, 2000) && at.aliveAt65 === true, 'the refused one still held at the 65th');
      assert.ok(await until(() => newest.closed(), 2000), 'the new one is refused');
      assert.strictEqual(serverSide.destroyed, false, 'the refused one keeps its grace to write');
      assert.ok(conns.every((c) => !c.closed()), 'every one whose bytes were read is kept');
      for (const c of conns) c.end();
      refused.destroy();
    });

    it('closes one silent past its deadline, and the pool is empty again', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 300}});
      const c = await shim.connect(sock);
      assert.ok(await until(() => c.closed(), 3000), 'silent past the deadline: closed');
      // (no session held, none in pre-auth: the idle stop may drain)
      assert.ok(await until(() => listener.drainIfIdle(), 3000), 'the pool emptied');
    });
  });

  describe('the client frame and settled', () => {
    it('a failed first client frame: own-runtime (conditions-failed), and no session is opened', async() => {
      await start();
      const a = await shim.session(sock, secret, {status: 'failed', why: 'timed out'});
      assert.deepStrictEqual(a.settled, {op: 'own-runtime', reason: 'conditions-failed'});
      assert.ok(await until(() => a.c.closed()));
      assert.strictEqual(opened.length, 0);
    });

    it('a token unlike the runtime\'s: own-runtime (token); the same one, or none, settles', async() => {
      const mine = handshake.tokenMac(Buffer.alloc(32, 1), 'x');
      await start({listener: {tokenMac: (s) => handshake.tokenMac(s, 'the-daemon-token')}});
      const other = await shim.session(sock, secret, {status: 'ok', conditions: 'no', repo: null, token: mine.toString('base64')});
      assert.deepStrictEqual(other.settled, {op: 'own-runtime', reason: 'token'});
      const same = await shim.session(sock, secret, {status: 'ok', conditions: 'no', repo: null, token: handshake.tokenMac(secret, 'the-daemon-token').toString('base64')});
      assert.deepStrictEqual(same.settled, {op: 'settled'});
      const none = await shim.session(sock, secret, {status: 'ok', conditions: 'no', repo: null, token: null});
      assert.deepStrictEqual(none.settled, {op: 'settled'});
      same.c.end();
      none.c.end();
    });

    // a pack credential the client's environment chooses (ch-local's
    // conditions child, by the installed packs' declared names), compared by
    // HMAC-SHA256(secret, "ch-cred" || name || 0x00 || value), never sent
    const DAEMON = {PACK_VAR_ALPHA: 'the-daemon-value-for-a-test'};
    const daemonCreds = (s, name) => (Object.prototype.hasOwnProperty.call(DAEMON, name) ? handshake.credentialMac(s, name, DAEMON[name]) : null);
    const base = {status: 'ok', conditions: 'no', repo: null, token: null};

    it('a pack credential unlike the runtime\'s, or one it has no value for: own-runtime (credential); equal ones, or none, settle', async() => {
      await start({listener: {credentialMac: daemonCreds}});
      const other = await shim.session(sock, secret, {...base, credentials: {PACK_VAR_ALPHA: handshake.credentialMac(secret, 'PACK_VAR_ALPHA', 'another-value').toString('base64')}});
      assert.deepStrictEqual(other.settled, {op: 'own-runtime', reason: 'credential'});
      const unknown = await shim.session(sock, secret, {...base, credentials: {PACK_VAR_BETA: handshake.credentialMac(secret, 'PACK_VAR_BETA', 'v').toString('base64')}});
      assert.deepStrictEqual(unknown.settled, {op: 'own-runtime', reason: 'credential'}, 'the runtime has no value: different');
      const same = await shim.session(sock, secret, {...base, credentials: {PACK_VAR_ALPHA: handshake.credentialMac(secret, 'PACK_VAR_ALPHA', DAEMON.PACK_VAR_ALPHA).toString('base64')}});
      assert.deepStrictEqual(same.settled, {op: 'settled'});
      const empty = await shim.session(sock, secret, {...base, credentials: {}});
      assert.deepStrictEqual(empty.settled, {op: 'settled'});
      const absent = await shim.session(sock, secret, base);
      assert.deepStrictEqual(absent.settled, {op: 'settled'}, 'an older ch-local sends no credentials');
      // one key among several unlike the runtime's is enough
      const mixed = await shim.session(sock, secret, {...base, credentials: {
        PACK_VAR_ALPHA: handshake.credentialMac(secret, 'PACK_VAR_ALPHA', DAEMON.PACK_VAR_ALPHA).toString('base64'),
        PACK_VAR_BETA: handshake.credentialMac(secret, 'PACK_VAR_BETA', 'v').toString('base64')}});
      assert.deepStrictEqual(mixed.settled, {op: 'own-runtime', reason: 'credential'});
      for (const c of [same, empty, absent]) c.c.end();
      assert.strictEqual(opened.length, 3, 'only the settled ones opened a session');
    });

    it('a malformed credentials key: own-runtime (conditions-failed), never shared', async() => {
      await start({listener: {credentialMac: daemonCreds}});
      const mac = handshake.credentialMac(secret, 'PACK_VAR_ALPHA', DAEMON.PACK_VAR_ALPHA).toString('base64');
      const many = {};
      for (let i = 0; i < 33; i++) many[`V${i}`] = mac;
      const cases = [
        null, [], 'PACK_VAR_ALPHA', 7, many,
        {'1BAD': mac}, {'A-B': mac}, {'': mac}, {[`V${'x'.repeat(128)}`]: mac},
        {PACK_VAR_ALPHA: null}, {PACK_VAR_ALPHA: 7}, {PACK_VAR_ALPHA: 'not base64!'},
        {PACK_VAR_ALPHA: Buffer.alloc(31, 1).toString('base64')}, {PACK_VAR_ALPHA: Buffer.alloc(33, 1).toString('base64')},
        {PACK_VAR_ALPHA: mac.replace(/=$/, '')}, {PACK_VAR_ALPHA: Buffer.from(mac, 'base64').toString('base64url')}
      ];
      for (const credentials of cases) {
        const a = await shim.session(sock, secret, {...base, credentials});
        assert.deepStrictEqual(a.settled, {op: 'own-runtime', reason: 'conditions-failed'}, JSON.stringify(credentials).slice(0, 80));
      }
      assert.strictEqual(opened.length, 0);
    });

    it('the vectors\' credentials: the frame with the runtime\'s own value settles, without it is own-runtime (credential); each malformed case is conditions-failed', async() => {
      const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json');
      const frame = JSON.parse(V.control.clientCredentials.json);
      const vsecret = Buffer.from(V.handshake.secretHex, 'hex');
      const theirs = (s, name) => (name === V.credentialMac.name ? handshake.credentialMac(s, name, V.credentialMac.value) : null);
      await start({listener: {credentialMac: theirs}});
      // the frame's hash is of the vectors' secret: made again here with this runtime's
      const own = {...frame, credentials: {[V.credentialMac.name]: handshake.credentialMac(secret, V.credentialMac.name, V.credentialMac.value).toString('base64')}};
      delete own.op;
      assert.strictEqual(handshake.credentialMac(vsecret, V.credentialMac.name, V.credentialMac.value).toString('base64'), frame.credentials[V.credentialMac.name]);
      const same = await shim.session(sock, secret, own);
      assert.deepStrictEqual(same.settled, {op: 'settled'});
      same.c.end();
      await listener.close();
      await start({listener: {credentialMac: () => null}});
      const lacking = await shim.session(sock, secret, own);
      assert.deepStrictEqual(lacking.settled, JSON.parse(V.control.ownRuntimeCredential.json));
      for (const credentials of V.credentialsMalformed.cases) {
        const a = await shim.session(sock, secret, {...own, credentials});
        assert.deepStrictEqual(a.settled, {op: 'own-runtime', reason: 'conditions-failed'}, JSON.stringify(credentials).slice(0, 80));
      }
    });

    it('a repo that is not an owner/name slug is kept as null', async() => {
      await start();
      const a = await shim.session(sock, secret, {status: 'ok', conditions: 'yes', repo: '../etc/passwd', token: null});
      assert.strictEqual(opened[0].client.repo, null);
      a.c.end();
    });
  });

  describe('messages', () => {
    it('dispatches a request that came with a seq, and answers it with that seq, byte-exact', async() => {
      await start();
      const a = await shim.session(sock, secret);
      shim.message(a.c, {seq: 5}, '{"jsonrpc":"2.0","id":"x","method":"echo","params":{"é":"✓"}}');
      const m = await shim.readM(a.c);
      assert.deepStrictEqual(m.header, {seq: 5});
      assert.strictEqual(m.line.toString('utf8'), '{"jsonrpc":"2.0","id":"x","result":{"echo":{"é":"✓"}}}');
      assert.strictEqual(dispatched[0].s, opened[0]);
      a.c.end();
    });

    it('never dispatches an id-carrying line without a seq: -32600 with its id, no header', async() => {
      await start();
      const a = await shim.session(sock, secret);
      shim.message(a.c, null, '{"jsonrpc":"2.0","id":10,"method":"echo"}');
      const m = await shim.readM(a.c);
      assert.strictEqual(m.header, null);
      assert.deepStrictEqual(JSON.parse(m.line), {jsonrpc: '2.0', id: 10, error: {code: -32600, message: 'the line was not framed as a request'}});
      assert.strictEqual(dispatched.length, 0);
      a.c.end();
    });

    it('dispatches a notification, and answers nothing for it', async() => {
      await start();
      const a = await shim.session(sock, secret);
      shim.message(a.c, null, '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}');
      assert.ok(await until(() => dispatched.length === 1));
      assert.strictEqual(await shim.readM(a.c, 200), null);
      a.c.end();
    });

    it('an answer over maxToShim is never written: OUTPUT_TOO_LARGE on its seq instead', async() => {
      await start({listener: {maxToShim: 260}});
      const a = await shim.session(sock, secret);
      shim.message(a.c, {seq: 9}, `{"jsonrpc":"2.0","id":7,"method":"echo","params":"${'x'.repeat(400)}"}`);
      const m = await shim.readM(a.c);
      assert.deepStrictEqual(m.header, {seq: 9});
      assert.strictEqual(m.line.toString('utf8'), require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').tooLargeAnswer.json);
      a.c.end();
    });
  });

  describe('the session interface (B1)', () => {
    it('s.notify sends a headerless M while attached, and drops it while detached', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      s.notify({jsonrpc: '2.0', method: 'notifications/tools/list_changed'});
      const m = await shim.readM(a.c);
      assert.strictEqual(m.header, null);
      assert.strictEqual(m.line.toString('utf8'), '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}');
      const detached = new Promise((r) => s.once('detach', r));
      a.c.end();
      await detached;
      assert.strictEqual(s.connected, false);
      assert.doesNotThrow(() => s.notify({jsonrpc: '2.0', method: 'x'}));
    });

    it('s.askConditions asks conditions? and resolves with the answer; no answer in time is null', async() => {
      await start({registry: {askTimeoutMs: 300}});
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const asked = s.askConditions();
      const q = await a.c.json('C');
      assert.strictEqual(q.op, 'conditions?');
      assert.ok(Number.isSafeInteger(q.seq));
      a.c.send('C', {op: 'client', seq: q.seq, status: 'ok', conditions: 'no', repo: 'acme/widgets', token: null});
      assert.deepStrictEqual(await asked, {status: 'ok', conditions: 'no', repo: 'acme/widgets'});
      assert.deepStrictEqual(s.client, {status: 'ok', conditions: 'no', repo: 'acme/widgets'});
      const late = s.askConditions();
      assert.strictEqual(await late, null, 'no answer within the wait');
      a.c.end();
    });

    // B2 Task 5's latch (N1) must see every frame: s.client is updated in
    // place, so a "no" overwritten by a later frame would otherwise be lost
    it('every client frame after the first is announced: an answer, a late answer to an ask that timed out, an unasked one', async() => {
      await start({registry: {askTimeoutMs: 200}});
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const seen = [];
      s.on('client', (c) => seen.push(c));
      // an answer in time
      const asked = s.askConditions();
      const q1 = await a.c.json('C');
      a.c.send('C', {op: 'client', seq: q1.seq, status: 'ok', conditions: 'yes', repo: null, token: null});
      await asked;
      // an ask that times out, answered late with "no"; then an unasked "yes"
      const late = s.askConditions();
      const q2 = await a.c.json('C');
      assert.strictEqual(await late, null);
      a.c.send('C', {op: 'client', seq: q2.seq, status: 'ok', conditions: 'no', repo: null, token: null});
      a.c.send('C', {op: 'client', status: 'ok', conditions: 'yes', repo: 'acme/widgets', token: null});
      await until(() => seen.length >= 3);
      assert.deepStrictEqual(seen, [{status: 'ok', conditions: 'yes', repo: null}, {status: 'ok', conditions: 'no', repo: null}, {status: 'ok', conditions: 'yes', repo: 'acme/widgets'}]);
      // each is a copy: a listener cannot change the session's own
      seen[2].conditions = 'no';
      assert.strictEqual(s.client.conditions, 'yes');
      a.c.end();
    });

    it('the default wait for conditions? is 12 s, longer than the shim\'s 10 s for the child', () => {
      assert.strictEqual(require('../../lib/session-transport/registry').ASK_TIMEOUT_MS, 12000);
    });

    it('s.record and s.forget send their control frames; a replay is emitted', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      s.record({kind: 'value', name: 'maxOutputBytes', value: 1048576});
      assert.deepStrictEqual(await a.c.json('C'), {op: 'record', entry: {kind: 'value', name: 'maxOutputBytes', value: 1048576}});
      s.forget();
      assert.deepStrictEqual(await a.c.json('C'), {op: 'forget'});
      // (the answer to a replay or a restore: kept or not)
      s.tightenings(false, 'replay');
      assert.deepStrictEqual(await a.c.json('C'), {op: 'tightenings', kept: false, after: 'replay'});
      s.tightenings(true, 'replay');
      assert.deepStrictEqual(await a.c.json('C'), {op: 'tightenings', kept: true, after: 'replay'});
      const got = new Promise((r) => s.once('replay', r));
      a.c.send('C', {op: 'replay', entries: [{kind: 'value', name: 'requestTimeout', value: 1000}]});
      assert.deepStrictEqual(await got, [{kind: 'value', name: 'requestTimeout', value: 1000}]);
      a.c.end();
    });

    it('a resume reattaches the same session once; the token is single-use, and refused while connected', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const live = await shim.attach(sock, secret, {resume: a.welcome.resumeToken});
      assert.strictEqual(live.refused.code, 'RESUME_REFUSED', 'refused while the session is connected');
      const detached = new Promise((r) => s.once('detach', r));
      a.c.end();
      await detached;
      const attached = new Promise((r) => s.once('attach', r));
      const b = await shim.session(sock, secret, undefined, {resume: a.welcome.resumeToken});
      assert.strictEqual(b.welcome.session, s.id);
      await attached;
      assert.notStrictEqual(b.welcome.resumeToken, a.welcome.resumeToken, 'rotated');
      assert.strictEqual(opened.length, 1, 'no new session');
      b.c.end();
      await until(() => !s.connected);
      const again = await shim.attach(sock, secret, {resume: a.welcome.resumeToken});
      assert.strictEqual(again.refused.code, 'RESUME_REFUSED', 'the old token is used up');
    });

    it('a session ends on bye, and on its reconnect window expiring', async() => {
      await start();
      const a = await shim.session(sock, secret);
      const s = opened[0];
      const ended = new Promise((r) => s.once('end', r));
      a.c.send('C', {op: 'bye'});
      await ended;
      const b = await shim.session(sock, secret);
      const t = opened[1];
      const expired = new Promise((r) => t.once('end', r));
      b.c.end();
      await expired;
      assert.strictEqual(registry.get(t.id), null);
    });

    it('an unknown control op is ignored', async() => {
      await start();
      const a = await shim.session(sock, secret);
      a.c.send('C', {op: 'later-op', x: 1});
      shim.message(a.c, {seq: 1}, '{"jsonrpc":"2.0","id":1,"method":"echo"}');
      assert.ok(await shim.readM(a.c) != null, 'still served');
      a.c.end();
    });
  });

  it('a plain net client that never speaks is closed at its deadline', async() => {
    await start({listener: {preAuthDeadlineMs: 200}});
    const c = net.createConnection(sock);
    const closed = new Promise((r) => c.on('close', r));
    c.on('error', () => {});
    await closed;
  });
});
