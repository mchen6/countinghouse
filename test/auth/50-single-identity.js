'use strict';

// LM1 B4 (plan 2026-11-11-lm1-store-and-identity.md, Task 7; spec section
// 4): the single-identity profile. --store local --stdio without
// --authConfigPath keeps one generated key and its binding in memory, writes
// no auth file and no key anywhere, and derives ctx.caller.id from the
// identity secret under <storePath> and the fixed source "local", so the id
// survives restarts while the key changes per process.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const LIB = path.join(ROOT, 'lib');

function child(body) {
  const run = spawnSync(process.execPath, ['-e', `
    const lib = (f) => require(require('path').join(${JSON.stringify(LIB)}, f));
    (async () => { const out = await (async () => { ${body} })(); process.stdout.write(JSON.stringify(out)); process.exit(0); })()
      .catch((e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });
  `], {cwd: ROOT, encoding: 'utf8', timeout: 30000});
  assert.strictEqual(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((d) => d.isDirectory() ? filesUnder(path.join(dir, d.name)) : [path.join(dir, d.name)]);
}
const TENANT_WORDS = /\b(key|keys|balance|free call|free calls|rate limit)\b/i;

describe('auth 50: the single-identity profile (LM1 B4)', function() {
  this.timeout(60000);

  it('is on for --store local --stdio without --authConfigPath only, with a key kept out of every options copy', () => {
    const cases = [
      [{store: 'local', stdio: true}, true],
      [{store: 'local', stdio: true, authConfigPath: '/x/auth.json'}, false],
      [{store: 'local'}, false],
      [{store: 'redis', stdio: true}, false]
    ];
    for (const [argv, on] of cases) {
      const out = child(`
        const options = lib('cli-options');
        options.setOptions(${JSON.stringify(argv)});
        return {single: options.singleIdentity, key: options.apiKey == null ? null : options.apiKey,
          inOptions: JSON.stringify(options.getOptions()).includes(String(options.apiKey)),
          inWorker: JSON.stringify(options.getOptionsForWorker()).includes(String(options.apiKey))};
      `);
      assert.strictEqual(out.single, on, JSON.stringify(argv));
      if (on) {
        assert.ok(/^local-[0-9a-f]{32}$/.test(out.key), out.key);
        assert.strictEqual(out.inOptions, false);
        assert.strictEqual(out.inWorker, false);
      } else assert.strictEqual(out.key, null, JSON.stringify(argv));
    }
  });

  it('the memory provider: the key passes for every device, any other is refused with no key or tenant word in the text', async () => {
    const MemoryAuthProvider = require('../../lib/auth/memory-provider');
    const p = new MemoryAuthProvider({apiKey: 'local-abc'});
    const call = (m, ...a) => new Promise((resolve) => p[m](...a, (err, r) => resolve({err, r})));
    assert.deepStrictEqual((await call('authenticate', 'local-abc', 'any-device', 's', 'a')).r, {ok: true, userName: 'local', isAdmin: false, err: null});
    const refused = (await call('authenticate', 'someone-elses-secret', 'any-device', 's', 'a')).r;
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.err.code, 'SYSTEM_ERROR_UNKNOWN_USER');
    assert.ok(!refused.err.message.includes('someone-elses-secret'), refused.err.message);
    assert.ok(!TENANT_WORDS.test(refused.err.message), refused.err.message);
    assert.deepStrictEqual((await call('listDevices', 'local-abc')).r, {devices: ['*']});
    assert.deepStrictEqual((await call('listDevices', 'other')).r, {devices: []});
    assert.deepStrictEqual((await call('identityForModule', 'any-module')).r, {apiKey: 'local-abc', conflicts: null});
    assert.deepStrictEqual((await call('entries')).r, [{apiKey: 'local-abc', userName: 'local', isAdmin: false, id: 'local'}]);
    assert.strictEqual((await call('reload')).r.ok, true);
  });

  it('the profile picks the memory provider; --meter with an auth file keeps the file provider', () => {
    const authFile = path.join(tmp('ch-auth-50-'), 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({'operator-key-0001': {userName: 'operator', devices: ['*']}}));
    const out = child(`
      const options = lib('cli-options');
      options.setOptions({store: 'local', stdio: true});
      const a = lib('auth').createAuthProvider().constructor.name;
      options.setOptions({store: 'local', stdio: true, meter: true, authConfigPath: ${JSON.stringify(authFile)}});
      const b = lib('auth').createAuthProvider().constructor.name;
      return {a, b};
    `);
    assert.deepStrictEqual(out, {a: 'MemoryAuthProvider', b: 'FileAuthProvider'});
  });

  function startProfile(storePath, moduleDataPath) {
    return child(`
      const options = lib('cli-options');
      options.setOptions({store: 'local', stdio: true, storePath: ${JSON.stringify(storePath)}, moduleDataPath: ${JSON.stringify(moduleDataPath)}});
      const identity = lib('identity');
      identity.initSync(options);
      const provider = lib('auth').getAuthProvider();
      await identity.rebuild(provider);
      return {key: options.apiKey, id: identity.idForKey(options.apiKey)};
    `);
  }

  it('the caller id is the same across two starts, though the key changes, and changes with the identity secret', () => {
    const storePath = path.join(tmp('ch-auth-50-'), 'store');
    const moduleDataPath = path.join(tmp('ch-auth-50-'), 'module_data');
    const first = startProfile(storePath, moduleDataPath);
    const second = startProfile(storePath, moduleDataPath);
    assert.notStrictEqual(first.key, second.key);
    assert.strictEqual(first.id, second.id);
    assert.ok(/^u_/.test(first.id), first.id);
    const secret = path.join(storePath, '.identity-secret');
    assert.strictEqual(fs.statSync(secret).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(moduleDataPath, '.identity-secret')));
    fs.unlinkSync(secret);
    assert.notStrictEqual(startProfile(storePath, moduleDataPath).id, first.id);
    for (const f of filesUnder(storePath).concat(filesUnder(moduleDataPath))) {
      assert.ok(!/auth\.json$/.test(f), f);
      const text = fs.readFileSync(f, 'utf8');
      for (const k of [first.key, second.key]) assert.ok(!text.includes(k), f);
    }
  });

  it('the identity secret under <storePath> is always denied to modules', () => {
    const out = child(`
      const {deniedPathsFor} = lib('fs-broker/denied');
      return deniedPathsFor({store: 'local', singleIdentity: true, storePath: '/s/store', moduleDataPath: '/s/module_data', authConfigPath: null});
    `);
    assert.ok(out.includes('/s/store/.identity-secret'), JSON.stringify(out));
  });
});

// The review of B4 (/code-review medium on 20af44b).
describe('auth 50: the review of B4', function() {
  this.timeout(60000);

  it('the secret moves to <storePath> in the profile only: a multi-tenant --store local keeps <moduleDataPath>\'s', () => {
    const storePath = path.join(tmp('ch-auth-50r-'), 'store');
    const moduleDataPath = path.join(tmp('ch-auth-50r-'), 'module_data');
    const authFile = path.join(tmp('ch-auth-50r-'), 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({'operator-key-0002': {userName: 'operator', devices: ['*']}}));
    child(`
      const options = lib('cli-options');
      options.setOptions({store: 'local', storePath: ${JSON.stringify(storePath)}, moduleDataPath: ${JSON.stringify(moduleDataPath)}, authConfigPath: ${JSON.stringify(authFile)}});
      lib('identity').initSync(options);
      return {};
    `);
    assert.ok(fs.existsSync(path.join(moduleDataPath, '.identity-secret')));
    assert.ok(!fs.existsSync(path.join(storePath, '.identity-secret')));
    const denied = child(`return lib('fs-broker/denied').deniedPathsFor({store: 'local', storePath: '/s/store', moduleDataPath: '/s/md', authConfigPath: '/s/auth.json'});`);
    assert.ok(!denied.includes('/s/store/.identity-secret'), JSON.stringify(denied));
  });

  it('an explicit --authProvider, or an --authConfigPath with no path, turns the profile off', () => {
    for (const argv of [{store: 'local', stdio: true, authProvider: 'sqlite'}, {store: 'local', stdio: true, authConfigPath: ''},
      {store: 'local', stdio: true, authConfigPath: true}]) {
      const out = child(`const o = lib('cli-options'); o.setOptions(${JSON.stringify(argv)}); return {single: o.singleIdentity};`);
      assert.strictEqual(out.single, false, JSON.stringify(argv));
    }
  });

  it('a bare or empty --authConfigPath refuses to start', () => {
    for (const value of [[], ['']]) {
      const run = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--workerThread', '--bindAddr', '127.0.0.1', '--port', '9696',
        '--authConfigPath'].concat(value), {cwd: ROOT, encoding: 'utf8', timeout: 20000});
      assert.strictEqual(run.status, 2, run.stderr);
      assert.ok(/--authConfigPath needs a path/.test(run.stderr), run.stderr);
    }
  });

  it('the key is made once and cannot be replaced', () => {
    const out = child(`
      const o = lib('cli-options');
      o.setOptions({store: 'local', stdio: true});
      const first = o.apiKey;
      o.setOptions({store: 'local', stdio: true});
      let assigned = true;
      try { 'use strict'; o.apiKey = 'other'; } catch (e) { assigned = false; }
      return {same: o.apiKey === first, kept: o.apiKey === first};
    `);
    assert.deepStrictEqual(out, {same: true, kept: true});
  });

  it('under --debug the profile still indexes its stable entry, so the caller id does not follow the key', () => {
    const out = child(`
      const o = lib('cli-options');
      o.setOptions({store: 'local', stdio: true, debug: true});
      return {source: lib('auth').identitySource(o) != null};
    `);
    assert.deepStrictEqual(out, {source: true});
    const plain = child(`const o = lib('cli-options'); o.setOptions({debug: true}); return {source: lib('auth').identitySource(o) != null};`);
    assert.deepStrictEqual(plain, {source: false});
  });

  it('a module may not declare the store directory, and --hardened grants and creates it', () => {
    const storePath = path.join(tmp('ch-auth-50r-'), 'store');
    const out = child(`
      const options = {store: 'local', storePath: ${JSON.stringify(storePath)}, modulePath: ${JSON.stringify(tmp('ch-auth-50m-'))},
        moduleDataPath: ${JSON.stringify(tmp('ch-auth-50d-'))}, authProvider: 'file', debug: false};
      const prot = lib('fs-broker').protectedPaths(options);
      const hl = lib('hardened-launch');
      hl.prepareGrants(options, process.cwd());
      const flags = hl.permissionFlags(options, ${JSON.stringify(ROOT)}, process.cwd());
      return {prot: prot.includes(${JSON.stringify(storePath)}), created: require('fs').existsSync(${JSON.stringify(storePath)}),
        read: flags.some((f) => f.startsWith('--allow-fs-read=') && f.includes(${JSON.stringify(storePath)})),
        write: flags.some((f) => f.startsWith('--allow-fs-write=') && f.includes(${JSON.stringify(storePath)}))};
    `);
    assert.deepStrictEqual(out, {prot: true, created: true, read: true, write: true});
  });

  it('--apiMonitor under --store local logs nothing and does not throw (the API log is absent)', () => {
    const out = child(`
      const options = lib('cli-options');
      options.setOptions({store: 'local', apiMonitor: true});
      const Session = lib('session');
      const s = Object.create(Session.prototype);
      s.serviceID = 'svc'; s.actionName = 'act'; s.deviceID = 'd'; s.appKey = 'k'; s.startTime = Date.now();
      s.device = {spec: {device: {serviceList: {svc: {actionList: [{name: 'act'}]}}}}};
      Session.prototype.logAPICall.call(s, null, null, null, true);
      return {ok: true};
    `);
    assert.deepStrictEqual(out, {ok: true});
  });
});
