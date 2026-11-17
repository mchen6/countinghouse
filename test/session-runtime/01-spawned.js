'use strict';
// C1 part 2: the runtime serving sessions on --sessionSocket (the shared-
// runtime design section 1 and the plan's C1), spawned as ch-local daemon
// will spawn it: --store local, --controlChannel ipc, an IPC channel, and a
// run directory of the user's at 0700. The test's shim
// (test/session-transport/helpers/shim.js) reads the secret the runtime
// writes, and speaks contract 2.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
// A scenario module (the single-identity profile lists scenarios only),
// written into the test's home: one tool that says hello.
function scenario(home, {dir = path.join(home, 'pack', 'ch-session-hello'), name = 'ch-session-hello'} = {}) {
  const svc = 'helloService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: name, manufacturer: 'countinghouse-test', modelDescription: 'hello',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: 'hello', description: 'says hello', input: {schema: `/${svc}/hello/input`}, output: {schema: `/${svc}/hello/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {hello: {input: {type: 'object'}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'hello.js'), 'module.exports = async (input) => ({output: {said: `hello ${input.name}`}});\n');
  return dir;
}
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// restore: send ch-local daemon's 'restore' (an empty table) once the
// control channel says ready, as the daemon does
// socketPath: a socket outside the run directory (C2's long-home fallback)
function runtime(home, extra = [], {dirMode = 0o700, socketName = 's', socketPath = null, restore = true, env = {}} = {}) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, dirMode);
  const socket = socketPath != null ? socketPath : path.join(run, socketName);
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''}, env)});
  const r = {child, socket, run, err: '', out: '', code: undefined};
  // ch-local's control requests over the IPC channel, as stdio's helper sends them
  const replies = new Map();
  let nextControl = 1;
  r.told = [];
  child.on('message', (m) => {
    // restore: true sends an empty table; an object sends that one
    if (m != null && m.type === 'ready' && restore) child.send(restore === true ? {id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []} : restore);
    if (m != null && m.id === undefined && m.type !== 'ready') r.told.push(m);
    const f = m != null ? replies.get(m.id) : null; if (f != null) { replies.delete(m.id); f(m); }
  });
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.out += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
const listening = async(r) => {
  await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
  return secretOf(r);
};
let nextSeq = 1;
async function request(c, method, params = {}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}

// the same without _meta: a legacy request
async function requestLegacy(c, method, params = {}) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}

describe('session-runtime 01: the runtime on --sessionSocket, spawned', function() {
  this.timeout(120000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('writes a new secret at 0600 before it listens, and serves an MCP session over the socket', async() => {
    r = runtime(home, ['--loadModule', scenario(home)]);
    const secret = await listening(r);
    assert.ok(secret != null, `no secret: ${r.err.slice(-2000)}`);
    assert.strictEqual(fs.statSync(path.join(r.run, 'secret')).mode & 0o777, 0o600);
    const a = await shim.session(r.socket, secret);
    assert.ok(a.welcome != null, JSON.stringify(a.refused));
    let tools = null;
    await until(async() => {
      const list = await request(a.c, 'tools/list');
      tools = list != null && list.result != null ? list.result.tools.map((t) => t.name) : [];
      return tools.some((n) => /hello/.test(n));
    });
    const hello = tools.find((n) => /hello/.test(n));
    assert.ok(hello, `${JSON.stringify(tools)}\n${r.err.slice(-2000)}`);
    const called = await request(a.c, 'tools/call', {name: hello, arguments: {name: 'session'}});
    assert.match(JSON.stringify(called.result), /hello session/);
    a.c.end();
  });

  it('a session tightens the two caps for itself and reads its own settings; every other set is the terminal\'s; no tasks; its log level is its own (B2 Tasks 3 and 4)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile]);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    const callOf = (s) => (args, extra = {}) => request(s.c, 'tools/call', Object.assign({name: 'countinghouse_settings', arguments: args}, extra));
    const call = callOf(a);
    const valueOf = (got, name) => got.result.structuredContent.settings.find((s) => s.name === name).value;
    const got = await call({action: 'get'});
    assert.ok(got.result != null && got.result.isError !== true, JSON.stringify(got));
    assert.strictEqual(valueOf(got, 'requestTimeout'), 30000);
    // a tightening of a cap is the session's own: applied for it, written nowhere
    const tightened = await call({action: 'set', name: 'requestTimeout', value: '20s'});
    assert.deepStrictEqual(tightened.result.structuredContent, {name: 'requestTimeout', old: 30000, new: 20000, applies: 'this session'}, JSON.stringify(tightened));
    assert.strictEqual(valueOf(await call({action: 'get'}), 'requestTimeout'), 20000);
    // its shim is told to forget what it kept, then given the one snapshot
    assert.deepStrictEqual(await a.c.json('C'), {op: 'forget'});
    assert.deepStrictEqual(await a.c.json('C'), {op: 'record', entry: {requestTimeout: 20000}});
    // the other session: its value, its history and its shim hear nothing of it
    const others = await callOf(b)({action: 'get'});
    assert.strictEqual(valueOf(others, 'requestTimeout'), 30000);
    assert.deepStrictEqual(others.result.structuredContent.history, []);
    assert.strictEqual(await b.c.json('C', 300), null);
    assert.deepStrictEqual((await call({action: 'get'})).result.structuredContent.history.map((h) => [h.setting, h.new, h.change]), [['requestTimeout', 20000, 'this session']]);
    // a loosening of a cap (of the session's own value too) is its user's to
    // confirm (Task 5, below): this client is not one a form is shown in,
    // so it is told the terminal command
    for (const value of ['60s', '25s']) {
      const r2 = await call({action: 'set', name: 'requestTimeout', value});
      assert.strictEqual(r2.result.isError, true, JSON.stringify(r2));
      assert.strictEqual(r2.result._meta['countinghouse/code'], 'SETTING_NEEDS_CONFIRMATION', JSON.stringify(r2));
      assert.match(r2.result.content[0].text, /ch-local settings set requestTimeout/);
    }
    // a retry that names no form of this session's confirms nothing, a
    // value that tightens included
    for (const value of ['60s', '10s']) {
      const r2 = await call({action: 'set', name: 'requestTimeout', value}, {requestState: 'x', inputResponses: {}});
      assert.strictEqual(r2.result.isError, true, JSON.stringify(r2));
      assert.strictEqual(r2.result._meta['countinghouse/code'], 'SETTING_CONFIRMATION_INVALID', JSON.stringify(r2));
    }
    // a pack is the session's own since B3 Task 8: on is a loosening (this
    // client gets no form here), off a tightening; neither writes a file
    const packOn = await call({action: 'set', name: 'pack.ch-pack-x', value: 'on'});
    assert.strictEqual(packOn.result._meta['countinghouse/code'], 'SETTING_NEEDS_CONFIRMATION', JSON.stringify(packOn));
    const packOff = await call({action: 'set', name: 'pack.ch-pack-x', value: 'off'});
    assert.strictEqual(packOff.result.structuredContent.applies, 'this session', JSON.stringify(packOff));
    // everything else is the terminal's: any other setting, and its
    // retries; nothing is written
    for (const [args, extra] of [[{action: 'set', name: 'moduleSandbox', value: 'audit'}, {}], [{action: 'set', name: 'locale', value: 'zh'}, {}]]) {
      const r2 = await call(args, extra);
      assert.strictEqual(r2.result.isError, true, JSON.stringify(r2));
      assert.strictEqual(r2.result._meta['countinghouse/code'], 'SETTING_TERMINAL_ONLY_SHARED', `${JSON.stringify(args)}: ${JSON.stringify(r2)}`);
      assert.match(r2.result.content[0].text, /ch-local settings set/);
    }
    assert.strictEqual(valueOf(await call({action: 'get'}), 'requestTimeout'), 20000, 'as it was');
    b.c.end();
    assert.ok(!fs.existsSync(settingsFile), 'settings.json never written');
    for (const method of ['tasks/list', 'tasks/get', 'tasks/cancel']) {
      // a modern request: tasks/* are gone in 2026-07-28 (#243), method not found
      const t = await request(a.c, method, {taskId: 'x'});
      assert.ok(t.error != null && t.error.code === -32601, `${method}: ${JSON.stringify(t)}`);
      // a legacy one reaches the session guard: not served on a shared runtime
      const l = await requestLegacy(a.c, method, {taskId: 'x'});
      assert.ok(l.error != null, `${method}: ${JSON.stringify(l)}`);
      assert.match(l.error.message, /shared runtime/);
    }
    // a modern request's logging/setLevel is gone in 2026-07-28; a legacy
    // session's sets its own level (B2 Task 3: lib/notices.js, per session)
    const level = await request(a.c, 'logging/setLevel', {level: 'debug'});
    assert.ok(level.error != null && level.error.code === -32601, JSON.stringify(level));
    const legacy = await requestLegacy(a.c, 'logging/setLevel', {level: 'warning'});
    assert.deepStrictEqual(legacy.result, {}, JSON.stringify(legacy));
    const bad = await requestLegacy(a.c, 'logging/setLevel', {level: 'loud'});
    assert.ok(bad.error != null && bad.error.code === -32602, JSON.stringify(bad));
    a.c.end();
  });

  // B2 Task 5, with real sessions over the listener and the shim's wire: the
  // test's runtime preloads test/fixtures/session-elicitation-preload.js (a
  // tested range for claude-code; production's is empty until the hand test)
  it('a session\'s user confirms a loosening in that session\'s own form: it is that session\'s only; another session cannot answer it; a client that says no is never asked again (B2 Task 5)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile], {env: {NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'fixtures', 'session-elicitation-preload.js')}`}});
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    const c = await shim.session(r.socket, secret);
    const meta = {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}})};
    // a settings call; conditions: what the session's shim answers the
    // runtime's conditions? with while the call runs (null: it must not ask)
    const call = async(s, args, extra = {}, conditions = null) => {
      const seq = nextSeq++;
      shim.message(s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call', params: Object.assign({name: 'countinghouse_settings', arguments: args}, meta, extra)}));
      let asked = 0;
      if (conditions != null) {
        const q = await s.c.json('C', 20000);
        assert.ok(q != null && q.op === 'conditions?', JSON.stringify(q));
        asked += 1;
        s.c.send('C', {op: 'client', seq: q.seq, status: 'ok', conditions, repo: null, token: null});
      }
      for (;;) {
        const m = await shim.readM(s.c, 60000);
        if (m == null) return null;
        if (m.header != null && m.header.seq === seq) return Object.assign(JSON.parse(m.line.toString('utf8')), {asked});
      }
    };
    const valueOf = (got, name) => got.result.structuredContent.settings.find((s) => s.name === name).value;
    const set60 = {action: 'set', name: 'requestTimeout', value: '60s'};
    const accept = (ask) => ({requestState: ask.result.requestState, inputResponses: {approve: {action: 'accept', content: {approve: true}}}});

    // A asks: its own shim is asked its conditions, and the form is A's
    const ask = await call(a, set60, {}, 'yes');
    assert.strictEqual(ask.result.resultType, 'input_required', JSON.stringify(ask));
    assert.strictEqual(ask.result.inputRequests.approve.method, 'elicitation/create');
    assert.match(ask.result.inputRequests.approve.params.message, /up to 60s in this session \(now 30s\)\? This applies to this session only, until it ends\./);
    assert.strictEqual(valueOf(await call(a, {action: 'get'}), 'requestTimeout'), 30000, 'nothing yet');
    // B cannot answer A's form: its state is good in A only, and B's shim is not even asked
    const fromB = await call(b, set60, accept(ask));
    assert.strictEqual(fromB.result.isError, true, JSON.stringify(fromB));
    assert.strictEqual(fromB.result._meta['countinghouse/code'], 'SETTING_CONFIRMATION_INVALID');
    assert.strictEqual(await b.c.json('C', 300), null);
    // A's user accepts: A's conditions are asked again, then it is A's override
    const done = await call(a, set60, accept(ask), 'yes');
    assert.deepStrictEqual(done.result.structuredContent, {name: 'requestTimeout', old: 30000, new: 60000, applies: 'this session'}, JSON.stringify(done));
    assert.strictEqual(valueOf(await call(a, {action: 'get'}), 'requestTimeout'), 60000);
    assert.strictEqual(valueOf(await call(b, {action: 'get'}), 'requestTimeout'), 30000, 'B runs as before');
    assert.deepStrictEqual((await call(b, {action: 'get'})).result.structuredContent.history, [], 'and reads nothing of it');
    // the same state again is used up
    const again = await call(a, set60, accept(ask));
    assert.strictEqual(again.result._meta['countinghouse/code'], 'SETTING_CONFIRMATION_USED', JSON.stringify(again));
    // C's client says its configuration could answer for the user: no form,
    // and none for the session's life, though it would now say yes (N1);
    // its shim is not asked a second time
    const no = await call(c, set60, {}, 'no');
    assert.strictEqual(no.result._meta['countinghouse/code'], 'SETTING_DECLINED_THIS_SESSION', JSON.stringify(no));
    const still = await call(c, {action: 'set', name: 'maxOutputBytes', value: '32MiB'});
    assert.strictEqual(still.result._meta['countinghouse/code'], 'SETTING_DECLINED_THIS_SESSION', JSON.stringify(still));
    assert.strictEqual(await c.c.json('C', 300), null, 'not asked again');
    assert.match(still.result.content[0].text, /ch-local settings set maxOutputBytes 32MiB/);
    // D's client says no in a frame nobody asked for, then yes in another:
    // the first has latched it, though the session's own copy now says yes
    const d = await shim.session(r.socket, secret);
    d.c.send('C', {op: 'client', status: 'ok', conditions: 'no', repo: null, token: null});
    d.c.send('C', {op: 'client', status: 'ok', conditions: 'yes', repo: null, token: null});
    const overwritten = await call(d, set60);
    assert.strictEqual(overwritten.result._meta['countinghouse/code'], 'SETTING_DECLINED_THIS_SESSION', JSON.stringify(overwritten));
    assert.strictEqual(await d.c.json('C', 300), null, 'and its shim is not asked');
    assert.ok(!fs.existsSync(settingsFile), 'settings.json never written');
    for (const s of [a, b, c, d]) s.c.end();
  });

  // B2 Task 5b, with real sessions: the call says scope: 'all-sessions'
  it('a session changes a cap for all sessions: a tightening at once, written and told to the others; a loosening by its own form, which names all; any other setting is still the terminal\'s (B2 Task 5b)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile, '--loadModule', scenario(home)], {env: {NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'fixtures', 'session-elicitation-preload.js')}`}});
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    // the scenario's tool: a notice rides on a module tool's result
    let hello = null;
    await until(async() => {
      const list = await request(b.c, 'tools/list');
      hello = list != null && list.result != null ? list.result.tools.map((x) => x.name).find((n) => /hello/.test(n)) : null;
      return hello != null;
    });
    assert.ok(hello, r.err.slice(-2000));
    const meta = {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}})};
    const call = async(s, args, extra = {}, conditions = null) => {
      const seq = nextSeq++;
      shim.message(s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method: 'tools/call', params: Object.assign({name: 'countinghouse_settings', arguments: args}, meta, extra)}));
      if (conditions != null) {
        const q = await s.c.json('C', 20000);
        assert.ok(q != null && q.op === 'conditions?', JSON.stringify(q));
        s.c.send('C', {op: 'client', seq: q.seq, status: 'ok', conditions, repo: null, token: null});
      }
      for (;;) {
        const m = await shim.readM(s.c, 60000);
        if (m == null) return null;
        if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
      }
    };
    const valueOf = (got, name) => got.result.structuredContent.settings.find((s) => s.name === name).value;
    const storedNow = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')).values;
    // the tool says it takes a scope
    const listed = await request(a.c, 'tools/list');
    const tool = listed.result.tools.find((t) => t.name === 'countinghouse_settings');
    assert.deepStrictEqual(tool.inputSchema.properties.scope.enum, ['all-sessions']);

    // a tightening for all: no form; B runs under it at once, and is told in its next result
    const tightened = await call(a, {action: 'set', name: 'requestTimeout', value: '20s', scope: 'all-sessions'});
    assert.deepStrictEqual(tightened.result.structuredContent, {name: 'requestTimeout', old: 30000, new: 20000, applies: 'all sessions'}, JSON.stringify(tightened));
    assert.strictEqual(storedNow().requestTimeout, 20000, 'settings.json, as a terminal change writes it');
    const seenByB = await call(b, {action: 'get'});
    assert.strictEqual(valueOf(seenByB, 'requestTimeout'), 20000);
    // a change made for all sessions is every session's to read, with no session's id
    assert.deepStrictEqual(seenByB.result.structuredContent.history.map((h) => [h.setting, h.old, h.new, h.change, h.session]), [['requestTimeout', 30000, 20000, 'all sessions', undefined]]);
    const toldB = await request(b.c, 'tools/call', {name: hello, arguments: {name: 'b'}});
    assert.ok(JSON.stringify(toldB.result).includes('requestTimeout changed to 20s for all sessions (changed from another session)'), JSON.stringify(toldB.result).slice(0, 600));
    // A, who asked, is told nothing of another session
    const toldA = await request(a.c, 'tools/call', {name: hello, arguments: {name: 'a'}});
    assert.ok(!JSON.stringify(toldA.result).includes('another session'), JSON.stringify(toldA.result).slice(0, 600));

    // a loosening for all: A's own form, which names all sessions; accepted, it is stored and B runs under it
    const set60 = {action: 'set', name: 'requestTimeout', value: '60s', scope: 'all-sessions'};
    const ask = await call(a, set60, {}, 'yes');
    assert.strictEqual(ask.result.resultType, 'input_required', JSON.stringify(ask));
    assert.match(ask.result.inputRequests.approve.params.message, /in all your sessions to run for up to 60s \(now 20s\)\? This changes the setting for every session, now and after a restart\./);
    const accept = {requestState: ask.result.requestState, inputResponses: {approve: {action: 'accept', content: {approve: true}}}};
    // the same state does not confirm a change for A alone: the form said all sessions
    const asOwn = await call(a, {action: 'set', name: 'requestTimeout', value: '60s'}, accept);
    assert.strictEqual(asOwn.result._meta['countinghouse/code'], 'SETTING_CONFIRMATION_INVALID', JSON.stringify(asOwn));
    const done = await call(a, set60, accept, 'yes');
    assert.deepStrictEqual(done.result.structuredContent, {name: 'requestTimeout', old: 20000, new: 60000, applies: 'all sessions'}, JSON.stringify(done));
    assert.strictEqual(storedNow().requestTimeout, 60000);
    assert.strictEqual(valueOf(await call(b, {action: 'get'}), 'requestTimeout'), 60000);

    // every other setting is the terminal's, for all sessions too; a scope that is not one is refused
    for (const args of [{action: 'set', name: 'moduleSandbox', value: 'audit', scope: 'all-sessions'}, {action: 'set', name: 'locale', value: 'zh', scope: 'all-sessions'},
      {action: 'set', name: 'pack.ch-pack-x', value: 'on', scope: 'all-sessions'}]) {
      const refusedAll = await call(a, args);
      assert.strictEqual(refusedAll.result._meta['countinghouse/code'], 'SETTING_TERMINAL_ONLY_SHARED', JSON.stringify(refusedAll));
    }
    const odd = await call(a, {action: 'set', name: 'requestTimeout', value: '10s', scope: 'everyone'});
    assert.strictEqual(odd.result._meta['countinghouse/code'], 'ARGUMENTS_INVALID', JSON.stringify(odd));
    assert.deepStrictEqual(storedNow(), {requestTimeout: 60000}, 'nothing else was written');
    for (const s of [a, b]) s.c.end();
  });

  // B2 Task 6, end to end, with the test as the daemon: it keeps what the
  // runtime tells it and hands it back to the next runtime
  it('a session\'s state crosses a runtime restart: told to the daemon as it changes, handed back in the restore, applied when its shim resumes it (B2 Task 6)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile]);
    let secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const id = a.welcome.session;
    const token = a.welcome.resumeToken;
    const call = (s, args) => request(s.c, 'tools/call', {name: 'countinghouse_settings', arguments: args});
    const valueOf = (got, name) => got.result.structuredContent.settings.find((s) => s.name === name).value;
    assert.strictEqual((await call(a, {action: 'set', name: 'requestTimeout', value: '20s'})).result.structuredContent.new, 20000);
    // the daemon's row for it: its state as last told, and its resume hash
    await until(() => r.told.some((m) => m.type === 'session-state' && m.session === id));
    const state = r.told.filter((m) => m.type === 'session-state' && m.session === id).pop().state;
    assert.deepStrictEqual(state, {overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}], locks: [], formsLeft: 3});
    const resume = r.told.filter((m) => m.type === 'session-resume' && m.session === id).pop().hash;
    // nothing told carries a key or a nonce
    assert.ok(!/nonce|mac|key|secret/i.test(JSON.stringify(r.told.filter((m) => m.type === 'session-state'))));
    // the runtime is killed; the next one is handed the table before it listens
    r.child.kill('SIGKILL');
    await r.exited;
    r = runtime(home, ['--settingsFile', settingsFile], {restore: false, socketName: 's2'});
    // the table in the one shape a runtime takes (lib/session-transport/restore.js). Its answer is
    // {ok, ...}: a refusal is ok: false with a code, never an "error" field.
    const answer = await r.control({type: 'restore', sessions: [{session: id, resume, state}], declines: [], reset: []});
    assert.deepStrictEqual([answer.ok, answer.sessions], [true, 1], JSON.stringify(answer));
    const t0 = Date.now();
    secret = await listening(r);
    // on the restore, not on the 3 s net (which would serve an empty table, and refuse the resume below)
    assert.ok(Date.now() - t0 < 2500, `it listened ${Date.now() - t0} ms after the restore`);
    // its shim resumes it, by its token
    const back = await shim.session(r.socket, secret, undefined, {resume: token});
    assert.ok(back.welcome != null && back.welcome.session === id, JSON.stringify(back.refused || back.welcome));
    const got = await call(back, {action: 'get'});
    assert.strictEqual(valueOf(got, 'requestTimeout'), 20000, 'its own value, as before the restart');
    // and a session that was not in the table is a new one
    const fresh = await shim.session(r.socket, secret);
    assert.strictEqual(valueOf(await call(fresh, {action: 'get'}), 'requestTimeout'), 30000);
    back.c.end();
    fresh.c.end();
  });

  // #300's follow-up: the restore's reset list reaches its session (the line in route-manager that passes it
  // on), and a session's unanswered-form count crosses the restart in its state
  it('a session in the daemon\'s reset list is told so at its resume, once; a kind it left one form unanswered of is still counted (B2 Task 6)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    const args = ['--settingsFile', settingsFile, '--loadModule', scenario(home)];
    r = runtime(home, args);
    let secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const id = a.welcome.session;
    const token = a.welcome.resumeToken;
    const hash = r.told.filter((m) => m.type === 'session-resume' && m.session === id).pop().hash;
    r.child.kill('SIGKILL');
    await r.exited;
    fs.rmSync(r.socket, {force: true});
    fs.rmSync(path.join(r.run, 'secret'), {force: true});
    // as the daemon hands it over after a re-exec: the row without its loosening, the session named in reset
    r = runtime(home, args, {restore: {id: 'restore-1', type: 'restore',
      sessions: [{session: id, resume: hash, state: {overrides: [], locks: [], formsLeft: 2, unanswered: ['maxOutputBytes']}}], declines: [], reset: [id]}});
    secret = await listening(r);
    const back = await shim.session(r.socket, secret, undefined, {resume: token});
    assert.strictEqual(back.welcome != null && back.welcome.session, id, JSON.stringify(back.refused));
    let hello = null;
    await until(async() => {
      const list = await request(back.c, 'tools/list');
      hello = list != null && list.result != null ? list.result.tools.map((x) => x.name).find((n) => /hello/.test(n)) : null;
      return hello != null;
    });
    assert.ok(hello, r.err.slice(-2000));
    const textOf = (got) => got.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const first = await request(back.c, 'tools/call', {name: hello, arguments: {name: 'again'}});
    assert.match(textOf(first), /your this-session loosenings were reset; ask again/, JSON.stringify(first).slice(0, 500));
    const second = await request(back.c, 'tools/call', {name: hello, arguments: {name: 'again'}});
    assert.doesNotMatch(textOf(second), /were reset/, 'said once');
    // its next change tells its state whole: the unanswered kind is still in it
    const set = await request(back.c, 'tools/call', {name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '20s'}});
    assert.strictEqual(set.result.structuredContent.new, 20000, JSON.stringify(set).slice(0, 400));
    await until(() => r.told.some((m) => m.type === 'session-state' && m.session === id));
    assert.deepStrictEqual(r.told.filter((m) => m.type === 'session-state' && m.session === id).pop().state,
      {overrides: [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}], locks: [], formsLeft: 2, unanswered: ['maxOutputBytes']});
    back.c.end();
  });

  it('with no restore from the daemon, no confirmation form is shown for 30 minutes: what was declined before is not known (B2 Task 6)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile], {restore: false, env: {NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'fixtures', 'session-elicitation-preload.js')}`}});
    const secret = await listening(r);
    assert.match(r.out + r.err, /no session table from ch-local daemon/);
    const a = await shim.session(r.socket, secret);
    const meta = {_meta: Object.assign({}, META, {'io.modelcontextprotocol/clientCapabilities': {elicitation: {}}, 'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}})};
    const asked = await request(a.c, 'tools/call', Object.assign({name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '60s'}}, meta));
    assert.strictEqual(asked.result._meta['countinghouse/code'], 'SETTING_NEEDS_CONFIRMATION', JSON.stringify(asked));
    assert.strictEqual(await a.c.json('C', 300), null, 'and its shim is not asked its conditions');
    // a tightening needs no form, and is taken
    const tightened = await request(a.c, 'tools/call', Object.assign({name: 'countinghouse_settings', arguments: {action: 'set', name: 'requestTimeout', value: '20s'}}, meta));
    assert.strictEqual(tightened.result.structuredContent.new, 20000, JSON.stringify(tightened));
    a.c.end();
  });

  it('takes ch-local\'s control requests: a pack loaded in place is listed to a session', async() => {
    const packs = path.join(home, 'packs');
    const dir = scenario(home, {dir: path.join(packs, 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two'), name: 'ch-pack-two'});
    r = runtime(home, ['--packsRoot', packs]);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    // a shared runtime's load names its pack and whether it is global (B3 Task 6)
    const reply = await r.control({type: 'load', name: 'ch-pack-two', scenario: dir, pack: 'ch-pack-two', global: true});
    assert.strictEqual(reply.ok, true, `${JSON.stringify(reply)}\n${r.err.slice(-1500)}`);
    assert.ok(Array.isArray(reply.tools) && reply.tools.length === 1, JSON.stringify(reply));
    const list = await request(a.c, 'tools/list');
    assert.ok(list.result.tools.some((t) => t.name === reply.tools[0]), JSON.stringify(list.result.tools.map((t) => t.name)));
    a.c.end();
  });

  it('listens only once ch-local daemon\'s restore has come (C3); without one, after its safety bound', async() => {
    r = runtime(home, [], {restore: false});
    await tick(1500);
    assert.ok(!fs.existsSync(r.socket), 'no socket before the restore, or its bound');
    const secret = await listening(r);
    assert.ok(secret != null, 'listens after the bound, with an empty table');
    assert.match(r.out + r.err, /no session table from ch-local daemon/, 'the warning is logged');
  });

  it('tells ch-local daemon it listens, naming its socket, once the socket is up (C3)', async() => {
    r = runtime(home);
    await listening(r);
    const until = Date.now() + 10000;
    while (!r.told.some((m) => m.type === 'listening') && Date.now() < until) await tick(50);
    assert.deepStrictEqual(r.told.find((m) => m.type === 'listening'), {type: 'listening', socket: r.socket});
  });

  it('ends, within its drain bound, once ch-local daemon is SIGKILLed, with a session still attached (C3)', async() => {
    // a parent standing in for the daemon: it forks the runtime in its own
    // group, with the IPC channel, sends the restore, and prints the pid
    const run = path.join(home, 'run', 'daemon');
    fs.mkdirSync(run, {recursive: true});
    fs.chmodSync(path.join(home, 'run'), 0o700);
    fs.chmodSync(run, 0o700);
    const socket = path.join(run, 's');
    const args = [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
      '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
      '--requestTimeout', '2', '--sessionSocket', socket];
    const parentCode = `const c = require('child_process').spawn(process.execPath, ${JSON.stringify(args)}, {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
      env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
      c.on('message', (m) => { if (m && m.type === 'ready') c.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []}); });
      process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', parentCode], {stdio: ['ignore', 'pipe', 'inherit']});
    let out = '';
    parent.stdout.on('data', (d) => { out += d; });
    let until = Date.now() + 10000;
    while (!/\n/.test(out) && Date.now() < until) await tick(50);
    const pid = Number(out.trim());
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    try {
      until = Date.now() + 30000;
      while (!(fs.existsSync(path.join(run, 'secret')) && fs.existsSync(socket)) && Date.now() < until) await tick(100);
      await tick(300);
      const a = await shim.session(socket, handshake.parseSecret(fs.readFileSync(path.join(run, 'secret'), 'utf8')));
      const t0 = Date.now();
      parent.kill('SIGKILL');
      assert.deepStrictEqual(await a.c.json('C', 10000), {op: 'drain'}, 'the attached shim is told to drain');
      // the attached session has nothing in flight, so the drain closes its
      // connection at once (#35 review) and the runtime ends well within its
      // bound (--requestTimeout 2 s); a call still running would hold it to
      // the bound, never past it
      until = Date.now() + 10000;
      while (alive() && Date.now() < until) await tick(50);
      const took = Date.now() - t0;
      assert.strictEqual(alive(), false, 'the runtime ended');
      assert.ok(took <= 5000, `within its bound, with slack (${took} ms)`);
      assert.ok(!fs.existsSync(socket), 'and its socket went with it');
      a.c.end();
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      parent.kill('SIGKILL');
    }
  });

  // a parent standing in for ch-local daemon, which dies at `when`: 'spawn'
  // (right after spawning the runtime) or 'ready' (on the control channel's
  // ready, never sending a restore). The runtime loads a worker-thread module,
  // whose worker keeps an orphan's process alive.
  const dyingDaemon = async(when) => {
    const run = path.join(home, 'run', 'daemon');
    fs.mkdirSync(run, {recursive: true});
    fs.chmodSync(path.join(home, 'run'), 0o700);
    fs.chmodSync(run, 0o700);
    const socket = path.join(run, 's');
    const args = [FRAMEWORK, '--workerThread', '--moduleSandbox', 'off', '--loadModule', path.join(ROOT, 'test', 'fixtures', 'handler-map-module'),
      '--store', 'local', '--storePath', path.join(home, 'store'),
      '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
      '--sessionSocket', socket];
    const die = "process.stdout.write(String(c.pid) + '\\n', () => process.kill(process.pid, 'SIGKILL'))";
    const parentCode = `const c = require('child_process').spawn(process.execPath, ${JSON.stringify(args)}, {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
      env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
      ${when === 'spawn' ? `${die};` : `c.on('message', (m) => { if (m && m.type === 'ready') ${die}; });`}`;
    const parent = spawn(process.execPath, ['-e', parentCode], {stdio: ['ignore', 'pipe', 'inherit']});
    let out = '';
    parent.stdout.on('data', (d) => { out += d; });
    const until0 = Date.now() + 30000;
    while (!/\n/.test(out) && Date.now() < until0) await tick(20);
    const pid = Number(out.trim());
    const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    return {pid, socket, alive, diedAt: Date.now()};
  };
  // the orphan is watched every 20 ms: a socket that appears even briefly is seen
  const watchOrphan = async(d, ms) => {
    let sawSocket = false;
    const until0 = Date.now() + ms;
    while (d.alive() && Date.now() < until0) { if (fs.existsSync(d.socket)) sawSocket = true; await tick(20); }
    if (fs.existsSync(d.socket)) sawSocket = true;
    return {ended: !d.alive(), sawSocket, after: Date.now() - d.diedAt};
  };

  it('ends, never listening, when ch-local daemon dies right after spawning it (#255 review)', async() => {
    const d = await dyingDaemon('spawn');
    try {
      const w = await watchOrphan(d, 10000);
      assert.strictEqual(w.ended, true, 'the runtime ended (an orphan would listen at the 3 s net and stay up)');
      assert.strictEqual(w.sawSocket, false, 'and never held the socket');
    } finally {
      if (d.alive()) process.kill(d.pid, 'SIGKILL');
    }
  });

  it('ends, never listening, when ch-local daemon dies after the ready, sending no restore (#255 review)', async() => {
    const d = await dyingDaemon('ready');
    try {
      const w = await watchOrphan(d, 10000);
      assert.strictEqual(w.ended, true, 'the runtime ended');
      assert.ok(w.after < 2000, `within 2 s, under the 3 s net (${w.after} ms)`);
      assert.strictEqual(w.sawSocket, false, 'and never listened');
    } finally {
      if (d.alive()) process.kill(d.pid, 'SIGKILL');
    }
  });

  it('a resume survives a runtime restart by the daemon\'s copy of its newest hash, and only by its newest token (N3)', async() => {
    r = runtime(home);
    let secret = await listening(r);
    const first = await shim.session(r.socket, secret);
    const id = first.welcome.session;
    const t1 = first.welcome.resumeToken;
    first.c.end();
    await tick(300);
    // a reconnect rotates the token
    const second = await shim.session(r.socket, secret, undefined, {resume: t1});
    assert.strictEqual(second.welcome != null && second.welcome.session, id, JSON.stringify(second.refused));
    const t2 = second.welcome.resumeToken;
    second.c.end();
    await tick(300);
    // the daemon's copy: the last hash told for the session, which is t2's
    const told = r.told.filter((m) => m.type === 'session-resume' && m.session === id);
    assert.strictEqual(told.length, 2, JSON.stringify(r.told));
    const hash = told[told.length - 1].hash;
    assert.strictEqual(hash, require('crypto').createHash('sha256').update(t2).digest('hex'));
    r.child.kill('SIGKILL');
    await r.exited;
    fs.rmSync(r.socket, {force: true});
    fs.rmSync(path.join(r.run, 'secret'), {force: true});
    r = runtime(home, [], {restore: {id: 'restore-1', type: 'restore', sessions: [{session: id, resume: hash, state: {overrides: [], locks: [], formsLeft: 3}}], declines: [], reset: []}});
    secret = await listening(r);
    const stale = await shim.attach(r.socket, secret, {resume: t1});
    assert.strictEqual(stale.refused != null && stale.refused.code, 'RESUME_REFUSED', 'the rotated-out token resumes nothing');
    stale.c.end();
    const back = await shim.session(r.socket, secret, undefined, {resume: t2});
    assert.strictEqual(back.welcome != null && back.welcome.session, id, `the same session, by the newest token: ${JSON.stringify(back.refused)}`);
    assert.notStrictEqual(back.welcome.resumeToken, t2, 'rotated again on the resume');
    // the restored row made it busy once, never twice (#263 review)
    assert.deepStrictEqual(r.told.filter((m) => m.type === 'idle' || m.type === 'busy').map((m) => m.type), ['busy']);
    back.c.end();
  });

  it('a second restore, and one after the safety net, are refused CONTROL_RESTORE_DONE (#255 review)', async() => {
    r = runtime(home);
    await listening(r);
    const again = await r.control({type: 'restore', sessions: [], declines: [], reset: []});
    assert.deepStrictEqual([again.ok, again.code], [false, 'CONTROL_RESTORE_DONE'], `second: ${JSON.stringify(again)}`);
    r.child.kill('SIGKILL');
    await r.exited;
    // the killed runtime's socket and secret would read as listening at once
    fs.rmSync(r.socket, {force: true});
    fs.rmSync(path.join(r.run, 'secret'), {force: true});
    r = runtime(home, [], {restore: false});
    const t0 = Date.now();
    await listening(r);   // after the 3 s net
    assert.ok(Date.now() - t0 >= 2500, 'it listened on the net, not at once');
    const late = await r.control({type: 'restore', sessions: [], declines: [], reset: []});
    assert.deepStrictEqual([late.ok, late.code], [false, 'CONTROL_RESTORE_DONE'], `late: ${JSON.stringify(late)}`);
  });

  it('a restore of another shape is refused CONTROL_BAD_RESTORE, and a good one may still come (#255 review)', async() => {
    r = runtime(home, [], {restore: false});
    await tick(500);
    const odd = await r.control({type: 'restore', sessions: {}, declines: [], reset: []});
    assert.deepStrictEqual([odd.ok, odd.code], [false, 'CONTROL_BAD_RESTORE'], JSON.stringify(odd));
    const good = await r.control({type: 'restore', sessions: [], declines: [], reset: []});
    assert.strictEqual(good.ok, true, JSON.stringify(good));
    const t0 = Date.now();
    await listening(r);
    assert.ok(Date.now() - t0 < 2500, 'it listened on the good restore, not the net');
  });

  it('the idle stop (#262 review): idle at listen; busy with a session; idle-stop refused while one is held, then accepted, and new handshakes refused', async() => {
    r = runtime(home, ['--requestTimeout', '2']);
    const secret = await listening(r);
    const until0 = Date.now() + 5000;
    while (!r.told.some((m) => m.type === 'idle') && Date.now() < until0) await tick(50);
    assert.ok(r.told.some((m) => m.type === 'idle'), `idle at listen: ${JSON.stringify(r.told)}`);
    const a = await shim.session(r.socket, secret);
    await tick(200);
    assert.strictEqual(r.told.filter((m) => m.type === 'idle' || m.type === 'busy').pop().type, 'busy');
    const held = await r.control({type: 'idle-stop'});
    assert.deepStrictEqual([held.ok, held.code], [false, 'CONTROL_BUSY'], JSON.stringify(held));
    // a pre-auth connection counts too
    const half = await shim.connect(r.socket);
    const mid = await r.control({type: 'idle-stop'});
    assert.deepStrictEqual([mid.ok, mid.code], [false, 'CONTROL_BUSY'], 'a session, and a handshake in pre-auth');
    half.end();
    a.c.end();
    assert.strictEqual((await r.control({type: 'idle-stop'})).code, 'CONTROL_BUSY', 'detached, within its window: not idle');
  });

  it('idle-stop on an idle runtime drains it: ok, and a new handshake is refused SHUTTING_DOWN (#262 review)', async() => {
    r = runtime(home);
    const secret = await listening(r);
    await tick(300);
    const stop = await r.control({type: 'idle-stop'});
    assert.strictEqual(stop.ok, true, JSON.stringify(stop));
    const late = await shim.attach(r.socket, secret);
    assert.strictEqual(late.refused != null && late.refused.code, 'SHUTTING_DOWN', JSON.stringify(late));
  });

  it('drain (C3): every shim is told, a new handshake is refused SHUTTING_DOWN', async() => {
    r = runtime(home);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const reply = await r.control({type: 'drain'});
    assert.strictEqual(reply.ok, true, JSON.stringify(reply));
    assert.deepStrictEqual(await a.c.json('C', 10000), {op: 'drain'});
    const b = await shim.attach(r.socket, secret);
    assert.strictEqual(b.refused != null && b.refused.code, 'SHUTTING_DOWN', JSON.stringify(b));
    // nothing in flight: the runtime closes the session's connection, and
    // tells ch-local daemon the drain is done (#35 review)
    const until0 = Date.now() + 5000;
    while (!r.told.some((m) => m.type === 'drained') && Date.now() < until0) await tick(50);
    assert.ok(r.told.some((m) => m.type === 'drained'), JSON.stringify(r.told));
    assert.strictEqual(a.c.sock.destroyed, true, 'its connection closed by the runtime');
  });

  it('two sessions each get their own answers', async() => {
    r = runtime(home);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    assert.notStrictEqual(a.welcome.session, b.welcome.session);
    const [ra, rb] = await Promise.all([request(a.c, 'tools/list'), request(b.c, 'tools/list')]);
    assert.ok(ra.result != null && rb.result != null);
    a.c.end();
    b.c.end();
  });

  it('a notice from ch-local reaches each open legacy session once, as its notifications/message, at the level it set; a modern one, unasked, none (B2 Task 3)', async() => {
    r = runtime(home);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    const c = await shim.session(r.socket, secret);
    // a and b are legacy sessions: they sent initialize; c never does
    for (const x of [a, b]) {
      const init = await requestLegacy(x.c, 'initialize', {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'test-client', version: '1.0.0'}});
      assert.ok(init != null && init.result != null && init.result.capabilities.logging != null, JSON.stringify(init));
    }
    // b asks for warning and above: no notification, the next result's line still
    assert.deepStrictEqual((await requestLegacy(b.c, 'logging/setLevel', {level: 'warning'})).result, {});
    const reply = await r.control({type: 'notice', module: null, text: 'ch-pack-x removed'});
    assert.ok(reply != null && reply.error == null, JSON.stringify(reply));
    const m = await shim.readM(a.c, 10000);
    assert.ok(m != null && m.header == null, 'a notification has no header');
    assert.deepStrictEqual(JSON.parse(m.line.toString('utf8')),
      {jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: 'ch-pack-x removed'}});
    // b asked for warning: nothing is sent to it
    assert.strictEqual(await shim.readM(b.c, 1500), null, 'no notification for b');
    assert.strictEqual(await shim.readM(a.c, 1500), null, 'a got it once');
    assert.strictEqual(await shim.readM(c.c, 1500), null, 'nothing unasked for a modern session');
    a.c.end();
    b.c.end();
    c.c.end();
  });

  it('keeps serving when its stdin ends (unlike --stdio)', async() => {
    r = runtime(home);
    const secret = await listening(r);
    r.child.stdin.end();
    await tick(1000);
    assert.strictEqual(r.code, undefined, `it exited: ${r.err.slice(-1500)}`);
    const a = await shim.session(r.socket, secret);
    assert.ok(a.welcome != null);
    a.c.end();
  });

  it('a new start writes a new secret', async() => {
    r = runtime(home);
    const first = await listening(r);
    r.child.kill('SIGKILL');
    await r.exited;
    fs.rmSync(path.join(r.run, 'secret'), {force: true});
    r = runtime(home);
    const second = await listening(r);
    assert.notStrictEqual(first.toString('hex'), second.toString('hex'));
  });

  it('refuses to start in a run directory not at 0700', async() => {
    r = runtime(home, [], {dirMode: 0o755});
    const {code} = await r.exited;
    assert.strictEqual(code, 2, r.err.slice(-1500));
    assert.match(r.err, /--sessionSocket/);
    assert.ok(!fs.existsSync(path.join(r.run, 'secret')), 'no secret written');
  });

  it('refuses a socket path over the platform limit', async() => {
    r = runtime(home, [], {socketName: 'x'.repeat(120)});
    const {code} = await r.exited;
    assert.strictEqual(code, 2, r.err.slice(-1500));
    assert.match(r.err, /bytes/);
  });

  it('refuses a socket another runtime is listening on', async() => {
    r = runtime(home);
    await listening(r);
    const second = runtime(home);
    const {code} = await second.exited;
    assert.strictEqual(code, 2, second.err.slice(-1500));
    // the start lock stops it first; a socket in use would too
    assert.match(second.err, /another runtime holds|in use/);
  });

  it('refuses --sessionSocket without --controlChannel ipc, or with --stdio', async() => {
    const run = path.join(home, 'run');
    fs.mkdirSync(run, {mode: 0o700});
    const args = [FRAMEWORK, '--no-workerThread', '--store', 'local', '--storePath', path.join(home, 'store'), '--sessionSocket', path.join(run, 's')];
    const without = spawn(process.execPath, args, {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
    let e1 = '';
    without.stderr.on('data', (d) => { e1 += d; });
    assert.strictEqual(await new Promise((res) => without.on('exit', res)), 2, e1);
    assert.match(e1, /--sessionSocket needs --controlChannel ipc/);
    const refused = async(extra, pattern, base = args) => {
      const c = spawn(process.execPath, [...base, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
      let e = '';
      c.stderr.on('data', (d) => { e += d; });
      assert.strictEqual(await new Promise((res) => c.on('exit', res)), 2, e);
      assert.match(e, pattern);
    };
    await refused(['--controlChannel', 'ipc', '--stdio'], /--stdio and --sessionSocket: choose one/);
    await refused(['--controlChannel', 'ipc', '--port', '19000'], /--sessionSocket and --port: choose one/);
    await refused(['--controlChannel', 'ipc', '--authConfigPath', path.join(home, 'auth.json')], /only for the single-identity profile/);
    // shared mode is ch-local's local store: a store shared across processes
    // (Redis) would break the per-process job-to-session map
    await refused(['--controlChannel', 'ipc', '--sessionSocket', path.join(run, 's')], /--sessionSocket needs --store local/,
      [FRAMEWORK, '--no-workerThread', '--store', 'redis', '--redisUrl', 'redis://127.0.0.1:1']);
    await refused(['--controlChannel', 'ipc', '--sessionSocket'], /--sessionSocket needs a path/, [FRAMEWORK, '--no-workerThread', '--store', 'local', '--storePath', path.join(home, 'store')]);
    // C2: --sessionDir only with --sessionSocket, and with a path
    // (--stdio, so the port guard lets it spawn: the refusal comes first)
    await refused(['--stdio', '--sessionDir', run], /--sessionDir is only for --sessionSocket/, [FRAMEWORK, '--no-workerThread', '--store', 'local', '--storePath', path.join(home, 'store')]);
    await refused(['--controlChannel', 'ipc', '--sessionDir'], /--sessionDir needs a path/);
  });

  // C2 ---------------------------------------------------------------------

  it('the long-home fallback: the socket in a directory of its own (a sticky parent allowed), the secret and lock in --sessionDir', async() => {
    const tmp = path.join(home, 'tmp');
    const sockDir = path.join(tmp, 'ch-1000');
    fs.mkdirSync(sockDir, {recursive: true, mode: 0o700});
    fs.chmodSync(sockDir, 0o700);
    fs.chmodSync(tmp, 0o1777);
    const run = path.join(home, 'run', 'daemon');
    r = runtime(home, ['--sessionDir', run], {socketPath: path.join(sockDir, 's')});
    const secret = await listening(r);
    assert.ok(secret != null, `no secret in --sessionDir: ${r.err.slice(-2000)}`);
    assert.deepStrictEqual(fs.readdirSync(sockDir), ['s'], 'only the socket is beside the socket');
    assert.ok(fs.existsSync(path.join(run, 'runtime.lock')), 'the lock is in --sessionDir');
    assert.ok(r.told.some((m) => m.type === 'listening' && m.socket === path.join(sockDir, 's')));
    const a = await shim.session(r.socket, secret);
    assert.ok(a.welcome != null, JSON.stringify(a.refused));
    a.c.end();
  });

  it('the fallback\'s socket directory is checked too: a world-writable parent without the sticky bit is refused', async() => {
    const tmp = path.join(home, 'tmp');
    const sockDir = path.join(tmp, 'ch-1000');
    fs.mkdirSync(sockDir, {recursive: true, mode: 0o700});
    fs.chmodSync(sockDir, 0o700);
    fs.chmodSync(tmp, 0o777);
    r = runtime(home, ['--sessionDir', path.join(home, 'run', 'daemon')], {socketPath: path.join(sockDir, 's')});
    const {code} = await r.exited;
    fs.chmodSync(tmp, 0o700);
    assert.strictEqual(code, 2, r.err.slice(-1500));
    assert.match(r.err, /writable/);
    assert.ok(!fs.existsSync(path.join(home, 'run', 'daemon', 'secret')), 'no secret written');
  });

  it('a named pipe\'s name is refused on POSIX', async() => {
    r = runtime(home, ['--sessionDir', path.join(home, 'run', 'daemon')], {socketPath: '\\\\.\\pipe\\countinghouse-0123456789abcdef0123456789abcdef'});
    const {code} = await r.exited;
    assert.strictEqual(code, 2, r.err.slice(-1500));
    assert.match(r.err, /a named pipe is Windows' only/);
  });
});
