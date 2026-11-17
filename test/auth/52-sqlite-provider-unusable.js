'use strict';
// #364: SqliteAuthProvider with an auth database it can't use. Before, an
// open failure (or a schema statement's) was an 'error' event on the
// database with no listener: with no uncaughtException handler the process
// died; with framework.js's (it logs and goes on) every auth call then
// waited forever. Now the open and the schema are one `ready`, every method
// waits on it, and an unusable database answers each call
// SYSTEM_ERROR_USERDB_NA (fail closed), soon; a late database error marks the
// provider failed and is logged, never thrown.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// sqlite3's native binding does not load everywhere (test/auth/03's header):
// probed in a child, as there
const loads = spawnSync(process.execPath, ['-e', 'require("sqlite3")'], {encoding: 'utf8', cwd: ROOT}).status === 0;

(loads ? describe : describe.skip)('auth 52: SqliteAuthProvider with a database it can\'t use (#364)', function() {
  this.timeout(30000);
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-auth52-')); });
  afterEach(() => {
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* gone */ }
    fs.rmSync(dir, {recursive: true, force: true});
  });

  // A child with NO uncaughtException handler: a provider on `dbPath`, then
  // each method once. It prints what each answered, within 5 s, and exits 0
  // only if it is still alive then.
  const probe = (dbPath) => {
    const script = `
      require(${JSON.stringify(path.join(ROOT, 'lib/logger'))}).createLogger();
      const P = require(${JSON.stringify(path.join(ROOT, 'lib/auth/sqlite-provider'))});
      const p = new P({dbPath: ${JSON.stringify(dbPath)}});
      const out = {};
      const said = (name) => (err, r) => { out[name] = err != null ? {code: err.code || null, message: String(err.message)} : {result: r}; };
      p.authenticate('some-key', 'some-device', null, null, said('authenticate'));
      p.authenticate('some-key', null, null, null, said('authenticateNoDevice'));
      p.listDevices('some-key', said('listDevices'));
      p.entries(said('entries'));
      p.identityForModule('some-module', said('identityForModule'));
      const t0 = Date.now();
      const done = () => {
        if (Object.keys(out).length === 5 || Date.now() - t0 > 5000) { console.log(JSON.stringify({out, ms: Date.now() - t0})); process.exit(0); }
        setTimeout(done, 20);
      };
      done();
    `;
    const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', cwd: ROOT, timeout: 20000});
    let parsed = null;
    try { parsed = JSON.parse(r.stdout.trim().split('\n').pop()); } catch (e) { /* none */ }
    return {status: r.status, signal: r.signal, stderr: r.stderr, parsed};
  };
  const allRefused = (got) => {
    assert.strictEqual(got.status, 0, `the process died: ${got.signal || got.status}\n${got.stderr.slice(-1500)}`);
    assert.ok(got.parsed != null, got.stderr.slice(-1500));
    assert.deepStrictEqual(Object.keys(got.parsed.out).sort(), ['authenticate', 'authenticateNoDevice', 'entries', 'identityForModule', 'listDevices'],
      `every call answered: ${JSON.stringify(got.parsed)}`);
    for (const [name, a] of Object.entries(got.parsed.out)) {
      assert.strictEqual(a.code, 'SYSTEM_ERROR_USERDB_NA', `${name}: ${JSON.stringify(a)}`);
      assert.ok(!a.message.includes(dir), `${name}: no path in the error: ${a.message}`);
    }
    assert.ok(got.parsed.ms < 5000, `within the bound: ${got.parsed.ms} ms`);
  };

  it('a database that can\'t be opened: the process lives, and every call answers SYSTEM_ERROR_USERDB_NA', () => {
    allRefused(probe(path.join(dir, 'no-such-dir', 'auth.sqlite3')));
  });

  it('a schema that can\'t be made (a read-only, empty database): every call answers SYSTEM_ERROR_USERDB_NA', function() {
    if (typeof(process.getuid) === 'function' && process.getuid() === 0) this.skip();   // root writes a read-only file
    const file = path.join(dir, 'auth.sqlite3');
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o444);
    allRefused(probe(file));
  });

  it('a usable database answers as before (the wait costs a usable one nothing)', async () => {
    require('../../lib/logger').createLogger();
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const file = path.join(dir, 'auth.sqlite3');
    const p = new SqliteAuthProvider({dbPath: file});
    const call = (fn) => new Promise((resolve) => fn((err, r) => resolve({err, r})));
    await p.ready;
    await call((cb) => p.db.run('INSERT INTO users (apiKey, userName) VALUES (?, ?)', ['k', 'u'], cb));
    const got = await call((cb) => p.authenticate('k', null, null, null, cb));
    assert.ifError(got.err);
    assert.strictEqual(got.r.ok, true);
    assert.strictEqual((await call((cb) => p.authenticate('nobody', null, null, null, cb))).r.err.code, 'SYSTEM_ERROR_UNKNOWN_USER');
    await new Promise((r) => p.db.close(r));
  });

  it('an already-migrated database mounted read-only (0444) still serves: the schema\'s no-ops need no write', async function() {
    if (typeof(process.getuid) === 'function' && process.getuid() === 0) this.skip();   // root writes a read-only file
    require('../../lib/logger').createLogger();
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const file = path.join(dir, 'auth.sqlite3');
    const call = (fn) => new Promise((resolve) => fn((err, r) => resolve({err, r})));
    // migrated by a first provider, with a user granted a device and a module bound
    const first = new SqliteAuthProvider({dbPath: file});
    await first.ready;
    await call((cb) => first.db.run('INSERT INTO users (apiKey, userName, admin) VALUES (?, ?, 1)', ['k', 'u'], cb));
    await call((cb) => first.db.run('INSERT INTO user_devices (apiKey, deviceID) VALUES (?, ?)', ['k', 'dev'], cb));
    await call((cb) => first.db.run('INSERT INTO module_identities (moduleName, apiKey) VALUES (?, ?)', ['m', 'k'], cb));
    await new Promise((r) => first.db.close(r));
    fs.chmodSync(file, 0o444);
    const p = new SqliteAuthProvider({dbPath: file});
    await p.ready;
    assert.strictEqual(p.failed, null);
    const got = await call((cb) => p.authenticate('k', 'dev', null, null, cb));
    assert.ifError(got.err);
    assert.deepStrictEqual([got.r.ok, got.r.isAdmin], [true, true]);
    assert.deepStrictEqual((await call((cb) => p.listDevices('k', cb))).r.devices, ['dev']);
    assert.strictEqual((await call((cb) => p.identityForModule('m', cb))).r.apiKey, 'k');
    assert.strictEqual((await call((cb) => p.entries(cb))).r.length, 1);
    await new Promise((r) => p.db.close(r));
  });

  it('a database error after it was ready marks the provider failed and is logged, never thrown', async () => {
    require('../../lib/logger').createLogger();
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const p = new SqliteAuthProvider({dbPath: path.join(dir, 'auth.sqlite3')});
    await p.ready;
    p.db.emit('error', Object.assign(new Error('SQLITE_IOERR: disk I/O error'), {code: 'SQLITE_IOERR'}));
    const got = await new Promise((resolve) => p.authenticate('k', null, null, null, (err, r) => resolve({err, r})));
    assert.strictEqual(got.err && got.err.code, 'SYSTEM_ERROR_USERDB_NA');
    await new Promise((r) => p.db.close(r));
  });
});
