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
    await until(async() => fs.existsSync(r.socket) && secretOf(r) != null);
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

  it('a bye with a call in flight: the call ends with the worker, and the partition goes only after the worker has stopped', async() => {
    const secret = await up();
    const a = await open(secret);
    outOf(await a.call('touch'));
    const held = a.call('hold', {ms: 3000}).catch(() => null);
    void held;
    await tick(400);
    a.c.send('C', {op: 'bye'});
    await until(async() => !fs.existsSync(dirOf(a.id)), 15000);
    assert.ok(!fs.existsSync(dirOf(a.id)));
    const c = counts(r);
    assert.strictEqual(c.ended, c.up, `${c.up} up, ${c.ended} ended: no worker left under a removed partition`);
  });

  it('a restart with A restored and B not: A\'s partition kept (its resumed call finds its file), B\'s swept before the listener accepts', async() => {
    let secret = await up();
    const a = await open(secret);
    const b = await open(secret);
    outOf(await a.call('touch'));
    outOf(await b.call('touch'));
    const hash = r.told.filter((m) => m.type === 'session-resume' && m.session === a.id).pop().hash;
    await stop();
    secret = await up({restore: {id: 'restore-1', type: 'restore', sessions: [{session: a.id, resume: hash, state: {overrides: [], locks: [], formsLeft: 3}}], declines: [], reset: []}});
    assert.ok(!fs.existsSync(dirOf(b.id)), 'B swept by the time the socket listens');
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
    assert.ok(!fs.existsSync(dirOf(a.id)), 'swept');
    const c = await open(secret);
    const first = await c.call('touch');
    assert.deepStrictEqual(outOf(first), {file: 1, store: 1, memory: 1});
    assert.ok(texts(first).includes(lifetime.RESET_AT_START), texts(first));
    assert.ok(!texts(await c.call('touch')).includes(lifetime.RESET_AT_START), 'once');
  });
});
