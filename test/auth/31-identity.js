// R2-1 Task 1: every user has an opaque id, the same across all modules on
// this server -- "u_" + 22 characters of base64url(HMAC-SHA256(secret,
// source)) -- where the source is the auth entry's optional stable `id`
// field, else its API key, domain-separated. The secret lives in
// <moduleDataPath>/.identity-secret (0600, never followed through a link) or
// COUNTINGHOUSE_IDENTITY_SECRET (the same 64 hex characters). An operator
// maps an id back to a user with POST /identity-lookup or the
// countinghouse_lookup_identity tool, admin only, and never gets the key.
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const {spawn, spawnSync} = require('child_process');
const request = require('supertest');
const {ROOT, startServer, stopServer} = require('../helpers/sandbox-server');
const waitForReady = require('../helpers/wait-for-ready');

const LIB   = path.join(ROOT, 'lib');
const hex   = (n) => crypto.randomBytes(n).toString('hex');
const ADMIN = `k${hex(12)}`;
const ALICE = `k${hex(12)}`;
const BOB   = `k${hex(12)}`;
const CAROL = `k${hex(12)}`;
const ID_SHAPE = /^u_[A-Za-z0-9_-]{22}$/;

// identity.idFor, computed in a child process with the given secret, so a
// secret change is a fresh process and nothing is cached across cases.
function idIn(secret, entry, apiKey) {
  const script = `
    const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
    identity.init({moduleDataPath: ${JSON.stringify(path.join(os.tmpdir(), 'ch-identity-unused'))}}).then(() => {
      process.stdout.write('ID ' + identity.idFor(${JSON.stringify(entry)}, ${JSON.stringify(apiKey)}) + '\\n');
    }, (e) => { process.stderr.write(e.message); process.exit(1); });`;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, {COUNTINGHOUSE_IDENTITY_SECRET: secret})});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('ID '));
  assert.ok(line != null, `no id: ${r.stdout} ${r.stderr}`);
  return line.slice(3);
}

// A server start that is expected to end on its own: its exit code and output.
function startAndWait(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1'].concat(args),
      {cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe']});
    let output = '';
    p.stdout.on('data', (c) => { output += c.toString(); });
    p.stderr.on('data', (c) => { output += c.toString(); });
    const timer = setTimeout(() => { p.kill('SIGKILL'); resolve({code: 'timeout', output}); }, 20000);
    p.on('exit', (code) => { clearTimeout(timer); resolve({code, output}); });
  });
}

const noKeys = (text, where) => [ADMIN, ALICE, BOB, CAROL].forEach((k) => assert.ok(!text.includes(k), `${where} holds a key: ${text.slice(0, 300)}`));

describe('auth 31: the opaque per-user id, its secret, and the operator\'s lookup', function() {
  this.timeout(120000);
  const S1 = hex(32);
  const S2 = hex(32);

  describe('idFor', () => {
    it('(a) is stable for a key, differs between keys, is u_ + 22 characters, and changes with the secret', () => {
      const a1 = idIn(S1, null, ALICE);
      assert.match(a1, ID_SHAPE);
      assert.strictEqual(idIn(S1, null, ALICE), a1);
      assert.notStrictEqual(idIn(S1, null, BOB), a1);
      assert.notStrictEqual(idIn(S2, null, ALICE), a1);
    });

    it('(b) an entry with a stable id keeps it when its key changes; one without does not', () => {
      assert.strictEqual(idIn(S1, {id: 'alice'}, ALICE), idIn(S1, {id: 'alice'}, BOB));
      assert.notStrictEqual(idIn(S1, null, ALICE), idIn(S1, null, BOB));
    });

    it('(c) an id equal to another entry\'s key does not yield that entry\'s id', () => {
      assert.notStrictEqual(idIn(S1, {id: ALICE}, BOB), idIn(S1, null, ALICE));
    });
  });

  describe('with the file provider', () => {
    const PORT = 9646;
    const URL  = `http://127.0.0.1:${PORT}`;
    let base = null;
    let authPath = null;
    let store = null;
    let server = null;
    let secret = null;
    const config = (extra) => Object.assign({
      [ADMIN]: {userName: 'admin', devices: ['*'], admin: true},
      [ALICE]: {userName: 'alice', devices: [], id: 'alice'},
      [BOB]:   {userName: 'bob', devices: []}
    }, extra || {});
    const lookup = (key, id) => request(URL).post('/identity-lookup').set('X-CH-Key', key).send({id});
    const tool = (key, id) => request(URL).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'countinghouse_lookup_identity', arguments: {id}}});

    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-identity-'));
      authPath = path.join(base, 'auth.json');
      store = path.join(base, 'store');
      fs.writeFileSync(authPath, JSON.stringify(config()));
      server = await startServer(PORT, ['--workerThread', '--authoringTools', '--authProvider', 'file', '--authConfigPath', authPath,
        '--moduleDataPath', store]);
      secret = fs.readFileSync(path.join(store, '.identity-secret'), 'utf8').trim();
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('(e) the secret file is created on first start, 64 hex characters, mode 0600', () => {
      assert.match(secret, /^[0-9a-f]{64}$/);
      assert.strictEqual(fs.statSync(path.join(store, '.identity-secret')).mode & 0o777, 0o600);
    });

    it('(f) POST /identity-lookup: an admin gets {id, userName, isAdmin}, a non-admin 403, an unknown id IDENTITY_NOT_FOUND, never a key', async () => {
      const aliceId = idIn(secret, {id: 'alice'}, ALICE);
      const bobId = idIn(secret, null, BOB);
      const r = await lookup(ADMIN, aliceId);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body, {id: aliceId, userName: 'alice', isAdmin: false});
      const rb = await lookup(ADMIN, bobId);
      assert.deepStrictEqual(rb.body, {id: bobId, userName: 'bob', isAdmin: false});
      const ra = await lookup(ADMIN, idIn(secret, null, ADMIN));
      assert.strictEqual(ra.body.isAdmin, true);
      const denied = await lookup(ALICE, aliceId);
      assert.strictEqual(denied.status, 403, JSON.stringify(denied.body));
      const unknown = await lookup(ADMIN, `u_${crypto.randomBytes(17).toString('base64url').slice(0, 22)}`);
      assert.notStrictEqual(unknown.status, 200);
      assert.strictEqual(unknown.body.code, 'IDENTITY_NOT_FOUND', JSON.stringify(unknown.body));
      [r, rb, ra, denied, unknown].forEach((x) => noKeys(JSON.stringify(x.body), 'a lookup answer'));
    });

    it('(g) countinghouse_lookup_identity does the same, admin only', async () => {
      const aliceId = idIn(secret, {id: 'alice'}, ALICE);
      const r = await tool(ADMIN, aliceId);
      assert.strictEqual(r.body.result && r.body.result.isError, false, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.result.structuredContent, {id: aliceId, userName: 'alice', isAdmin: false});
      const denied = await tool(ALICE, aliceId);
      assert.ok((denied.body.result != null && denied.body.result.isError === true) || denied.body.error != null, JSON.stringify(denied.body));
      const unknown = await tool(ADMIN, `u_${crypto.randomBytes(17).toString('base64url').slice(0, 22)}`);
      assert.strictEqual(unknown.body.result.isError, true);
      assert.match(JSON.stringify(unknown.body), /IDENTITY_NOT_FOUND/);
      [r, denied, unknown].forEach((x) => noKeys(JSON.stringify(x.body), 'a tool answer'));
    });

    it('(i) after POST /reload-auth adds an entry, its id resolves', async () => {
      const carolId = idIn(secret, null, CAROL);
      assert.strictEqual((await lookup(ADMIN, carolId)).body.code, 'IDENTITY_NOT_FOUND');
      fs.writeFileSync(authPath, JSON.stringify(config({[CAROL]: {userName: 'carol', devices: []}})));
      const reloaded = await request(URL).post('/reload-auth').set('X-CH-Key', ADMIN).send({});
      assert.strictEqual(reloaded.status, 200, JSON.stringify(reloaded.body));
      const r = await lookup(ADMIN, carolId);
      assert.deepStrictEqual(r.body, {id: carolId, userName: 'carol', isAdmin: false});
    });
  });

  describe('a start that is refused', () => {
    const PORT = 9647;
    let base = null;
    beforeEach(() => { base = fs.mkdtempSync(path.join(os.homedir(), '.ch-identity-refused-')); });
    afterEach(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); base = null; });
    const args = (authPath, store) => ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath, '--moduleDataPath', store, '--port', String(PORT)];

    it('(d) a file config with a duplicate id exits 2, naming the entry positions and no key', async () => {
      const keys = [ADMIN, ALICE, BOB, CAROL, `k${hex(12)}`];
      const cfg = {};
      keys.forEach((k, i) => { cfg[k] = {userName: `u${i + 1}`, devices: [], admin: i === 0}; });
      cfg[keys[1]].id = 'dup';
      cfg[keys[4]].id = 'dup';
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify(cfg));
      const r = await startAndWait(args(authPath, path.join(base, 'store')));
      assert.strictEqual(r.code, 2, r.output.slice(-600));
      assert.match(r.output, /entries 2 and 5 share id/);
      keys.forEach((k) => assert.ok(!r.output.includes(k), 'a key in the output'));
    });

    it('(e) a group-readable secret file refuses startup', async () => {
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
      const store = path.join(base, 'store');
      fs.mkdirSync(store, {recursive: true});
      fs.writeFileSync(path.join(store, '.identity-secret'), hex(32), {mode: 0o644});
      const r = await startAndWait(args(authPath, store));
      assert.strictEqual(r.code, 2, r.output.slice(-600));
      assert.match(r.output, /identity-secret/);
    });

    it('(e) a symlinked secret file refuses startup', async () => {
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
      const store = path.join(base, 'store');
      fs.mkdirSync(store, {recursive: true});
      const real = path.join(base, 'real-secret');
      fs.writeFileSync(real, hex(32), {mode: 0o600});
      fs.symlinkSync(real, path.join(store, '.identity-secret'));
      const r = await startAndWait(args(authPath, store));
      assert.strictEqual(r.code, 2, r.output.slice(-600));
      assert.match(r.output, /identity-secret/);
    });

    it('(e) COUNTINGHOUSE_IDENTITY_SECRET that is not 64 hex characters refuses startup, without echoing it', async () => {
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
      for (const bad of ['not-hex-at-all', hex(16), `${hex(32)}00`]) {
        const r = await startAndWait(args(authPath, path.join(base, 'store')), {COUNTINGHOUSE_IDENTITY_SECRET: bad});
        assert.strictEqual(r.code, 2, r.output.slice(-600));
        assert.match(r.output, /COUNTINGHOUSE_IDENTITY_SECRET/);
        assert.match(r.output, /64 hex/);
        assert.ok(!r.output.includes(bad), 'the value was echoed');
      }
    });

    it('(e) a secret file and a variable that differ refuse startup, naming the conflict and neither value', async () => {
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
      const store = path.join(base, 'store');
      fs.mkdirSync(store, {recursive: true});
      const fileSecret = hex(32);
      const envSecret = hex(32);
      fs.writeFileSync(path.join(store, '.identity-secret'), fileSecret, {mode: 0o600});
      const r = await startAndWait(args(authPath, store), {COUNTINGHOUSE_IDENTITY_SECRET: envSecret});
      assert.strictEqual(r.code, 2, r.output.slice(-600));
      assert.match(r.output, /identity-secret/);
      assert.match(r.output, /COUNTINGHOUSE_IDENTITY_SECRET/);
      assert.ok(!r.output.includes(fileSecret) && !r.output.includes(envSecret), 'a secret was echoed');
    });
  });

  describe('(e) COUNTINGHOUSE_IDENTITY_SECRET overrides the file', () => {
    const PORT = 9648;
    const SECRET = hex(32);
    let base = null;
    let proc = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-identity-env-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}, [ALICE]: {userName: 'alice', devices: []}}));
      proc = spawn(process.execPath, [path.join(ROOT, 'framework.js'), '--bindAddr', '127.0.0.1', '--port', String(PORT), '--workerThread',
        '--authProvider', 'file', '--authConfigPath', authPath, '--moduleDataPath', path.join(base, 'store')],
      {cwd: ROOT, env: Object.assign({}, process.env, {COUNTINGHOUSE_IDENTITY_SECRET: SECRET}), stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      proc.output = '';
      proc.stdout.on('data', (c) => { proc.output += c.toString(); });
      await new Promise((resolve, reject) => waitForReady(proc, (err) => (err ? reject(err) : resolve())));
    });
    after(() => {
      stopServer(proc);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('ids come from the variable, and no secret file is written', async () => {
      const aliceId = idIn(SECRET, null, ALICE);
      const r = await request(`http://127.0.0.1:${PORT}`).post('/identity-lookup').set('X-CH-Key', ADMIN).send({id: aliceId});
      assert.deepStrictEqual(r.body, {id: aliceId, userName: 'alice', isAdmin: false});
      assert.ok(!fs.existsSync(path.join(base, 'store', '.identity-secret')), 'a secret file was written although the variable is set');
    });
  });

  describe('(h) sqlite: a stable id per user', () => {
    let sqlite3 = null;
    try { sqlite3 = require('sqlite3'); } catch (e) { sqlite3 = null; }
    const CLI = path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js');
    let base = null;
    before(function() {
      if (sqlite3 == null) this.skip();
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-identity-sqlite-'));
    });
    after(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); });
    const cli = (dbPath, cmdArgs) => spawnSync(process.execPath, [CLI, '--dbPath', dbPath].concat(cmdArgs), {encoding: 'utf8', timeout: 20000});
    const columns = (dbPath) => new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath);
      db.all('PRAGMA table_info(users)', (err, rows) => { db.close(); return err ? reject(err) : resolve(rows.map((r) => r.name)); });
    });

    it('set-id stores an id; a duplicate fails without naming a key', async () => {
      const dbPath = path.join(base, 'auth.db');
      assert.strictEqual(cli(dbPath, ['add-user', ALICE, 'alice']).status, 0);
      assert.strictEqual(cli(dbPath, ['add-user', BOB, 'bob']).status, 0);
      const ok = cli(dbPath, ['set-id', ALICE, 'alice']);
      assert.strictEqual(ok.status, 0, ok.stderr);
      const dup = cli(dbPath, ['set-id', BOB, 'alice']);
      assert.notStrictEqual(dup.status, 0, 'a duplicate id was accepted');
      assert.ok(!dup.stderr.includes(ALICE) && !dup.stderr.includes(BOB), `a key in the error: ${dup.stderr}`);
      assert.ok((await columns(dbPath)).includes('id'));
    });

    it('an existing database without the column is migrated on open', async () => {
      const dbPath = path.join(base, 'old.db');
      await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.serialize(() => {
          db.run('CREATE TABLE users (apiKey TEXT PRIMARY KEY, userName TEXT, admin INTEGER DEFAULT 0)');
          db.run('CREATE TABLE user_devices (apiKey TEXT NOT NULL, deviceID TEXT NOT NULL, PRIMARY KEY (apiKey, deviceID))');
          db.run('INSERT INTO users (apiKey, userName, admin) VALUES (?, ?, 0)', [CAROL, 'carol'], (err) => { db.close(); return err ? reject(err) : resolve(); });
        });
      });
      assert.ok(!(await columns(dbPath)).includes('id'));
      const r = cli(dbPath, ['set-id', CAROL, 'carol']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok((await columns(dbPath)).includes('id'));
    });
  });
});
