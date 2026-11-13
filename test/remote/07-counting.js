// RC1-min plan step 5 (spec section 6): one usage record per call to a
// remote, under the tools/call it was made for, and that call's id carried
// unchanged from a composite through its parts to the remote. The remote
// message's id is the worker's claim, checked on the main thread after the
// remote's own checks (lib/usage/hop.js): an id the worker was not given is
// refused USAGE_CALL_FOREIGN, a finished one goes on and records nothing.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const wt     = require('worker_threads');
const {ROOT} = require('../helpers/sandbox-server');
const {startRemoteServer} = require('../helpers/remote-mcp-server');
const {createUsage} = require('../../lib/usage');
require('../../lib/logger').createLogger(false);

const REMOTE = 9728;
const KEY = 'remote-counting-key';
const TOKEN = `ghp_${'A'.repeat(36)}`;

function probeAt(port) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-07-')), 'remote-probe');
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'remote-probe'), dir, {recursive: true});
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.countinghouse.remotes[0].url = `http://127.0.0.1:${port}/mcp`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  return dir;
}

describe('remote 07: usage records for remote calls, and the call id across every hop', function() {
  this.timeout(60000);
  const cli = require('../../lib/cli-options');
  const registry = require('../../lib/remote');
  const credentials = require('../../lib/remote/credentials');
  const remoteUsage = require('../../lib/remote/usage');
  const handlerCtx = require('../../lib/handler-ctx');
  const PROBE = probeAt(REMOTE);
  let remote = null;
  let u = null;
  before(async () => {
    cli.setOptions({workerThread: false, debug: true});
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-remote-07a-')), 'remote-credentials.json');
    fs.writeFileSync(file, JSON.stringify({[`http://127.0.0.1:${REMOTE}`]: ['CH_TEST_REMOTE_TOKEN'], [`http://127.0.0.1:${REMOTE + 1}`]: ['CH_TEST_REMOTE_TOKEN']}));
    credentials.configure(file);
    process.env.CH_TEST_REMOTE_TOKEN = TOKEN;
    remote = await startRemoteServer(REMOTE);
    registry.register('count-probe', PROBE);
    await registry.listing('count-probe', 'probe');
  });
  after(async () => {
    await registry.unregister('count-probe');
    if (remote != null) await remote.close();
    remoteUsage.setRecorder(null);
    cli.setOptions({workerThread: false});
    delete process.env.CH_TEST_REMOTE_TOKEN;
  });
  beforeEach(() => {
    u = createUsage({usageDir: null});
    remoteUsage.setRecorder(u);
  });
  const ins = () => u.records().filter((r) => r.bytesIn !== undefined);
  const call = (tool, args, meta) => registry.callRemote('count-probe', 'probe', tool, args, Object.assign({billingKey: KEY}, meta));

  it('one recordIn per call, with the documented fields and no content', async () => {
    const id = u.beginCall({module: 'count-probe', tool: 'outer', caller: 'u_test'});
    await call('echo_text', {n: 1}, {usageCall: id});
    const text = JSON.stringify({n: 1});
    const records = ins();
    assert.strictEqual(records.length, 1);
    const r = records[0];
    assert.deepStrictEqual([r.call, r.server, r.module, r.tool, r.bytesIn, r.linesIn, r.outcome, r.credential, r.caller],
      [id, 'probe', 'count-probe', 'echo_text', Buffer.byteLength(text), 1, 'ok', 'CH_TEST_REMOTE_TOKEN', 'u_test']);
    assert.ok(Number.isInteger(r.ms) && r.ms >= 0);
    assert.ok(!JSON.stringify(r).includes(text), 'no content is recorded');
  });

  it('outcome is isError for a tool error, and the code for a rejection', async () => {
    const id = u.beginCall({tool: 'outer'});
    await call('fails', {}, {usageCall: id});
    await registry.unregister('count-probe');
    registry.register('count-probe', probeAt(REMOTE + 1));     // nothing listens there
    try {
      await assert.rejects(call('echo_text', {}, {usageCall: id}), {code: 'REMOTE_UNREACHABLE'});
    } finally {
      await registry.unregister('count-probe');
      registry.register('count-probe', PROBE);
    }
    assert.deepStrictEqual(ins().map((r) => [r.tool, r.outcome, r.bytesIn]),
      [['fails', 'isError', Buffer.byteLength('failed to get job logs: unexpected status code: 410 Gone')], ['echo_text', 'REMOTE_UNREACHABLE', 0]]);
  });

  it('a call the remote refuses before contacting the server records nothing', async () => {
    const id = u.beginCall({tool: 'outer'});
    await assert.rejects(registry.callRemote('count-probe', 'nope', 'echo_text', {}, {billingKey: KEY, usageCall: id}), {code: 'REMOTE_UNDECLARED'});
    await assert.rejects(call('echo_text', [1], {usageCall: id}), {code: 'REMOTE_ARGS_INVALID'});
    assert.deepStrictEqual(ins(), []);
  });

  it('a null id records nothing', async () => {
    await call('echo_text', {n: 2}, {usageCall: null});
    await call('echo_text', {n: 3}, {});
    assert.deepStrictEqual(ins(), []);
  });

  it('non-text content is passed and not counted', async () => {
    const id = u.beginCall({tool: 'outer'});
    const r = await call('mixed', {}, {usageCall: id});
    assert.deepStrictEqual(r.content.map((c) => c.type), ['text', 'image'], 'passed as the server sent it');
    assert.deepStrictEqual(ins().map((x) => [x.bytesIn, x.linesIn]), [[Buffer.byteLength('ab\ncd'), 2]]);
  });

  it('no record holds the token', async () => {
    const id = u.beginCall({tool: 'outer'});
    await call('echo_text', {}, {usageCall: id});
    await call('fails', {}, {usageCall: id});
    assert.ok(ins().length === 2);
    assert.ok(!JSON.stringify(u.records()).includes(TOKEN));
  });

  describe('the call id across every hop', () => {
    const device = {moduleName: 'count-probe', deviceID: 'd-count', spec: {device: {friendlyName: 'count-probe'}}};
    const outerArgs = (usageCall) => ({input: {}, ctx: {appKey: KEY}, usageCall: usageCall});

    it('the call id is carried unchanged from the composite through the part to the remote', async () => {
      const id = u.beginCall({tool: 'outer'});
      const ctx = handlerCtx.buildCtx(device, outerArgs(id));
      assert.strictEqual(ctx.usageCall, undefined, 'never on ctx');
      assert.ok(!Object.values(ctx).includes(id), 'never on ctx');
      await ctx.call('remote:probe/echo_text', {n: 4});
      assert.deepStrictEqual(ins().map((r) => r.call), [id]);

      // the part hop: a cached client gets the id beside billingKey, whatever
      // the module states
      let sent = null;
      device._ctxServiceClients = {'d-part|svc|internal': {invoke: (opts, cb) => { sent = opts; cb(null, {}); }, deviceID: 'd-part', serviceID: 'svc'}};
      await new Promise((resolve, reject) => ctx.serviceClient({deviceID: 'd-part', serviceID: 'svc', as: 'internal'}, (err, client) =>
        (err != null ? reject(err) : client.invoke({actionName: 'act', input: {}, usageCall: 999}, resolve))));
      assert.strictEqual(sent.usageCall, id);
      assert.strictEqual(sent.billingKey, KEY);
    });

    it('a routed hop carries the id in its args; a direct peer channel does not', () => {
      const ServiceClient = require('../../lib/service-client');
      const seen = {};
      const dm = {
        sendActionInvokeMessageToParent: (appKey, billingKey, deviceID, serviceID, actionName, args) => { seen.routed = args; },
        invokeActionViaPeerChannel: (appKey, billingKey, deviceID, serviceID, actionName, args) => { seen.peer = args; }
      };
      const client = new ServiceClient({deviceManager: dm}, false, true, 'internal', 'd-part', 'svc', KEY);
      cli.setOptions({workerThread: false, debug: true, directPeerChannels: false});
      client.invoke({actionName: 'act', input: {a: 1}, usageCall: 5}, () => {});
      cli.setOptions({workerThread: false, debug: true, directPeerChannels: true});
      client.invoke({actionName: 'act', input: {a: 1}, usageCall: 5}, () => {});
      cli.setOptions({workerThread: false, debug: true});
      assert.deepStrictEqual(seen.routed, {input: {a: 1}, usageCall: 5});
      assert.deepStrictEqual(seen.peer, {input: {a: 1}});
    });

    it('a worker\'s remote message carries the id', async () => {
      const CHUtil = require('../../lib/countinghouse-util');
      const saved = CHUtil.dm;
      let data = null;
      CHUtil.dm = {workerMessage: {sendRemoteCallToParent: (d, cb) => { data = d; cb(null, {content: []}); }}};
      Object.defineProperty(wt, 'isMainThread', {value: false, configurable: true, writable: true});
      try {
        await handlerCtx.buildCtx(device, outerArgs(11)).call('remote:probe/echo_text', {});
      } finally {
        Object.defineProperty(wt, 'isMainThread', {value: true, configurable: true, writable: true});
        CHUtil.dm = saved;
      }
      assert.strictEqual(data.usageCall, 11);
    });
  });

  describe('the remote message, answered on the main thread', () => {
    const W = 41;
    // the call's token, as the main thread issues one to worker W (R2-1 Task 3)
    const tokenFor = (workerId) => require('../../lib/call-tokens').issue({billingKey: KEY, module: 'count-probe', workerId: workerId, deviceID: 'd-count'});

    it('an id the worker owns is recorded', async () => {
      const id = u.beginCall({tool: 'outer'});
      const release = u.grantCall(id, W);
      await registry.answerRemoteMessage('count-probe', {remote: 'probe', tool: 'echo_text', args: {}, billingKey: KEY, usageCall: id, token: tokenFor(W)}, W);
      release();
      assert.deepStrictEqual(ins().map((r) => r.call), [id]);
    });

    it('an id the worker was not given is refused USAGE_CALL_FOREIGN, and the server is not called', async () => {
      const id = u.beginCall({tool: 'outer'});
      const before = remote.calls.length;
      await assert.rejects(registry.answerRemoteMessage('count-probe', {remote: 'probe', tool: 'echo_text', args: {}, billingKey: KEY, usageCall: id, token: tokenFor(W)}, W),
        {code: 'USAGE_CALL_FOREIGN'});
      assert.strictEqual(remote.calls.length, before);
      assert.deepStrictEqual(ins(), []);
    });

    it('a token issued to another worker is refused CALL_TOKEN_INVALID, and the server is not called', async () => {
      const id = u.beginCall({tool: 'outer'});
      const release = u.grantCall(id, W);
      const before = remote.calls.length;
      await assert.rejects(registry.answerRemoteMessage('count-probe', {remote: 'probe', tool: 'echo_text', args: {}, billingKey: KEY, usageCall: id, token: tokenFor(W + 1)}, W),
        {code: 'CALL_TOKEN_INVALID'});
      release();
      assert.strictEqual(remote.calls.length, before);
      assert.deepStrictEqual(ins(), []);
    });

    it('a remote the module does not declare is refused as such whatever the id says', async () => {
      await assert.rejects(registry.answerRemoteMessage('count-probe', {remote: 'nope', tool: 'echo_text', args: {}, billingKey: KEY, usageCall: 424242, token: tokenFor(W)}, W),
        {code: 'REMOTE_UNDECLARED'});
    });

    it('a finished id goes on and records nothing', async () => {
      const id = u.beginCall({tool: 'outer'});
      u.recordOut(id, {tool: 'outer', bytes: 0, lines: 0, ms: 0, outcome: 'ok'});
      const r = await registry.answerRemoteMessage('count-probe', {remote: 'probe', tool: 'echo_text', args: {n: 5}, billingKey: KEY, usageCall: id, token: tokenFor(W)}, W);
      assert.deepStrictEqual(r.content, [{type: 'text', text: JSON.stringify({n: 5})}]);
      assert.deepStrictEqual(ins(), []);
    });
  });
});
