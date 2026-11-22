// M3 (module-level configuration, #413 sections 6.5 and 6.6): under a
// version 2 --remoteCredentials file a key is bound to one module. Another
// module that declares the same variable and origin gets nothing, and so
// does the bound module's own declaration of another origin or variable;
// each is said with the design's sentence and the hint for who can bind it
// (ch-local's command on a runtime with a control channel, the operator's
// file otherwise). Version 1 is unchanged (remote 02, 05).
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {toolOutput} = require('../helpers/tool-result');
const {startRemoteServer} = require('../helpers/remote-mcp-server');

// Synthetic and low-entropy, built here, never a realistic literal.
const TOKEN = `ghp_${'C'.repeat(36)}`;
const OTHER = `ghp_${'D'.repeat(36)}`;
const KEY = 'remote-13-key';
const REMOTE = testPort(9762);
const ORIGIN = `http://127.0.0.1:${REMOTE}`;
const SLOT1 = 'COUNTINGHOUSE_CREDENTIAL_1';

// A copy of the remote probe under another package name, its remote on this
// file's stand-in, declaring `variable`.
function probe(name, variable, url) {
  const dir = path.join(tmpDirs.mkdtemp('ch-remote-13-'), name);
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = name;
  pkg.countinghouse.remotes[0].url = (url != null) ? url : `${ORIGIN}/mcp`;
  pkg.countinghouse.remotes[0].credential = variable;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  // the tools are named after the device's friendlyName: one per copy
  const apiPath = path.join(dir, 'api.json');
  const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
  api.device.friendlyName = name;
  fs.writeFileSync(apiPath, JSON.stringify(api));
  return dir;
}
const v2file = (modules) => {
  const file = path.join(tmpDirs.mkdtemp('ch-remote-13f-'), 'remote-credentials.json');
  fs.writeFileSync(file, JSON.stringify({version: 2, modules: modules}));
  return file;
};
const BOUND = {'remote-bound': {[ORIGIN]: {CH_TEST_REMOTE_TOKEN: SLOT1}}};

// this file's temporary trees, in os.tmpdir() (a module a runtime loads
// stays outside the runtime's tree) and removed (test/helpers/test-tmp.js
// forFile); nothing left there
const tmpDirs = require('../helpers/test-tmp').forFile(['ch-remote-13'], {base: require('os').tmpdir()});

describe('remote 13: a version 2 binding, at registration', function() {
  this.timeout(30000);
  const cli = require('../../lib/cli-options');
  const credentials = require('../../lib/remote/credentials');
  const remoteRegistry = require('../../lib/remote');
  let saved = null;
  let remote = null;
  const dirs = {};
  before(async () => {
    remote = await startRemoteServer(REMOTE);
    dirs.bound = probe('remote-bound', 'CH_TEST_REMOTE_TOKEN');
    dirs.copycat = probe('remote-copycat', 'CH_TEST_REMOTE_TOKEN');
    dirs.elsewhere = probe('remote-bound', 'OTHER_TOKEN');
    dirs.newOrigin = probe('remote-bound', 'CH_TEST_REMOTE_TOKEN', 'http://127.0.0.1:9/mcp');
    saved = credentials.snapshot();
    credentials.configure(v2file(BOUND));
  });
  after(async () => {
    credentials.restore(saved);
    cli.setOptions({workerThread: false});
    for (const name of ['remote-bound', 'remote-copycat']) await remoteRegistry.unregister(name);
    await remote.close();
  });
  const operator = () => cli.setOptions({workerThread: false, debug: true});
  const chLocal = () => cli.setOptions({workerThread: false, debug: true, controlChannel: 'ipc'});

  const disabledOf = (r) => { assert.deepStrictEqual(r.problems, []); assert.strictEqual(r.disabled.length, 1, JSON.stringify(r.notes)); return r.disabled[0]; };

  it('another module that declares the same variable and origin gets nothing: "no credential is bound", with the operator\'s hint', () => {
    operator();
    const r = remoteRegistry.register('remote-copycat', dirs.copycat, {version: '1.0.0'});
    const d = disabledOf(r);
    assert.strictEqual(d.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
    assert.strictEqual(d.detail, `no credential is bound to remote-copycat for ${ORIGIN}: the operator binds it in the --remoteCredentials file`);
    assert.ok(r.notes.some((n) => n.includes(d.detail)), JSON.stringify(r.notes));
  });

  it('on a runtime with a control channel the hint is ch-local\'s command', () => {
    chLocal();
    const d = disabledOf(remoteRegistry.register('remote-copycat', dirs.copycat, {version: '1.0.0'}));
    assert.strictEqual(d.detail, `no credential is bound to remote-copycat for ${ORIGIN}: run \`ch-local credentials add remote-copycat\` at a terminal`);
  });

  it('the bound module declaring another variable at the same origin gets nothing: "under a new name", with its version', () => {
    chLocal();
    const d = disabledOf(remoteRegistry.register('remote-bound', dirs.elsewhere, {version: '1.2.0'}));
    assert.strictEqual(d.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
    assert.strictEqual(d.detail, `remote-bound 1.2.0 asks for its credential under a new name (OTHER_TOKEN) for ${ORIGIN}; it gets no key until that is allowed` +
      ': run `ch-local credentials add remote-bound` at a terminal');
  });

  it('the bound module declaring another origin gets nothing: "somewhere new", with its version', () => {
    chLocal();
    const d = disabledOf(remoteRegistry.register('remote-bound', dirs.newOrigin, {version: '1.3.0'}));
    assert.strictEqual(d.detail, 'remote-bound 1.3.0 sends its credential CH_TEST_REMOTE_TOKEN somewhere new (http://127.0.0.1:9); it gets no key until that is allowed' +
      ': run `ch-local credentials add remote-bound` at a terminal');
  });

  it('a call to a disabled remote answers the code with that sentence, and the stand-in sees nothing', async () => {
    operator();
    const before = remote.headers.length;
    remoteRegistry.register('remote-copycat', dirs.copycat, {version: '1.0.0'});
    const err = await remoteRegistry.callRemote('remote-copycat', 'probe', 'echo_text', {}, {billingKey: 'k'}).then(() => null, (e) => e);
    assert.strictEqual(err.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
    assert.ok(err.message.includes('no credential is bound to remote-copycat'), err.message);
    assert.strictEqual(remote.headers.length, before);
  });

  // (the dry run: ch-local is on no PATH) under ch-local, the refusal of a
  // call names the command through the home's launcher; built when the call
  // is refused, after the held-back list is read, never the bare form kept
  // from the registration (which may come before that read)
  it('under ch-local with its launcher known, a refused call names the command through it', async () => {
    const heldBack = require('../../lib/held-back');
    const home = fs.realpathSync.native(tmpDirs.mkdtemp('ch-remote-13h-'));
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '// launcher');
    const launcher = fs.realpathSync.native(path.join(home, 'bin', 'ch-local.js'));
    // (private as ch-local writes it, Windows' ACL included)
    require('../helpers/private-auth').writePrivate(path.join(home, 'held-back.json'), JSON.stringify({v: 1, modules: [], launcher}));
    cli.setOptions({workerThread: false, debug: true, controlChannel: 'ipc', heldBackFile: path.join(home, 'held-back.json'), settingsFile: path.join(home, 'settings.json')});
    heldBack.resetForTests();
    try {
      remoteRegistry.register('remote-copycat', dirs.copycat, {version: '1.0.0'});
      const err = await remoteRegistry.callRemote('remote-copycat', 'probe', 'echo_text', {}, {billingKey: 'k'}).then(() => null, (e) => e);
      assert.strictEqual(err.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
      assert.ok(err.message.includes(`run \`node "${launcher}" credentials add remote-copycat\` at a terminal`), err.message);
    } finally {
      heldBack.resetForTests();
    }
  });

  // Q1 (a) of the plan's review: a pack's own version 1 file is not used
  // under a version 2 start; a module the start binds uses the start's.
  it('under a version 2 start, a pack\'s version 1 allowance is never used', () => {
    operator();
    const packV1 = new Map([[ORIGIN, new Set(['CH_TEST_REMOTE_TOKEN'])]]);
    const d = disabledOf(remoteRegistry.register('remote-copycat', dirs.copycat, {version: '1.0.0', allowance: packV1}));
    assert.strictEqual(d.code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
    assert.ok(d.detail.startsWith('no credential is bound to remote-copycat'), d.detail);
    process.env[SLOT1] = TOKEN;
    try {
      const bound = remoteRegistry.register('remote-bound', dirs.bound, {version: '1.0.0', allowance: new Map()});
      assert.deepStrictEqual(bound.disabled, [], JSON.stringify(bound.notes));
      assert.ok(bound.notes.some((n) => n.includes(`sends CH_TEST_REMOTE_TOKEN to ${ORIGIN}`)), JSON.stringify(bound.notes));
    } finally {
      delete process.env[SLOT1];
    }
  });
  tmpDirs.hooks();
});

describe('remote 13: a version 2 binding, end to end', function() {
  this.timeout(120000);
  const PORT = testPort(9763);
  let remote = null;
  let server = null;
  let dirs = null;
  const tool = (module, action) => `${module.replace(/-/g, '_')}_probeservice_${action.toLowerCase()}`;
  const call = (module, action, input) => mcpCall(PORT, KEY, tool(module, action), input).then(toolOutput);
  before(async () => {
    remote = await startRemoteServer(REMOTE);
    dirs = {bound: probe('remote-bound', 'CH_TEST_REMOTE_TOKEN'), copycat: probe('remote-copycat', 'CH_TEST_REMOTE_TOKEN')};
    server = await startServer(PORT, ['--debug', '--debugKey', KEY, '--workerThread', '--remoteCredentials', v2file(BOUND),
      '--loadModule', dirs.bound, '--loadModule', dirs.copycat],
    // the copycat's variable is set in the runtime's environment too: it is never read
    {env: {[SLOT1]: TOKEN, CH_TEST_REMOTE_TOKEN: OTHER}});
  });
  after(async () => {
    await stopServer(server);
    await remote.close();
  });

  it('the bound module\'s call carries its slot\'s value; the copycat\'s is refused and reaches nothing', async () => {
    assert.deepStrictEqual(await call('remote-bound', 'callTool', {tool: 'echo_text', args: {a: 1}}),
      {result: {content: [{type: 'text', text: '{"a":1}'}]}});
    const auths = remote.headers.map((h) => h.authorization);
    assert.ok(auths.length > 0 && auths.every((a) => a === `Bearer ${TOKEN}`), JSON.stringify(auths.map((a) => (a === `Bearer ${TOKEN}` ? 'slot' : String(a).slice(0, 12)))));
    const n = remote.headers.length;
    assert.strictEqual((await call('remote-copycat', 'callTool', {tool: 'echo_text', args: {}})).code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
    assert.strictEqual(remote.headers.length, n, 'the copycat reached the stand-in');
  });

  it('neither value is in the log', () => {
    assert.ok(!server.output.includes(TOKEN) && !server.output.includes(OTHER));
    assert.ok(server.output.includes(`no credential is bound to remote-copycat for ${ORIGIN}`), server.output.slice(-2000));
  });
  tmpDirs.hooks();
});
