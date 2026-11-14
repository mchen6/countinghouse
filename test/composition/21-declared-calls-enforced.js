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
const {ROOT, startServer, stopServer, waitFor, mcpCall, post} = require('../helpers/sandbox-server');
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

    // R2-1 Task 5 (#130's interim key): the callee's ctx holds no key, on
    // either path: not as ctx.caller, not as the key its own work bills.
    // The main thread bills the callee's work by the hop's token.
    it('the callee of a declared hop holds no key: ctx.caller has none, ctx.recordUsage reports none', async () => {
      const {out} = await tried('calleeHolds');
      assert.strictEqual(out.code, null, JSON.stringify(out));
      assert.deepStrictEqual(out.holds, {callerKey: null, usageKey: null, admin: false}, JSON.stringify(out));
    });

    it('ctx.caller is {id, isAdmin}; `as` is refused (R2-1 Task 5)', async () => {
      const seen = await attempt('seeCaller');
      assert.deepStrictEqual(seen.holds.callerKeys, ['id', 'isAdmin'], JSON.stringify(seen));
      assert.match(String(seen.holds.id), /^u_[A-Za-z0-9_-]{22}$/);
      assert.match(String((await attempt('asRefused')).message), /remove `as`/);
    });

    it('a hand-built hop carrying a ctx of its own making: the callee sees none of it', async () => {
      const {out} = await tried('forgedCtxHop');
      assert.strictEqual(out.code, null, JSON.stringify(out));
      assert.deepStrictEqual(out.holds, {callerKey: null, usageKey: null, admin: false}, JSON.stringify(out));
    });

    it('a module cannot load a second module into its worker', async () => {
      const {out} = await tried('loadSecond');
      assert.strictEqual(out.code, 'LOAD_MODULE_FAIL', JSON.stringify(out));
      assert.match(String(out.message), /one module/);
      // nor through the lower-level entry (Task 4's review)
      const {out: code} = await tried('loadSecondCode');
      assert.match(String(code.message), /one module/, JSON.stringify(code));
    });
  });
});

// R2-1 Task 5 (#148, 1): a module's identity binding is looked up by the
// module name the main thread loaded, never by a friendlyName its worker
// states. A module whose device claims another module's friendlyName gets
// that module's binding no more: it is unbound, and purged as unbound.
describe('composition 21: a device that claims another module\'s friendlyName', function() {
  this.timeout(120000);
  const KEY = `nc-key-${hex()}`;
  const INTERNAL = `nc-internal-${hex()}`;
  let base = null;
  let server = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21n-'));
    // declare-caller's code and api.json (friendlyName "declare-caller") as
    // another module, "name-claimer"
    const copy = path.join(base, 'name-claimer');
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'declare-caller'), copy, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'));
    pkg.name = 'name-claimer';
    fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify(pkg, null, 2));
    fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({
      [KEY]: {userName: `nc-${hex()}`, devices: ['*']},
      [INTERNAL]: {userName: `nc-internal-${hex()}`, devices: ['*'], runsModules: ['declare-caller']}
    }));
    server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', path.join(base, 'auth.json'),
      '--mcpToolCallCost', '1', '--moduleSandbox', 'off', '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
      '--loadModule', copy]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('gets no binding: the module is unbound, named by its module name, and its device purged', async () => {
    await waitFor(() => /composition declaration is invalid: name-claimer[^\n]*runsModules/.test(server.output), 10000, 'the unbound module in the log',
      async () => server.output.slice(-3000));
    // purged: its tool is gone, not merely failing
    const r = await mcpCall(PORT, KEY, ATTEMPT, {route: 'declared', as: INTERNAL}, {allowUnknownTool: true});
    assert.match(JSON.stringify(r), /unknown tool/, `the claimed binding was taken: ${JSON.stringify(r).slice(0, 400)}`);
  });
});

// The review of #163 (5): a running module that announces another module's
// device while that module is unloaded takes nothing: the ID is the other
// module's (its api.json declares it, and it owned it), and it registers
// its own again when it is loaded back.
describe('composition 21: a running module announcing another module\'s device', function() {
  this.timeout(120000);
  let base = null;
  let server = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21q-'));
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', 'k', '--authoringTools', '--moduleSandbox', 'off',
      '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'id-squatter'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('is refused while that module is unloaded, and the module registers its own when loaded back', async () => {
    const callee = path.join(ROOT, 'test', 'fixtures', 'token-callee');
    assert.strictEqual((await post(PORT, 'k', '/unload-module', {name: 'token-callee'})).status, 200);
    await mcpCall(PORT, 'k', 'id_squatter_squatservice_noop', {});
    await waitFor(() => /id-squatter announced device/.test(server.output), 10000, 'the refusal in the log', async () => server.output.slice(-2000));
    const loaded = await mcpCall(PORT, 'k', 'countinghouse_load_module', {path: callee, name: 'token-callee'});
    assert.ok(loaded != null && loaded.isError !== true, JSON.stringify(loaded).slice(0, 400));
    const r = await waitFor(async () => {
      const x = await mcpCall(PORT, 'k', COUNT, {}, {allowUnknownTool: true});
      return (x != null && x.isError !== true && !/unknown tool/.test(JSON.stringify(x))) ? x : null;
    }, 20000, 'token-callee to answer');
    assert.ok(r != null);
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

// R2-1 Task 4's review: a module that rewrites its own package.json at load,
// to declare a call it was not given, gains no target. The main thread reads
// the file before the module runs (and keeps that copy across supervised
// restarts); under audit the write itself is refused EACCES. Under off the
// write lands and changes nothing.
[['audit', 'EACCES'], ['off', 'written']].forEach(([mode, write]) => {
  describe(`composition 21: a module that rewrites its declarations at load (--moduleSandbox ${mode})`, function() {
    this.timeout(120000);
    const KEY = `rw-key-${hex()}`;
    const INTERNAL = `rw-internal-${hex()}`;
    let base = null;
    let server = null;
    before(async () => {
      base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21r-'));
      const copy = path.join(base, 'declare-rewriter');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'declare-rewriter'), copy, {recursive: true});
      fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({
        [KEY]: {userName: `rw-${hex()}`, devices: ['*']},
        [INTERNAL]: {userName: `rw-internal-${hex()}`, devices: ['*'], runsModules: ['declare-rewriter']}
      }));
      server = await startServer(PORT, ['--workerThread', '--authProvider', 'file', '--authConfigPath', path.join(base, 'auth.json'),
        '--mcpToolCallCost', '1', '--moduleSandbox', mode, '--moduleDataPath', path.join(base, 'store'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
        '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
        '--loadModule', copy]);
    });
    after(() => {
      stopServer(server);
      if (base != null) fs.rmSync(base, {recursive: true, force: true});
    });

    it(`the rewritten call is refused CTX_CALL_UNDECLARED; the write: ${write}`, async () => {
      const r = await request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
        .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'declare_rewriter_rewriterservice_attempt', arguments: {other: IDS.other, as: INTERNAL}}}).then((x) => x.body);
      assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
      const out = toolOutput(r.result);
      assert.strictEqual(out.write, write, JSON.stringify(out));
      assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', `the rewritten declaration was taken: ${JSON.stringify(out)}`);
    });
  });
});

// R2-1 Task 4's re-review, item 1: validation runs the module's code, so the
// main thread pins its package.json before the validation, and the load
// that follows takes that copy. A call added to the file in between -- here
// by the test, standing for a module that changes it during its validation
// by a route the file broker does not see under audit -- is not taken, and
// is logged.
describe('composition 21: validated, then loaded (--moduleSandbox audit)', function() {
  this.timeout(120000);
  const KEY = `vl-key-${hex()}`;
  const ADDED = 'compose-callee/calleeService.double';
  let base = null;
  let server = null;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21v-'));
    fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'declare-rewriter'), path.join(base, 'declare-rewriter'), {recursive: true});
    server = await startServer(PORT, ['--workerThread', '--debug', '--debugKey', KEY, '--authoringTools', '--moduleSandbox', 'audit',
      '--mcpToolCallCost', '1', '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  it('a call added to package.json after the validation is not taken by the load, and is logged', async () => {
    const copy = path.join(base, 'declare-rewriter');
    await mcpCall(PORT, KEY, 'countinghouse_validate_module', {path: copy});
    const file = path.join(copy, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    pkg.countinghouse.calls.push(ADDED);
    fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
    const loaded = await mcpCall(PORT, KEY, 'countinghouse_load_module', {path: copy, name: 'declare-rewriter'});
    assert.ok(loaded != null && loaded.isError !== true, JSON.stringify(loaded).slice(0, 600));
    // the composition verdict lands shortly after the load answers
    const out = await waitFor(async () => {
      const o = toolOutput(await mcpCall(PORT, KEY, 'declare_rewriter_rewriterservice_attempt', {other: IDS.other, as: KEY}));
      return (o != null && o.code !== 'CTX_CALL_NOT_READY') ? o : null;
    }, 20000, 'the composition verdict');
    assert.strictEqual(out.code, 'CTX_CALL_UNDECLARED', `the call added after validation was taken: ${JSON.stringify(out)}`);
    // the log line is JSON: the address's quotes arrive escaped
    await waitFor(() => /declare-rewriter declared call added since its last pin: [^\n]*compose-callee\/calleeService\.double[^\n]*not adopted/.test(server.output),
      5000, 'the added call in the log', async () => server.output.slice(-3000));
  });
});

// R2-1 Task 4's review, spec section 8: in single-thread mode the hop is
// checked in the calling module's ctx, against its composition's targets.
describe('composition 21: declared calls in single-thread mode', function() {
  this.timeout(120000);
  const KEY = `st-key-${hex()}`;
  const INTERNAL = `st-internal-${hex()}`;
  let base = null;
  let server = null;
  const attempt = async (route) => {
    const r = await request(URL).post('/mcp').set('X-CH-Key', KEY).set('Accept', 'application/json, text/event-stream')
      .send({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name: ATTEMPT, arguments: Object.assign({route, as: INTERNAL}, IDS)}}).then((x) => x.body);
    assert.ok(r.result != null && r.result.isError === false, JSON.stringify(r).slice(0, 600));
    return toolOutput(r.result);
  };
  before(async () => {
    base = fs.mkdtempSync(path.join(os.homedir(), '.ch-declared-21s-'));
    fs.writeFileSync(path.join(base, 'auth.json'), JSON.stringify({
      [KEY]: {userName: `st-${hex()}`, devices: ['*']},
      [INTERNAL]: {userName: `st-internal-${hex()}`, devices: ['*'], runsModules: ['declare-caller']}
    }));
    server = await startServer(PORT, ['--no-workerThread', '--authProvider', 'file', '--authConfigPath', path.join(base, 'auth.json'),
      '--mcpToolCallCost', '1', '--moduleDataPath', path.join(base, 'store'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'token-callee'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'compose-callee'),
      '--loadModule', path.join(ROOT, 'test', 'fixtures', 'declare-caller')]);
  });
  after(() => {
    stopServer(server);
    if (base != null) fs.rmSync(base, {recursive: true, force: true});
  });

  // R2-1 Task 5 (plan step 5): the same ctx as in worker mode
  it('ctx.caller is {id, isAdmin}; `as` is refused', async () => {
    const seen = await attempt('seeCaller');
    assert.deepStrictEqual(seen.holds.callerKeys, ['id', 'isAdmin'], JSON.stringify(seen));
    assert.match(String(seen.holds.id), /^u_[A-Za-z0-9_-]{22}$/);
    const refused = await attempt('asRefused');
    assert.match(String(refused.message), /remove `as`/, JSON.stringify(refused));
  });

  it('the declared call works; ctx.serviceClient to an undeclared device or action is CTX_CALL_UNDECLARED', async () => {
    assert.strictEqual((await attempt('declared')).code, null);
    assert.strictEqual((await attempt('clientOtherDevice')).code, 'CTX_CALL_UNDECLARED');
    assert.strictEqual((await attempt('clientOtherAction')).code, 'CTX_CALL_UNDECLARED');
  });
});
