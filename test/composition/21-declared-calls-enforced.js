// R2-1 Task 4 (spec section 4): a module can call only what it declared in
// package.json's countinghouse.calls, whatever API it used, and the main
// thread decides it from the WorkerMessage the request arrived on, never from
// the message. A hop to an undeclared target answers CTX_CALL_UNDECLARED, no
// handler runs, nothing is billed. On the direct peer path the broker refuses
// a channel to an undeclared device and the callee refuses an undeclared
// action on a granted one, so no main round trip is added per invoke.
//
// declare-caller (test/fixtures) declares only token-callee/tokenCallee.bump
// and, under --moduleSandbox off, tries the others by every route: ctx.call,
// ctx.serviceClient by raw device id, and hand-built hop messages carrying its
// own call's token read off its worker's send path. It also tries to load a
// second module into its worker (the one-module-per-worker guard the peer
// path's argument rests on).
const assert  = require('assert');
const crypto  = require('crypto');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const request = require('supertest');
const {ROOT, startServer, stopServer, waitFor} = require('../helpers/sandbox-server');
const {toolOutput} = require('../helpers/tool-result');
const {deviceIDForName} = require('../../lib/call-address');
const {testPort} = require('../helpers/test-env');

const hex = () => crypto.randomBytes(6).toString('hex');
const ATTEMPT = 'declare_caller_declareservice_attempt';
const COUNT = 'token_callee_tokencallee_count';
const PORT = testPort(9699);
const URL = `http://127.0.0.1:${PORT}`;
const IDS = {callee: deviceIDForName('token-callee'), other: deviceIDForName('compose-callee')};

[['routed', '--no-directPeerChannels'], ['direct peer channels', '--directPeerChannels']].forEach(([label, flag]) => {
  describe(`composition 21: declared calls, enforced on the main thread (${label})`, function() {
    this.timeout(120000);
    const KEYS = {a: `a-key-${hex()}`, reader: `reader-key-${hex()}`, internal: `declare-internal-${hex()}`};
    let base = null;
    let server = null;

    const mcp = (key, name, args) => request(URL).post('/mcp').set('X-CH-Key', key)
      .set('Accept', 'application/json, text/event-stream').send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name, arguments: args}}).then((r) => r.body);
    const attempt = async (route) => {
      const r = await mcp(KEYS.a, ATTEMPT, Object.assign({route, as: KEYS.internal}, IDS));
      assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
      return toolOutput(r.result);
    };
    const runs = async () => toolOutput((await mcp(KEYS.reader, COUNT, {})).result).n;
    const balanceOf = (key) => request(URL).get('/balance').set('X-CH-Key', key).then((r) => r.body.balance);
    async function settled(key) {
      let last = null, stable = 0;
      const deadline = Date.now() + 10000;
      for (;;) {
        const b = await balanceOf(key);
        stable = (last !== null && b === last) ? stable + 1 : 1;
        last = b;
        if (stable >= 3) return b;
        if (Date.now() >= deadline) throw new Error(`the balance of ${key} never settled (last ${b})`);
        await new Promise((ok) => setTimeout(ok, 150));
      }
    }
    // -> {out, paid, ran}: the attempt's answer, what KEYS.a paid, how many
    // times token-callee's counter moved
    async function tried(route) {
      const before = await settled(KEYS.a);
      const ranBefore = await runs();
      const out = await attempt(route);
      return {out, paid: before - await settled(KEYS.a), ran: (await runs()) - ranBefore};
    }

    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21-'));
      const authPath = path.join(base, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({
        [KEYS.a]: {userName: `a-${hex()}`, devices: ['*']},
        [KEYS.reader]: {userName: `reader-${hex()}`, devices: ['*']},
        [KEYS.internal]: {userName: `declare-internal-${hex()}`, devices: ['*'], runsModules: ['declare-caller']}
      }));
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', authPath,
        '--mcpToolCallCost', '1', '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store'), flag,
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'declare-caller')]);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it('the declared call works, and is billed to the caller (the baseline)', async () => {
      const {out, paid, ran} = await tried('declared');
      assert.strictEqual(out.code, null, JSON.stringify(out));
      assert.deepStrictEqual([paid, ran], [2, 1]);
    });

    it('ctx.serviceClient by raw device id, to a device the module did not declare: CTX_CALL_UNDECLARED, nothing billed', async () => {
      const {out, paid} = await tried('clientOtherDevice');
      assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', JSON.stringify(out));
      assert.strictEqual(paid, 1, 'the hop was billed');
    });

    it('ctx.serviceClient to a declared device, for an action the module did not declare: CTX_CALL_UNDECLARED, no handler runs', async () => {
      const {out, paid, ran} = await tried('clientOtherAction');
      assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', JSON.stringify(out));
      assert.deepStrictEqual([paid, ran], [1, 0], 'the undeclared action ran or was billed');
    });

    it('a hand-built hop with the call\'s own token, to an undeclared device: refused, nothing billed', async () => {
      const {out, paid, ran} = await tried('rawHopOtherDevice');
      assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', JSON.stringify(out));
      assert.deepStrictEqual([paid, ran], [2, 1], 'only the declared hop before it is billed and ran');
    });

    it('a hand-built hop with the call\'s own token, to an undeclared action of a declared device: refused, no handler runs', async () => {
      const {out, paid, ran} = await tried('rawHopOtherAction');
      assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', JSON.stringify(out));
      assert.deepStrictEqual([paid, ran], [2, 1]);
    });

    it('a module cannot load a second module into its worker', async () => {
      const {out} = await tried('loadSecond');
      assert.strictEqual(out.code, 'LOAD_MODULE_FAIL', JSON.stringify(out));
      assert.match(String(out.message), /one module/);
    });
  });
});

// Under --debug with no auth file a declaring module no identity claims
// binds to the debug key, visibly; under --debug with an auth file an
// unbound declaration is the error it is everywhere else, and the module
// is purged (the reviewer's narrowing, 2026-11-13).
describe('composition 21: a declaring module under --debug', function() {
  this.timeout(120000);
  const KEY = `debug-key-${hex()}`;
  const TOOLS = (key) => request(URL).post('/mcp').set('X-CH-Key', key).set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {}}).then((r) => (r.body.result != null ? r.body.result.tools.map((t) => t.name) : []));
  let base = null;
  let server = null;
  const modules = ['token-callee', 'compose-callee', 'declare-caller'].flatMap((m) => ['--loadModule', path.join(ROOT, 'test', 'fixtures', m)]);
  before(() => { base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21d-')); });
  afterEach(() => { stopServer(server); server = null; });
  after(() => { if (base != null) fs.rmSync(base, {recursive: true, force: true}); });

  it('with no auth file: binds to the debug key, says so, and its declared call works', async () => {
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store-a')].concat(modules));
    assert.ok((await TOOLS(KEY)).includes(ATTEMPT), 'declare-caller was not loaded');
    const r = await request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: ATTEMPT, arguments: Object.assign({route: 'declared', as: KEY}, IDS)}}).then((x) => x.body);
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 400));
    assert.strictEqual(toolOutput(r.result).code, null, JSON.stringify(r.result));
    assert.ok(/declare-caller: its declared calls authorize as the debug key \(--debug, no auth file\)/.test(server.output), `no info line: ${server.output.slice(-1500)}`);
    // the module is not handed the debug key (Task 4's review)
    const seen = await request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: ATTEMPT, arguments: Object.assign({route: 'seeComposition', as: KEY}, IDS)}}).then((x) => x.body);
    assert.ok(seen.result != null && seen.result.isError === false, JSON.stringify(seen).slice(0, 400));
    assert.strictEqual(toolOutput(seen.result).code, null, 'the worker holds the debug key');
    // a runtime load re-verifies every composition; the line is not repeated
    const loaded = await request(URL).post('/load-module').set('X-CH-Key', KEY)
      .send({path: path.join(ROOT, 'test', 'fixtures', 'worker-end'), name: 'worker-end', version: '1.0.0'});
    assert.ok(loaded.status < 300, JSON.stringify(loaded.body));
    await waitFor(async () => (await TOOLS(KEY)).some((t) => t.startsWith('worker_end_')), 20000, 'worker-end to load');
    await new Promise((ok) => setTimeout(ok, 1500));
    const lines = server.output.match(/declare-caller: its declared calls authorize as the debug key/g) || [];
    assert.strictEqual(lines.length, 1, `logged ${lines.length} times`);
  });

  it('with no auth file and no --debugKey: still binds, so a declaring module loads', async () => {
    server = await startServer(PORT, ['--workerThread', '--debug', '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store-c')].concat(modules));
    assert.ok((await TOOLS('any-key')).includes(ATTEMPT), `declare-caller was not loaded: ${server.output.slice(-1500)}`);
  });

  it('with an auth file that claims it for no identity: purged as unbound, as anywhere else', async () => {
    const authPath = path.join(base, 'auth.json');
    fs.writeFileSync(authPath, JSON.stringify({[KEY]: {userName: 'debug-tenant', devices: ['*'], admin: true}}));
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--authProvider', 'file', '--authConfigPath', authPath,
      '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store-b')].concat(modules));
    await waitFor(async () => /MODULE_COMPOSITION_INVALID|runsModules/.test(server.output), 20000, 'the composition verdict');
    const tools = await TOOLS(KEY);
    assert.ok(!tools.includes(ATTEMPT), `declare-caller stayed loaded: ${tools.join(' ')}`);
    assert.ok(!/authorize as the debug key/.test(server.output), 'bound to the debug key with an auth file present');
  });
});
