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
  let lastClient = null;
  const store = (port) => {
    const client = lastClient = redisResilient.createClient(`redis://127.0.0.1:${port}`, {db: 13, detect_buffers: true}, 50); // run-local: not the shared Redis (a port this test opened)
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

  // A Redis that is connected and ready, then answers nothing more: it
  // answers the client's INFO (its ready check), SELECT and PING, so the
  // client is ready and its commands are sent, and the deadline's timer is
  // what fails them (the high review of #443, 3: a server that answered
  // nothing never made the client ready, so NR_CLOSED failed it instead)
  async function hungRedis({infoAfterMs = 0} = {}) {
    const sockets = [];
    const server = net.createServer((s) => {
      sockets.push(s);
      s.on('error', () => {});
      s.on('data', (d) => {
        const text = d.toString('latin1').toLowerCase();
        if (text.includes('\r\ninfo\r\n')) setTimeout(() => s.write('$21\r\nredis_version:7.0.0\r\n\r\n'), infoAfterMs);
        if (text.includes('\r\nselect\r\n')) s.write('+OK\r\n');
        if (text.includes('\r\nping\r\n')) s.write('+PONG\r\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return {port: server.address().port, close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)); }};
  }
  const ready = (client) => new Promise((r) => (client.ready ? r() : client.once('ready', r)));

  it('Redis hung (ready, then never answering): a put fails RESULT_STORE_UNAVAILABLE at the deadline, by its timer', async () => {
    const hung = await hungRedis();
    try {
      const b = store(hung.port);
      await ready(opened.length > 0 ? lastClient : null);
      const t0 = Date.now();
      await assert.rejects(b.put(item()), (e) => unavailable(e) && e.timedOut === true && !Object.keys(e).includes('timedOut'));
      const ms = Date.now() - t0;
      assert.ok(ms >= DEADLINE - 20 && ms < DEADLINE + 1500, `answered in ${ms} ms`);
    } finally {
      await hung.close();
    }
  });

  // the medium on #443's high round, 1: node_redis' own ready check is not
  // the deadline's: a slow INFO still makes the client ready
  it('a resilient client whose ready check answers later than its command deadline still becomes ready', async () => {
    const hung = await hungRedis({infoAfterMs: 500});
    const client = redisResilient.createClient(`redis://127.0.0.1:${hung.port}`, {db: 5}, 50, {commandDeadlineMs: 100}); // run-local: not the shared Redis (a port this test opened)
    client.on('error', () => {});
    try {
      await Promise.race([ready(client), new Promise((resolve, reject) => setTimeout(() => reject(new Error('never ready')), 3000))]);
    } finally {
      client.quit(() => {});
      await hung.close();
    }
  });

  it('a resilient client with a command deadline fails a command Redis never answers (REDIS_COMMAND_TIMEOUT)', async () => {
    const hung = await hungRedis();
    const client = redisResilient.createClient(`redis://127.0.0.1:${hung.port}`, {db: 5}, 50, {commandDeadlineMs: 200}); // run-local: not the shared Redis (a port this test opened)
    client.on('error', () => {});
    try {
      await ready(client);
      const t0 = Date.now();
      const err = await new Promise((resolve) => client.get('k', (e) => resolve(e)));
      assert.strictEqual(err && err.code, 'REDIS_COMMAND_TIMEOUT');
      assert.ok(Date.now() - t0 < 1500);
    } finally {
      client.quit(() => {});
      await hung.close();
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
    c.ready = true;
    c.ran = [];
    c.sent = [];
    c.hangRemoves = false;
    c.next = null;   // the next eval's own answer: (cb) => ...
    c.eval = (...args) => {
      const cb = args.pop();
      const isRemove = /drop\(ARGV\[1\], ARGV\[2\]\)/.test(String(args[0]));
      c.sent.push(isRemove ? 'remove' : 'put');
      if (isRemove && c.hangRemoves) return undefined;
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
    c.next = (cb) => { c.ran.push('put'); c.down = true; c.ready = false; setImmediate(cb, Object.assign(new Error('reset'), {code: 'ECONNRESET'})); };
    await assert.rejects(b.put(item()), (e) => unavailable(e) && e.cause != null && e.cause.code === 'ECONNRESET');
    assert.deepStrictEqual(c.ran, ['put'], 'nothing reaches a Redis that is down');
    c.down = false;
    c.ready = true;
    c.emit('ready');
    await new Promise((r) => setTimeout(r, 1300));   // (a send in flight at 'ready' is retried once it fails)
    assert.strictEqual(c.ran.length, 2, JSON.stringify(c.ran));
    assert.match(c.ran[1], /^remove [A-Za-z0-9_-]{43}$/);
  });

  it('a remove made while Redis is down runs once the client is ready again', async () => {
    const c = fakeClient();
    const b = local(c);
    c.down = true;
    c.ready = false;
    const id = 'b'.repeat(43);
    await assert.rejects(b.remove(id), unavailable);
    c.down = false;
    c.ready = true;
    c.emit('ready');
    await new Promise((r) => setTimeout(r, 1300));
    assert.deepStrictEqual(c.ran, [`remove ${id}`]);
  });

  it('an error Redis answers (a script error) goes on as it is, never RESULT_STORE_UNAVAILABLE', async () => {
    const c = fakeClient();
    const b = local(c);
    c.next = (cb) => setImmediate(cb, Object.assign(new Error('ERR user_script:1: boom'), {name: 'ReplyError', code: 'ERR'}));
    await assert.rejects(b.put(item()), (e) => e.code === 'ERR' && /boom/.test(e.message));
  });

  // the high review of #443, 2: a hung Redis never builds up removes: each
  // waiting id is sent once while one is in flight
  it('a remove that keeps failing on a hung Redis is sent in the background once, not once per failure', async () => {
    const c = fakeClient();
    c.hangRemoves = true;
    const evals = () => c.sent.length;
    const b = local(c);
    const id = 'c'.repeat(43);
    for (let i = 0; i < 3; i++) await assert.rejects(b.remove(id), unavailable);
    // three bounded attempts, and one background remove in flight
    assert.strictEqual(evals(), 4, JSON.stringify(c.sent));
  });
});
