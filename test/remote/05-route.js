// RC1-min plan step 3 (spec section 4): ctx.call('remote:<name>/<tool>')
// from a module's handler, served by the main thread for that module's own
// declaration, in worker and in single-thread mode; metered as an inner hop;
// the credential in no log line and no result.
const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const redis   = require('redis');
const request = require('supertest');
const {ROOT, startServer, stopServer, mcpCall, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
const {redisUrlFor} = require('../helpers/test-env');

const KEY    = 'remote-route-key';
const TOKEN  = `ghp_${'A'.repeat(36)}`;
const REMOTE = 9688;
const PROBE  = path.join(ROOT, 'test', 'fixtures', 'remote-probe');
const NONE   = path.join(ROOT, 'test', 'fixtures', 'remote-none');
const tool   = (module, action) => `${module.replace(/-/g, '_')}_probeservice_${action.toLowerCase()}`;

const allowanceFile = (obj) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-05-')), 'remote-credentials.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};
const ALLOW = {[`http://127.0.0.1:${REMOTE}`]: ['CH_TEST_REMOTE_TOKEN']};
const serverArgs = (thread, allowance, extra) => ['--debug', '--debugKey', KEY, thread, '--mcpToolCallCost', '1',
  '--remoteCredentials', allowanceFile(allowance), '--loadModule', PROBE, '--loadModule', NONE].concat(extra || []);
const call = (port, module, action, input) => mcpCall(port, KEY, tool(module, action), input).then(toolOutput);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

[['worker mode', '--workerThread', 9720], ['single-thread mode', '--no-workerThread', 9721]].forEach(([mode, thread, port]) => {
  describe(`remote 05: the remote: route, ${mode}`, function() {
    this.timeout(120000);
    let remote = null;
    let server = null;
    let db = null;
    before(async () => {
      remote = await startRemoteServer(REMOTE);
      server = await startServer(port, serverArgs(thread, ALLOW), {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
      db = redis.createClient(redisUrlFor(), {db: 0});
    });
    after(async () => {
      await stopServer(server);
      await remote.close();
      await new Promise((resolve) => db.del(KEY, () => db.quit(() => resolve())));
    });

    it('the module gets the raw result, sent with the declared headers and the credential', async () => {
      assert.deepStrictEqual(await call(port, 'remote-probe', 'callTool', {tool: 'echo_text', args: {a: 1}}),
        {result: {content: [{type: 'text', text: '{"a":1}'}]}});
      const last = remote.headers[remote.headers.length - 1];
      assert.strictEqual(last.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(last['x-mcp-toolsets'], 'actions,repos');
    });

    it('isError reaches the module as a result', async () => {
      const out = await call(port, 'remote-probe', 'callTool', {tool: 'fails', args: {}});
      assert.strictEqual(out.result.isError, true);
      assert.ok(out.result.content[0].text.includes('410'));
    });

    it('a module cannot reach another module\'s remote, nor one it did not declare', async () => {
      assert.strictEqual((await call(port, 'remote-none', 'callProbe', {})).code, 'REMOTE_UNDECLARED');
      assert.strictEqual((await call(port, 'remote-probe', 'callOther', {remote: 'other', tool: 'echo_text'})).code, 'REMOTE_UNDECLARED');
    });

    it('arguments that are not a plain object are REMOTE_ARGS_INVALID', async () => {
      assert.strictEqual((await call(port, 'remote-probe', 'callTool', {tool: 'echo_text', args: [1, 2]})).code, 'REMOTE_ARGS_INVALID');
    });

    // Code review of step 3: the arguments are checked as the main thread
    // will see them, alike in both modes, before anything is sent.
    it('a function in the arguments is REMOTE_ARGS_INVALID, and a class instance arrives as its fields', async () => {
      assert.strictEqual((await call(port, 'remote-probe', 'callArgs', {kind: 'function'})).code, 'REMOTE_ARGS_INVALID');
      assert.deepStrictEqual(await call(port, 'remote-probe', 'callArgs', {kind: 'class'}),
        {result: {content: [{type: 'text', text: '{"x":1,"y":2}'}]}});
    });

    it('a malformed remote address is REMOTE_ARGS_INVALID, not REMOTE_UNDECLARED', async () => {
      assert.strictEqual((await call(port, 'remote-probe', 'callOther', {remote: 'GitHub', tool: 'echo_text'})).code, 'REMOTE_ARGS_INVALID');
    });

    // The outer call is charged whatever happens inside; the remote hop
    // adds one charge (--mcpToolCallCost 1) to the outer caller.
    it('a remote call is metered to the outer caller as an inner hop', async () => {
      const read = () => new Promise((resolve) => db.hget(KEY, 'balance', (e, v) => resolve(Number(v))));
      // Charges land after the answer: wait until two reads 300 ms apart
      // agree, so an earlier test's late charge is not counted here.
      const settled = async () => {
        let last = await read();
        for (let i = 0; i < 20; i++) {
          await sleep(300);
          const now = await read();
          if (now === last) return now;
          last = now;
        }
        return last;
      };
      const balanceAfter = async (action, input) => {
        await settled();
        await new Promise((resolve) => db.hset(KEY, 'balance', '100', () => resolve()));
        await call(port, 'remote-probe', action, input);
        return settled();
      };
      const withHop = await balanceAfter('callTool', {tool: 'echo_text', args: {}});
      const without = await balanceAfter('callOther', {remote: 'other', tool: 'echo_text'});
      assert.strictEqual(without - withHop, 1, `with the hop ${withHop}, without ${without}`);
    });

    it('the token appears in no log line', () => {
      assert.ok(!server.output.includes(TOKEN), 'the token is in the server log');
      assert.ok(server.output.includes('remote probe: sends CH_TEST_REMOTE_TOKEN to http://127.0.0.1:9688'), server.output.slice(-2000));
    });
  });
});

// Code review of step 3: a load that fails drops its own registration,
// never a newer one's.
describe('remote 05: the registry', () => {
  const remoteRegistry = require('../../lib/remote');
  const cli = require('../../lib/cli-options');
  before(() => cli.setOptions({workerThread: false, debug: true}));
  after(() => cli.setOptions({workerThread: false}));

  // No --remoteCredentials here: a registered probe is disabled, and says
  // so (REMOTE_CREDENTIAL_NOT_ALLOWED); an unregistered one is undeclared.
  it('unregister(name, entries) drops only that registration', async () => {
    const codeOf = () => remoteRegistry.callRemote('registry-probe', 'probe', 'echo_text', {}, {billingKey: 'k'}).then(() => 'resolved', (e) => e.code);
    const first = remoteRegistry.register('registry-probe', PROBE);
    const second = remoteRegistry.register('registry-probe', PROBE);
    assert.deepStrictEqual([first.problems, second.problems], [[], []]);
    assert.notStrictEqual(first.entries, second.entries);
    await remoteRegistry.unregister('registry-probe', first.entries);
    assert.strictEqual(await codeOf(), 'REMOTE_CREDENTIAL_NOT_ALLOWED', 'the newer registration is still there');
    await remoteRegistry.unregister('registry-probe', second.entries);
    assert.strictEqual(await codeOf(), 'REMOTE_UNDECLARED');
  });
});

describe('remote 05: the credential at load', function() {
  this.timeout(120000);
  const PORT = 9721;
  let remote = null;
  before(async () => { remote = await startRemoteServer(REMOTE); });
  after(async () => { await remote.close(); });

  it('a variable the allowance does not name disables the remote, with one load line', async () => {
    const server = await startServer(PORT, serverArgs('--workerThread', {[`http://127.0.0.1:${REMOTE}`]: ['OTHER_VARIABLE']}),
      {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
    try {
      assert.strictEqual((await call(PORT, 'remote-probe', 'callTool', {tool: 'echo_text', args: {}})).code, 'REMOTE_CREDENTIAL_NOT_ALLOWED');
      assert.ok(server.output.includes(`CH_TEST_REMOTE_TOKEN is not allowed for http://127.0.0.1:${REMOTE}`), server.output.slice(-2000));
      assert.strictEqual(remote.headers.length, 0, 'nothing reached the remote');
    } finally {
      await stopServer(server);
    }
  });

  // A running process's environment cannot change from outside, so "set
  // later" is "unset at load": read once, at load (Review Focus 4).
  it('an allowed variable unset at load disables the remote until a reload: REMOTE_CREDENTIAL_MISSING', async () => {
    const server = await startServer(PORT, serverArgs('--workerThread', ALLOW), {env: {CH_TEST_REMOTE_TOKEN: ''}});
    try {
      assert.strictEqual((await call(PORT, 'remote-probe', 'callTool', {tool: 'echo_text', args: {}})).code, 'REMOTE_CREDENTIAL_MISSING');
    } finally {
      await stopServer(server);
    }
  });

  // Review Focus 1: a reload closes the module's client; a call in flight
  // on it ends rather than hangs, and no socket to the remote stays open.
  it('a reload closes the old client', async () => {
    const server = await startServer(PORT, serverArgs('--no-workerThread', ALLOW), {env: {CH_TEST_REMOTE_TOKEN: TOKEN}});
    try {
      const inFlight = call(PORT, 'remote-probe', 'callTool', {tool: 'slow', args: {}}).catch((e) => ({code: `rejected ${e.message}`}));
      await waitFor(() => remote.calls.includes('slow'), 5000, 'the slow call to reach the remote');
      const before = remote.sockets();   // the old client's
      await request(`http://127.0.0.1:${PORT}`).post('/reload-module').set('X-CH-Key', KEY).send({path: PROBE});
      const out = await inFlight;
      assert.strictEqual(out.code, 'REMOTE_UNREACHABLE', JSON.stringify(out));
      // The new registration lists at load (step 4) on a connection of its
      // own; every one the old client had is closed.
      await waitFor(() => Array.from(before).every((socket) => !remote.sockets().has(socket)), 5000, 'the old client\'s connections to close');
      assert.deepStrictEqual(await call(PORT, 'remote-probe', 'callTool', {tool: 'echo_text', args: {r: 1}}),
        {result: {content: [{type: 'text', text: '{"r":1}'}]}});
    } finally {
      await stopServer(server);
    }
  });
});
