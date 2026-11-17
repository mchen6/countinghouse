'use strict';
// R1 Task 5 (#236 section 4a, §9 residual 5; plan
// docs/superpowers/plans/2026-11-16-shared-runtime-r1-per-session-modules.md
// Task 5 and the Reviewer's peer-channel ruling): a hop into a per-session
// module reaches the worker of the session its own call's token names. A
// shared caller (ps-caller) serving two sessions at once, in one worker,
// hops for each into that session's worker, never the other's. On the
// shared runtime every such hop takes the main-thread route (it is the
// single-identity profile: no peer channels), which is the route the
// runtime uses for a per-session module under any profile (the broker
// never opens one a direct channel: test/direct-peer-channels' in-process
// case). A hop whose session has ended runs nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {NAME, tick, until, perSession, caller, runtime, secretOf, request, outOf, counts, shim} = require('./helpers/per-session');

describe('session-runtime 10: a hop reaches its own session\'s worker (R1 Task 5)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr4-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  // the runtime with the caller and its per-session part, and two sessions
  async function twoSessions(extra = []) {
    const part = perSession(home, {dir: path.join(home, 'hop', 'node_modules', NAME), role: 'part'});
    r = runtime(home, ['--loadModule', part, '--loadModule', caller(home), ...extra]);
    await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
    const secret = secretOf(r);
    assert.ok(secret != null, `no secret: ${r.log().slice(-3000)}`);
    const out = {};
    for (const s of ['A', 'B']) {
      const a = await shim.session(r.socket, secret);
      assert.ok(a.welcome != null, JSON.stringify(a.refused));
      out[s] = {c: a.c, id: a.welcome.session};
    }
    let tools = [];
    await until(async() => {
      const list = await request(out.A.c, 'tools/list');
      tools = (list != null && list.result != null) ? list.result.tools.map((t) => t.name) : [];
      return tools.some((t) => /hoptwice$/.test(t));
    });
    const tool = (action) => tools.find((t) => t === action.toLowerCase() || new RegExp(`_${action.toLowerCase()}$`).test(t));
    assert.ok(tool('hop') != null, `${tools.join(', ')}\n${r.log().slice(-3000)}`);
    out.call = (s, action, args = {}) => request(out[s].c, 'tools/call', {name: tool(action), arguments: args});
    return out;
  }
  const partition = (sid) => path.join(home, 'module_data', NAME, 'sessions', sid, 'data');

  it('a hop from a shared caller reaches the calling session\'s worker, with its files and store', async() => {
    const s = await twoSessions();
    assert.deepStrictEqual(outOf(await s.call('A', 'hop')), {file: 1, store: 1, memory: 1});
    assert.deepStrictEqual(outOf(await s.call('A', 'hop')), {file: 2, store: 2, memory: 2});
    assert.deepStrictEqual(outOf(await s.call('B', 'hop')), {file: 1, store: 1, memory: 1}, 'B\'s own');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.A.id), 'count'), 'utf8'), '2');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.B.id), 'count'), 'utf8'), '1');
    assert.deepStrictEqual(counts(r), {up: 2, ended: 0});
  });

  it('hop isolation: the shared caller serving A and B at once, in one worker, hops each into its own session\'s worker', async() => {
    const s = await twoSessions();
    // interleaved: A's first hop, B's first, A's second, B's second, all
    // from the one caller worker
    const [a, b] = await Promise.all([s.call('A', 'hopTwice', {ms: 600}), tick(200).then(() => s.call('B', 'hopTwice', {ms: 600}))]);
    assert.deepStrictEqual(outOf(a), {first: {file: 1, store: 1, memory: 1}, second: {file: 2, store: 2, memory: 2}});
    assert.deepStrictEqual(outOf(b), {first: {file: 1, store: 1, memory: 1}, second: {file: 2, store: 2, memory: 2}});
    assert.strictEqual(fs.readFileSync(path.join(partition(s.A.id), 'count'), 'utf8'), '2');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.B.id), 'count'), 'utf8'), '2');
  });

  it('a hop made after its session has left (bye) runs nothing: DEVICE_NOT_FOUND, no ID; the other session runs on', async() => {
    const s = await twoSessions();
    outOf(await s.call('B', 'hop'));
    // A's call is under way in the caller (sent, given time to start); A
    // leaves before the call's hop, made 1.5 s in
    const pending = s.call('A', 'later', {ms: 1500}).catch(() => null);
    void pending;
    await tick(400);
    s.A.c.send('C', {op: 'bye'});
    const log = path.join(home, 'module_data', 'ps-caller', 'data', 'hops.log');
    await until(async() => fs.existsSync(log), 15000);
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    for (const got of lines) {
      assert.strictEqual(got.code, 'DEVICE_NOT_FOUND', JSON.stringify(got));
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(got.message), `no device ID: ${got.message}`);
    }
    assert.ok(!fs.existsSync(path.join(partition(s.A.id), 'count')), 'nothing ran for A');
    assert.deepStrictEqual(outOf(await s.call('B', 'hop')), {file: 2, store: 2, memory: 2}, 'B runs on');
  });
});
