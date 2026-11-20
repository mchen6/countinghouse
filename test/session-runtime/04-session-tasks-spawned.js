'use strict';
// Shared runtime B5, Task 2, spawned: tasks by key and session in a real
// shared runtime (--sessionSocket, the local store, two sessions through
// the test's shim). Every session has the user's one key; a session's tasks
// are its own. Another session's task id is answered as one never issued,
// in both eras:
//   - 2026-07-28 (M15's extension, now offered to a session): A's task, a
//     minted t- id; B's tasks/get and tasks/cancel of it are the one -32602
//     an unknown id gets (M15's recorded precondition, closed here);
//   - legacy (params.task): A's task has an s- id; B's tasks/get,
//     tasks/result and tasks/cancel of it equal B's for a well-formed id
//     never issued; B's tasks/list is empty while A's has it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');
// (one copy: the runtime's listening tell, null if it exited first)
const {listening} = require('./helpers/per-session');

const ROOT = path.join(__dirname, '..', '..');
const FRAMEWORK = path.join(ROOT, 'framework.js');
const V = '2026-07-28';
const EXT = 'io.modelcontextprotocol/tasks';
const MODERN = {'io.modelcontextprotocol/protocolVersion': V, 'io.modelcontextprotocol/clientCapabilities': {extensions: {[EXT]: {}}}};
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const until = async(test, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await test()) && Date.now() < end) await tick(100);
  return test();
};

// a scenario (the single-identity profile lists scenarios) with one long-running action
function scenario(home) {
  const dir = path.join(home, 'pack', 'ch-session-tasks');
  const svc = 'taskService';
  fs.mkdirSync(path.join(dir, 'handlers', svc), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'ch-session-tasks', version: '1.0.0', license: 'Apache-2.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'ch-session-tasks', manufacturer: 'countinghouse-test', modelDescription: 'tasks',
    serviceList: {[`urn:countinghouse-test:serviceID:${svc}`]: {actionList: [{name: 'slow', description: 'runs a while', longRunning: true,
      input: {schema: `/${svc}/slow/input`}, output: {schema: `/${svc}/slow/output`}},
    {name: 'finished', description: 'how many slow runs have finished', input: {schema: `/${svc}/finished/input`}, output: {schema: `/${svc}/finished/output`}}]}}}}));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    [svc]: {slow: {input: {type: 'object'}, output: {type: 'object'}}, finished: {input: {type: 'object'}, output: {type: 'object'}}}}));
  // a slow run counts itself once it has waited (B5 Task 4: a run its session ended under goes to its end)
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'slow.js'), 'module.exports = async (input) => { await new Promise((r) => setTimeout(r, Number(input.ms) || 0)); global.__slowDone = (global.__slowDone || 0) + 1; return {output: {done: true}}; };\n');
  fs.writeFileSync(path.join(dir, 'handlers', svc, 'finished.js'), 'module.exports = async () => ({output: {finished: global.__slowDone || 0}});\n');
  return dir;
}

function runtime(home, extra = []) {
  const run = path.join(home, 'run', 'daemon');
  fs.mkdirSync(run, {recursive: true});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  fs.chmodSync(run, 0o700);
  const socket = path.join(run, 's');
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, socket, run, err: '', out: '', told: []};
  child.on('message', (m) => {
    if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    // (what the runtime tells unasked: its 'listening', among others)
    if (m != null && m.id === undefined && m.type !== 'ready') r.told.push(m);
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', (d) => { r.out += d; });
  r.exited = new Promise((res) => child.on('exit', (code, signal) => { r.code = code; res({code, signal}); }));
  child.on('error', () => {});
  return r;
}
const secretOf = (r) => {
  try { return handshake.parseSecret(fs.readFileSync(path.join(r.run, 'secret'), 'utf8')); } catch (e) { return null; }
};
let nextSeq = 1;
async function request(c, method, params, meta) {
  const seq = nextSeq++;
  shim.message(c, {seq}, JSON.stringify({jsonrpc: '2.0', id: seq, method, params: Object.assign({}, meta != null ? {_meta: meta} : {}, params)}));
  for (;;) {
    const m = await shim.readM(c, 60000);
    if (m == null) return null;
    if (m.header != null && m.header.seq === seq) return JSON.parse(m.line.toString('utf8'));
  }
}
const modern = (s, method, params) => request(s.c, method, params, MODERN);
const legacy = (s, method, params) => request(s.c, method, params, null);
// an answer with its JSON-RPC id and the task id it names taken out, so two can be compared
const shape = (got, id) => JSON.stringify(Object.assign({}, got, {id: null})).split(id).join('<id>');

describe('session-runtime 04: tasks by key and session, spawned (shared runtime B5, Task 2)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return;   // the named pipe is C2's
  let home;
  let r;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr4-')); });
  afterEach(async() => {
    if (r != null && r.child.exitCode === null) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  it('a session\'s tasks are its own: another session\'s id is one never issued, in both eras', async() => {
    r = runtime(home, ['--loadModule', scenario(home)]);
    assert.ok(await listening(r) != null, `the runtime is not listening (exit ${r.code}): ${(r.err || '').slice(-1500)}`);
    const secret = secretOf(r);
    const open = async() => { try { return await shim.session(r.socket, secret); } catch (e) { throw new Error(`${e.message}\n${r.err.slice(-2000)}`); } };
    const a = await open();
    const b = await open();
    assert.ok(await until(async() => {
      const list = await modern(a, 'tools/list', {});
      return list != null && list.result != null && list.result.tools.some((t) => t.name === 'slow');
    }), r.err.slice(-1500));

    // 2026-07-28: the extension is offered to a session, and A's task is A's
    const made = await modern(a, 'tools/call', {name: 'slow', arguments: {ms: 300}});
    assert.strictEqual(made.result.resultType, 'task', JSON.stringify(made));
    const tid = made.result.taskId;
    assert.match(tid, /^t-[0-9a-f]{32}$/);
    const never = `t-${'0'.repeat(32)}`;
    // B's answer for A's id, the whole of it, against B's for an id never issued
    const asNever = async(method, id, extra = {}) => {
      const fromB = await modern(b, method, Object.assign({taskId: id}, extra));
      const unknown = await modern(b, method, Object.assign({taskId: never}, extra));
      assert.strictEqual(fromB.error && fromB.error.code, -32602, `${method}: ${JSON.stringify(fromB)}`);
      assert.strictEqual(shape(fromB, id), shape(unknown, never), method);
    };
    for (const method of ['tasks/get', 'tasks/cancel']) await asNever(method, tid);
    await asNever('tasks/update', tid, {inputResponses: {}});
    assert.ok(await until(async() => (await modern(a, 'tasks/get', {taskId: tid})).result.status === 'completed'), 'A\'s own, not cancelled by B');
    // and once it has completed
    await asNever('tasks/get', tid);

    // A cancels its own working task (its tombstone is written): A reads it
    // cancelled; to B it is still an id never issued
    const long = await modern(a, 'tools/call', {name: 'slow', arguments: {ms: 3000}});
    const cid = long.result.taskId;
    const cancelled = await modern(a, 'tasks/cancel', {taskId: cid});
    assert.ok(cancelled.result != null, JSON.stringify(cancelled));
    assert.strictEqual((await modern(a, 'tasks/get', {taskId: cid})).result.status, 'cancelled');
    for (const method of ['tasks/get', 'tasks/cancel']) await asNever(method, cid);
    await asNever('tasks/update', cid, {inputResponses: {}});

    // legacy: params.task makes an s- task
    const lmade = await legacy(a, 'tools/call', {name: 'slow', arguments: {ms: 300}, task: {}});
    assert.ok(lmade.result != null && lmade.result.task != null, JSON.stringify(lmade));
    const lid = lmade.result.task.taskId;
    assert.match(lid, /^s-[0-9a-f]{32}$/);
    const lnever = `s-${'0'.repeat(32)}`;
    for (const method of ['tasks/get', 'tasks/result', 'tasks/cancel']) {
      const fromB = await legacy(b, method, {taskId: lid});
      const unknown = await legacy(b, method, {taskId: lnever});
      assert.strictEqual(shape(fromB, lid), shape(unknown, lnever), `${method}: ${JSON.stringify(fromB)}`);
    }
    assert.deepStrictEqual((await legacy(b, 'tasks/list', {})).result.tasks, []);
    assert.ok((await legacy(a, 'tasks/list', {})).result.tasks.some((t) => t.taskId === lid));
    assert.ok(await until(async() => (await legacy(a, 'tasks/get', {taskId: lid})).result.status === 'completed'), 'A\'s legacy task, not cancelled by B');
    // and once it has completed: B's get and result of it are still a never-issued id's
    for (const method of ['tasks/get', 'tasks/result']) {
      const fromB = await legacy(b, method, {taskId: lid});
      const unknown = await legacy(b, method, {taskId: lnever});
      assert.strictEqual(shape(fromB, lid), shape(unknown, lnever), `${method} after completion: ${JSON.stringify(fromB)}`);
    }
    a.c.end();
    b.c.end();
  });

  it('A says bye with a task under way: it runs to its end (cooperative), and B\'s own task completes (B5 Task 4)', async() => {
    r = runtime(home, ['--loadModule', scenario(home)]);
    assert.ok(await listening(r) != null, `the runtime is not listening (exit ${r.code}): ${(r.err || '').slice(-1500)}`);
    const secret = secretOf(r);
    const a = await shim.session(r.socket, secret);
    const b = await shim.session(r.socket, secret);
    assert.ok(await until(async() => {
      const list = await modern(a, 'tools/list', {});
      return list != null && list.result != null && list.result.tools.some((t) => t.name === 'slow');
    }), r.err.slice(-1500));
    const finished = async() => {
      const got = await modern(b, 'tools/call', {name: 'finished', arguments: {}});
      return got != null && got.result != null && got.result.structuredContent != null ? got.result.structuredContent.finished : JSON.stringify(got);
    };
    assert.strictEqual(await finished(), 0);
    const made = await modern(a, 'tools/call', {name: 'slow', arguments: {ms: 1500}});
    const tid = made.result.taskId;
    assert.match(tid, /^t-[0-9a-f]{32}$/, JSON.stringify(made));
    // A ends (its shim says bye) while its task runs
    a.c.send('C', {op: 'bye'});
    // its run is not interrupted: it waits out its 1.5 s and counts itself
    assert.ok(await until(async() => (await finished()) === 1), `A's run went to its end: ${await finished()}`);
    // B's own task, made after A's end, completes; A's id is still one never issued to B
    const mine = await modern(b, 'tools/call', {name: 'slow', arguments: {ms: 100}});
    assert.ok(await until(async() => (await modern(b, 'tasks/get', {taskId: mine.result.taskId})).result.status === 'completed'), 'B\'s completes');
    const never = `t-${'0'.repeat(32)}`;
    assert.strictEqual(shape(await modern(b, 'tasks/get', {taskId: tid}), tid), shape(await modern(b, 'tasks/get', {taskId: never}), never));
    assert.strictEqual(r.child.exitCode, null, 'the runtime serves on');
    b.c.end();
  });
});
