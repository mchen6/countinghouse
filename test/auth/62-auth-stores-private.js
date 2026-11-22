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

  // (the high on #520, M2) a reload whose file can't be verified as the
  // operator's own -- made loose meanwhile (a `jq ... > tmp && mv` edit leaves
  // 0644), or under --hardened on Windows, where no ACL can be read -- still
  // applies what tightens: a revoked key must not stay live. What adds or
  // widens is refused, by entry number, never a key
  (POSIX ? it : it.skip)('a reload of a file made loose meanwhile applies only what tightens, naming chmod and restart', (done) => {
    const OTHER = `other-${KEY}`;
    const NEW = `new-${KEY}`;
    const file = write('reload.json', {[KEY]: {userName: 'u', devices: ['*'], admin: true}, [OTHER]: {userName: 'o', devices: ['d1']}}, 0o600);
    const p = new FileAuthProvider({configPath: file});
    // the edit: u narrowed to one device and its admin dropped (tightening),
    // o removed (tightening), a new key added (refused)
    write('reload.json', {[KEY]: {userName: 'u', devices: ['d1'], admin: false}, [NEW]: {userName: 'n', devices: ['*']}}, 0o644);
    p.reload((err, r) => {
      try {
        assert.ifError(err);
        // (the reload tool's own shape: ok false while anything was refused,
        // changed in entries -- u modified, o removed -- the rest in its note)
        assert.strictEqual(r.ok, false, JSON.stringify(r));
        assert.strictEqual(r.changed, 2, JSON.stringify(r));
        assert.match(r.note, /refused 1 /);
        assert.match(r.note, /chmod 600/);
        assert.match(r.note, /entry #2: a new key/);
        for (const k of [KEY, OTHER, NEW]) assert.ok(!JSON.stringify(r).includes(k), 'no key in the answer');
        assert.deepStrictEqual(p._lookup(KEY), {userName: 'u', devices: ['d1'], admin: false});
        assert.strictEqual(p._lookup(OTHER), null, 'the removed key is gone');
        assert.strictEqual(p._lookup(NEW), null, 'the new key is not admitted');
        done();
      } catch (e) { done(e); }
    });
  });

  (POSIX ? it : it.skip)('a reload through a link is still refused whole, the config kept', (done) => {
    const real = write('reload-real.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600);
    const p = new FileAuthProvider({configPath: write('reload-l.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600)});
    fs.unlinkSync(p.configPath);
    fs.symlinkSync(real, p.configPath);
    p.reload((err) => {
      try {
        assert.ok(err != null && err.code === 'AUTH_RELOAD_INVALID' && /symbolic link/.test(err.message), String(err && err.message));
        assert.strictEqual(p._lookup(KEY).userName, 'u', 'the config kept');
        done();
      } catch (e) { done(e); }
    });
  });

  it('tightenOnly: removals, narrowings and admin dropped apply; a new key, an id or userName change and any widening are refused', () => {
    const t = FileAuthProvider.tightenOnly;
    assert.strictEqual(typeof(t), 'function');
    const k = (n) => `${KEY}-${n}`;
    const old = {
      [k(1)]: {userName: 'a', devices: ['*'], admin: true, id: 'ida', runsModules: ['m1', 'm2']},
      [k(2)]: {userName: 'b', devices: ['d1', 'd2']},
      [k(3)]: {userName: 'c', devices: ['d1']},
      [k(4)]: {userName: 'd', devices: ['*']}
    };
    const next = {
      // '*' -> a list: the list; admin dropped; a module removed and one added
      [k(1)]: {userName: 'a', devices: ['d9'], admin: false, id: 'ida', runsModules: ['m1', 'm3']},
      // a list -> '*': kept; a new name: kept
      [k(2)]: {userName: 'B', devices: ['*']},
      // a list, part new: the old ones it keeps; a new id: kept; admin granted: refused
      [k(3)]: {userName: 'c', devices: ['d1', 'd7'], id: 'new-id', admin: true},
      // k(4) removed; k(5) new
      [k(5)]: {userName: 'e', devices: []}
    };
    const r = t(old, next);
    assert.deepStrictEqual(r.config[k(1)], {userName: 'a', devices: ['d9'], admin: false, id: 'ida', runsModules: ['m1']});
    assert.deepStrictEqual(r.config[k(2)], {userName: 'b', devices: ['d1', 'd2']});
    assert.deepStrictEqual(r.config[k(3)], {userName: 'c', devices: ['d1']});
    assert.ok(!(k(4) in r.config), 'removed');
    assert.ok(!(k(5) in r.config), 'a new key refused');
    // applied: k1 devices, admin, runsModules; k4 removed
    assert.strictEqual(r.applied, 4, JSON.stringify(r));
    const said = r.refused.join(' | ');
    for (const want of [/entry #1: runsModules widened/, /entry #2: its userName changed/, /entry #2: devices widened/, /entry #3: devices widened/,
      /entry #3: its id changed/, /entry #3: admin granted/, /entry #4: a new key/]) assert.match(said, want);
    assert.ok(!said.includes(KEY), 'no key named');
  });

  // (the round's medium) an entry that is no object (off) is never made one;
  // a module two entries claimed (no identity) is never handed to the one
  // left: it stays unbound
  it('tightenOnly never revives an entry that is off, nor hands a module to its remaining claimant', () => {
    const t = FileAuthProvider.tightenOnly;
    const k = (n) => `${KEY}-${n}`;
    const off = t({[k(1)]: null}, {[k(1)]: {userName: 'x'}});
    assert.strictEqual(off.config[k(1)], null, 'still off');
    assert.match(off.refused.join(' | '), /entry #1: changed/);
    const both = {[k(1)]: {userName: 'a', runsModules: ['m']}, [k(2)]: {userName: 'b', runsModules: ['m', 'q']}};
    // a drops m: m would be b's alone
    const r1 = t(both, {[k(1)]: {userName: 'a', runsModules: []}, [k(2)]: {userName: 'b', runsModules: ['m', 'q']}});
    assert.deepStrictEqual(r1.config[k(1)].runsModules, []);
    assert.deepStrictEqual(r1.config[k(2)].runsModules, ['q'], 'm left unbound');
    // a removed: the same
    const r2 = t(both, {[k(2)]: {userName: 'b', runsModules: ['m', 'q']}});
    assert.deepStrictEqual(r2.config[k(2)].runsModules, ['q'], 'm left unbound');
  });

  (POSIX ? it : it.skip)('a reload of a file others can write in is refused whole, the config kept', (done) => {
    const file = write('reload-w.json', {[KEY]: {userName: 'u', devices: ['*']}}, 0o600);
    const p = new FileAuthProvider({configPath: file});
    write('reload-w.json', {}, 0o666);
    p.reload((err) => {
      try {
        assert.ok(err != null && err.code === 'AUTH_RELOAD_INVALID', String(err && err.message));
        assert.match(err.message, /chmod 600/);
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
      process.stdout.write(JSON.stringify({cwd: process.cwd(), used: p.configPath, fn: typeof(F.defaultConfigPath) === 'function' ? F.defaultConfigPath() : null}));`],
    {cwd: dir, encoding: 'utf8', env: Object.assign({}, process.env, {COUNTINGHOUSE_API_KEY: `env-${KEY}`}), timeout: 20000});
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.fn, path.join(o.cwd, 'auth.json'), r.stdout + r.stderr);
    assert.strictEqual(o.used, o.fn);
    // (the --hardened parent's check and its grant name the default by that
    // function, never by a spelling of their own)
    for (const f of ['framework.js', path.join('lib', 'hardened-launch.js')]) {
      assert.ok(!/'auth\.json'/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), `${f} spells the default auth.json path itself`);
    }
  });

  // (the second and third mediums) the --hardened child is granted auth.json
  // to read only when the file provider reads it, and never to write: the
  // parent makes the demo file before the relaunch, on every platform
  it('the --hardened grant on auth.json: read when the file provider reads it, never write', () => {
    const grant = ({platform = process.platform, options = {}, envKey = null, cwd = dir}) => {
      const file = options.authConfigPath != null ? options.authConfigPath : path.join(cwd, 'auth.json');
      const env = Object.assign({}, process.env);
      delete env.COUNTINGHOUSE_API_KEY;
      if (envKey != null) env.COUNTINGHOUSE_API_KEY = envKey;
      const r = spawnSync(process.execPath, ['-e', `
        if (${JSON.stringify(platform)} === 'win32') Object.defineProperty(process, 'platform', {value: 'win32'});
        const hl = require(${JSON.stringify(path.join(ROOT, 'lib', 'hardened-launch'))});
        const options = Object.assign({modulePath: ${JSON.stringify(path.join(dir, 'grant-m'))}, moduleDataPath: ${JSON.stringify(path.join(dir, 'grant-d'))},
          authProvider: 'file', debug: false}, ${JSON.stringify(options)});
        const flags = hl.permissionFlags(options, ${JSON.stringify(ROOT)}, process.cwd(), (p) => p);
        const has = (kind) => flags.some((f) => f.startsWith('--allow-fs-' + kind + '=') && f.split(',').concat(f.slice(f.indexOf('=') + 1)).includes(${JSON.stringify(file)}));
        process.stdout.write(JSON.stringify({read: has('read'), write: has('write')}));`],
      {cwd, encoding: 'utf8', env, timeout: 20000});
      assert.ok(r.stdout.startsWith('{'), r.stdout + r.stderr);
      return JSON.parse(r.stdout);
    };
    const posix = process.platform === 'win32' ? 'linux' : process.platform;
    const named = {authConfigPath: path.join(dir, 'grant-auth.json')};
    assert.deepStrictEqual(grant({platform: posix, options: named}), {read: true, write: false}, 'POSIX, first run: the parent makes it');
    assert.deepStrictEqual(grant({platform: 'win32', options: named}), {read: true, write: false}, 'Windows: the parent makes it');
    assert.deepStrictEqual(grant({platform: posix, options: Object.assign({singleIdentity: true}, named)}), {read: false, write: false}, 'single identity: no file provider');
    // the default, by its one function: in the working directory
    assert.deepStrictEqual(grant({platform: posix}), {read: true, write: false}, 'the default path');
    // an unknown or unset provider is the file provider (lib/auth), so it is
    // granted; sqlite's and CouchDB's are not
    assert.deepStrictEqual(grant({platform: posix, options: Object.assign({authProvider: null}, named)}), {read: true, write: false}, 'unset: the file provider');
  });

  // where the file provider's auth.json is, and whether there is one: one
  // function, for the --hardened parent's create and check and the child's
  // grant
  // a --authConfigPath given twice is refused at the start, as one given
  // empty or bare: the --hardened parent, the grant, the
  // provider and the broker's protected lists all name one file
  it('a --authConfigPath given twice, bare or empty is refused at the start; an all-digit name is that file', () => {
    const r = spawnSync(process.execPath, ['-e', `const o = require(${JSON.stringify(path.join(ROOT, 'lib', 'cli-options'))});
      const out = [];
      for (const v of [['a.json', 'b.json'], '', true, 'ok.json', 1234]) { o.setOptions({authConfigPath: v}); out.push([o.authConfigPathInvalid === true, o.authConfigPath]); }
      process.stdout.write(JSON.stringify(out));`], {encoding: 'utf8', timeout: 20000});
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(out.map((x) => x[0]), [true, true, true, false, false], r.stderr);
    assert.strictEqual(out[4][1], '1234', 'the file named 1234');
  });

  it('fileAuthPathOf: the file provider\'s auth.json, or null when none is read', () => {
    const {fileAuthPathOf} = require('../../lib/auth/auth-file-defaults');
    const cwd = path.join(dir, 'cwd');
    assert.strictEqual(fileAuthPathOf({authProvider: 'file'}, cwd), path.join(cwd, 'auth.json'));
    assert.strictEqual(fileAuthPathOf({}, cwd), path.join(cwd, 'auth.json'), 'unset: the file provider');
    assert.strictEqual(fileAuthPathOf({authProvider: 'file', authConfigPath: ''}, cwd), path.join(cwd, 'auth.json'), 'empty: the default, never the directory');
    assert.strictEqual(fileAuthPathOf({authProvider: 'file', authConfigPath: 'conf/a.json'}, cwd), path.join(cwd, 'conf', 'a.json'));
    for (const o of [{debug: true}, {singleIdentity: true}, {authProvider: 'sqlite'}, {authProvider: 'couchdb'}]) {
      assert.strictEqual(fileAuthPathOf(Object.assign({authProvider: 'file'}, o), cwd), null, JSON.stringify(o));
    }
  });

  // the sqlite store's default is its own file, and the broker protects the
  // file that holds the keys, whichever store it is
  // (the final pass's gateway part, A13) a load error names the auth store
  // as it is, never "null": the default file, or CouchDB's database
  it('authStoreName names the store a message points at: the default file, the given one, or CouchDB\'s database', () => {
    const {authStoreName} = require('../../lib/auth/auth-file-defaults');
    // (absolute on every OS, as the store's own path.resolve makes it: on
    // Windows '/srv/ch' gains its drive -- #531's high, L7)
    const cwd = path.resolve('/srv/ch');
    assert.strictEqual(authStoreName({}, cwd), path.join(cwd, 'auth.json'));
    assert.strictEqual(authStoreName({authProvider: 'sqlite'}, cwd), path.join(cwd, 'auth.sqlite3'));
    assert.strictEqual(authStoreName({authConfigPath: 'k.json'}, cwd), path.join(cwd, 'k.json'));
    assert.strictEqual(authStoreName({authProvider: 'couchdb'}, cwd), 'the CouchDB database');
    // the three composition messages take it, never options.authConfigPath itself
    const src = require('fs').readFileSync(path.join(__dirname, '../../lib/device-manager.js'), 'utf8');
    assert.ok(!/\$\{options\.authConfigPath\}/.test(src), 'a message still names options.authConfigPath');
  });

  it('authConfigPathOf names the sqlite store\'s default, and the broker protects and denies it', () => {
    const {authConfigPathOf} = require('../../lib/auth/auth-file-defaults');
    const cwd = path.join(dir, 'cwd');
    assert.strictEqual(authConfigPathOf({authProvider: 'sqlite'}, cwd), path.join(cwd, 'auth.sqlite3'));
    assert.strictEqual(authConfigPathOf({authProvider: 'sqlite', authConfigPath: 'k.db'}, cwd), path.join(cwd, 'k.db'));
    assert.strictEqual(authConfigPathOf({authProvider: 'couchdb'}, cwd), null, 'CouchDB: no file here');
    const r = spawnSync(process.execPath, ['-e', `const broker = require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))});
      const denied = require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker', 'denied'))});
      const options = {authProvider: 'sqlite', modulePath: 'm', moduleDataPath: 'd'};
      process.stdout.write(JSON.stringify({prot: broker.protectedPaths(options), denied: denied.deniedPathsFor(options)}));`],
    {cwd: dir, encoding: 'utf8', timeout: 20000});
    const o = JSON.parse(r.stdout);
    const db = path.join(fs.realpathSync(dir), 'auth.sqlite3');
    assert.ok(o.prot.map((p) => path.resolve(dir, String(p))).some((p) => fs.realpathSync(path.dirname(p)) === path.dirname(db) && path.basename(p) === 'auth.sqlite3'), JSON.stringify(o.prot));
    assert.ok(o.denied.some((p) => /auth\.sqlite3-wal$/.test(p)), JSON.stringify(o.denied));
    // (its journals are protected from a declaration too, as they hold its pages)
    for (const side of ['-wal', '-shm', '-journal']) assert.ok(o.prot.some((p) => p.endsWith(`auth.sqlite3${side}`)), `${side}: ${JSON.stringify(o.prot)}`);
  });

  // (the seventh medium) COUNTINGHOUSE_API_KEY with no auth.json is a whole
  // configuration under --hardened too: the parent makes none, and the start
  // goes on
  (POSIX ? it : it.skip)('a --hardened start with COUNTINGHOUSE_API_KEY and no auth.json starts, and makes none', async function() {
    this.timeout(120000);
    const {startServer, stopServer} = require('../helpers/sandbox-server');
    const cwd = tmp.mkdtemp('ch-auth-62-hard-env-');
    const server = await startServer(require('../helpers/test-env').testPort(9833), ['--workerThread', '--hardened', '--store', 'local',
      '--storePath', path.join(cwd, 'store'), '--moduleDataPath', path.join(cwd, 'data'), '--modulePath', path.join(cwd, 'modules')],
    {cwd, env: {COUNTINGHOUSE_API_KEY: `env-${KEY}`}});
    try {
      assert.ok(!fs.existsSync(path.join(cwd, 'auth.json')), 'none made beside the env key');
      assert.ok(!server.output.includes(KEY), 'no key in the output');
    } finally {
      stopServer(server);
    }
  });

  // (the third medium's run of remote 08) on POSIX too the parent makes it:
  // the child's write of a temp file beside it is refused by its grants
  (POSIX ? it : it.skip)('on POSIX the --hardened parent makes a missing auth.json too, and a child finding none is refused', () => {
    const bare = Object.assign({}, process.env);
    delete bare.COUNTINGHOUSE_API_KEY;
    const file = path.join(dir, 'posix-hardened.json');
    const made = spawnSync(process.execPath, ['-e', `const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      if (typeof(F.makeForHardened) !== 'function') { process.stdout.write('none'); process.exit(0); }
      F.makeForHardened(${JSON.stringify(file)});`], {encoding: 'utf8', env: bare, timeout: 20000});
    assert.ok(fs.existsSync(file), `made by the parent: ${made.stdout} ${made.stderr}`);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    const demoKey = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))[0];
    assert.ok(made.stdout.includes(file) && !made.stdout.includes(demoKey), made.stdout);
    const beside = path.join(dir, 'posix-hardened-envkey.json');
    const besideRun = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))}).makeForHardened(${JSON.stringify(beside)});
      process.stdout.write('ran');`], {encoding: 'utf8', env: Object.assign({}, bare, {COUNTINGHOUSE_API_KEY: `env-${KEY}`}), timeout: 20000});
    assert.strictEqual(besideRun.stdout, 'ran', besideRun.stderr);
    assert.ok(!fs.existsSync(beside), 'COUNTINGHOUSE_API_KEY: none is made');
    const missing = path.join(dir, 'posix-child-missing.json');
    const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '-e', `
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger'))}).createLogger();
      const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      try { new F({configPath: ${JSON.stringify(missing)}}); process.stdout.write('started'); }
      catch (e) { process.stdout.write(JSON.stringify({code: e.code, message: e.message})); }`],
    {encoding: 'utf8', env: bare, timeout: 20000});
    assert.match(r.stdout, /AUTH_CONFIG_INVALID.*created before the relaunch: start countinghouse with --hardened itself/, r.stdout + r.stderr);
  });

  // (M2) under --hardened on Windows a reload applies what tightens too
  (POSIX ? it : it.skip)('under --hardened on Windows a reload applies what tightens and refuses the rest, naming restart', () => {
    const file = path.join(dir, 'win-hardened-reload.json');
    const env = Object.assign({}, process.env, {COUNTINGHOUSE_API_KEY: `env-${KEY}`});
    const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-fs-write=*', '-e', `
      Object.defineProperty(process, 'platform', {value: 'win32'});
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger'))}).createLogger();
      const fs = require('fs');
      const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      const p = new F({configPath: ${JSON.stringify(file)}});
      fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({${JSON.stringify(`new-${KEY}`)}: {userName: 'n', devices: ['*']}}));
      p.reload((err, r) => process.stdout.write('\\nOUT ' + JSON.stringify({err: err && err.message, r, admitted: p._lookup(${JSON.stringify(`new-${KEY}`)}) != null}) + '\\n'));`],
    {encoding: 'utf8', env, timeout: 20000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, r.stdout + r.stderr);
    const o = JSON.parse(line.slice(4));
    assert.strictEqual(o.err, null, r.stdout + r.stderr);
    assert.strictEqual(o.r.ok, false);
    assert.match(o.r.note, /refused 1 /);
    assert.match(o.r.note, /restart countinghouse/);
    assert.strictEqual(o.admitted, false);
  });

  // (the second medium's 2) a Windows --hardened child finding no auth.json
  // is told where it is made, never sent into a write it can't make
  (POSIX ? it : it.skip)('a --hardened Windows child with no auth.json is refused, naming the parent\'s create', () => {
    const missing = path.join(dir, 'child-missing.json');
    const bare = Object.assign({}, process.env);
    delete bare.COUNTINGHOUSE_API_KEY;
    const r = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-fs-write=*', '-e', `
      Object.defineProperty(process, 'platform', {value: 'win32'});
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger'))}).createLogger();
      const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      try { new F({configPath: ${JSON.stringify(missing)}}); process.stdout.write('started'); }
      catch (e) { process.stdout.write(JSON.stringify({code: e.code, message: e.message})); }`],
    {encoding: 'utf8', env: bare, timeout: 20000});
    const o = JSON.parse(r.stdout);
    assert.strictEqual(o.code, 'AUTH_CONFIG_INVALID', r.stdout + r.stderr);
    assert.match(o.message, /created before the relaunch: start countinghouse with --hardened itself/);
    assert.ok(!fs.existsSync(missing));
    // (gone between the look and the read: the same answer)
    const raced = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', '--allow-fs-write=*', '-e', `
      Object.defineProperty(process, 'platform', {value: 'win32'});
      const fs = require('fs');
      const exists = fs.existsSync;
      fs.existsSync = (p) => (p === ${JSON.stringify(missing)} ? true : exists(p));
      require(${JSON.stringify(path.join(ROOT, 'lib', 'logger'))}).createLogger();
      const F = require(${JSON.stringify(path.join(ROOT, 'lib', 'auth', 'file-provider'))});
      try { new F({configPath: ${JSON.stringify(missing)}}); process.stdout.write('started'); }
      catch (e) { process.stdout.write(JSON.stringify({code: e.code, message: e.message})); }`],
    {encoding: 'utf8', env: bare, timeout: 20000});
    assert.match(raced.stdout, /created before the relaunch: start countinghouse with --hardened itself/, raced.stdout + raced.stderr);
  });

  // the fix a refusal names, by its kind (both stores)
  (POSIX ? it : it.skip)('the fix named: chmod for a mode, chown then chmod for an owner, none otherwise', () => {
    const {fixFor} = require('../../lib/auth/private-store');
    assert.strictEqual(fixFor('mode', '/f'), ', as it holds API keys: chmod 600 /f');
    assert.strictEqual(fixFor('owner', '/f'), '; it holds API keys: chown it to this user, then chmod 600 /f');
    assert.strictEqual(fixFor(undefined, '/f'), '');
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
    // (the user is there, under that key: the path ran)
    assert.match(cli(path.join(dir, 'open.sqlite3'), ['list']).stdout, /^olive \(id -\)/m);
    assert.strictEqual(cli(path.join(dir, 'open.sqlite3'), ['remove-user'], `${KEY}\n`).status, 0);
  });

  // (the second medium's 5) a key past the bound is refused, never cut short
  it('a key over 64 KiB is refused, never cut short, and no user added; one of exactly 64 KiB is taken', () => {
    const db = path.join(dir, 'long.sqlite3');
    // (no line end; and a line whose cut at the bound would fall on spaces)
    for (const input of ['k'.repeat(70 * 1024), `${'k'.repeat(65530)}${' '.repeat(10)}tail\n`]) {
      const r = cli(db, ['add-user', 'lena'], input);
      assert.notStrictEqual(r.status, 0, `${input.length}: ${r.stderr}`);
      assert.match(r.stderr, /longer than 64 KiB/);
    }
    assert.ok(!/lena/.test(cli(db, ['list']).stdout), 'no user added');
    assert.strictEqual(cli(db, ['add-user', 'lena'], `${'k'.repeat(64 * 1024)}\n`).status, 0, 'exactly 64 KiB');
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

  // (the high on #520, M1) SQLite plays back a hot -journal beside the
  // database at open, whoever made it: a store is used only in a directory
  // no one else can write in, and with side files that are this user's own
  // and owner-only
  (POSIX ? it : it.skip)('a DB in a directory others can write in is refused, sticky or not, naming the directory', () => {
    for (const mode of [0o770, 0o775, 0o1777]) {
      const shared = path.join(dir, `shared-${mode.toString(8)}`);
      fs.mkdirSync(shared);
      fs.chmodSync(shared, mode);
      const db = path.join(shared, 'users.sqlite3');
      const r = cli(db, ['add-user', 'alice'], `${KEY}\n`);
      assert.notStrictEqual(r.status, 0, `${mode.toString(8)}: ${r.stderr}`);
      assert.match(r.stderr, /group or others can write in it/, r.stderr);
      // (a shared, sticky directory is never to be chmod-ed: the store moves)
      if ((mode & 0o1000) !== 0) assert.match(r.stderr, /move it to a directory only this user can write in/, r.stderr);
      else assert.match(r.stderr, /chmod go-w/, r.stderr);
      assert.ok(!fs.existsSync(db), 'no store made there');
      const SqliteAuthProvider = require('../../lib/auth/sqlite-provider');
      assert.throws(() => new SqliteAuthProvider({dbPath: db}), (e) => e.code === 'AUTH_CONFIG_INVALID' && /group or others can write in it/.test(e.message));
    }
  });

  // (the round's medium) every directory above it too: one another user can
  // write in (not sticky) lets them rename the store's directory away
  (POSIX ? it : it.skip)('a DB under a directory others can write in, at any depth, is refused', () => {
    const up = path.join(dir, 'up-shared');
    fs.mkdirSync(path.join(up, 'mine'), {recursive: true});
    // (others may write in it, and it is not sticky; a directory only this
    // user's own primary group may write in is fine above the store)
    fs.chmodSync(up, 0o777);
    fs.chmodSync(path.join(up, 'mine'), 0o700);
    const r = cli(path.join(up, 'mine', 'users.sqlite3'), ['add-user', 'alice'], `${KEY}\n`);
    assert.notStrictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /up-shared/, r.stderr);
    fs.chmodSync(up, 0o700);
  });

  (POSIX ? it : it.skip)('a side file (-journal, -wal, -shm) that is loose or a link is refused, so none is played back', () => {
    for (const side of ['-journal', '-wal', '-shm']) {
      const db = path.join(dir, `side${side}.sqlite3`);
      assert.strictEqual(cli(db, ['add-user', 'alice'], `${KEY}\n`).status, 0);
      fs.writeFileSync(db + side, 'planted', {mode: 0o644});
      fs.chmodSync(db + side, 0o644);
      const r = cli(db, ['list']);
      assert.notStrictEqual(r.status, 0, side);
      assert.match(r.stderr, new RegExp(`${side}.*accessible by group or others`), r.stderr);
      fs.unlinkSync(db + side);
      fs.symlinkSync(path.join(dir, 'elsewhere'), db + side);
      assert.match(cli(db, ['list']).stderr, /symbolic link/, side);
      fs.unlinkSync(db + side);
    }
  });

  // (the high's L4) a `file:` name is a file to node-sqlite3, so it is checked
  // and made owner-only as any other
  (POSIX ? it : it.skip)('a --dbPath starting file: is a file, made owner-only', () => {
    const r = spawnSync(process.execPath, [CLI, '--dbPath', 'file:keys.db', 'add-user', 'alice'], {cwd: dir, encoding: 'utf8', input: `${KEY}\n`, timeout: 20000});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.statSync(path.join(dir, 'file:keys.db')).mode & 0o777, 0o600);
  });

  // (the high's L5) the key given as an argument too is refused, never stored
  // as a name nor echoed
  it('an argument equal to the key on stdin is refused, never stored or echoed', () => {
    const db = path.join(dir, 'twice.sqlite3');
    for (const arg of [KEY, ` ${KEY}`, `${KEY}-alice`]) {
      const a = cli(db, ['add-user', arg], `${KEY}\n`);
      assert.notStrictEqual(a.status, 0, JSON.stringify(arg));
      assert.ok(!`${a.stdout}${a.stderr}`.includes(KEY));
    }
    const r = cli(db, ['add-user', KEY], `${KEY}\n`);
    assert.notStrictEqual(r.status, 0);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(KEY), r.stdout + r.stderr);
    assert.match(r.stderr, /holds the API key/);
    assert.ok(!cli(db, ['list']).stdout.includes(KEY));
  });

  // (the high's F9a) --dbPath with no value is a usage error
  it('--dbPath with no value is a usage error, not a crash', () => {
    const r = spawnSync(process.execPath, [CLI, 'list', '--dbPath'], {encoding: 'utf8', timeout: 20000});
    assert.strictEqual(r.status, 1, r.stderr);
    assert.match(r.stderr, /^Usage:/m);
    assert.ok(!/TypeError|\n\s+at /.test(r.stderr), r.stderr);
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
