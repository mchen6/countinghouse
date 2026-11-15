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
function scenario(home) {
  const dir = path.join(home, 'pack', 'ch-session-hello');
  const svc = 'helloService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ch-session-hello', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-session-hello', manufacturer: 'countinghouse-test', modelDescription: 'hello',
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

  it('until per-session settings land, a session may tighten or read settings but not loosen or confirm, nor set the log level', async() => {
    const settingsFile = path.join(home, 'settings.json');
    r = runtime(home, ['--settingsFile', settingsFile]);
    const secret = await listening(r);
    const a = await shim.session(r.socket, secret);
    const call = (args, extra = {}) => request(a.c, 'tools/call', Object.assign({name: 'countinghouse_settings', arguments: args}, extra));
    const got = await call({action: 'get'});
    assert.ok(got.result != null && got.result.isError !== true, JSON.stringify(got));
    const tighter = await call({action: 'set', name: 'requestTimeout', value: '20s'});
    assert.ok(tighter.result.isError !== true, JSON.stringify(tighter));
    const looser = await call({action: 'set', name: 'requestTimeout', value: '60s'});
    assert.strictEqual(looser.result.isError, true, JSON.stringify(looser));
    assert.strictEqual(looser.result._meta['countinghouse/code'], 'SETTING_LOOSENS_A_GUARD');
    const confirm = await call({action: 'set', name: 'requestTimeout', value: '60s'}, {requestState: 'x', inputResponses: {}});
    assert.strictEqual(confirm.result._meta['countinghouse/code'], 'SETTING_LOOSENS_A_GUARD', JSON.stringify(confirm));
    const level = await request(a.c, 'logging/setLevel', {level: 'debug'});
    assert.ok(level.error != null, JSON.stringify(level));
    assert.match(level.error.message, /shared runtime/);
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
    assert.match(second.err, /in use/);
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
    const both = spawn(process.execPath, [...args, '--controlChannel', 'ipc', '--stdio'], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
    let e2 = '';
    both.stderr.on('data', (d) => { e2 += d; });
    assert.strictEqual(await new Promise((res) => both.on('exit', res)), 2, e2);
    assert.match(e2, /--stdio and --sessionSocket: choose one/);
  });
});
