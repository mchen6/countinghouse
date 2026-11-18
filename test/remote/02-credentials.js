// RC1-min (spec sections 2 and 3): the operator's --remoteCredentials
// allowance, and the credential a remote is called with. A module cannot
// choose where a credential goes: a declared variable is read only where
// the allowance names it for the declared URL's exact origin.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {parseRemotes} = require('../../lib/remote/declaration');
const {loadAllowance, resolveCredential} = require('../../lib/remote/credentials');
const {testPort} = require('../helpers/test-env');

// Synthetic and low-entropy, built here, never a realistic literal.
const TOKEN = `ghp_${'A'.repeat(36)}`;
const OTHER = `ghp_${'B'.repeat(36)}`;

const remoteFor = (url, credential) => {
  const r = parseRemotes({name: 'm', countinghouse: {remotes: [{name: 'gh', transport: 'streamable-http', url: url, credential: credential}]}},
    {debug: true, redisEndpoint: {host: '127.0.0.1', port: 6379}});
  assert.deepStrictEqual(r.problems, []);
  return r.remotes[0];
};
const GH = remoteFor('https://api.githubcopilot.com/mcp/', {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN'});
const allowance = (obj) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02-')), 'remote-credentials.json');
  fs.writeFileSync(file, typeof(obj) === 'string' ? obj : JSON.stringify(obj));
  return loadAllowance(file);
};
const ALLOWED = () => allowance({'https://api.githubcopilot.com': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']});

describe('remote 02: the credential allowance', () => {
  it('reads env when allowed for the exact origin', () => {
    const c = resolveCredential(GH, {COUNTINGHOUSE_GITHUB_TOKEN: TOKEN, GITHUB_TOKEN: OTHER}, ALLOWED());
    assert.deepStrictEqual(c, {header: 'Authorization', value: `Bearer ${TOKEN}`, source: 'COUNTINGHOUSE_GITHUB_TOKEN'});
  });

  it('reads fallbackEnv when env is unset or empty', () => {
    for (const env of [{GITHUB_TOKEN: OTHER}, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: OTHER}]) {
      assert.deepStrictEqual(resolveCredential(GH, env, ALLOWED()), {header: 'Authorization', value: `Bearer ${OTHER}`, source: 'GITHUB_TOKEN'});
    }
  });

  it('does not read a variable allowed for another port or scheme', () => {
    for (const origin of ['https://api.githubcopilot.com:8443', 'https://githubcopilot.com']) {
      const c = resolveCredential(GH, {COUNTINGHOUSE_GITHUB_TOKEN: TOKEN}, allowance({[origin]: ['COUNTINGHOUSE_GITHUB_TOKEN']}));
      assert.deepStrictEqual(c, {missing: 'not-allowed', variable: 'COUNTINGHOUSE_GITHUB_TOKEN', origin: 'https://api.githubcopilot.com'}, origin);
      assert.ok(!JSON.stringify(c).includes(TOKEN));
    }
    // The scheme, where both are possible (a loopback origin).
    const local = remoteFor(`http://127.0.0.1:${testPort(9688)}/mcp`, {env: 'CH_TEST_REMOTE_TOKEN'});
    const c = resolveCredential(local, {CH_TEST_REMOTE_TOKEN: TOKEN}, allowance({[`https://127.0.0.1:${testPort(9688)}`]: ['CH_TEST_REMOTE_TOKEN']}));
    assert.deepStrictEqual(c, {missing: 'not-allowed', variable: 'CH_TEST_REMOTE_TOKEN', origin: `http://127.0.0.1:${testPort(9688)}`});
  });

  it('allows env and fallbackEnv one by one', () => {
    const onlyFallback = allowance({'https://api.githubcopilot.com': ['GITHUB_TOKEN']});
    assert.deepStrictEqual(resolveCredential(GH, {COUNTINGHOUSE_GITHUB_TOKEN: TOKEN, GITHUB_TOKEN: OTHER}, onlyFallback),
      {header: 'Authorization', value: `Bearer ${OTHER}`, source: 'GITHUB_TOKEN'});
  });

  it('no allowance means no credential is read', () => {
    assert.deepStrictEqual(resolveCredential(GH, {COUNTINGHOUSE_GITHUB_TOKEN: TOKEN}, null),
      {missing: 'not-allowed', variable: 'COUNTINGHOUSE_GITHUB_TOKEN', origin: 'https://api.githubcopilot.com'});
  });

  it('an allowed but unset variable is unset', () => {
    assert.deepStrictEqual(resolveCredential(GH, {}, ALLOWED()),
      {missing: 'unset', variable: 'COUNTINGHOUSE_GITHUB_TOKEN', origin: 'https://api.githubcopilot.com'});
  });

  it('a remote with no credential block has none to resolve', () => {
    assert.strictEqual(resolveCredential(remoteFor('https://example.com/mcp'), {GITHUB_TOKEN: TOKEN}, ALLOWED()), null);
  });

  it('the header and the scheme are the declaration\'s, and the scheme "" sends the bare token', () => {
    const r = remoteFor('https://api.githubcopilot.com/mcp/', {env: 'GITHUB_TOKEN', header: 'X-Api-Key', scheme: ''});
    assert.deepStrictEqual(resolveCredential(r, {GITHUB_TOKEN: TOKEN}, ALLOWED()), {header: 'X-Api-Key', value: TOKEN, source: 'GITHUB_TOKEN'});
  });

  it('loadAllowance refuses what is not the documented shape', () => {
    const bad = [
      '[]', '"x"', 'not json',
      {'https://api.githubcopilot.com/mcp': ['A']},     // a path, not an origin
      {'http://example.com': ['A']},                    // plain http, not loopback
      {'https://*.example.com': ['A']},                 // no wildcards
      {'https://example.com': 'A'},                     // not an array
      {'https://example.com': [1]},                     // not a variable name
      {'ftp://example.com': ['A']},
      {'http://127.evil.com': ['A']}                    // a name, not a loopback address (code review)
    ];
    bad.forEach((b) => assert.throws(() => allowance(b), /remoteCredentials/, JSON.stringify(b)));
  });

  it('loadAllowance accepts an http loopback origin, for the tests\' local server', () => {
    const a = allowance({[`http://127.0.0.1:${testPort(9688)}`]: ['CH_TEST_REMOTE_TOKEN']});
    assert.ok(a.get(`http://127.0.0.1:${testPort(9688)}`).has('CH_TEST_REMOTE_TOKEN'));
  });
});

// M3 (#413 sections 6.4 and 6.5): version 2 binds a credential to one
// module, through a slot (COUNTINGHOUSE_CREDENTIAL_<n>); the start's file
// fixes each slot for the life of the runtime.
describe('remote 02: version 2, by module', () => {
  const credentials = require('../../lib/remote/credentials');
  const ORIGIN = 'https://api.githubcopilot.com';
  const SLOT1 = 'COUNTINGHOUSE_CREDENTIAL_1';
  const SLOT2 = 'COUNTINGHOUSE_CREDENTIAL_2';
  const v2file = (modules) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02b-')), 'remote-credentials.json');
    fs.writeFileSync(file, typeof(modules) === 'string' ? modules : JSON.stringify({version: 2, modules: modules}));
    return file;
  };
  const load = (modules) => credentials.loadFile(v2file(modules));
  const BOUND = {'@countinghouse/ch-access-github': {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}};
  const short = (url, variable) => parseRemotes({name: 'm', countinghouse: {remotes: [{name: 'gh', url: url, credential: variable}]}},
    {debug: true, redisEndpoint: null}).remotes[0];
  const GHV2 = short(`${ORIGIN}/mcp/`, 'GITHUB_TOKEN');
  const entryOf = (loaded, name) => loaded.modules.get(name);

  it('parses version 2 into module -> origin -> variable -> slot, and the slots it fixes', () => {
    const l = load(Object.assign({}, BOUND, {'@acme/tracker-access': {'https://api.tracker.example': {TRACKER_KEY: SLOT2}}}));
    assert.strictEqual(l.version, 2);
    assert.strictEqual(entryOf(l, '@countinghouse/ch-access-github').get(ORIGIN).get('GITHUB_TOKEN'), SLOT1);
    assert.deepStrictEqual(l.slots.get(SLOT2), {module: '@acme/tracker-access', origin: 'https://api.tracker.example', variable: 'TRACKER_KEY'});
    assert.strictEqual(load({}).modules.size, 0, 'an empty version 2 file binds nothing');
  });

  it('version 1 still loads as before, through loadFile too', () => {
    const file = v2file(JSON.stringify({[ORIGIN]: ['GITHUB_TOKEN']}));
    const l = credentials.loadFile(file);
    assert.strictEqual(l.version, 1);
    assert.ok(l.origins.get(ORIGIN).has('GITHUB_TOKEN'));
    assert.ok(loadAllowance(file).get(ORIGIN).has('GITHUB_TOKEN'));
  });

  it('refuses any environment name that is not a slot, and every other malformed version 2 file, naming the file and never a value', () => {
    const bad = [
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'COUNTINGHOUSE_IDENTITY_SECRET'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'PATH'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_0'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_01'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_10000'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 'countinghouse_credential_1'}}},
      {m: {[ORIGIN]: {GITHUB_TOKEN: 1}}},
      {m: {[ORIGIN]: {'NOT A VAR': SLOT1}}},
      {m: {[ORIGIN]: ['GITHUB_TOKEN']}},
      {m: {[`${ORIGIN}/mcp`]: {GITHUB_TOKEN: SLOT1}}},
      {m: {'http://example.com': {GITHUB_TOKEN: SLOT1}}},
      {m: {'https://*.example.com': {GITHUB_TOKEN: SLOT1}}},
      {'Bad Name': {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}},
      {'@scope': {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}},
      {'../x': {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}},
      {m: []},
      {a: {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}, b: {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}},       // one slot for two bindings
      {a: {[ORIGIN]: {A: SLOT1, B: SLOT1}}}
    ];
    bad.forEach((b) => assert.throws(() => load(b), (e) => /--remoteCredentials/.test(e.message), JSON.stringify(b)));
    const shapes = ['{"version": 2}', '{"version": 2, "modules": []}', '{"version": 3, "modules": {}}', '{"version": 2, "modules": {}, "x": 1}',
      '{"version": "2", "modules": {}}'];
    shapes.forEach((t) => assert.throws(() => credentials.loadFile(v2file(t)), /--remoteCredentials/, t));
  });

  it('a pack\'s own file (loadAllowance) is version 1 only', () => {
    assert.throws(() => loadAllowance(v2file(BOUND)), /version 2/);
  });

  it('resolves only the module\'s own binding: the bound module sends its slot\'s value, under its declared header', () => {
    const l = load(BOUND);
    const env = {[SLOT1]: TOKEN, GITHUB_TOKEN: OTHER};
    assert.deepStrictEqual(credentials.resolveModuleCredential(GHV2, env, entryOf(l, '@countinghouse/ch-access-github'), '@countinghouse/ch-access-github'),
      {header: 'Authorization', value: `Bearer ${TOKEN}`, source: 'GITHUB_TOKEN'});
  });

  it('a second module declaring the same variable and origin gets nothing: no binding names it', () => {
    const l = load(BOUND);
    const c = credentials.resolveModuleCredential(GHV2, {[SLOT1]: TOKEN, GITHUB_TOKEN: OTHER}, entryOf(l, '@evil/copycat'), '@evil/copycat');
    assert.deepStrictEqual(c, {missing: 'not-allowed', why: 'unbound', variable: 'GITHUB_TOKEN', origin: ORIGIN});
  });

  it('another origin, or another variable, of the bound module gets nothing: the binding is elsewhere', () => {
    const l = load(BOUND);
    const e = entryOf(l, '@countinghouse/ch-access-github');
    const env = {[SLOT1]: TOKEN, OTHER_TOKEN: OTHER};
    assert.deepStrictEqual(credentials.resolveModuleCredential(short('https://api.example.com/mcp', 'GITHUB_TOKEN'), env, e, 'x'),
      {missing: 'not-allowed', why: 'elsewhere', variable: 'GITHUB_TOKEN', origin: 'https://api.example.com'});
    assert.deepStrictEqual(credentials.resolveModuleCredential(short(`${ORIGIN}/mcp/`, 'OTHER_TOKEN'), env, e, 'x'),
      {missing: 'not-allowed', why: 'elsewhere', variable: 'OTHER_TOKEN', origin: ORIGIN});
  });

  it('two modules with one variable name and two values each send their own', () => {
    const l = load({a: {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}, b: {[ORIGIN]: {GITHUB_TOKEN: SLOT2}}});
    const env = {[SLOT1]: TOKEN, [SLOT2]: OTHER};
    assert.strictEqual(credentials.resolveModuleCredential(GHV2, env, entryOf(l, 'a'), 'a').value, `Bearer ${TOKEN}`);
    assert.strictEqual(credentials.resolveModuleCredential(GHV2, env, entryOf(l, 'b'), 'b').value, `Bearer ${OTHER}`);
  });

  it('an empty slot is unset; a fallbackEnv is never read under version 2', () => {
    const l = load(BOUND);
    const e = entryOf(l, '@countinghouse/ch-access-github');
    assert.deepStrictEqual(credentials.resolveModuleCredential(GHV2, {[SLOT1]: ''}, e, 'x'),
      {missing: 'unset', variable: 'GITHUB_TOKEN', origin: ORIGIN});
    const withFallback = remoteFor(`${ORIGIN}/mcp/`, {env: 'GITHUB_TOKEN', fallbackEnv: 'COUNTINGHOUSE_GITHUB_TOKEN'});
    const both = load({m: {[ORIGIN]: {GITHUB_TOKEN: SLOT1, COUNTINGHOUSE_GITHUB_TOKEN: SLOT2}}});
    assert.deepStrictEqual(credentials.resolveModuleCredential(withFallback, {[SLOT2]: OTHER}, entryOf(both, 'm'), 'm'),
      {missing: 'unset', variable: 'GITHUB_TOKEN', origin: ORIGIN});
    // only the fallback is bound: still nothing is sent
    const onlyFallback = load({m: {[ORIGIN]: {COUNTINGHOUSE_GITHUB_TOKEN: SLOT2}}});
    assert.deepStrictEqual(credentials.resolveModuleCredential(withFallback, {[SLOT2]: OTHER}, entryOf(onlyFallback, 'm'), 'm'),
      {missing: 'not-allowed', why: 'elsewhere', variable: 'GITHUB_TOKEN', origin: ORIGIN});
  });

  it('the result carries the value only where it is sent', () => {
    const l = load(BOUND);
    for (const name of ['@countinghouse/ch-access-github', '@evil/copycat']) {
      const c = credentials.resolveModuleCredential(short('https://api.example.com/mcp', 'GITHUB_TOKEN'), {[SLOT1]: TOKEN}, entryOf(l, name), name);
      assert.ok(!JSON.stringify(c).includes(TOKEN), name);
    }
  });

  describe('the start\'s file fixes the slots', () => {
    let saved = null;
    beforeEach(() => { saved = credentials.snapshot(); credentials.configure(v2file(Object.assign({}, BOUND, {b: {'https://api.b.example': {B_KEY: SLOT2}}}))); });
    afterEach(() => credentials.restore(saved));

    it('the start\'s bindings are each module\'s allowance', () => {
      assert.strictEqual(credentials.version(), 2);
      assert.strictEqual(credentials.allowance(), null, 'no process-wide (version 1) allowance under version 2');
      assert.strictEqual(credentials.moduleEntry('@countinghouse/ch-access-github').get(ORIGIN).get('GITHUB_TOKEN'), SLOT1);
      assert.strictEqual(credentials.moduleEntry('@evil/copycat'), undefined);
    });

    it('a later entry that repeats the start\'s is taken; it is set and dropped by module', () => {
      const m = credentials.checkEntry('b', {'https://api.b.example': {B_KEY: SLOT2}});
      assert.strictEqual(m.get('https://api.b.example').get('B_KEY'), SLOT2);
      credentials.dropModule('b');
      assert.strictEqual(credentials.moduleEntry('b'), undefined);
      credentials.setModule('b', m);
      assert.strictEqual(credentials.moduleEntry('b').get('https://api.b.example').get('B_KEY'), SLOT2);
    });

    it('a later entry naming a slot the start did not name, or one named for another module, variable or origin, is refused', () => {
      const refused = [
        ['b', {'https://api.b.example': {B_KEY: 'COUNTINGHOUSE_CREDENTIAL_3'}}],
        ['b', {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}],                              // the slot of another module
        ['b', {'https://api.b.example': {OTHER_KEY: SLOT2}}],                  // another variable
        ['b', {'https://api.other.example': {B_KEY: SLOT2}}],                  // another origin
        ['@evil/copycat', {[ORIGIN]: {GITHUB_TOKEN: SLOT1}}],
        ['b', {'https://api.b.example': {B_KEY: 'PATH'}}],
        ['b', {'https://api.b.example': ['B_KEY']}]
      ];
      refused.forEach(([name, obj]) => assert.throws(() => credentials.checkEntry(name, obj), JSON.stringify([name, obj])));
    });

    it('a shared runtime compares a session\'s credential on no name the start adds under version 2 (route-manager credentialVariables)', () => {
      const {credentialVariables} = require('../../lib/route-manager');
      const pack = {packsInPlace: new Map([['p', {allowance: new Map([['https://x.example', new Set(['X_KEY'])]])}]])};
      assert.deepStrictEqual([...credentialVariables(null)], []);
      assert.deepStrictEqual([...credentialVariables(pack)], [], 'a pack\'s own version 1 file is not used under version 2: it adds no name');
      // the same pack under a version 1 start still adds its names
      const v2 = credentials.snapshot();
      try {
        credentials.configure(v2file(JSON.stringify({[ORIGIN]: ['GITHUB_TOKEN']})));
        assert.deepStrictEqual([...credentialVariables(pack)].sort(), ['GITHUB_TOKEN', 'X_KEY']);
      } finally {
        credentials.restore(v2);
      }
    });

    it('the names an allowance reads from: the slots under version 2, and no pack\'s version 1 names (never used there)', () => {
      assert.deepStrictEqual([...credentials.namesReadFrom([])].sort(), [SLOT1, SLOT2]);
      assert.deepStrictEqual([...credentials.namesReadFrom([new Map([['https://x.example', new Set(['X_KEY'])]])])].sort(), [SLOT1, SLOT2]);
    });
  });

  it('the names an allowance reads from: under version 1, the start\'s variables and each extra (a pack\'s) allowance\'s', () => {
    const saved = credentials.snapshot();
    try {
      credentials.configure(v2file(JSON.stringify({[ORIGIN]: ['GITHUB_TOKEN']})));
      assert.deepStrictEqual([...credentials.namesReadFrom([new Map([['https://x.example', new Set(['X_KEY'])]])])].sort(), ['GITHUB_TOKEN', 'X_KEY']);
    } finally {
      credentials.restore(saved);
    }
  });
});

describe('remote 02: the allowance at start', function() {
  this.timeout(30000);
  const {spawnSync} = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const start = (args) => spawnSync(process.execPath, ['framework.js', '--no-workerThread', '--debug', '--port', String(testPort(9689))].concat(args),
    {cwd: ROOT, encoding: 'utf8', timeout: 20000});

  it('a malformed --remoteCredentials file stops the start, naming the file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02-')), 'bad.json');
    fs.writeFileSync(file, JSON.stringify({'https://example.com/mcp': ['A']}));
    const r = start(['--remoteCredentials', file]);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('--remoteCredentials') && r.stderr.includes(file), r.stderr);
  });

  it('a version 2 file whose environment name is not a slot stops the start (M3)', () => {
    for (const name of ['COUNTINGHOUSE_IDENTITY_SECRET', 'PATH', 'COUNTINGHOUSE_CREDENTIAL_0']) {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02-')), 'v2.json');
      fs.writeFileSync(file, JSON.stringify({version: 2, modules: {m: {'https://api.githubcopilot.com': {GITHUB_TOKEN: name}}}}));
      const r = start(['--remoteCredentials', file]);
      assert.strictEqual(r.status, 2, `${name}: ${r.stderr}`);
      assert.ok(r.stderr.includes('--remoteCredentials') && r.stderr.includes(file), r.stderr);
    }
  });

  it('--remoteCredentials with no file stops the start', () => {
    const r = start(['--remoteCredentials']);
    assert.strictEqual(r.status, 2, r.stderr);
  });

  it('an all-digit file path is a path, not a number (code review)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02n-'));
    fs.writeFileSync(path.join(dir, '123'), JSON.stringify({'https://example.com/mcp': ['A']}));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--port', String(testPort(9689)), '--remoteCredentials', '123'],
      {cwd: dir, encoding: 'utf8', timeout: 20000});
    assert.strictEqual(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('is not an origin'), `read the file, not "needs a file": ${r.stderr}`);
  });

  it('the remote options survive getOptions, as a worker receives them (code review)', () => {
    const cli = require('../../lib/cli-options');
    cli.setOptions({workerThread: false, remoteCredentials: '/x/allow.json', remoteTimeout: 5, remoteMaxBytes: 1024});
    const round = cli.getOptions();
    assert.deepStrictEqual([round.remoteCredentials, round.remoteTimeout, round.remoteMaxBytes], ['/x/allow.json', 5, 1024]);
    cli.setOptions(round);
    assert.deepStrictEqual([cli.remoteCredentials, cli.remoteTimeout, cli.remoteMaxBytes], ['/x/allow.json', 5, 1024]);
    cli.setOptions({workerThread: false});
  });

  it('a limit that is not a positive number stops the start', () => {
    for (const [flag, value] of [['--remoteTimeout', '0'], ['--remoteMaxBytes', 'lots']]) {
      const r = start([flag, value]);
      assert.strictEqual(r.status, 2, `${flag} ${value}: ${r.stderr}`);
      assert.ok(r.stderr.includes(flag), r.stderr);
    }
  });
});

describe('remote 02: countinghouse-validate reads the declaration', () => {
  require('../../lib/cli-options').setOptions({workerThread: false});
  const moduleValidator = require('../../lib/module-validator');
  const withRemotes = (remotes) => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02v-')), 'm');
    fs.cpSync(path.join(__dirname, '..', 'fixtures', 'compose-caller'), dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {remotes: remotes});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };
  const remotesProblems = (dir) => new Promise((resolve, reject) => moduleValidator.validateModule(dir, (err, result) =>
    (err != null ? reject(err) : resolve(result.problems.filter((p) => p.stage === 'countinghouse.remotes')))));

  it('reports a bad declaration', async () => {
    const problems = await remotesProblems(withRemotes([{name: 'gh', transport: 'streamable-http', url: 'http://example.com/mcp'}]));
    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.ok(problems[0].message.includes('remotes[0].url'), problems[0].message);
  });

  it('accepts the first pack\'s declaration', async () => {
    const problems = await remotesProblems(withRemotes([{name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
      headers: {'X-MCP-Toolsets': 'actions,repos'},
      credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}}]));
    assert.deepStrictEqual(problems, []);
  });
});
