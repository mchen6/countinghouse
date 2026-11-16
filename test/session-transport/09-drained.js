'use strict';
// A drain that completes (the review of ch-local #35): after drain(), each
// live connection is closed by the runtime once its in-flight requests are
// answered, and once no live connection is left the listener calls
// onDrained, once, so ch-local daemon's upgrade waits no longer than the
// calls. Sockets, no server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handshake = require('../../lib/session-transport/handshake');
const {createRegistry} = require('../../lib/session-transport/registry');
const {createListener} = require('../../lib/session-transport/listener');
const shim = require('./helpers/shim');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('session-transport 09: a drain completes, and says so (#35 review)', function() {
  this.timeout(20000);
  if (process.platform === 'win32') return;
  let dir;
  let listener;
  let held;     // the 'slow' requests' replies, to answer when the test says
  let drained;
  let sock;
  let secret;
  beforeEach(async() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dr-'));
    sock = path.join(dir, 's');
    secret = handshake.newSecret();
    held = [];
    drained = 0;
    listener = createListener({
      path: sock, secret, registry: createRegistry({reconnectWindowMs: 5000}), runtimeVersion: '8.0.0-test', maxToRuntime: 1 << 20, maxToShim: 1 << 20, tokenMac: null,
      onDrained: () => { drained += 1; },
      onMessage: (s, message, reply) => {
        if (message.method === 'slow') held.push(() => reply({jsonrpc: '2.0', id: message.id, result: {}}));
        else if (message.id !== undefined) reply({jsonrpc: '2.0', id: message.id, result: {}});
      }
    });
    await listener.listen();
  });
  afterEach(async() => {
    await listener.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const closed = (c) => new Promise((r) => { if (c.sock.destroyed) r(); else c.sock.once('close', r); });

  it('with nothing in flight, every connection is closed at once and onDrained is called once', async() => {
    const a = await shim.session(sock, secret);
    const b = await shim.session(sock, secret);
    listener.drain();
    await Promise.all([closed(a.c), closed(b.c)]);
    await tick(50);
    assert.strictEqual(drained, 1);
  });

  it('a connection with a request in flight stays until it is answered; then it closes, and onDrained follows', async() => {
    const a = await shim.session(sock, secret);
    shim.message(a.c, {seq: 1}, JSON.stringify({jsonrpc: '2.0', id: 1, method: 'slow'}));
    await tick(100);
    listener.drain();
    assert.deepStrictEqual(await a.c.json('C', 2000), {op: 'drain'});
    await tick(150);
    assert.strictEqual(a.c.sock.destroyed, false, 'still open while its call runs');
    assert.strictEqual(drained, 0);
    held.shift()();
    const answer = await shim.readM(a.c, 2000);
    assert.strictEqual(answer.header.seq, 1, 'its answer is relayed first');
    await closed(a.c);
    await tick(50);
    assert.strictEqual(drained, 1);
  });

  it('with no live connection, a drain is drained at once', async() => {
    listener.drain();
    await tick(50);
    assert.strictEqual(drained, 1);
    listener.drain();
    await tick(50);
    assert.strictEqual(drained, 1, 'once per runtime');
  });
});
