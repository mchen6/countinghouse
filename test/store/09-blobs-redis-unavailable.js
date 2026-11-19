// The blob store under --store redis with Redis down or hung (the back-sweep,
// 11-18: #16's rule, calls answer with Redis down). tools/call waits on a
// stored result's write while it shapes the result, and resources/read on its
// read. With node_redis' defaults a command waited in memory for the whole
// outage, and after an hour the client closed for good. Now the client is
// lib/redis-resilient.js's (lib/store.js), and each write and read has a
// deadline: past it, or on a connection error, RESULT_STORE_UNAVAILABLE.
// Server-free: a port nothing listens on (down), and a server that accepts
// and never answers (hung).
const assert = require('assert');
const net = require('net');
const blobsRedis = require('../../lib/store/blobs-redis');
const redisResilient = require('../../lib/redis-resilient');

const LIMITS = {retentionMs: 60000, storeBytes: 1 << 20, quotaBytes: 1 << 20, quotaItems: 10, itemBytes: 1 << 20};
const DEADLINE = 300;
const OWNER = `u_${'A'.repeat(22)}`;
const item = () => ({owner: OWNER, session: null, mimeType: 'image/png', bytes: Buffer.from('png'), source: {module: 'm', tool: 't', field: '/img'}});
const unavailable = (e) => e != null && e.code === 'RESULT_STORE_UNAVAILABLE';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

describe('store 09: the redis blob store answers with Redis down or hung', function() {
  this.timeout(30000);
  const opened = [];
  after(async () => { for (const b of opened) await Promise.race([b.close(), new Promise((r) => setTimeout(r, 200))]).catch(() => {}); });
  const store = (port) => {
    const client = redisResilient.createClient(`redis://127.0.0.1:${port}`, {db: 13, detect_buffers: true}, 50);
    client.on('error', () => {});
    const b = blobsRedis.create({client, limits: LIMITS, deadlineMs: DEADLINE});
    opened.push(b);
    return b;
  };

  it('Redis down: a put and a get fail RESULT_STORE_UNAVAILABLE within the deadline', async () => {
    const b = store(await freePort());
    await new Promise((r) => setTimeout(r, 100));   // past the client's first-connect window
    for (const op of [() => b.put(item()), () => b.get('a'.repeat(43), {owner: OWNER})]) {
      const t0 = Date.now();
      await assert.rejects(op(), unavailable);
      assert.ok(Date.now() - t0 < DEADLINE + 500, `answered in ${Date.now() - t0} ms`);
    }
  });

  it('Redis hung (connected, never answering): a put fails RESULT_STORE_UNAVAILABLE at the deadline', async () => {
    const sockets = [];
    const hung = net.createServer((s) => { sockets.push(s); s.on('error', () => {}); });
    await new Promise((r) => hung.listen(0, '127.0.0.1', r));
    try {
      const b = store(hung.address().port);
      const t0 = Date.now();
      await assert.rejects(b.put(item()), unavailable);
      assert.ok(Date.now() - t0 < DEADLINE + 1500, `answered in ${Date.now() - t0} ms`);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise((r) => hung.close(r));
    }
  });

  it('lib/store.js makes the kv, device-log and blob clients resilient', () => {
    const src = require('fs').readFileSync(require.resolve('../../lib/store'), 'utf8');
    for (const part of ['kv', 'deviceLog', 'blobs']) {
      const body = src.slice(src.indexOf(`    ${part}: () => {`), src.indexOf('\n    },', src.indexOf(`    ${part}: () => {`)));
      assert.ok(/require\('\.\/redis-resilient'\)\.createClient\(/.test(body), `${part}: ${body.slice(0, 160)}`);
      assert.ok(!/require\('redis'\)\.createClient\(/.test(body), `${part} makes a plain client`);
    }
  });

  // the medium on the blob-store PR, 2, 3 and 4, with a client this test
  // drives: what a lost reply may have left, and a remove made while Redis
  // is down, are removed once the client is ready again; an error Redis
  // answers (a script error) is never taken for an outage
  function fakeClient() {
    const c = new (require('events').EventEmitter)();
    c.down = false;
    c.ran = [];
    c.next = null;   // the next eval's own answer: (cb) => ...
    c.eval = (...args) => {
      const cb = args.pop();
      const isRemove = /drop\(ARGV\[1\], ARGV\[2\]\)/.test(String(args[0]));
      if (c.down) return setImmediate(cb, Object.assign(new Error('closed'), {code: 'NR_CLOSED'}));
      if (c.next != null && !isRemove) { const f = c.next; c.next = null; return f(cb); }
      c.ran.push(isRemove ? `remove ${args[3]}` : 'put');
      return setImmediate(cb, null, isRemove ? 1 : 'ok');
    };
    c.get = (k, cb) => setImmediate(cb, null, null);
    c.quit = (cb) => cb && cb();
    return c;
  }
  const local = (client) => {
    const b = blobsRedis.create({client, limits: LIMITS, deadlineMs: DEADLINE});
    opened.push(b);
    return b;
  };

  it('a put whose reply was lost (the connection reset after Redis ran it) is removed once the client is ready again', async () => {
    const c = fakeClient();
    const b = local(c);
    c.next = (cb) => { c.ran.push('put'); c.down = true; setImmediate(cb, Object.assign(new Error('reset'), {code: 'ECONNRESET'})); };
    await assert.rejects(b.put(item()), (e) => unavailable(e) && e.cause != null && e.cause.code === 'ECONNRESET');
    assert.deepStrictEqual(c.ran, ['put'], 'nothing reaches a Redis that is down');
    c.down = false;
    c.emit('ready');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(c.ran.length, 2, JSON.stringify(c.ran));
    assert.match(c.ran[1], /^remove [A-Za-z0-9_-]{43}$/);
  });

  it('a remove made while Redis is down runs once the client is ready again', async () => {
    const c = fakeClient();
    const b = local(c);
    c.down = true;
    const id = 'b'.repeat(43);
    await assert.rejects(b.remove(id), unavailable);
    c.down = false;
    c.emit('ready');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(c.ran, [`remove ${id}`]);
  });

  it('an error Redis answers (a script error) goes on as it is, never RESULT_STORE_UNAVAILABLE', async () => {
    const c = fakeClient();
    const b = local(c);
    c.next = (cb) => setImmediate(cb, Object.assign(new Error('ERR user_script:1: boom'), {name: 'ReplyError', code: 'ERR'}));
    await assert.rejects(b.put(item()), (e) => e.code === 'ERR' && /boom/.test(e.message));
  });
});
