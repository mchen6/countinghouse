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

function runtime(home, extra = [], {dirMode = 0o700, socketName = 's'} = {}) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, dirMode);
  const socket = path.join(run, socketName);
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', out: '', code: undefined};
  // ch-local's control requests over the IPC channel, as stdio's helper sends them
  const replies = new Map();
  let nextControl = 1;
  child.on('message', (m) => { const f = m != null ? replies.get(m.id) : null; if (f != null) { replies.delete(m.id); f(m); } });
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

  it('until per-session settings land, a session reads settings but changes none, nor reaches tasks; its log level is its own (B2 Task 3)', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile]);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const call = (args, extra = {}) => request(a.c, 'tools/call', Object.assign({name: 'countinghouse_settings', arguments: args}, extra));
    const got = await call({action: 'get'});
    assert.ok(got.result != null && got.result.isError !== true, JSON.stringify(got));
    // every set is the terminal's: a tightening, a loosening, a pack on or
    // off, a confirmation's retry; nothing is written
    for (const [args, extra] of [[{action: 'set', name: 'requestTimeout', value: '20s'}, {}], [{action: 'set', name: 'requestTimeout', value: '60s'}, {}],
      [{action: 'set', name: 'requestTimeout', value: '60s'}, {requestState: 'x', inputResponses: {}}],
      [{action: 'set', name: 'pack.ch-pack-x', value: 'on'}, {}], [{action: 'set', name: 'pack.ch-pack-x', value: 'off'}, {}]]) {
      const r2 = await call(args, extra);
      assert.strictEqual(r2.result.isError, true, JSON.stringify(r2));
      assert.strictEqual(r2.result._meta['countinghouse/code'], 'SETTING_TERMINAL_ONLY_SHARED', `${JSON.stringify(args)}: ${JSON.stringify(r2)}`);
      assert.match(r2.result.content[0].text, /ch-local settings set/);
    }
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

  it('takes ch-local\'s control requests: a pack loaded in place is listed to a session', async() => {
    const packs = path.join(home, 'packs');
    const dir = scenario(home, {dir: path.join(packs, 'ch-pack-two', '1.0.0', 'node_modules', 'ch-pack-two'), name: 'ch-pack-two'});
    r = runtime(home, ['--packsRoot', packs]);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const reply = await r.control({type: 'load', name: 'ch-pack-two', scenario: dir});
    assert.strictEqual(reply.ok, true, `${JSON.stringify(reply)}\n${r.err.slice(-1500)}`);
    assert.ok(Array.isArray(reply.tools) && reply.tools.length === 1, JSON.stringify(reply));
    const list = await request(a.c, 'tools/list');
    assert.ok(list.result.tools.some((t) => t.name === reply.tools[0]), JSON.stringify(list.result.tools.map((t) => t.name)));
    a.c.end();
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

  it('a notice from ch-local reaches each open session once, as its notifications/message, at the level it set (B2 Task 3)', async() => {
    r = runtime(home);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
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
    a.c.end();
    b.c.end();
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
  });
});
