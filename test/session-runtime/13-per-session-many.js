'use strict';
// Shared runtime R1, per-session modules: two of them and three sessions in
// one runtime (asked by the user, 2026-11-17: the spawned tests before this
// loaded one module and opened two sessions). Each (module, session) pair has
// a worker, files and store of its own; --maxSessionWorkers counts every
// module's workers together; a hop from one per-session module to the other
// stays in the calling session; a session's bye ends only its own workers and
// partitions; a reload of one module leaves the other's workers running.
//
// The modules: the per-session fixture as a scenario (per-session-module,
// listed under its bare names), with one more action, hopTwo, that calls the
// second; and a renamed copy of the fixture, ps-two, a scenario too (the
// single-identity profile lists scenarios only), installed beside it as a
// pack's parts are, its actions and prompt suffixed Two so no bare name
// clashes (touchTwo, holdTwo, ...). Both are generated in the test's home: no
// committed fixture.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {NAME, RESET, tick, until, perSession, runtime, secretOf, request, texts, outOf, shim} = require('./helpers/per-session');

const TWO = 'ps-two';
const RESET_TWO = `${TWO}'s in-memory state was reset; its files were kept`;
const SESSIONS = ['A', 'B', 'C'];
// a JSON file of a generated module, changed in place by fn
function editJson(file, fn) {
  const v = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(v);
  fs.writeFileSync(file, JSON.stringify(v));
}

// per-session-module, a scenario under <home>/pack/node_modules, with hopTwo:
// one touch of ps-two, its output (or its error's code)
// (hop: false leaves it calling nothing, so its pack has no part)
function one(home, {hop = true, ...opts} = {}) {
  const dir = perSession(home, Object.assign({dir: path.join(home, 'pack', 'node_modules', NAME)}, opts));
  if (!hop) return dir;
  editJson(path.join(dir, 'package.json'), (pkg) => { pkg.countinghouse = Object.assign({}, pkg.countinghouse, {calls: [`${TWO}/stateService.touchTwo`]}); });
  editJson(path.join(dir, 'api.json'), (api) => {
    api.device.serviceList['urn:countinghouse-test:serviceID:stateService'].actionList.push({name: 'hopTwo', description: 'One touch of ps-two, in this session.',
      input: {schema: '/stateService/hopTwo/input'}, output: {schema: '/stateService/hopTwo/output'}});
  });
  editJson(path.join(dir, 'schema.json'), (schema) => { schema.stateService.hopTwo = {input: {type: 'object'}, output: {type: 'object'}}; });
  fs.writeFileSync(path.join(dir, 'handlers', 'stateService', 'hopTwo.js'), `module.exports = async (input, ctx) => {
  const r = await ctx.call('${TWO}/stateService.touchTwo', {}).then((x) => x, (e) => ({code: (e && e.code) || null, message: String(e && e.message).slice(0, 200)}));
  return {output: (r != null && r.output !== undefined) ? r.output : r};
};\n`);
  return dir;
}
// ps-two: the fixture renamed, a scenario beside per-session-module, every
// action and prompt name suffixed Two
function two(home, opts = {}) {
  const dir = perSession(home, Object.assign({dir: path.join(home, 'pack', 'node_modules', TWO)}, opts));
  editJson(path.join(dir, 'package.json'), (pkg) => { pkg.name = TWO; });
  const apiFile = path.join(dir, 'api.json');
  const api = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
  api.device.friendlyName = TWO;
  const actions = api.device.serviceList['urn:countinghouse-test:serviceID:stateService'].actionList;
  const schemaFile = path.join(dir, 'schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
  const handlers = path.join(dir, 'handlers', 'stateService');
  for (const a of actions) {
    const old = a.name;
    a.name = `${old}Two`;
    for (const io of ['input', 'output']) if (a[io] != null) a[io].schema = a[io].schema.replace(`/stateService/${old}/`, `/stateService/${a.name}/`);
    schema.stateService[a.name] = schema.stateService[old];
    delete schema.stateService[old];
    fs.renameSync(path.join(handlers, `${old}.js`), path.join(handlers, `${a.name}.js`));
  }
  for (const p of api.device.promptList || []) {
    const old = p.name;
    p.name = `${old}Two`;
    p.arguments.schema = p.arguments.schema.replace(`/prompts/${old}/`, `/prompts/${p.name}/`);
    schema.prompts[p.name] = schema.prompts[old];
    delete schema.prompts[old];
  }
  fs.writeFileSync(apiFile, JSON.stringify(api));
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  return dir;
}

// the module form's dirs for a top-level module laid out as ch-local laid
// out a pack: every module beside it, by its package name (M6)
const dirsOf = (top) => {
  let nm = require('path').dirname(top);
  // (a scoped package: its scope's parent holds the others)
  if (require('path').basename(nm).startsWith('@')) nm = require('path').dirname(nm);
  const out = {};
  for (const n of require('fs').readdirSync(nm)) {
    if (n.startsWith('@')) for (const m of require('fs').readdirSync(require('path').join(nm, n))) out[`${n}/${m}`] = require('path').join(nm, n, m);
    else out[n] = require('path').join(nm, n);
  }
  return out;
};

describe('session-runtime 13: two per-session modules, three sessions (R1)', function() {
  this.timeout(240000);
  if (process.platform === 'win32') return; // the named pipe is C2's
  let home;
  let r = null;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sr13-')); });
  afterEach(async() => {
    if (r != null && r.code === undefined) { r.child.kill('SIGKILL'); await r.exited; }
    r = null;
    fs.rmSync(home, {recursive: true, force: true});
  });

  // the runtime up with both modules and `extra`, three sessions, and both
  // modules' tools listed
  async function three(extra = [], {hop = true} = {}) {
    r = runtime(home, ['--loadModule', one(home, {hop}), '--loadModule', two(home), ...extra]);
    await until(async() => r.told.some((m) => m.type === 'listening') || r.code !== undefined, 30000);
    assert.ok(r.told.some((m) => m.type === 'listening'), `not listening (exit ${r.code}): ${r.log().slice(-3000)}`);
    const secret = secretOf(r);
    const s = {};
    for (const who of SESSIONS) {
      const a = await shim.session(r.socket, secret);
      assert.ok(a.welcome != null, JSON.stringify(a.refused));
      s[who] = {c: a.c, id: a.welcome.session};
    }
    let tools = [];
    const of = {one: (action) => tools.find((t) => t === action.toLowerCase()), two: (action) => tools.find((t) => t === `${action}Two`.toLowerCase())};
    await until(async() => {
      const list = await request(s.A.c, 'tools/list');
      tools = (list != null && list.result != null) ? list.result.tools.map((t) => t.name) : [];
      return of.one('touch') != null && (!hop || of.one('hopTwo') != null) && of.two('touch') != null;
    });
    assert.ok(of.one('touch') != null && (!hop || of.one('hopTwo') != null) && of.two('touch') != null, `${tools.join(', ')}\n${r.log().slice(-3000)}`);
    s.call = (who, mod, action, args = {}) => request(s[who].c, 'tools/call', {name: of[mod](action), arguments: args});
    return s;
  }
  // a module's session workers, by the runtime's own lines (each names its module)
  const lines = (name, what) => (r.log().match(new RegExp(`module: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: a session's worker ${what}`, 'g')) || []).length;
  const workers = (name) => ({up: lines(name, 'is up'), ended: lines(name, 'ended')});
  const partition = (name, sid) => path.join(home, 'module_data', name, 'sessions', sid);
  const fileCount = (name, sid) => fs.readFileSync(path.join(partition(name, sid), 'data', 'count'), 'utf8');

  it('six (module, session) pairs: six workers, each with its own state; nothing crosses a module or a session', async() => {
    const s = await three();
    // a different number of touches per pair, so any crossing shows
    const plan = {A: {one: 1, two: 2}, B: {one: 2, two: 3}, C: {one: 3, two: 1}};
    for (const who of SESSIONS) {
      for (const mod of ['one', 'two']) {
        for (let i = 1; i <= plan[who][mod]; i++) {
          assert.deepStrictEqual(outOf(await s.call(who, mod, 'touch')), {file: i, store: i, memory: i}, `${who} ${mod} touch ${i}`);
        }
      }
    }
    for (const who of SESSIONS) {
      assert.strictEqual(fileCount(NAME, s[who].id), String(plan[who].one), `${who}'s ${NAME} files`);
      assert.strictEqual(fileCount(TWO, s[who].id), String(plan[who].two), `${who}'s ${TWO} files`);
    }
    assert.deepStrictEqual([workers(NAME), workers(TWO)], [{up: 3, ended: 0}, {up: 3, ended: 0}]);
  });

  it('a hop from per-session-module to ps-two lands in the calling session\'s ps-two worker, never another session\'s', async() => {
    const s = await three();
    for (const [who, n] of [['A', 2], ['B', 3], ['C', 1]]) {
      for (let i = 0; i < n; i++) outOf(await s.call(who, 'two', 'touch'));
    }
    assert.deepStrictEqual(outOf(await s.call('A', 'one', 'hopTwo')), {file: 3, store: 3, memory: 3}, 'A\'s ps-two, after its 2');
    assert.deepStrictEqual(outOf(await s.call('B', 'one', 'hopTwo')), {file: 4, store: 4, memory: 4}, 'B\'s, after its 3');
    assert.deepStrictEqual(outOf(await s.call('C', 'one', 'hopTwo')), {file: 2, store: 2, memory: 2}, 'C\'s, after its 1');
    // and at once from all three: each still its own
    const all = await Promise.all(SESSIONS.map((who) => s.call(who, 'one', 'hopTwo')));
    assert.deepStrictEqual(all.map((a) => outOf(a).file), [4, 5, 3]);
    assert.deepStrictEqual([workers(NAME), workers(TWO)], [{up: 3, ended: 0}, {up: 3, ended: 0}], 'one worker of each module per session, none more');
  });

  it('--maxSessionWorkers counts both modules\' workers together: a ps-two spawn evicts an idle per-session-module worker', async() => {
    const s = await three(['--maxSessionWorkers', '4']);
    // least recently used first: A's per-session-module
    outOf(await s.call('A', 'one', 'touch'));
    outOf(await s.call('A', 'two', 'touch'));
    outOf(await s.call('B', 'one', 'touch'));
    outOf(await s.call('B', 'two', 'touch'));
    assert.deepStrictEqual([workers(NAME).up, workers(TWO).up], [2, 2]);
    assert.deepStrictEqual(outOf(await s.call('C', 'two', 'touch')), {file: 1, store: 1, memory: 1}, 'a fifth worker: one was evicted for it');
    assert.ok(await until(async() => workers(NAME).ended === 1, 20000), r.log().slice(-2000));
    assert.deepStrictEqual([workers(NAME), workers(TWO)], [{up: 2, ended: 1}, {up: 3, ended: 0}], 'the idle per-session-module worker went for a ps-two one');
    // A is told on its next per-session-module result; its files and store
    // kept. Its spawn evicts the least recently used idle one: A's ps-two
    const again = await s.call('A', 'one', 'touch');
    assert.deepStrictEqual(outOf(again), {file: 2, store: 2, memory: 1});
    assert.ok(texts(again).includes(RESET), texts(again));
    assert.ok(await until(async() => workers(TWO).ended === 1, 20000), r.log().slice(-2000));
    // and ps-two tells A the same way, on its next ps-two result
    const twoAgain = await s.call('A', 'two', 'touch');
    assert.deepStrictEqual(outOf(twoAgain), {file: 2, store: 2, memory: 1});
    assert.ok(texts(twoAgain).includes(RESET_TWO), texts(twoAgain));
  });

  it('at the cap with every slot in a call, of either module, the next session\'s call is SESSION_WORKERS_BUSY; the held calls complete', async() => {
    // (no hop here: a module that declares calls has its verdict sent after
    // its worker is up and before its first call, a window this case's wait
    // would have to cover too)
    const s = await three(['--maxSessionWorkers', '2'], {hop: false});
    const heldOne = s.call('A', 'one', 'hold', {ms: 5000});
    const heldTwo = s.call('B', 'two', 'hold', {ms: 5000});
    assert.ok(await until(async() => workers(NAME).up === 1 && workers(TWO).up === 1, 20000), r.log().slice(-2000));
    await tick(1000);
    for (const mod of ['one', 'two']) {
      const busy = await s.call('C', mod, 'touch');
      assert.ok(/SESSION_WORKERS_BUSY|per-session module workers are busy/.test(JSON.stringify(busy)), JSON.stringify(busy).slice(0, 800));
    }
    assert.deepStrictEqual(outOf(await heldOne), {held: 5000});
    assert.deepStrictEqual(outOf(await heldTwo), {held: 5000});
    assert.deepStrictEqual([workers(NAME).ended, workers(TWO).ended], [0, 0], 'no worker taken mid-call');
  });

  it('B\'s bye ends B\'s two workers and removes B\'s partition of both modules; A\'s and C\'s four run on with their state', async() => {
    const s = await three();
    for (const who of SESSIONS) {
      outOf(await s.call(who, 'one', 'touch'));
      outOf(await s.call(who, 'two', 'touch'));
    }
    s.B.c.send('C', {op: 'bye'});
    // (the worker lines come through the child's pipe: waited for too)
    await until(async() => !fs.existsSync(partition(NAME, s.B.id)) && !fs.existsSync(partition(TWO, s.B.id)) && workers(NAME).ended === 1 && workers(TWO).ended === 1, 15000);
    assert.ok(!fs.existsSync(partition(NAME, s.B.id)) && !fs.existsSync(partition(TWO, s.B.id)), 'B\'s files of both modules removed');
    assert.deepStrictEqual([workers(NAME).ended, workers(TWO).ended], [1, 1], 'B\'s two workers, and only they, ended');
    for (const who of ['A', 'C']) {
      assert.deepStrictEqual(outOf(await s.call(who, 'one', 'touch')), {file: 2, store: 2, memory: 2}, `${who}'s ${NAME} ran on`);
      assert.deepStrictEqual(outOf(await s.call(who, 'two', 'touch')), {file: 2, store: 2, memory: 2}, `${who}'s ${TWO} ran on`);
    }
    assert.deepStrictEqual([workers(NAME).up, workers(TWO).up], [3, 3], 'no worker restarted');
  });

  // (the two modules independent here: per-session-module calls nothing, so
  // its pack's new version brings no part with it)
  it('a reload of per-session-module stops its three workers only; ps-two\'s three run on, their memory kept', async() => {
    const s = await three(['--modulesRoot', path.join(home, 'packs'), '--modulesRoot', path.join(home, 'pack')], {hop: false});
    for (const who of SESSIONS) {
      outOf(await s.call(who, 'one', 'touch'));
      outOf(await s.call(who, 'two', 'touch'));
    }
    const v2 = one(home, {hop: false, dir: path.join(home, 'packs', NAME, '1.1.0', 'node_modules', NAME), version: '1.1.0',
      edit: (src) => src.replace('return {output: {file: n, store: stored, memory}};', 'return {output: {file: n, store: stored, memory: memory + 1000}};')});
    const answer = await r.control({type: 'reload', names: [NAME], dirs: dirsOf(v2)});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    assert.ok(await until(async() => workers(NAME).ended === 3, 20000), r.log().slice(-2000));
    for (const who of SESSIONS) {
      assert.deepStrictEqual(outOf(await s.call(who, 'one', 'touch')), {file: 2, store: 2, memory: 1001}, `${who}: the new code, its files kept`);
      assert.deepStrictEqual(outOf(await s.call(who, 'two', 'touch')), {file: 2, store: 2, memory: 2}, `${who}'s ${TWO} ran on`);
    }
    assert.deepStrictEqual([workers(NAME), workers(TWO)], [{up: 6, ended: 3}, {up: 3, ended: 0}], 'its three stopped and three new ones; ps-two\'s untouched');
  });

  // Issue #391 (C's packs queue): a reload of a pack whose new version brings
  // ps-two as its part leaves ps-two unlisted, though its own load lists it
  // (MODULE_NOT_LISTED on touchTwo). Skipped until #391 is fixed; then this
  // runs as it stands.
  it.skip('#391: a reload of per-session-module\'s pack, which brings ps-two as its part, leaves ps-two listed and running', async() => {
    const s = await three(['--modulesRoot', path.join(home, 'packs'), '--modulesRoot', path.join(home, 'pack')]);
    for (const who of SESSIONS) outOf(await s.call(who, 'two', 'touch'));
    const v2 = one(home, {dir: path.join(home, 'packs', NAME, '1.1.0', 'node_modules', NAME), version: '1.1.0'});
    fs.cpSync(two(home, {dir: path.join(home, 'tmp-two')}), path.join(path.dirname(v2), TWO), {recursive: true});
    const answer = await r.control({type: 'reload', names: [NAME], dirs: dirsOf(v2)});
    assert.strictEqual(answer.ok, true, JSON.stringify(answer));
    await until(async() => workers(NAME).ended === workers(NAME).up, 20000);
    for (const who of SESSIONS) {
      assert.deepStrictEqual(outOf(await s.call(who, 'two', 'touch')), {file: 2, store: 2, memory: 2}, `${who}'s ${TWO}: still listed, run on`);
    }
  });
});
