'use strict';
// R1 Task 6 (#236 section 4a and section 6; plan Task 6), spawned: a
// per-session module's partitions live as long as the session. A bye
// removes that session's (after its worker has stopped, a call in flight
// included) and keeps the other's; a runtime restarted with A restored and
// B not keeps A's (A's resumed call finds its file) and sweeps B's before
// it listens; one restarted with nothing restored sweeps everything, and the
// next session's first result says per-session state was reset. The
// runtime's own stop (SIGTERM, 'closed') removes nothing. The window
// expiry is sessions 33's, in-process (the window is a minute).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const ns = require('../../lib/redis-namespace');
const lifetime = require('../../lib/session-lifetime');
const {NAME, tick, until, perSession, runtime, secretOf, request, texts, outOf, counts, shim} = require('./helpers/per-session');

describe('session-runtime 11: a per-session module\'s partitions live as long as the session (R1 Task 6)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr11-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  const dirOf = (sid) => path.join(home, 'module_data', NAME, 'sessions', sid);
  // the store's keys, read once the runtime has stopped
  const keysOf = (sid) => {
    const kv = new LocalKv({storePath: path.join(home, 'store')});
    try { return kv.keysWithPrefix(ns.sessionPrefixFor(NAME, sid)); } finally { if (typeof(kv.close) === 'function') kv.close(); }
  };
  async function up(opts = {}) {
    r = runtime(home, ['--loadModule', perSession(home)], opts);
    // its own 'listening' tell (after the restore and the sweep), not the
    // socket file: or its exit, which the assert then shows with its log
    await until(async() => r.told.some((m) => m.type === 'listening') || r.code !== undefined, 30000);
    assert.ok(r.told.some((m) => m.type === 'listening'), `not listening (exit ${r.code}): ${r.log().slice(-3000)}`);
    const secret = secretOf(r);
    assert.ok(secret != null, `no secret: ${r.log().slice(-3000)}`);
    return secret;
  }
  async function open(secret, opts) {
    const a = await shim.session(r.socket, secret, undefined, opts);
    assert.ok(a.welcome != null, JSON.stringify(a.refused));
    let tool = null;
    await until(async() => {
      const list = await request(a.c, 'tools/list');
      tool = (list != null && list.result != null) ? list.result.tools.map((t) => t.name).find((t) => /touch$/.test(t)) : null;
      return tool != null;
    });
    return {c: a.c, id: a.welcome.session, token: a.welcome.resumeToken, call: (action, args = {}) => request(a.c, 'tools/call', {name: tool.replace(/touch$/, action), arguments: args})};
  }
  // the runtime's own stop (SIGTERM: the local store flushes, the registry
  // closes, 'closed': every partition kept), bounded
  async function stop() {
    r.child.kill('SIGTERM');
    const t = setTimeout(() => r.child.kill('SIGKILL'), 15000);
    await r.exited;
    clearTimeout(t);
    fs.rmSync(r.socket, {force: true});
    fs.rmSync(path.join(r.run, 'secret'), {force: true});
  }

  it('a bye removes that session\'s files and keys once its worker has stopped; the other session\'s stay', async() => {
    const secret = await up();
    const a = await open(secret);
    const b = await open(secret);
    outOf(await a.call('touch'));
    outOf(await b.call('touch'));
    assert.ok(fs.existsSync(dirOf(a.id)) && fs.existsSync(dirOf(b.id)));
    a.c.send('C', {op: 'bye'});
    await until(async() => !fs.existsSync(dirOf(a.id)), 15000);
    assert.ok(!fs.existsSync(dirOf(a.id)), 'A\'s files removed');
    assert.ok(counts(r).ended >= 1, 'its worker ended first');
    assert.deepStrictEqual(outOf(await b.call('touch')), {file: 2, store: 2, memory: 2}, 'B runs on, its own');
    await stop();
    assert.deepStrictEqual(keysOf(a.id), [], 'A\'s keys removed');
    assert.strictEqual(keysOf(b.id).length, 1, 'B\'s kept');
    assert.ok(fs.existsSync(dirOf(b.id)));
  });

  // The security pass of 11-17: the module's fs quota is one counter for all
  // its session workers; a partition removed by a bye leaves it, while
  // another session's worker keeps it held (enforced: --moduleSandbox enforce)
  it('the quota is freed by a bye: B, refused past the module\'s 1 MB, writes again once A has left, its worker running all along', async() => {
    const dir = perSession(home);
    const edit = (f, fn) => { const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); fn(v); fs.writeFileSync(path.join(dir, f), JSON.stringify(v)); };
    edit('package.json', (pkg) => { pkg.countinghouse.permissions = {limits: {diskMb: 1}}; });
    edit('api.json', (api) => api.device.serviceList['urn:countinghouse-test:serviceID:stateService'].actionList.push({name: 'fill', description: 'Writes input.kb KB to a new file in /data.',
      input: {schema: '/stateService/fill/input'}, output: {schema: '/stateService/fill/output'}}));
    edit('schema.json', (schema) => { schema.stateService.fill = {input: {type: 'object'}, output: {type: 'object'}}; });
    fs.writeFileSync(path.join(dir, 'handlers', 'stateService', 'fill.js'), `const fs = require('fs');
let n = 0;
module.exports = async (input) => {
  try {
    fs.writeFileSync('/data/fill-' + (n++), Buffer.alloc(Number(input.kb) * 1024));
    return {output: {ok: true}};
  } catch (e) {
    return {output: {ok: false, code: (e && e.code) || null}};
  }
};\n`);
    r = runtime(home, ['--loadModule', dir, '--moduleSandbox', 'enforce']);
    assert.ok(await until(async() => r.told.some((m) => m.type === 'listening') || r.code !== undefined, 30000), r.log().slice(-3000));
    const secret = secretOf(r);
    const a = await open(secret);
    const b = await open(secret);
    const fill = (s) => s.call('fill', {kb: 400});
    assert.deepStrictEqual(outOf(await fill(a)), {ok: true});
    assert.deepStrictEqual(outOf(await fill(a)), {ok: true});
    assert.deepStrictEqual(outOf(await fill(b)), {ok: false, code: 'ENOSPC'}, 'A\'s 800 KB and B\'s 400 KB are past the module\'s 1 MB');
    a.c.send('C', {op: 'bye'});
    assert.ok(await until(async() => !fs.existsSync(dirOf(a.id)) && counts(r).ended === 1, 15000), r.log().slice(-2000));
    assert.deepStrictEqual(outOf(await fill(b)), {ok: true}, 'A\'s 800 KB left the quota with its partition');
    assert.deepStrictEqual(counts(r), {up: 2, ended: 1}, 'B\'s worker ran all along: its quota was never measured again');
  });

  // 'unsettled' (a connection that ended before its session was announced):
  // a removal reason like 'bye' (the registry's 'end', any but 'closed').
  // Such a session can't have called anything, so it has no partition: its
  // end must simply leave every other session's alone (its removal and its
  // quota share: sessions 33)
  it('an unsettled session\'s end (its connection gone before it settled) touches no other session\'s partition or worker', async() => {
    const secret = await up();
    const a = await open(secret);
    outOf(await a.call('touch'));
    const raw = await shim.attach(r.socket, secret);   // welcomed, never settled
    assert.ok(raw.welcome != null, JSON.stringify(raw.refused));
    raw.c.end();
    await tick(500);
    assert.ok(fs.existsSync(dirOf(a.id)), 'A\'s partition kept');
    assert.deepStrictEqual(outOf(await a.call('touch')), {file: 2, store: 2, memory: 2}, 'A\'s worker ran on');
    assert.doesNotMatch(r.log(), /partition was not removed/);
  });

  it('a bye with a call in flight: the call ends with the worker, and the partition goes only after the worker has stopped', async() => {
    const secret = await up();
    const a = await open(secret);
    outOf(await a.call('touch'));
    const held = a.call('hold', {ms: 3000}).then((res) => ({res}), (err) => ({err: String(err && err.message)}));
    await tick(400);
    a.c.send('C', {op: 'bye'});
    await until(async() => !fs.existsSync(dirOf(a.id)), 15000);
    assert.ok(!fs.existsSync(dirOf(a.id)));
    // the held call ends with its session: no answer on a connection the bye
    // closed (request's null), never left pending, never a success
    const outcome = await Promise.race([held, tick(5000).then(() => 'pending')]);
    assert.deepStrictEqual(outcome, {res: null}, JSON.stringify(outcome).slice(0, 400));
    const c = counts(r);
    assert.strictEqual(c.ended, c.up, `${c.up} up, ${c.ended} ended: no worker left under a removed partition`);
  });

  it('a restart with A restored and B not: A\'s partition kept (its resumed call finds its file), B\'s swept once the listener accepts', async() => {
    let secret = await up();
    const a = await open(secret);
    const b = await open(secret);
    outOf(await a.call('touch'));
    outOf(await b.call('touch'));
    const hash = r.told.filter((m) => m.type === 'session-resume' && m.session === a.id).pop().hash;
    await stop();
    secret = await up({restore: {id: 'restore-1', type: 'restore', sessions: [{session: a.id, resume: hash, state: {overrides: [], locks: [], formsLeft: 3}}], declines: [], reset: []}});
    // the sweep runs once the socket listens, in the background
    assert.ok(await until(async() => !fs.existsSync(dirOf(b.id)), 15000), 'B swept after the listen');
    assert.ok(fs.existsSync(dirOf(a.id)), 'A kept');
    const back = await open(secret, {resume: a.token});
    assert.strictEqual(back.id, a.id);
    const got = await back.call('touch');
    assert.deepStrictEqual(outOf(got), {file: 2, store: 2, memory: 1}, 'its files and store kept; its memory, a new worker\'s');
    assert.ok(!texts(got).includes(lifetime.RESET_AT_START), 'restored: nothing reset');
  });

  it('a restart with nothing restored sweeps every partition, and the next session\'s first result says per-session state was reset', async() => {
    let secret = await up();
    const a = await open(secret);
    outOf(await a.call('touch'));
    await stop();
    assert.ok(fs.existsSync(dirOf(a.id)), 'the runtime\'s stop removed nothing');
    secret = await up();
    // swept once it listens, in the background
    assert.ok(await until(async() => !fs.existsSync(dirOf(a.id)), 15000), 'swept');
    const c = await open(secret);
    const first = await c.call('touch');
    assert.deepStrictEqual(outOf(first), {file: 1, store: 1, memory: 1});
    assert.ok(texts(first).includes(lifetime.RESET_AT_START), texts(first));
    assert.ok(!texts(await c.call('touch')).includes(lifetime.RESET_AT_START), 'once');
  });
});
