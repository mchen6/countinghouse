// The always-denied set (R2-1 spec, "What each sandbox mode guarantees"):
// under audit and under enforce a module cannot read the auth configuration
// (the JSON file, or the sqlite database with its -wal, -shm and -journal
// side files) or the identity secret, however it names them -- directly,
// through a symlink in its /tmp, through `..`, or through a hard link in a
// declared rw directory -- and however the file is replaced underneath; it
// gets EACCES and the server records the denial in full. COUNTINGHOUSE_*
// never reaches a worker's environment even when declared, the validator
// says so, and the worker's options carry no redisUrl (nor dbUrl). The
// Redis endpoint is refused in the worker (net.connect, tls.connect, a raw
// Socket) -- an in-worker check until the network broker ships. Under off
// nothing is decided: the reads succeed.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const moduleValidator = require('../../lib/module-validator');

const ADMIN   = 'always-denied-admin-key';
const SECRET_ENV = 'should-never-arrive';
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'deny-probe');
const NAME    = 'deny-probe';
const tool    = (a) => `deny_probe_probeservice_${a.toLowerCase()}`;
const REDIS   = {host: '127.0.0.1', port: 6379};

// A copy of the fixture whose declared rw directory is one the test owns
// (the fixture's /opt path stands for "somewhere outside the namespace").
function copyFixture(base, rwDir) {
  const dir = path.join(base, NAME);
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions.fs = [{path: rwDir, access: 'rw'}];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return dir;
}

function world(tag) {
  const base = fs.mkdtempSync(path.join(os.homedir(), `.ch-denied-${tag}-`));
  const w = {
    base: base,
    authPath: path.join(base, 'auth.json'),
    store: path.join(base, 'store'),
    rw: path.join(base, 'rw'),
    secretPath: path.join(base, 'store', '.identity-secret'),
    moduleTmp: path.join(base, 'store', NAME, 'tmp')
  };
  fs.mkdirSync(w.rw);
  fs.writeFileSync(path.join(w.rw, 'ok.txt'), 'declared');
  fs.writeFileSync(w.authPath, JSON.stringify({[ADMIN]: {userName: 'admin', devices: ['*'], admin: true}}));
  // Under enforce a declaration is granted only by the operator's policy;
  // approving it as declared is what makes the rw directory the control
  // case (and the hard-link case) in both modes.
  w.policy = path.join(base, 'policy.json');
  fs.writeFileSync(w.policy, JSON.stringify({modules: {[NAME]: {approve: 'as-declared'}}}));
  w.fixture = copyFixture(base, w.rw);
  return w;
}

function start(port, w, mode, provider, authPath) {
  return startServer(port, ['--workerThread', '--authProvider', provider || 'file', '--authConfigPath', authPath || w.authPath,
    '--moduleDataPath', w.store, '--moduleSandbox', mode, '--modulePolicy', w.policy, '--loadModule', w.fixture],
  {env: {COUNTINGHOUSE_API_KEY: SECRET_ENV}});
}

describe('sandbox 34: the always-denied set', function() {
  this.timeout(180000);

  [['audit', 9680], ['enforce', 9681]].forEach(([mode, port]) => {
    describe(`${mode}`, () => {
      let w = null;
      let server = null;
      const read = (p) => mcpCall(port, ADMIN, tool('read'), {path: p}).then(toolOutput);
      const deniedLine = (target) => waitFor(() => server.output.includes(`module sandbox: ${NAME} file denied ${target}`), 5000,
        `a denial line for ${target}`, () => server.output.split('\n').filter((l) => l.includes('module sandbox')).slice(-8));

      before(async () => {
        w = world(mode);
        server = await start(port, w, mode);
      });
      after(() => {
        stopServer(server);
        if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
      });

      it('a declared rw file outside the namespace is readable: the denial is not a blanket refusal', async () => {
        assert.deepStrictEqual(await read(path.join(w.rw, 'ok.txt')), {content: 'declared', code: null});
      });

      it('the auth config is EACCES by its own path, and the denial is recorded', async () => {
        assert.deepStrictEqual(await read(w.authPath), {content: null, code: 'EACCES'});
        await deniedLine(w.authPath);
      });

      it('the auth config is EACCES through a symlink in /tmp', async () => {
        fs.symlinkSync(w.authPath, path.join(w.moduleTmp, 'auth-link'));
        assert.deepStrictEqual(await read('/tmp/auth-link'), {content: null, code: 'EACCES'});
        await deniedLine('/tmp/auth-link');
      });

      it('the auth config is EACCES through `..` from /data', async () => {
        const dotted = path.posix.join('/data', '..', w.authPath);
        assert.deepStrictEqual(await read(dotted), {content: null, code: 'EACCES'});
      });

      it('the auth config is EACCES through a hard link in a declared rw directory', async () => {
        fs.linkSync(w.authPath, path.join(w.rw, 'auth-hard'));
        assert.deepStrictEqual(await read(path.join(w.rw, 'auth-hard')), {content: null, code: 'EACCES'});
        await deniedLine(path.join(w.rw, 'auth-hard'));
      });

      it('still EACCES through the symlink after the auth file is rewritten in place (a new inode)', async () => {
        const before = fs.statSync(w.authPath).ino;
        const tmp = path.join(w.base, 'auth.json.new');
        fs.writeFileSync(tmp, fs.readFileSync(w.authPath));
        fs.renameSync(tmp, w.authPath);
        assert.notStrictEqual(fs.statSync(w.authPath).ino, before, 'premise: the rewrite changed the inode');
        assert.deepStrictEqual(await read('/tmp/auth-link'), {content: null, code: 'EACCES'});
        assert.deepStrictEqual(await read(w.authPath), {content: null, code: 'EACCES'});
      });

      it('the identity secret is EACCES directly and through a symlink', async () => {
        assert.deepStrictEqual(await read(w.secretPath), {content: null, code: 'EACCES'});
        fs.symlinkSync(w.secretPath, path.join(w.moduleTmp, 'secret-link'));
        assert.deepStrictEqual(await read('/tmp/secret-link'), {content: null, code: 'EACCES'});
        await deniedLine(w.secretPath);
      });

      it('a declared COUNTINGHOUSE_* variable does not reach the worker, and the load logs the denial', async () => {
        const r = await mcpCall(port, ADMIN, tool('env'), {name: 'COUNTINGHOUSE_API_KEY'});
        assert.deepStrictEqual(toolOutput(r), {present: false}, JSON.stringify(r));
        assert.ok(/module sandbox: deny-probe: .*COUNTINGHOUSE_API_KEY.*denied/.test(server.output),
          `no denial logged for the env declaration: ${server.output.split('\n').filter((l) => l.includes('module sandbox')).join('\n')}`);
        assert.ok(!server.output.includes(SECRET_ENV), 'the variable\'s value reached the log');
      });

      it('the Redis endpoint is EACCES from net.connect, tls.connect and a raw Socket, and recorded; another port connects', async () => {
        for (const a of ['connect', 'tlsConnect', 'socketConnect']) {
          const r = await mcpCall(port, ADMIN, tool(a), REDIS);
          assert.deepStrictEqual(toolOutput(r), {code: 'EACCES'}, `${a}: ${JSON.stringify(r)}`);
        }
        await waitFor(() => /module sandbox: deny-probe violation [a-z-]+ 127\.0\.0\.1:6379/.test(server.output), 5000, 'a denial line for the Redis endpoint');
        // The server's own port: not Redis, so audit lets it through.
        const own = await mcpCall(port, ADMIN, tool('connect'), {host: '127.0.0.1', port: port});
        assert.deepStrictEqual(toolOutput(own), {code: 'connected'}, JSON.stringify(own));
      });

      // Review of #36: a loopback Redis is reached under any loopback
      // literal (all of 127/8, the short and numeric IPv4 forms getaddrinfo
      // accepts, ::1 written out, IPv4-mapped) and the loopback names.
      it('the Redis endpoint is EACCES under any loopback literal and the loopback names', async () => {
        for (const host of ['127.0.0.2', '127.1', '2130706433', '0x7f.0.0.1', '0', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.2',
          'LOCALHOST', 'localhost.', 'redis.localhost', 'localhost.localdomain', 'ip6-localhost']) {
          const r = await mcpCall(port, ADMIN, tool('connect'), {host: host, port: REDIS.port});
          assert.deepStrictEqual(toolOutput(r), {code: 'EACCES'}, `${host}: ${JSON.stringify(r)}`);
        }
      });

      it('http.request over the Redis unix socket', function() {
        // --redisUrl has no unix-socket form today (lib/cli-options.js), so
        // there is no socket path to deny; the wrapper is in place for when
        // it does. Ruled in the Task 2 ledger.
        this.skip();
      });

      it('the options the worker received hold no redisUrl and no dbUrl', async () => {
        const r = await mcpCall(port, ADMIN, tool('options'), {});
        assert.deepStrictEqual(toolOutput(r), {found: true, hasRedisUrl: false, hasDbUrl: false}, JSON.stringify(r));
      });
    });
  });

  describe('audit, sqlite provider: the database and its side files', () => {
    let sqlite3 = null;
    try { sqlite3 = require('sqlite3'); } catch (e) { sqlite3 = null; }
    const CLI = path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js');
    const port = 9682;
    let w = null;
    let server = null;
    before(async function() {
      if (sqlite3 == null) this.skip();
      w = world('sqlite');
      w.dbPath = path.join(w.base, 'auth.db');
      const {spawnSync} = require('child_process');
      const cli = (args) => spawnSync(process.execPath, [CLI, '--dbPath', w.dbPath].concat(args), {encoding: 'utf8', timeout: 20000});
      assert.strictEqual(cli(['add-user', ADMIN, 'admin']).status, 0);
      assert.strictEqual(cli(['grant', ADMIN, '*']).status, 0);
      assert.strictEqual(cli(['set-admin', ADMIN, 'true']).status, 0);
      server = await start(port, w, 'audit', 'sqlite', w.dbPath);
    });
    after(() => {
      stopServer(server);
      if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
    });

    it('the database, its -wal, -shm and -journal are EACCES, present or not', async () => {
      const read = (p) => mcpCall(port, ADMIN, tool('read'), {path: p}).then(toolOutput);
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        assert.deepStrictEqual(await read(w.dbPath + suffix), {content: null, code: 'EACCES'}, suffix || 'the database');
      }
      await waitFor(() => server.output.includes(`module sandbox: ${NAME} file denied ${w.dbPath}-journal`), 5000, 'a denial line for a side file');
    });
  });

  describe('off decides nothing', () => {
    const port = 9680;
    let w = null;
    let server = null;
    before(async () => {
      w = world('off');
      server = await start(port, w, 'off');
    });
    after(() => {
      stopServer(server);
      if (w != null) fs.rmSync(w.base, {recursive: true, force: true});
    });

    it('the auth config and the secret are readable, directly and through links', async () => {
      const read = (p) => mcpCall(port, ADMIN, tool('read'), {path: p}).then(toolOutput);
      const authText = fs.readFileSync(w.authPath, 'utf8');
      assert.deepStrictEqual(await read(w.authPath), {content: authText, code: null});
      fs.symlinkSync(w.authPath, path.join(w.moduleTmp, 'auth-link'));
      assert.deepStrictEqual(await read('/tmp/auth-link'), {content: authText, code: null});
      fs.linkSync(w.authPath, path.join(w.rw, 'auth-hard'));
      assert.deepStrictEqual(await read(path.join(w.rw, 'auth-hard')), {content: authText, code: null});
      assert.strictEqual((await read(w.secretPath)).code, null);
      assert.ok(!server.output.includes('file denied'), 'a denial was recorded under off');
    });

    it('the server environment and the Redis endpoint are reachable', async () => {
      const env = await mcpCall(port, ADMIN, tool('env'), {name: 'COUNTINGHOUSE_API_KEY'});
      assert.deepStrictEqual(toolOutput(env), {present: true});
      const r = await mcpCall(port, ADMIN, tool('connect'), REDIS);
      assert.deepStrictEqual(toolOutput(r), {code: 'connected'}, JSON.stringify(r));
    });

    it('the worker still receives no redisUrl and no dbUrl', async () => {
      const r = await mcpCall(port, ADMIN, tool('options'), {});
      assert.deepStrictEqual(toolOutput(r), {found: true, hasRedisUrl: false, hasDbUrl: false}, JSON.stringify(r));
    });
  });

  describe('countinghouse-validate', () => {
    it('reports a declared COUNTINGHOUSE_* variable as never handed over', (done) => {
      const base = fs.mkdtempSync(path.join(os.homedir(), '.ch-denied-validate-'));
      const dir = copyFixture(base, path.join(base, 'rw'));
      moduleValidator.validateModule(dir, (err, result) => {
        fs.rmSync(base, {recursive: true, force: true});
        assert.ifError(err);
        const hit = (result.warnings || []).find((x) => x.stage === 'countinghouse.permissions' && /COUNTINGHOUSE_API_KEY/.test(x.message));
        assert.ok(hit != null, JSON.stringify(result));
        assert.ok(/never/.test(hit.message), hit.message);
        done();
      });
    });
  });
});
