// POST /reload-auth (and countinghouse_reload_auth) re-reads the auth config
// without a restart: a grant added to the file applies from the next call.
// A file that fails validation leaves the config that was working in place,
// and the answer names what is wrong by entry position, never by key. The
// answer is counts only: {ok, entries, changed}.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');

const PORT      = 9628;
const URL       = `http://127.0.0.1:${PORT}`;
// Random, so a 6-character piece of a key can't be an ordinary word in a
// message or a path.
const ADMIN     = `k${require('crypto').randomBytes(12).toString('hex')}`;
const ALICE     = `k${require('crypto').randomBytes(12).toString('hex')}`;
const DEVICE_ID = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';   // echo-device-module (see auth/07)
const SERVICE   = 'urn:countinghouse-com:serviceID:echoService';

const invokeAs = (key) => request(URL).post(`/devices/${DEVICE_ID}/invoke-action`).set('X-CH-Key', key)
  .send({serviceID: SERVICE, actionName: 'echo', input: {foo: [{item1: 'x'}], bar: 'y'}});
const reload = (key) => request(URL).post('/reload-auth').set('X-CH-Key', key).send({});
const tool = (key) => request(URL).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_reload_auth', arguments: {}}});
const noKeys = (body) => {
  const text = JSON.stringify(body);
  assert.ok(!text.includes(ADMIN) && !text.includes(ALICE), `a key in the answer: ${text}`);
};
// No 6-character piece of a key either: V8's JSON.parse messages quote the
// input around a syntax error.
const pieces = (key) => Array.from({length: key.length - 5}, (_, i) => key.slice(i, i + 6));
const noKeyPieces = (text, where) => {
  [ADMIN, ALICE].forEach((key) => pieces(key).forEach((p) => {
    assert.ok(!text.includes(p), `${where} contains "${p}", part of a key: ${text.slice(0, 400)}`);
  }));
};

describe('auth 32: reloading the auth config without a restart', function() {
  this.timeout(60000);
  let base = null;
  let authPath = null;
  let server = null;
  const write = (aliceDevices) => fs.writeFileSync(authPath, JSON.stringify({
    [ADMIN]: {userName: 'admin', devices: ['*'], admin: true},
    [ALICE]: {userName: 'alice', devices: aliceDevices}
  }));

  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-reload-auth-'));
    authPath = path.join(base, 'auth.json');
    write([]);
    server = await startServer(PORT, ['--workerThread', '--authoringTools', '--authProvider', 'file', '--authConfigPath', authPath,
      '--loadModule', path.join(ROOT, 'pre-installed-packages', 'echo-device-module')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('a grant added to the file is refused until the reload, and allowed after', async () => {
    assert.strictEqual((await invokeAs(ALICE)).body.code, 'USER_HAS_NO_DEVICE');
    write([DEVICE_ID]);
    assert.strictEqual((await invokeAs(ALICE)).body.code, 'USER_HAS_NO_DEVICE', 'applied without a reload');
    const r = await reload(ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, {ok: true, entries: 2, changed: 1});
    const after = await invokeAs(ALICE);
    assert.strictEqual(after.status, 200, JSON.stringify(after.body));
  });

  it('is admin only', async () => {
    const r = await reload(ALICE);
    assert.notStrictEqual(r.status, 200);
    noKeys(r.body);
  });

  it('a file that is not valid JSON leaves the working config in place', async () => {
    fs.writeFileSync(authPath, '{ not json');
    const r = await reload(ADMIN);
    assert.notStrictEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /not valid JSON/);
    noKeys(r.body);
    assert.strictEqual((await invokeAs(ALICE)).status, 200, 'the old config was dropped');
  });

  it('a syntax error right after a key is located by line and column, with no part of the key anywhere', async () => {
    const mark = server.output.length;
    fs.writeFileSync(authPath, `{\n  "${ADMIN}": {"userName": "admin", "devices": ["*"], "admin": true},\n  "${ALICE}": xyz\n}\n`);
    const r = await reload(ADMIN);
    assert.notStrictEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /not valid JSON at line 3, column \d+/);
    noKeyPieces(JSON.stringify(r.body), 'the answer');
    await new Promise((ok) => setTimeout(ok, 300));
    noKeyPieces(server.output.slice(mark), 'the server log');
    assert.strictEqual((await invokeAs(ALICE)).status, 200);
  });

  it('an entry that is not an object is named by position, not key, and nothing changes', async () => {
    fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}, [ALICE]: 5}));
    const r = await reload(ADMIN);
    assert.notStrictEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /entry #2/);
    noKeys(r.body);
    assert.strictEqual((await invokeAs(ALICE)).status, 200);
  });

  it('a missing file leaves the working config in place', async () => {
    fs.rmSync(authPath);
    const r = await reload(ADMIN);
    assert.notStrictEqual(r.status, 200);
    noKeys(r.body);
    assert.strictEqual((await invokeAs(ALICE)).status, 200);
  });

  it('countinghouse_reload_auth does the same, for an admin key', async () => {
    write([]);
    const r = await tool(ADMIN);
    assert.strictEqual(r.body.result.isError, false, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.result.structuredContent, {ok: true, entries: 2, changed: 1});
    assert.strictEqual((await invokeAs(ALICE)).body.code, 'USER_HAS_NO_DEVICE');
    noKeys(r.body);
  });
});

describe('auth 32: a syntax error at startup is logged without the file\'s contents', () => {
  it('names a line and column, and no part of a key', () => {
    const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-reload-auth-start-'));
    try {
      const file = path.join(base, 'auth.json');
      fs.writeFileSync(file, `{"${ALICE}": xyz}`);
      const lib = path.join(ROOT, 'lib');
      const script = `
        require(${JSON.stringify(path.join(lib, 'cli-options'))}).setOptions({workerThread: false});
        const LOG = require(${JSON.stringify(path.join(lib, 'logger'))});
        LOG.createLogger(false);
        const lines = [];
        LOG.E = (e) => { lines.push(String(e && e.message ? e.message : e)); return e; };
        const P = require(${JSON.stringify(path.join(lib, 'auth', 'file-provider'))});
        new P({configPath: ${JSON.stringify(file)}});
        process.stdout.write('LINES ' + JSON.stringify(lines) + '\\n');
        process.exit(0);`;
      const run = require('child_process').spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
      const out = (run.stdout || '').split('\n').find((l) => l.startsWith('LINES '));
      assert.ok(out != null, `no output: ${run.stdout} ${run.stderr}`);
      const lines = JSON.parse(out.slice('LINES '.length));
      assert.ok(lines.some((l) => /not valid JSON at line 1, column \d+/.test(l)), JSON.stringify(lines));
      noKeyPieces(lines.join('\n'), 'the startup log');
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });
});

describe('auth 32: providers without a file to re-read', () => {
  it('CouchDB: a reload empties its cache', (done) => {
    let CouchDBAuthProvider = null;
    try { CouchDBAuthProvider = require('../../lib/couchdb-adapter/couchdb-auth-provider'); } catch (e) { return done(); }
    const fake = {_cache: new Map([['some-key', {ok: true}]])};
    CouchDBAuthProvider.prototype.reload.call(fake, (err, result) => {
      try {
        assert.ifError(err);
        assert.strictEqual(fake._cache.size, 0);
        assert.strictEqual(result.ok, true);
        return done();
      } catch (e) { return done(e); }
    });
  });

  it('sqlite: reads its database on every call, so a reload is a no-op that says so', (done) => {
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    SqliteAuthProvider.prototype.reload.call({}, (err, result) => {
      try {
        assert.ifError(err);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.changed, 0);
        assert.match(result.note, /reads its database on every call/);
        return done();
      } catch (e) { return done(e); }
    });
  });
});
