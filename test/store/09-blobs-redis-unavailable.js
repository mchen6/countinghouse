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
});
