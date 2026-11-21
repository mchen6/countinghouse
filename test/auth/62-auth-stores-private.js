'use strict';
// B-meter-keys 4r (the reviewer's release-1 row): the auth stores hold API
// keys in the clear, so the runtime reads them only from files that are the
// operator's own and owner-only, makes the ones it creates so, and never
// puts a key in its output.
//   - auth.json: refused (startup exit 2, a reload refused) unless this
//     user's own, a regular file under one name, mode 0600 (Windows: its
//     ACL, lib/private-file.js);
//   - the demo key: written to a 0600 auth.json, its path printed, never
//     the key;
//   - an entry with no userName is never named by its key.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');
const FileAuthProvider = require('../../lib/auth/file-provider');
const tmp = require('../helpers/test-tmp').forFile(['ch-auth-62-']);

const ROOT = path.join(__dirname, '..', '..');
const POSIX = process.platform !== 'win32';
const KEY = `k62-${require('crypto').randomBytes(10).toString('hex')}`;

describe('auth 62: the auth file is the operator\'s own, owner-only (B-meter-keys 4r)', function() {
  this.timeout(60000);
  let dir = null;
  let savedEnv;
  before(() => {
    // (the provider warns of an entry with no userName through the logger)
    require('../../lib/logger').createLogger();
    dir = tmp.mkdtemp('ch-auth-62-');
    savedEnv = process.env.COUNTINGHOUSE_API_KEY;
    delete process.env.COUNTINGHOUSE_API_KEY;
  });
  after(() => { if (savedEnv !== undefined) process.env.COUNTINGHOUSE_API_KEY = savedEnv; });
  const write = (name, config, mode) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(config), {mode});
    fs.chmodSync(file, mode);
    return file;
  };

  it('a 0600 auth.json loads', () => {
    const file = write('ok.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600);
    const p = new FileAuthProvider({configPath: file});
    assert.strictEqual(p._lookup(KEY).userName, 'u');
  });

  (POSIX ? it : it.skip)('a group- or world-readable auth.json is refused at startup: AUTH_CONFIG_INVALID, the fix named, no key', () => {
    const file = write('loose.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o644);
    let err = null;
    try { new FileAuthProvider({configPath: file}); } catch (e) { err = e; }
    assert.ok(err != null, 'refused');
    assert.strictEqual(err.code, 'AUTH_CONFIG_INVALID');
    assert.match(err.message, /accessible by group or others \(mode 644\); it must be 0600, as it holds API keys: chmod 600 /);
    assert.ok(!err.message.includes(KEY), err.message);
  });

  (POSIX ? it : it.skip)('a link in its place is refused', () => {
    const real = write('real.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600);
    const link = path.join(dir, 'linked.json');
    fs.symlinkSync(real, link);
    // (no chmod named: a mode never fixes a link)
    assert.throws(() => new FileAuthProvider({configPath: link}), (e) => e.code === 'AUTH_CONFIG_INVALID' && /symbolic link/.test(e.message) && !/chmod/.test(e.message));
  });

  (POSIX ? it : it.skip)('a reload of a file made loose meanwhile is refused, the config kept', (done) => {
    const file = write('reload.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600);
    const p = new FileAuthProvider({configPath: file});
    fs.chmodSync(file, 0o644);
    p.reload((err) => {
      try {
        assert.ok(err != null && err.code === 'AUTH_RELOAD_INVALID', String(err && err.code));
        assert.match(err.message, /chmod 600/);
        assert.ok(!err.message.includes(KEY));
        assert.strictEqual(p._lookup(KEY).userName, 'u', 'the config kept');
        done();
      } catch (e) { done(e); }
    });
  });

  it('the demo key is written to a 0600 auth.json, and only its path is printed', () => {
    const file = path.join(dir, 'demo-auth.json');
    const logged = [];
    const real = console.log;
    console.log = (...a) => logged.push(a.join(' '));
    try {
      new FileAuthProvider({configPath: file});
    } finally {
      console.log = real;
    }
    const demoKey = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))[0];
    assert.match(demoKey, /^demo-/);
    const said = logged.join('\n');
    assert.ok(!said.includes(demoKey), `the demo key was printed: ${said}`);
    assert.ok(said.includes(file), `its path is said: ${said}`);
    if (POSIX) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('an entry with no userName is never named by its key', () => {
    const file = write('noname.json', {[KEY]: {devices: ['*']}}, 0o600);
    const p = new FileAuthProvider({configPath: file});
    const name = p._lookup(KEY).userName;
    assert.ok(!String(name).includes(KEY), `named by its key: ${name}`);
    // no name at all, as entries() says and the sqlite store answers (never a
    // made-up one that moves with the entry's place or meets a real name)
    assert.strictEqual(name, null);
    p.entries((err, list) => assert.strictEqual(list.find((e) => e.apiKey === KEY).userName, null));
  });

  // (the review's 1) the --hardened parent checks the file the child reads:
  // one spelling of the default path
  it('the default auth.json path is one function\'s, the one the --hardened parent checks', () => {
    const r = spawnSync(process.execPath, ['-e', `const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      const p = new F({});
      process.stdout.write(JSON.stringify({used: p.configPath, fn: typeof(F.defaultConfigPath) === 'function' ? F.defaultConfigPath() : null}));`],
    {cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, {COUNTINGHOUSE_API_KEY: `env-${KEY}`}), timeout: 20000});
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.fn, path.join(fs.realpathSync(dir), 'auth.json'), r.stdout + r.stderr);
    assert.strictEqual(o.used, o.fn);
    assert.match(fs.readFileSync(path.join(ROOT, 'framework.js'), 'utf8'), /file-provider'\)\.prepareForHardened\(options\.authConfigPath \|\| require\('\.\/lib\/auth\/file-provider'\)\.defaultConfigPath\(\)\)/);
  });

  // (the review's 3) under --hardened on Windows the child can't make a
  // file (no PowerShell): the parent makes the demo one before the relaunch
  it('the --hardened parent makes a missing auth.json (the demo key), owner-only, its path said; none beside COUNTINGHOUSE_API_KEY', () => {
    const run = (file, env) => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))}).prepareForHardened(${JSON.stringify(file)});`],
      {cwd: dir, encoding: 'utf8', env, timeout: 20000});
    const bare = Object.assign({}, process.env);
    delete bare.COUNTINGHOUSE_API_KEY;
    const file = path.join(dir, 'hardened-demo.json');
    const r = run(file, bare);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(file), 'made by the parent');
    const demoKey = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))[0];
    assert.match(demoKey, /^demo-/);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(demoKey), 'the key is not printed');
    assert.ok(r.stdout.includes(file), r.stdout);
    if (POSIX) assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const none = path.join(dir, 'hardened-none.json');
    assert.strictEqual(run(none, Object.assign({}, bare, {COUNTINGHOUSE_API_KEY: `env-${KEY}`})).status, 0);
    assert.ok(!fs.existsSync(none), 'COUNTINGHOUSE_API_KEY alone is a whole configuration');
  });

  // (the review's 9) the config another start wrote is checked as any load
  it('an auth.json another start wrote first is loaded with the same checks (two entries with one id refused)', () => {
    const p = new FileAuthProvider({configPath: write('race-ok.json', {[KEY]: {userName: 'u', devices: []}}, 0o600)});
    p.configPath = write('race-dup.json', {[`a-${KEY}`]: {id: 'same', devices: []}, [`b-${KEY}`]: {id: 'same', devices: []}}, 0o600);
    assert.throws(() => p._loadWritten(), (e) => e.code === 'AUTH_CONFIG_INVALID' && !e.message.includes(KEY));
  });

  (POSIX ? it : it.skip)('a server given a loose auth.json does not start: exit 2, the fix said, no key in its output', () => {
    const file = write('server-loose.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o644);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--authConfigPath', file, '--moduleDataPath', path.join(dir, 'data'),
      '--store', 'local', '--storePath', path.join(dir, 'store'), '--port', String(require('../helpers/test-env').testPort(9833))], {encoding: 'utf8', timeout: 30000, cwd: dir});
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 2, out);
    assert.match(out, /chmod 600/);
    assert.ok(!out.includes(KEY), out);
  });

  // (v): a running server's own output holds no key -- an entry with no
  // userName, one whose name is its key, the env key
  (POSIX ? it : it.skip)('a server\'s startup output holds no key', async function() {
    this.timeout(120000);
    const {startServer, stopServer} = require('../helpers/sandbox-server');
    const ENV_KEY = `env-${KEY}`;
    const NAMED = `named-${KEY}`;
    const file = write('server-ok.json', {[KEY]: {devices: ['*']}, [NAMED]: {userName: NAMED, devices: []}}, 0o600);
    const server = await startServer(require('../helpers/test-env').testPort(9833), ['--workerThread', '--authConfigPath', file,
      '--moduleDataPath', path.join(dir, 'data-ok')], {env: {COUNTINGHOUSE_API_KEY: ENV_KEY}});
    try {
      for (const k of [KEY, NAMED, ENV_KEY]) assert.ok(!server.output.includes(k), `a key in the startup output: ${server.output.slice(0, 2000)}`);
      // (the log is JSON: its quotes escaped)
      assert.match(server.output, /entry #1 in .* has no userName, so callers see no user name/);
    } finally {
      stopServer(server);
    }
  });

  tmp.hooks();
});

// the sqlite store and its users CLI: the DB file is the operator's own,
// owner-only (made so, refused otherwise); keys reach the CLI on stdin only,
// and nothing it prints holds one
describe('auth 62: the sqlite store and its users CLI (B-meter-keys 4r)', function() {
  this.timeout(60000);
  let sqlite3 = null;
  try { sqlite3 = require('sqlite3'); } catch (e) { sqlite3 = null; }
  const CLI = path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js');
  let dir = null;
  before(function() {
    if (sqlite3 == null) this.skip();
    require('../../lib/logger').createLogger();
    dir = tmp.mkdtemp('ch-auth-62-sqlite-');
  });
  const cli = (db, args, input) => spawnSync(process.execPath, [CLI, '--dbPath', db].concat(args), {encoding: 'utf8', timeout: 20000, input: input == null ? '' : input});

  it('the CLI reads the key from stdin: add-user, grant, list; no key in anything it prints', () => {
    const db = path.join(dir, 'users.sqlite3');
    const outs = [cli(db, ['add-user', 'alice'], `${KEY}\n`), cli(db, ['grant', '*'], `${KEY}\n`), cli(db, ['set-id', 'alice-stable'], `${KEY}\n`), cli(db, ['list'])];
    for (const r of outs) assert.strictEqual(r.status, 0, r.stderr);
    const all = outs.map((r) => r.stdout + r.stderr).join('\n');
    assert.ok(!all.includes(KEY), `a key in the CLI's output: ${all}`);
    assert.match(outs[3].stdout, /^alice \(id alice-stable\): \*$/m);
    if (POSIX) assert.strictEqual(fs.statSync(db).mode & 0o777, 0o600, 'made owner-only');
  });

  it('a key given as an argument is refused (usage), never echoed', () => {
    const db = path.join(dir, 'argv.sqlite3');
    const r = cli(db, ['add-user', KEY, 'alice']);
    assert.notStrictEqual(r.status, 0);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(KEY), r.stdout + r.stderr);
  });

  it('nothing on stdin is refused', () => {
    const r = cli(path.join(dir, 'empty.sqlite3'), ['add-user', 'alice'], '');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /no API key on stdin/);
  });

  (POSIX ? it : it.skip)('a loose DB file is refused by the CLI and the provider, the fix named', () => {
    const db = path.join(dir, 'loose.sqlite3');
    assert.strictEqual(cli(db, ['add-user', 'alice'], `${KEY}\n`).status, 0);
    fs.chmodSync(db, 0o644);
    const r = cli(db, ['list']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /mode 644.*chmod 600/s);
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    assert.throws(() => new SqliteAuthProvider({dbPath: db}), (e) => e.code === 'AUTH_CONFIG_INVALID' && /chmod 600/.test(e.message) && !e.message.includes(KEY));
  });

  // (the review's 4) the key is its first line: a pipe left open is no hang
  it('the CLI takes the key at the first line, with stdin left open', async () => {
    const {spawn} = require('child_process');
    const child = spawn(process.execPath, [CLI, '--dbPath', path.join(dir, 'open.sqlite3'), 'add-user', 'olive'], {stdio: ['pipe', 'pipe', 'pipe']});
    child.stdin.write(`${KEY}\n`);
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve('hung'); }, 15000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    child.stdin.destroy();
    assert.strictEqual(code, 0);
  });

  // (the review's 7) a second name (a hard link) is refused, as auth.json's
  (POSIX ? it : it.skip)('a DB file with a second name is refused by the CLI and the provider', () => {
    const db = path.join(dir, 'linked.sqlite3');
    assert.strictEqual(cli(db, ['add-user', 'alice'], `${KEY}\n`).status, 0);
    fs.linkSync(db, path.join(dir, 'linked-2.sqlite3'));
    const r = cli(db, ['list']);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /2 names \(hard links\)/);
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    assert.throws(() => new SqliteAuthProvider({dbPath: db}), (e) => e.code === 'AUTH_CONFIG_INVALID' && /hard links/.test(e.message));
  });

  // (the review's 8) without sqlite3 the start is refused before a file is made
  it('a provider with no sqlite3 to load leaves no DB file behind', () => {
    const db = path.join(dir, 'nosqlite.sqlite3');
    const r = spawnSync(process.execPath, ['-e', `const Module = require('module');
      const load = Module._load;
      Module._load = function(request, ...rest) { if (request === 'sqlite3') throw Object.assign(new Error("Cannot find module 'sqlite3'"), {code: 'MODULE_NOT_FOUND'}); return load.call(this, request, ...rest); };
      const P = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'sqlite-provider'))});
      try { new P({dbPath: ${JSON.stringify(db)}}); } catch (e) { process.stdout.write('refused'); }`], {encoding: 'utf8', timeout: 20000});
    assert.match(r.stdout, /refused/, r.stderr);
    assert.ok(!fs.existsSync(db), 'no DB file left');
  });

  (POSIX ? it : it.skip)('a DB file the provider creates is owner-only', async () => {
    const db = path.join(dir, 'made.sqlite3');
    const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
    const p = new SqliteAuthProvider({dbPath: db});
    await p.ready;
    await new Promise((resolve) => p.db.close(resolve));
    assert.strictEqual(fs.statSync(db).mode & 0o777, 0o600);
  });

  tmp.hooks();
});
