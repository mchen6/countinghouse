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

    it('evicts the OLDEST pre-auth connection when the 65th arrives, and closes one silent past its deadline', async() => {
      await start({listener: {preAuthMax: 64, preAuthDeadlineMs: 1500}});
      const conns = [];
      for (let i = 0; i < 64; i++) conns.push(await shim.connect(sock));
      await tick(50);
      const newest = await shim.connect(sock);
      assert.ok(await until(() => conns[0].closed(), 500), 'the oldest is evicted');
      assert.strictEqual(conns[1].closed(), false, 'only the oldest');
      assert.strictEqual(newest.closed(), false, 'the newest is kept');
      assert.ok(await until(() => newest.closed(), 3000), 'silent past the deadline: closed');
      for (const c of conns) c.end();
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
      await start({listener: {maxToShim: 200}});
      const a = await shim.session(sock, secret);
      shim.message(a.c, {seq: 9}, `{"jsonrpc":"2.0","id":7,"method":"echo","params":"${'x'.repeat(400)}"}`);
      const m = await shim.readM(a.c);
      assert.deepStrictEqual(m.header, {seq: 9});
      assert.strictEqual(m.line.toString('utf8'), '{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"the answer is larger than this connection carries","data":{"countinghouse/code":"OUTPUT_TOO_LARGE","retryable":false}}}');
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
