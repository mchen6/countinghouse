'use strict';
// Shared runtime R1, Task 2 (design #236 section 4a): the registry says why a
// session ended, on 'end' and on 'gone'. A session's per-session state is
// removed on any reason but 'closed' (a runtime stopping ends its sessions
// without their leaving), so the reasons must be right:
//   'bye'        the shim left;
//   'window'     the reconnect window expired: detached, or restored and
//                never resumed;
//   'closed'     the registry closed;
//   'unsettled'  a connection that ended, or ran its own runtime, before its
//                session settled.
// The registry's own cases in process; the listener's (bye, unsettled) on a
// Unix socket in a private temporary directory, through the test shim.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handshake = require('../../lib/session-transport/handshake');
const {createRegistry} = require('../../lib/session-transport/registry');
const {createListener} = require('../../lib/session-transport/listener');
const shim = require('./helpers/shim');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await tick(10);
  return test();
};
// every 'end' and 'gone' of `reg`, as [kind, id, reason]
function watch(reg) {
  const seen = [];
  reg.on('gone', (id, reason) => seen.push(['gone', id, reason]));
  reg.on('session', (s) => s.on('end', (reason) => seen.push(['end', s.id, reason])));
  return seen;
}

describe('session-transport 10: why a session ended (R1)', function() {
  this.timeout(20000);

  describe('the registry', () => {
    it('close() ends every session \'closed\'', () => {
      const reg = createRegistry({tell: () => {}});
      const seen = watch(reg);
      const a = reg._create();
      const b = reg._create();
      reg._announce(a);
      reg._announce(b);
      reg.close();
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'end').map((x) => x[2]), ['closed', 'closed']);
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'gone').map((x) => x[2]), ['closed', 'closed']);
      assert.strictEqual(a.endReason, 'closed');
    });

    it('a detached session whose window expires ends \'window\'', async() => {
      const reg = createRegistry({tell: () => {}, reconnectWindowMs: 60});
      const seen = watch(reg);
      const s = reg._create();
      reg._announce(s);
      s._attach({notify() {}, control() {}, close() {}});
      s._detach();
      assert.ok(await until(() => seen.length === 2), JSON.stringify(seen));
      assert.deepStrictEqual(seen.map((x) => x[2]), ['window', 'window']);
    });

    it('a restored session never resumed is forgotten \'window\' (it was never announced: no \'end\' anyone heard)', async() => {
      const reg = createRegistry({tell: () => {}, reconnectWindowMs: 60});
      const seen = watch(reg);
      const id = 'e'.repeat(32);
      reg._restore([{session: id, resume: sha('rt_r1')}]);
      assert.ok(await until(() => seen.length === 1), JSON.stringify(seen));
      assert.deepStrictEqual(seen, [['gone', id, 'window']]);
    });

    it('an unknown reason is taken as \'closed\', the one that removes nothing', () => {
      const reg = createRegistry({tell: () => {}});
      const seen = watch(reg);
      const s = reg._create();
      reg._announce(s);
      s._end();
      s._end('bye');   // a second end changes nothing
      assert.deepStrictEqual(seen.map((x) => x[2]), ['closed', 'closed']);
    });
  });

  describe('the listener', () => {
    if (process.platform === 'win32') return; // the named pipe is C2's
    let dir;
    let sock;
    let secret;
    let registry;
    let listener;
    let seen;
    async function start() {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-st10-'));
      sock = path.join(dir, 's');
      secret = handshake.newSecret();
      registry = createRegistry({reconnectWindowMs: 300});
      seen = watch(registry);
      listener = createListener({path: sock, secret, registry, runtimeVersion: '8.0.0-test', maxToRuntime: 1 << 20, maxToShim: 1 << 20,
        tokenMac: null, onMessage: () => {}});
      await listener.listen();
    }
    afterEach(async() => {
      if (listener != null) await listener.close();
      listener = null;
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    it('a shim\'s bye ends its session \'bye\'', async() => {
      await start();
      const a = await shim.session(sock, secret);
      assert.deepStrictEqual(a.settled, {op: 'settled'});
      a.c.send('C', {op: 'bye'});
      assert.ok(await until(() => seen.some((x) => x[0] === 'end')), JSON.stringify(seen));
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'end').map((x) => x[2]), ['bye']);
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'gone').map((x) => x[2]), ['bye']);
    });

    it('a session that runs its own runtime before it settled is forgotten \'unsettled\'', async() => {
      await start();
      const a = await shim.session(sock, secret, {status: 'failed', why: 'timed out'});
      assert.deepStrictEqual(a.settled, {op: 'own-runtime', reason: 'conditions-failed'});
      assert.ok(await until(() => seen.some((x) => x[0] === 'gone')), JSON.stringify(seen));
      assert.deepStrictEqual(seen.map((x) => x[2]), ['unsettled']);
      a.c.end();
    });

    it('a settled session whose connection drops is detached, then ends \'window\', never \'unsettled\'', async() => {
      await start();
      const a = await shim.session(sock, secret);
      a.c.end();
      assert.ok(await until(() => seen.some((x) => x[0] === 'end'), 3000), JSON.stringify(seen));
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'end').map((x) => x[2]), ['window']);
    });

    it('the listener\'s close (the runtime stopping) ends its sessions \'closed\'', async() => {
      await start();
      await shim.session(sock, secret);
      await listener.close();
      listener = null;
      registry.close();
      assert.ok(await until(() => seen.some((x) => x[0] === 'end')), JSON.stringify(seen));
      assert.deepStrictEqual(seen.filter((x) => x[0] === 'end').map((x) => x[2]), ['closed']);
    });
  });
});
