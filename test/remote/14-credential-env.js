// M3 (module-level configuration, #413 section 6.5, the security review's
// B1): a worker is never given, from the runtime's own environment, a
// variable a credentials allowance in force reads a value from -- under
// version 1 the listed names (a module that declares GITHUB_TOKEN in
// permissions.env was handed the operator's token under audit), under
// version 2 the slots, which the COUNTINGHOUSE_ prefix already covers.
// The one exemption: a value the operator's --modulePolicy sets for that
// module under that name is the operator's own, and is given. A
// COUNTINGHOUSE_* name stays denied whatever the policy says.
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');

const NAME = 'deny-probe';
const SLOT1 = 'COUNTINGHOUSE_CREDENTIAL_1';
// Synthetic, built here.
const SERVER_TOKEN = `ghp_${'E'.repeat(36)}`;
const SLOT_VALUE = `ghp_${'F'.repeat(36)}`;

// The deny probe, declaring `env` and nothing on the file system.
function probe(env) {
  const dir = path.join(tmpDirs.mkdtemp('ch-remote-14-'), NAME);
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'deny-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.permissions = {env: env};
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}
const policyFile = (entry) => {
  const file = path.join(tmpDirs.mkdtemp('ch-remote-14p-'), 'policy.json');
  fs.writeFileSync(file, JSON.stringify({modules: {[NAME]: entry}}));
  return file;
};

// this file's temporary trees, under test/.tmp and removed
// (test/helpers/test-tmp.js forFile); nothing left in os.tmpdir()
const tmpDirs = require('../helpers/test-tmp').forFile(['ch-remote-14']);

describe('remote 14: a name a credentials allowance reads is never copied to a worker', () => {
  tmpDirs.hooks();
  const {build} = require('../../lib/module-sandbox-config');
  const SERVER_ENV = {GITHUB_TOKEN: SERVER_TOKEN, [SLOT1]: SLOT_VALUE, PLAIN: 'plain'};
  const READS = new Set(['GITHUB_TOKEN', SLOT1]);
  let dir = null;
  before(() => { dir = probe(['GITHUB_TOKEN', SLOT1, 'PLAIN']); });
  const built = (mode, policy, credentialNames) => build(dir, NAME, {mode: mode, modulePolicy: policy, serverEnv: SERVER_ENV, redisUrl: null,
    credentialNames: credentialNames});

  const cases = [
    ['audit, no policy', 'audit', () => null],
    ['enforce, approved as declared', 'enforce', () => policyFile({approve: 'as-declared'})],
    ['audit, the names granted in the policy without a value', 'audit', () => policyFile({env: {GITHUB_TOKEN: true, [SLOT1]: true, PLAIN: true}})]
  ];
  cases.forEach(([label, mode, policy]) => {
    it(`${label}: neither value is given, each denial is noted, and an unrelated name still is`, () => {
      const c = built(mode, policy(), READS);
      assert.deepStrictEqual(c.workerOptions.env, {PLAIN: 'plain'});
      assert.ok(c.notes.some((n) => n === 'env GITHUB_TOKEN denied: a credentials allowance reads it; only a value --modulePolicy sets for this module is given'),
        JSON.stringify(c.notes));
      assert.ok(c.notes.some((n) => n.startsWith(`env ${SLOT1} denied: COUNTINGHOUSE_*`)), JSON.stringify(c.notes));
      assert.ok(!JSON.stringify(c).includes(SERVER_TOKEN) && !JSON.stringify(c).includes(SLOT_VALUE));
    });
  });

  it('the exemption: a value the policy sets for the module under that name is given; without it, nothing', () => {
    assert.strictEqual(built('enforce', policyFile({approve: 'as-declared', env: {GITHUB_TOKEN: 'x'}}), READS).workerOptions.env.GITHUB_TOKEN, 'x');
    const c = built('audit', policyFile({env: {GITHUB_TOKEN: 'x'}}), READS);
    assert.strictEqual(c.workerOptions.env.GITHUB_TOKEN, 'x');
    assert.ok(!c.notes.some((n) => n.startsWith('env GITHUB_TOKEN denied')), JSON.stringify(c.notes));
    assert.strictEqual(built('audit', null, READS).workerOptions.env.GITHUB_TOKEN, undefined);
  });

  it('a COUNTINGHOUSE_* name set in the policy is still denied', () => {
    const c = built('audit', policyFile({env: {[SLOT1]: 'x'}}), READS);
    assert.strictEqual(c.workerOptions.env[SLOT1], undefined);
  });

  it('with no allowance reading it, a declared name is copied as before', () => {
    assert.strictEqual(built('audit', null, new Set()).workerOptions.env.GITHUB_TOKEN, SERVER_TOKEN);
    assert.strictEqual(built('audit', null, undefined).workerOptions.env.GITHUB_TOKEN, SERVER_TOKEN);
  });

  // #422 high review, 2: the migration case. A version 2 file binds
  // GITHUB_TOKEN to a slot, and the operator's GITHUB_TOKEN is still
  // exported: a module that declares it is never handed it.
  it('under version 2, a variable name the file binds is denied too, though the value is read from a slot', () => {
    const credentials = require('../../lib/remote/credentials');
    const saved = credentials.snapshot();
    const tmp = tmpDirs.mkdtemp('ch-remote-14b-');
    const file = path.join(tmp, 'allow.json');
    fs.writeFileSync(file, JSON.stringify({version: 2, modules: {'some-module': {'https://api.githubcopilot.com': {GITHUB_TOKEN: SLOT1}}}}));
    try {
      credentials.configure(file);
      const c = build(dir, NAME, {mode: 'audit', modulePolicy: null, serverEnv: SERVER_ENV, redisUrl: null,
        credentialNames: require('../../lib/module-manager').credentialNamesNow()});
      assert.deepStrictEqual(c.workerOptions.env, {PLAIN: 'plain'});
      assert.ok(c.notes.some((n) => n.startsWith('env GITHUB_TOKEN denied: a credentials allowance reads it')), JSON.stringify(c.notes));
    } finally {
      credentials.restore(saved);
      fs.rmSync(tmp, {recursive: true, force: true});
    }
  });

  it('the names at a spawn are the start\'s and every pack\'s version 1 allowance\'s (lib/module-manager.js)', () => {
    const credentials = require('../../lib/remote/credentials');
    const mmod = require('../../lib/module-manager');
    const saved = credentials.snapshot();
    const file = path.join(tmpDirs.mkdtemp('ch-remote-14a-'), 'allow.json');
    fs.writeFileSync(file, JSON.stringify({'https://api.githubcopilot.com': ['GITHUB_TOKEN']}));
    try {
      credentials.configure(file);
      mmod.packRemotes.set('some-module', new Map([['some-pack', new Map([['https://api.x.example', new Set(['X_KEY'])]])]]));
      assert.deepStrictEqual([...mmod.credentialNamesNow()].sort(), ['GITHUB_TOKEN', 'X_KEY']);
    } finally {
      mmod.packRemotes.delete('some-module');
      credentials.restore(saved);
    }
  });
});

// The probe end to end: a real worker's environment, under audit and
// enforce, with a version 1 allowance reading GITHUB_TOKEN and a slot set
// in the runtime's environment.
describe('remote 14: a worker\'s environment', function() {
  tmpDirs.hooks();
  this.timeout(120000);
  const KEY = 'remote-14-key';
  [['audit', testPort(9764)], ['enforce', testPort(9765)]].forEach(([mode, port]) => {
    describe(mode, () => {
      let server = null;
      before(async () => {
        const allow = path.join(tmpDirs.mkdtemp('ch-remote-14s-'), 'allow.json');
        fs.writeFileSync(allow, JSON.stringify({'https://api.githubcopilot.com': ['GITHUB_TOKEN']}));
        const store = tmpDirs.mkdtemp('ch-remote-14d-');
        server = await startServer(port, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleDataPath', store,
          '--moduleSandbox', mode, '--modulePolicy', policyFile({approve: 'as-declared'}), '--remoteCredentials', allow,
          '--loadModule', probe(['GITHUB_TOKEN', SLOT1])], {env: {GITHUB_TOKEN: SERVER_TOKEN, [SLOT1]: SLOT_VALUE}});
      });
      after(async () => { await stopServer(server); });

      it('neither the allowance\'s variable nor the slot reaches the worker; both denials are logged; no value is', async () => {
        for (const name of ['GITHUB_TOKEN', SLOT1]) {
          const r = await mcpCall(port, KEY, 'deny_probe_probeservice_env', {name: name});
          assert.deepStrictEqual(toolOutput(r), {present: false}, `${name}: ${JSON.stringify(r)}`);
        }
        assert.ok(server.output.includes(`module sandbox: ${NAME}: env GITHUB_TOKEN denied: a credentials allowance reads it`),
          server.output.split('\n').filter((l) => l.includes('module sandbox')).join('\n'));
        assert.ok(!server.output.includes(SERVER_TOKEN) && !server.output.includes(SLOT_VALUE));
      });
    });
  });
});
