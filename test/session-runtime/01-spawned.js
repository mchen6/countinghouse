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
function runtime(home, extra = [], {dirMode = 0o700, socketName = 's', restore = true} = {}) {
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

  it('until per-session settings land, a session reads settings but changes none, nor sets the log level, nor reaches tasks', async() => {
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
    // a modern request's logging/setLevel is gone in 2026-07-28; either way
    // a session gets an error, never a changed level
    const level = await request(a.c, 'logging/setLevel', {level: 'debug'});
    assert.ok(level.error != null, JSON.stringify(level));
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
