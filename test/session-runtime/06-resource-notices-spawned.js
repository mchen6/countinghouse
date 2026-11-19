'use strict';
// MCP completeness M8 on the shared runtime, spawned: a resources/updated
// notice reaches only the sessions whose own view holds the change.
//   - A per-session module (R1): two sessions subscribe to the same URI of
//     its resource; A's call to the action its changesWith names notifies A
//     only (A's worker's state changed, not B's, and B must not learn that A
//     acted), and B's notifies B only.
// (The B3 case, a pack one session has on, went with the per-session pack
// layer in M5a: no session has a view of its own.)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'per-session-module');
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};
const SUB = 'io.modelcontextprotocol/subscriptionId';
const COUNT_URI = 'countinghouse://m/per_session_module/count';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// the per-session fixture as a scenario, its resource `count` changed by
// touch (changesWith)
function perSession(home) {
  const dir = path.join(home, 'pack', 'per-session-module');
  fs.cpSync(FIXTURE, dir, {recursive: true});
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.countinghouse = Object.assign({}, pkg.countinghouse, {role: 'scenario'});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
  for (const service of Object.values(api.device.serviceList)) {
    for (const action of service.actionList) if (action.resource != null) action.resource.changesWith = ['stateService.touch'];
  }
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(api));
  return dir;
}

// the runtime, spawned as ch-local's daemon spawns it
function runtime(home, args) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, '--settingsFile', path.join(home, 'settings.json'), ...args],
  {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: '',
    NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'fixtures', 'session-elicitation-preload.js')}`})});
  const r = {child, socket, run, err: ''};
  const replies = new Map();
  let nextControl = 1;
  r.control = (msg) => new Promise((resolve) => { const id = nextControl++; replies.set(id, resolve); child.send(Object.assign({}, msg, {id})); });
  child.on('message', (m) => {
    if (m == null) return undefined;
    if (m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    const f = replies.get(m.id);
    if (f != null) { replies.delete(m.id); return f(m); }
    return undefined;
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.err += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => res({code, signal})));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};

// a session: its lines as they arrive (answers by seq, notifications in order)
let nextSeq = 1;
function session(c) {
  const s = {c, answers: new Map(), notes: []};
  (async() => {
    for (;;) {
      const m = await shim.readM(c, 120000);
      if (m == null) return;
      const msg = JSON.parse(m.line.toString('utf8'));
      if (m.header != null) s.answers.set(m.header.seq, msg); else s.notes.push(msg);
    }
  })();
  return s;
}
async function request(s, method, params = {}, meta = {_meta: META}) {
  const seq = nextSeq++;
  shim.message(s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({}, meta, params)}));
  await until(() => s.answers.has(seq), 60000);
  return s.answers.get(seq);
}
// a listen: its id, once acknowledged, and what was agreed
async function listen(s, notifications) {
  const id = nextSeq++;
  shim.message(s.c, {seq: id}, JSON.stringify({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META, notifications}}));
  const ackOf = () => s.notes.find((n) => n.method === 'notifications/subscriptions/acknowledged' && n.params._meta[SUB] === id);
  await until(() => ackOf() != null);
  const ack = ackOf();
  return {id, agreed: ack != null ? ack.params.notifications : null};
}
const updatesOf = (s, id) => s.notes.filter((n) => n.method === 'notifications/resources/updated' && n.params._meta[SUB] === id).map((n) => n.params.uri);
const quiet = () => tick(1000);

describe('session-runtime 06: resources/updated reaches only the sessions whose view changed, spawned (M8)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr6-')); });
  afterEach(async() => {
    if (r != null && r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });
  const open = async() => {
    await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
    try { return session((await shim.session(r.socket, secretOf(r))).c); } catch (e) { throw new Error(`${e.message}\n${r.err.slice(-2000)}`); }
  };
  const tools = async(s) => {
    const got = await request(s, 'tools/list');
    return (got != null && got.result != null) ? got.result.tools.map((t) => t.name) : [];
  };

  it('a per-session module: both sessions subscribe to one URI; A\'s touch tells A only, B\'s tells B only', async() => {
    r = runtime(home, ['--loadModule', perSession(home)]);
    const a = await open();
    const b = await open();
    for (const s of [a, b]) assert.ok(await until(async() => (await tools(s)).includes('touch')), r.err.slice(-2000));
    const la = await listen(a, {resourceSubscriptions: [COUNT_URI]});
    const lb = await listen(b, {resourceSubscriptions: [COUNT_URI]});
    assert.deepStrictEqual([la.agreed, lb.agreed], [{resourceSubscriptions: [COUNT_URI]}, {resourceSubscriptions: [COUNT_URI]}]);

    const touchA = await request(a, 'tools/call', {name: 'touch', arguments: {}});
    assert.ok(touchA.result != null && touchA.result.isError !== true, JSON.stringify(touchA).slice(0, 600));
    assert.ok(await until(() => updatesOf(a, la.id).length === 1), JSON.stringify(a.notes));
    await quiet();
    assert.deepStrictEqual([updatesOf(a, la.id), updatesOf(b, lb.id)], [[COUNT_URI], []], 'A\'s touch was told to B');

    const touchB = await request(b, 'tools/call', {name: 'touch', arguments: {}});
    assert.ok(touchB.result != null && touchB.result.isError !== true, JSON.stringify(touchB).slice(0, 600));
    assert.ok(await until(() => updatesOf(b, lb.id).length === 1), JSON.stringify(b.notes));
    await quiet();
    assert.deepStrictEqual([updatesOf(a, la.id).length, updatesOf(b, lb.id).length], [1, 1], 'B\'s touch was told to A');
    a.c.end();
    b.c.end();
  });
});
