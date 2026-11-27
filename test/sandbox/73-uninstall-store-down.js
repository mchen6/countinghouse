// An uninstall with its store down removed the
// --moduleRegistry row first, then failed at the purge of the module's keys,
// so the keys and the data directory stayed with no row, and a later module
// of the same name inherited them. The keys are purged first now: a store
// that can't be reached removes nothing. The store is taken down for the
// server only, through a TCP proxy this test owns (as auth 42 does).
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const redis = require('redis');
const {startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort, redisUrlFor, redisConnectionFor} = require('../helpers/test-env');
const {CODES} = require('../../lib/error-catalogue');
const ns = require('../../lib/redis-namespace');

const PORT = testPort(9834);
const PROXY_PORT = testPort(9835);
const KEY = 'k';
const KV_DB = require('../../lib/store').KV_REDIS_DB;
// The proxy forwards to the test's own Redis; the server is given the test's
// URL with only its host and port changed to the proxy's (any userinfo kept)
const REAL_REDIS = (() => { const c = redisConnectionFor(0); return {host: c.host, port: c.port}; })();
const PROXIED_URL = (() => { const u = new URL(redisUrlFor()); u.hostname = '127.0.0.1'; u.port = String(PROXY_PORT); u.pathname = ''; return u.toString(); })();
const NAME = `ghost-mod-${process.pid}`;

function redisProxy() {
  const sockets = new Set();
  let server = null;
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };
  return {
    up: () => new Promise((resolve, reject) => {
      server = net.createServer((client) => {
        const upstream = net.connect(REAL_REDIS);
        track(client); track(upstream);
        client.pipe(upstream); upstream.pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      server.once('error', reject);
      server.listen(PROXY_PORT, '127.0.0.1', resolve);
    }),
    down: () => new Promise((resolve) => {
      sockets.forEach((s) => s.destroy());
      if (server == null) return resolve();
      server.close(() => resolve());
    })
  };
}

describe('sandbox 73: an uninstall whose store is down removes nothing', function() {
  this.timeout(180000);
  const proxy = redisProxy();
  let proxyUp = false;
  let server = null;
  let base = null;
  let direct = null;
  const trees = require('../helpers/test-tmp').forFile(['uninstall-down-']);
  const cmd = (name, ...args) => new Promise((resolve, reject) => direct[name](...args, (e, r) => (e ? reject(e) : resolve(r))));
  const keys = [`${ns.prefixFor(NAME)}a`, `${ns.prefixFor(NAME)}b`];

  before(async () => {
    // (the server's own db: KV_DB, whatever db the test's URL names)
    direct = redis.createClient(redisConnectionFor(KV_DB));
    direct.on('error', () => {});
  });
  after(async () => {
    stopServer(server);
    if (proxyUp) await proxy.down();
    if (direct != null) { await cmd('del', keys).catch(() => {}); direct.quit(); }
  });

  it('the two texts, word for word', () => {
    assert.strictEqual(CODES.MODULE_KEYS_NOT_PURGED.en,
      "The module's stored data could not all be deleted ({code}): its registry entry and data directory are kept, and some of its stored data may already be deleted -- try the uninstall again: it deletes what is left");
    assert.strictEqual(CODES.REMOVE_MODULE_INFO_FAIL.en,
      "Failed to remove the module's registry entry -- its data directory was kept; its stored data was deleted unless the uninstall was asked to keep it; uninstall again to finish; the server log has the reason");
  });

  it('registry mode, the store down: MODULE_KEYS_NOT_PURGED, and the registry row, the data and the keys all as they were', async function() {
    let sqlite3 = null;
    try { sqlite3 = require('sqlite3'); } catch (e) { return this.skip(); }
    base = trees.mkdtemp('uninstall-down-');
    const modulesDir = path.join(base, 'modules');
    const store = path.join(base, 'store');
    fs.mkdirSync(modulesDir);
    fs.mkdirSync(path.join(store, NAME, 'data'), {recursive: true});
    const dbFile = path.join(modulesDir, 'countinghouse-modules.db');
    const db = new sqlite3.Database(dbFile);
    await new Promise((resolve, reject) => db.run('CREATE TABLE IF NOT EXISTS module_info(name TEXT PRIMARY KEY, version TEXT, path TEXT, deviceList TEXT)',
      (e) => (e ? reject(e) : db.run("INSERT INTO module_info(name, version, path, deviceList) VALUES (?, '1.0.0', '/nonexistent', '[]')", [NAME],
        (e2) => (e2 ? reject(e2) : resolve())))));
    await new Promise((resolve) => db.close(resolve));
    for (const k of keys) await cmd('set', k, 'kept');
    await proxy.up();
    proxyUp = true;
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'audit',
      '--redisUrl', PROXIED_URL, '--modulePath', modulesDir, '--moduleDataPath', store, '--moduleRegistry']);
    await proxy.down();
    proxyUp = false;
    const r = await post(PORT, KEY, '/uninstall-module', {name: NAME});
    assert.strictEqual(r.body && r.body.code, 'MODULE_KEYS_NOT_PURGED', JSON.stringify(r.body));
    // (the store's error code named, and nothing else of its error)
    assert.ok(/^The module's stored data could not all be deleted \([A-Z][A-Z0-9_]*\): /.test(r.body.message), r.body.message);
    const rows = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(dbFile);
      d.all('SELECT name FROM module_info WHERE name = ?', [NAME], (e, got) => d.close(() => (e ? reject(e) : resolve(got))));
    });
    assert.strictEqual(rows.length, 1, 'the registry row is still there');
    assert.ok(fs.existsSync(path.join(store, NAME, 'data')), 'the data is still there');
    assert.deepStrictEqual(await Promise.all(keys.map((k) => cmd('get', k))), ['kept', 'kept'], 'the keys are still there');
  });

  trees.hooks();
});
