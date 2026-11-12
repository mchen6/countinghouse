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
    const local = remoteFor('http://127.0.0.1:9688/mcp', {env: 'CH_TEST_REMOTE_TOKEN'});
    const c = resolveCredential(local, {CH_TEST_REMOTE_TOKEN: TOKEN}, allowance({'https://127.0.0.1:9688': ['CH_TEST_REMOTE_TOKEN']}));
    assert.deepStrictEqual(c, {missing: 'not-allowed', variable: 'CH_TEST_REMOTE_TOKEN', origin: 'http://127.0.0.1:9688'});
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
    const a = allowance({'http://127.0.0.1:9688': ['CH_TEST_REMOTE_TOKEN']});
    assert.ok(a.get('http://127.0.0.1:9688').has('CH_TEST_REMOTE_TOKEN'));
  });
});

describe('remote 02: the allowance at start', function() {
  this.timeout(30000);
  const {spawnSync} = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const start = (args) => spawnSync(process.execPath, ['framework.js', '--no-workerThread', '--debug', '--port', '9689'].concat(args),
    {cwd: ROOT, encoding: 'utf8', timeout: 20000});

  it('a malformed --remoteCredentials file stops the start, naming the file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02-')), 'bad.json');
    fs.writeFileSync(file, JSON.stringify({'https://example.com/mcp': ['A']}));
    const r = start(['--remoteCredentials', file]);
    assert.strictEqual(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('--remoteCredentials') && r.stderr.includes(file), r.stderr);
  });

  it('--remoteCredentials with no file stops the start', () => {
    const r = start(['--remoteCredentials']);
    assert.strictEqual(r.status, 2, r.stderr);
  });

  it('an all-digit file path is a path, not a number (code review)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-02n-'));
    fs.writeFileSync(path.join(dir, '123'), JSON.stringify({'https://example.com/mcp': ['A']}));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'framework.js'), '--no-workerThread', '--debug', '--port', '9689', '--remoteCredentials', '123'],
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
