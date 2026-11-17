'use strict';
// R1 Task 4 (#236 section 4a; plan docs/superpowers/plans/
// 2026-11-16-shared-runtime-r1-per-session-modules.md, Task 4 and the
// Reviewer's P1-P5): a per-session module on the shared runtime, spawned as
// ch-local daemon spawns it (session-runtime 01's harness). Each session
// gets its own worker, store partition and files; the cap evicts only an
// idle worker and says so; a crash or a reload touches what it must and no
// more; an unload leaves no worker; and every path not yet routed to a
// session's worker (Task 5) fails closed, never with a TypeError or a hang.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {NAME, RESET, tick, until, perSession, caller, runtime, secretOf, request, texts, outOf, counts, shim} = require('./helpers/per-session');

describe('session-runtime 03: per-session workers (R1 Task 4)', function() {
  this.timeout(180000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr3-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  // the runtime up with `extra`, and two sessions with the touch tool listed
  async function twoSessions(extra = [], modules = [perSession(home)], wanted = ['touch']) {
    r = runtime(home, [...modules.flatMap((m) => ['--loadModule', m]), ...extra]);
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
      return wanted.every((w) => tools.some((t) => new RegExp(`${w}$`).test(t)));
    });
    for (const w of wanted) assert.ok(tools.some((t) => new RegExp(`${w}$`).test(t)), `${w} not listed: ${tools.join(', ')}\n${r.log().slice(-4000)}`);
    out.tool = (action) => tools.find((t) => new RegExp(`${action}$`).test(t));
    out.tools = tools;
    out.call = (s, action, args = {}) => request(out[s].c, 'tools/call', {name: out.tool(action), arguments: args});
    return out;
  }
  const partition = (sid) => path.join(home, 'module_data', NAME, 'sessions', sid, 'data');

  it('two sessions each have their own worker, store partition and files; no session id reaches the module', async() => {
    const s = await twoSessions();
    // listed as before, schemas included, with no worker (the record's copy)
    const listed = (await request(s.A.c, 'tools/list')).result.tools.find((t) => t.name === s.tool('touch'));
    assert.strictEqual(listed.inputSchema.type, 'object', JSON.stringify(listed));
    assert.ok(listed.outputSchema != null && listed.outputSchema.properties.file != null, JSON.stringify(listed));
    assert.deepStrictEqual(counts(r), {up: 0, ended: 0}, 'listing starts no worker');
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 1, store: 1, memory: 1});
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 2, store: 2, memory: 2});
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 1, store: 1, memory: 1}, 'B\'s own state');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.A.id), 'count'), 'utf8'), '2');
    assert.strictEqual(fs.readFileSync(path.join(partition(s.B.id), 'count'), 'utf8'), '1');
    assert.ok(!fs.existsSync(path.join(home, 'module_data', NAME, 'data', 'count')), 'nothing in the module\'s shared /data');
    for (const who of ['A', 'B']) {
      const seen = fs.readFileSync(path.join(partition(s[who].id), 'seen.json'), 'utf8');
      for (const sid of [s.A.id, s.B.id]) assert.ok(!seen.includes(sid), `${who}'s worker saw a session id: ${seen.slice(0, 600)}`);
      assert.ok(!seen.includes('/sessions/'), 'nor the partition\'s host path');
    }
    assert.deepStrictEqual(counts(r), {up: 2, ended: 0});
  });

  it('at --maxSessionWorkers 1, B\'s call evicts A\'s idle worker: A is told, and keeps its files and store', async() => {
    const s = await twoSessions(['--maxSessionWorkers', '1']);
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const again = await s.call('A', 'touch');
    assert.deepStrictEqual(outOf(again), {file: 2, store: 2, memory: 1}, 'files and store kept, memory reset');
    assert.ok(texts(again).includes(RESET), texts(again));
  });

  it('never mid-call: with A\'s call in flight at --maxSessionWorkers 1, B is SESSION_WORKERS_BUSY and A\'s call completes', async() => {
    const s = await twoSessions(['--maxSessionWorkers', '1']);
    const held = s.call('A', 'hold', {ms: 3000});
    await until(async() => counts(r).up === 1, 20000);
    await tick(300);
    const busy = await s.call('B', 'touch');
    assert.ok(/SESSION_WORKERS_BUSY|per-session module workers are busy/.test(JSON.stringify(busy)), JSON.stringify(busy).slice(0, 800));
    assert.deepStrictEqual(outOf(await held), {held: 3000});
    assert.strictEqual(counts(r).ended, 0, 'A\'s worker was never taken');
  });

  it('a crash of A\'s worker: A\'s next call starts a fresh one and is told; B\'s worker, state and the listing are untouched', async() => {
    const s = await twoSessions();
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    outOf(await s.call('A', 'crash'));
    await until(async() => counts(r).ended === 1, 20000);
    const a = await s.call('A', 'touch');
    assert.deepStrictEqual(outOf(a), {file: 2, store: 2, memory: 1});
    assert.ok(texts(a).includes(RESET), texts(a));
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 2, store: 2, memory: 2}, 'B\'s worker ran on');
    const list = await request(s.B.c, 'tools/list');
    assert.deepStrictEqual(list.result.tools.map((t) => t.name), s.tools);
  });

  it('a reload stops every session\'s worker; the next calls run the new code on the files kept', async() => {
    // a reload in place takes a pack version under --packsRoot, laid out
    // as ch-local lays it (test/stdio/16)
    const s = await twoSessions(['--packsRoot', path.join(home, 'packs')]);
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const v2 = perSession(home, {dir: path.join(home, 'packs', NAME, '1.1.0', 'node_modules', NAME), version: '1.1.0',
      edit: (src) => src.replace('return {output: {file: n, store: stored, memory}};', 'return {output: {file: n, store: stored, memory: memory + 1000}};')});
    const answer = await r.control({type: 'reload', name: NAME, scenario: v2});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    await until(async() => counts(r).ended === 2, 20000);
    assert.deepStrictEqual(outOf(await s.call('A', 'touch')), {file: 2, store: 2, memory: 1001});
    assert.deepStrictEqual(outOf(await s.call('B', 'touch')), {file: 2, store: 2, memory: 1001});
  });

  it('an unload while a call is under way: the call ends refused or completed, and then no session worker is left', async() => {
    const s = await twoSessions();
    outOf(await s.call('B', 'touch'));
    const held = s.call('A', 'hold', {ms: 1500});
    await until(async() => counts(r).up === 2, 20000);
    const answer = await r.control({type: 'unload', name: NAME});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    const a = await held;
    assert.ok(a != null && a.result != null, JSON.stringify(a));
    if (a.result.isError === true) assert.ok(/MODULE_UNLOADED|unloaded|DEVICE_NOT_FOUND|not found/i.test(texts(a)), texts(a));
    else assert.deepStrictEqual(outOf(a), {held: 1500});
    await until(async() => counts(r).ended === counts(r).up, 10000);
    const c = counts(r);
    assert.strictEqual(c.ended, c.up, `${c.up} up, ${c.ended} ended`);
    const after = await s.call('A', 'touch');
    assert.ok(after.result == null || after.result.isError === true || after.error != null, 'unloaded');
    await tick(500);
    assert.deepStrictEqual(counts(r), c, 'nothing started after the unload');
  });

  // A hop into it: test/session-runtime/10-per-session-routing.js (Task 5).

  it('its resource (M7): resources/read goes the call path\'s way, to the reading session\'s own worker and files', async() => {
    const s = await twoSessions();
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('A', 'touch'));
    outOf(await s.call('B', 'touch'));
    const list = await request(s.A.c, 'resources/list');
    const res = (list.result.resources || []).find((x) => /\/count$/.test(x.uri));
    assert.ok(res != null, JSON.stringify(list).slice(0, 800));
    const readA = await request(s.A.c, 'resources/read', {uri: res.uri});
    const readB = await request(s.B.c, 'resources/read', {uri: res.uri});
    assert.strictEqual(readA.result.contents[0].text, '2', JSON.stringify(readA));
    assert.strictEqual(readB.result.contents[0].text, '1', JSON.stringify(readB));
    assert.deepStrictEqual(counts(r), {up: 2, ended: 0}, 'no worker of its own for a read');
  });

  it('its prompt: listed, rendered and completed from the main thread\'s copy of its spec, with no worker; never a TypeError', async() => {
    const s = await twoSessions();
    const list = await request(s.A.c, 'prompts/list');
    const prompt = (list.result.prompts || []).find((p) => /greet$/.test(p.name));
    assert.ok(prompt != null, JSON.stringify(list).slice(0, 800));
    const got = await request(s.A.c, 'prompts/get', {name: prompt.name, arguments: {style: 'brief'}});
    assert.ok(got.result != null, JSON.stringify(got));
    assert.match(JSON.stringify(got.result.messages), /brief style/);
    const done = await request(s.A.c, 'completion/complete', {ref: {type: 'ref/prompt', name: prompt.name}, argument: {name: 'style', value: 'b'}});
    assert.ok(done.result != null, JSON.stringify(done));
    assert.deepStrictEqual(done.result.completion.values, ['brief']);
    assert.ok(!/TypeError|is not a function|Cannot read/.test(r.log()), r.log().slice(-3000));
    assert.deepStrictEqual(counts(r), {up: 0, ended: 0}, 'no worker for a prompt');
  });
});
