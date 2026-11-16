// MCP completeness M19, spec section 13, step 4: a remote call the main
// thread is making for a call is aborted when that call's token is dropped
// (a cancel, or its timeout), so the user's quota on the remote server stops
// being spent. An aborted call never answers, so it is not metered.
// callTokens.onDrop(token, fn) runs fn when the token or any ancestor of it
// is dropped; its unregister keeps it from running after the call settles.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
const {testPort} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');
const REMOTE = testPort(9589);
const KEY = 'remote-12-key';
const TOKEN = `ghp_${'C'.repeat(36)}`;
require('../../lib/logger').createLogger(false);
const callTokens = require('../../lib/call-tokens');

describe('remote 12: a dropped token aborts its remote call (M19)', function() {
  this.timeout(60000);

  describe('callTokens.onDrop', () => {
    it('runs when the token is dropped, or an ancestor of it; once', () => {
      const root = callTokens.issue({billingKey: 'k', workerId: 'w-12'});
      const child = callTokens.issue({billingKey: 'k', workerId: 'w-12b', parent: root});
      const ran = [];
      callTokens.onDrop(child, () => ran.push('child'));
      callTokens.onDrop(root, () => ran.push('root'));
      callTokens.drop(root);
      assert.deepStrictEqual(ran.sort(), ['child', 'root']);
      callTokens.drop(root);
      assert.strictEqual(ran.length, 2, 'once');
    });

    it('its unregister keeps it from running; a token already gone runs it at once', () => {
      const t = callTokens.issue({billingKey: 'k', workerId: 'w-12'});
      let n = 0;
      const off = callTokens.onDrop(t, () => { n += 1; });
      off();
      callTokens.drop(t);
      assert.strictEqual(n, 0);
      callTokens.onDrop(t, () => { n += 1; });
      assert.strictEqual(n, 1, 'gone already: at once');
    });
  });

  describe('a worker\'s remote call', () => {
    const cli = require('../../lib/cli-options');
    const registry = require('../../lib/remote');
    const credentials = require('../../lib/remote/credentials');
    const CHUtil = require('../../lib/countinghouse-util');
    let remote = null;
    let dir = null;
    let savedCi;
    const metered = [];
    before(async () => {
      cli.setOptions({workerThread: false, debug: true});
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-12-'));
      const probe = path.join(dir, 'remote-probe');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), probe, {recursive: true});
      const pkgPath = path.join(probe, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${REMOTE}/mcp`;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg));
      const file = path.join(dir, 'remote-credentials.json');
      fs.writeFileSync(file, JSON.stringify({[`http://127.0.0.1:${REMOTE}`]: ['CH_TEST_REMOTE_TOKEN']}));
      credentials.configure(file);
      process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
      remote = await startRemoteServer(REMOTE);
      registry.register('abort-probe', probe);
      await registry.listing('abort-probe', 'probe');
      savedCi = CHUtil.ci;
      CHUtil.ci = {recordCall: (k, tool, cost, cb) => { metered.push(tool); cb(null, {}); }};
    });
    after(async () => {
      CHUtil.ci = savedCi;
      await registry.unregister('abort-probe');
      if (remote != null) await remote.close();
      cli.setOptions({workerThread: false});
      delete process.env.CH_TEST_REMOTE_TOKEN;
      if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
    });

    // the SDK aborts by rejecting the request and telling the server with
    // notifications/cancelled (its transport's HTTP request is shared, so
    // the server is told, not cut off), as MCP has a client do
    it('dropping the call\'s token aborts the remote call at once: the server is told to cancel it, and nothing is metered', async () => {
      const token = callTokens.issue({billingKey: KEY, workerId: 'w-remote-12'});
      const before = remote.cancelled.length;
      const started = Date.now();
      const call = registry.callRemote('abort-probe', 'probe', 'slow', {a: 1}, {workerId: 'w-remote-12', token});
      setTimeout(() => callTokens.drop(token), 300);
      await assert.rejects(call);
      assert.ok(Date.now() - started < 2000, `at once, not after the remote's 3 s (${Date.now() - started} ms)`);
      for (let w = 0; remote.cancelled.length === before && w < 2000; w += 50) await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(remote.cancelled.length, before + 1, 'the remote was sent notifications/cancelled for it');
      assert.deepStrictEqual(metered, [], 'an aborted call is not metered');
    });

    it('a call that settles normally runs nothing on a later drop', async () => {
      const token = callTokens.issue({billingKey: KEY, workerId: 'w-remote-12'});
      await registry.callRemote('abort-probe', 'probe', 'echo_text', {a: 2}, {workerId: 'w-remote-12', token});
      const before = remote.cancelled.length;
      callTokens.drop(token);
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(remote.cancelled.length, before);
      assert.strictEqual(metered.length, 1, 'the call that answered is metered once');
    });
  });
});
