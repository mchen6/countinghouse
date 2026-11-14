// RC1-min plan step 4 (spec section 5): the remote's tools/list, taken at
// load and recorded with a hash that the load log and the permission
// note carry; it refuses nothing, and a listing that failed at load is
// tried once at the first call, which goes ahead either way.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
require('../../lib/logger').createLogger(false);

const REMOTE = 9722;
const SERVER = 9723;
const KEY = 'remote-listing-key';
const TOKEN = `ghp_${'A'.repeat(36)}`;

// remote-probe, copied with its url at this file's port.
function probeAt(port) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-06-')), 'remote-probe');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${port}/mcp`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}
const allowanceFileFor = (variables) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-06a-')), 'remote-credentials.json');
  fs.writeFileSync(file, JSON.stringify({[`http://127.0.0.1:${REMOTE}`]: variables}));
  return file;
};
const allowanceFile = () => allowanceFileFor(['CH_TEST_REMOTE_TOKEN']);

describe('remote 06: tools/list at load, in the registry', function() {
  this.timeout(60000);
  const cli = require('../../lib/cli-options');
  const registry = require('../../lib/remote');
  const credentials = require('../../lib/remote/credentials');
  const PROBE = probeAt(REMOTE);
  let remote = null;
  before(() => {
    cli.setOptions({workerThread: false, debug: true});
    credentials.configure(allowanceFile());
    process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
  });
  after(() => { cli.setOptions({workerThread: false}); delete process.env.CH_TEST_REMOTE_TOKEN; });
  afterEach(async () => {
    await registry.unregister('listing-probe');
    if (remote != null) await remote.close();
    remote = null;
  });

  it('the listing is recorded with a hash that is stable across loads', async () => {
    remote = await startRemoteServer(REMOTE);
    registry.register('listing-probe', PROBE);
    const first = await registry.listing('listing-probe', 'probe');
    assert.ok(first != null, 'listed at load');
    assert.deepStrictEqual(first.tools.map((t) => t.name), ['big', 'big_sse', 'echo_text', 'fails', 'slow', 'sse_text', 'structured']);
    assert.match(first.sha256, /^[0-9a-f]{16}$/);
    registry.register('listing-probe', PROBE);
    assert.strictEqual((await registry.listing('listing-probe', 'probe')).sha256, first.sha256);
  });

  it('a tool missing from the list is called all the same', async () => {
    remote = await startRemoteServer(REMOTE);
    registry.register('listing-probe', PROBE);
    await registry.listing('listing-probe', 'probe');
    remote.extraTools.push('added_later');
    const r = await registry.callRemote('listing-probe', 'probe', 'added_later', {}, {billingKey: KEY});
    assert.deepStrictEqual(r, {content: [{type: 'text', text: 'no tool added_later'}], isError: true}, 'the server\'s own answer');
  });

  it('a failed listing does not refuse the load, is tried once at the first call, and the call goes ahead', async () => {
    const registered = registry.register('listing-probe', PROBE);   // nothing listens yet
    assert.deepStrictEqual(registered.problems, []);
    assert.strictEqual(await registry.listing('listing-probe', 'probe'), null);
    remote = await startRemoteServer(REMOTE);
    const r = await registry.callRemote('listing-probe', 'probe', 'echo_text', {n: 1}, {billingKey: KEY});
    assert.deepStrictEqual(r, {content: [{type: 'text', text: '{"n":1}'}]});
    assert.ok((await registry.listing('listing-probe', 'probe')) != null, 'listed at the first call');
    const listings = remote.headers.length;
    await registry.callRemote('listing-probe', 'probe', 'echo_text', {n: 2}, {billingKey: KEY});
    assert.strictEqual(remote.headers.length - listings, 1, 'no listing at the second call');
  });

  // Reviewer, 2026-11-11: allowed but unset, the remote is disabled for
  // calls, and the listing runs without a credential; a disallowed one is
  // not contacted at all.
  it('an allowed variable unset at load: listed without a credential, calls REMOTE_CREDENTIAL_MISSING', async () => {
    remote = await startRemoteServer(REMOTE);
    delete process.env.CH_TEST_REMOTE_TOKEN;
    try {
      registry.register('listing-probe', PROBE);
      assert.ok((await registry.listing('listing-probe', 'probe')) != null, 'listed');
      assert.ok(remote.headers.length > 0 && remote.headers.every((h) => h.authorization === undefined), 'with no credential');
      const code = await registry.callRemote('listing-probe', 'probe', 'echo_text', {}, {billingKey: KEY}).then(() => 'resolved', (e) => e.code);
      assert.strictEqual(code, 'REMOTE_CREDENTIAL_MISSING');
    } finally {
      process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
    }
  });

  it('a variable the allowance does not name: not contacted at all', async () => {
    remote = await startRemoteServer(REMOTE);
    credentials.configure(allowanceFileFor(['OTHER_VARIABLE']));
    try {
      registry.register('listing-probe', PROBE);
      assert.strictEqual(await registry.listing('listing-probe', 'probe'), null);
      assert.strictEqual(remote.headers.length, 0);
    } finally {
      credentials.configure(allowanceFile());
    }
  });

  it('when the listing fails at the call too, the call still goes out and fails on its own', async () => {
    registry.register('listing-probe', PROBE);
    await registry.listing('listing-probe', 'probe');
    const code = await registry.callRemote('listing-probe', 'probe', 'echo_text', {}, {billingKey: KEY}).then(() => 'resolved', (e) => e.code);
    assert.strictEqual(code, 'REMOTE_UNREACHABLE');
  });
});

describe('remote 06: the load log', function() {
  this.timeout(120000);
  let remote = null;
  let server = null;
  before(async () => {
    remote = await startRemoteServer(REMOTE);
    server = await startServer(SERVER, ['--debug', '--debugKey', KEY, '--workerThread', '--remoteCredentials', allowanceFile(),
      '--loadModule', probeAt(REMOTE)], {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
  });
  after(async () => { await stopServer(server); await remote.close(); });

  it('the load logs the credential\'s origin, the number of tools and their hash', async () => {
    await mcpCall(SERVER, KEY, 'remote_probe_probeservice_calltool', {tool: 'echo_text', args: {}}).then(toolOutput);
    assert.ok(server.output.includes(`remote probe: sends CH_TEST_REMOTE_TOKEN to http://127.0.0.1:${REMOTE}`), server.output.slice(-2000));
    // The listing runs beside the call, not before it.
    await waitFor(() => /module remote: remote-probe: remote probe: tools\/list 7 tools sha256 [0-9a-f]{16}/.test(server.output),
      20000, 'the tools/list line');
    assert.ok(!server.output.includes(TOKEN));
  });
});
