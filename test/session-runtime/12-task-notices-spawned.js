'use strict';
// MCP completeness M16, Task 2 on the shared runtime, spawned (the plan's D4,
// reversed: tasks run in sessions since B5 Task 2): two sessions of the
// user's one key each make a 2026-07-28 task, and each listens for both
// tasks' ids. Each is agreed, and told, only its own: the listen agrees an
// id through tasks/get's own lookup (findModernTask, its session's scope),
// and every notice is built through it again, so another session's task is
// never agreed and its changes never reach this session's stream.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const EXT = 'io.modelcontextprotocol/tasks';
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {extensions: {[EXT]: {}}}};
const SUB = 'io.modelcontextprotocol/subscriptionId';
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// a scenario with one long-running action
function scenario(home) {
  const dir = path.join(home, 'pack', 'ch-task-notices');
  const svc = 'taskService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ch-task-notices', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-task-notices', manufacturer: 'countinghouse-test', modelDescription: 'tasks',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: 'slow', description: 'runs a while', longRunning: true,
      input: {schema: `/${svc}/slow/input`}, output: {schema: `/${svc}/slow/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {slow: {input: {type: 'object', properties: {ms: {type: 'integer', minimum: 0, maximum: 10000}}}, output: {type: 'object'}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'slow.js'),
    'module.exports = async (input) => { await new Promise((r) => setTimeout(r, Number(input.ms) || 0)); return {output: {done: true}}; };\n');
  return dir;
}

function runtime(home, args) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...args], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', told: []};
  child.on('message', (m) => {
    if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    // (what the runtime tells unasked: its 'listening', among others)
    if (m != null && m.id === undefined && m.type !== 'ready') r.told.push(m);
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.err += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
// the runtime's own 'listening' tell (after its start's checks), not its
// socket file and secret: a first connect raced those (ECONNREFUSED), the
// flake seen four times on 11-17, as session-runtime 01, 03, 10 and 11
// found; or its exit
const listening = async(r) => {
  await until(async() => (r.told.some((m) => m.type === 'listening') && secretOf(r) != null) || r.code !== undefined);
  return secretOf(r);
};

// a session: answers by seq, notifications in order
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
async function request(s, method, params = {}) {
  const seq = nextSeq++;
  shim.message(s.c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({_meta: META}, params)}));
  await until(() => s.answers.has(seq), 60000);
  return s.answers.get(seq);
}
async function listen(s, notifications) {
  const id = nextSeq++;
  shim.message(s.c, {seq: id}, JSON.stringify({jsonrpc: '2.0', id, method: 'subscriptions/listen', params: {_meta: META, notifications}}));
  const ackOf = () => s.notes.find((n) => n.method === 'notifications/subscriptions/acknowledged' && n.params._meta[SUB] === id);
  await until(() => ackOf() != null);
  return {id, agreed: ackOf() != null ? ackOf().params.notifications : null};
}
const taskNotes = (s, id) => s.notes.filter((n) => n.method === 'notifications/tasks' && n.params._meta[SUB] === id).map((n) => `${n.params.taskId} ${n.params.status}`);

describe('session-runtime 12: a session\'s task listen is agreed and told only its own tasks, spawned (M16 Task 2)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr12-')); });
  afterEach(async() => {
    if (r != null && r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('two sessions listen for both tasks: each is agreed its own, and told its own completion only', async() => {
    r = runtime(home, ['--loadModule', scenario(home)]);
    await listening(r);
    const open = async() => { try { return session((await shim.session(r.socket, secretOf(r))).c); } catch (e) { throw new Error(`${e.message}\n${r.err.slice(-2000)}`); } };
    const a = await open();
    const b = await open();
    assert.ok(await until(async() => {
      const list = await request(a, 'tools/list');
      return list != null && list.result != null && list.result.tools.some((t) => t.name === 'slow');
    }), r.err.slice(-1500));
    const made = async(s) => {
      const got = await request(s, 'tools/call', {name: 'slow', arguments: {ms: 1500}});
      assert.strictEqual(got.result && got.result.resultType, 'task', JSON.stringify(got));
      return got.result.taskId;
    };
    const ta = await made(a);
    const tb = await made(b);
    const la = await listen(a, {taskIds: [ta, tb]});
    const lb = await listen(b, {taskIds: [tb, ta]});
    assert.deepStrictEqual(la.agreed, {taskIds: [ta]}, 'A: its own only');
    assert.deepStrictEqual(lb.agreed, {taskIds: [tb]}, 'B: its own only');
    assert.ok(await until(() => taskNotes(a, la.id).includes(`${ta} completed`) && taskNotes(b, lb.id).includes(`${tb} completed`)), JSON.stringify([a.notes, b.notes]));
    await tick(1000);
    assert.ok(!taskNotes(a, la.id).some((n) => n.startsWith(tb)), 'A is never told of B\'s task');
    assert.ok(!taskNotes(b, lb.id).some((n) => n.startsWith(ta)), 'B is never told of A\'s task');
  });
});
