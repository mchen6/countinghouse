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
      return deniedPathsFor({store: 'local', storePath: '/s/store', moduleDataPath: '/s/module_data', authConfigPath: null});
    `);
    assert.ok(out.includes('/s/store/.identity-secret'), JSON.stringify(out));
  });
});
