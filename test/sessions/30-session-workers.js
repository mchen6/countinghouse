// R1 (#236 section 4a): lib/session-workers.js on its own, with a fake
// spawn. Server-free: the cap and its LRU eviction (never a busy one), the
// refusal when every slot is busy, a crash (slot freed, session told,
// suspension per (module, session) only), and an unload racing a spawn (no
// worker outlives its module). The spawned runtime's own cases are in
// test/session-runtime/03-per-session-workers.js.
const assert = require('assert');
const {EventEmitter} = require('events');
const sessionWorkers = require('../../lib/session-workers');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

function harness({max = 2, delay = 0} = {}) {
  let clock = 1000;
  let nextId = 1;
  const spawned = [];
  const ended = [];
  const told = [];
  const pendingSpawns = [];
  const busySet = new Set();
  const sw = sessionWorkers.create({
    spawn: (name, sid, wanted, cb) => {
      const go = () => {
        const wm = Object.assign(new EventEmitter(), {workerId: nextId++, name, sid, wanted});
        spawned.push(wm);
        cb(null, wm);
      };
      if (delay === 'manual') pendingSpawns.push(go); else setImmediate(go);
    },
    end: (wm) => { ended.push(wm); setImmediate(() => wm.emit('exit')); return new Promise((r) => wm.once('exit', r)); },
    onExit: (wm, fn) => wm.once('exit', fn),
    busy: (wm) => busySet.has(wm),
    announce: (name, sid, text) => told.push({name, sid, text}),
    max: () => max,
    now: () => clock
  });
  const get = (name, sid) => new Promise((resolve) => sw.get(name, sid, (err, wm) => resolve({err, wm})));
  return {sw, get, spawned, ended, told, busySet, pendingSpawns, tick: (ms) => { clock += ms; }};
}

describe('sessions 30: per-session workers (lib/session-workers.js)', () => {
  it('one worker per (module, session), spawned once for calls that arrive together', async () => {
    const h = harness({max: 4});
    const [x, y] = await Promise.all([h.get('m', A), h.get('m', A)]);
    assert.strictEqual(x.wm, y.wm);
    const z = await h.get('m', B);
    assert.notStrictEqual(z.wm, x.wm);
    assert.strictEqual(h.spawned.length, 2);
    assert.strictEqual(h.sw.size(), 2);
  });

  it('at the cap the least recently used idle worker gives up its slot, and its session is told', async () => {
    const h = harness({max: 2});
    const a = (await h.get('m', A)).wm;
    h.tick(10);
    await h.get('m', B);
    h.tick(10);
    await h.get('m', A);   // A used more recently than B now
    h.tick(10);
    const c = await h.get('m', C);
    assert.ifError(c.err);
    assert.strictEqual(h.ended.length, 1);
    assert.strictEqual(h.ended[0].sid, B, 'B was the least recently used');
    assert.deepStrictEqual(h.told, [{name: 'm', sid: B, text: 'm\'s in-memory state was reset; its files were kept'}]);
    assert.strictEqual((await h.get('m', A)).wm, a, 'A keeps its worker');
    assert.strictEqual(h.sw.size(), 2);
  });

  it('never mid-call: a busy worker is never evicted; with every slot busy the call is SESSION_WORKERS_BUSY', async () => {
    const h = harness({max: 1});
    const a = (await h.get('m', A)).wm;
    h.busySet.add(a);
    const b = await h.get('m', B);
    assert.strictEqual(b.err.code, 'SESSION_WORKERS_BUSY');
    assert.match(b.err.message, /All 1 per-session/);
    assert.deepStrictEqual([h.ended.length, h.told.length], [0, 0]);
    h.busySet.delete(a);
    assert.ifError((await h.get('m', B)).err);
    assert.strictEqual(h.ended[0], a);
  });

  it('a spawn under way holds its slot', async () => {
    const h = harness({max: 1, delay: 'manual'});
    const first = h.get('m', A);
    const b = await h.get('m', B);
    assert.strictEqual(b.err.code, 'SESSION_WORKERS_BUSY', 'nothing idle to evict while A comes up');
    h.pendingSpawns.shift()();
    assert.ifError((await first).err);
  });

  it('a crash frees its slot at once and tells its session; the next call spawns a fresh worker', async () => {
    const h = harness({max: 1});
    const a = (await h.get('m', A)).wm;
    a.emit('exit');
    assert.strictEqual(h.sw.size(), 0);
    assert.deepStrictEqual(h.told.map((t) => t.sid), [A]);
    const again = (await h.get('m', A)).wm;
    assert.notStrictEqual(again, a);
  });

  it('repeated crashes suspend that (module, session) only; a neighbour\'s worker is untouched', async () => {
    const h = harness({max: 4});
    const b = (await h.get('m', B)).wm;
    for (let i = 0; i < 3; i++) (await h.get('m', A)).wm.emit('exit');
    const refused = await h.get('m', A);
    assert.strictEqual(refused.err.code, 'MODULE_SUSPENDED');
    assert.strictEqual((await h.get('m', B)).wm, b, 'B runs on, the same worker');
    assert.ifError((await h.get('other', A)).err, 'another module in the same session runs');
    h.tick(10 * 60 * 1000 + 1);
    assert.ifError((await h.get('m', A)).err, 'past the window it may run again');
  });

  it('stopModule: every session\'s worker of the module stops; one spawning meanwhile is ended once up; none left', async () => {
    const h = harness({max: 4, delay: 'manual'});
    const pa = h.get('m', A);
    h.pendingSpawns.shift()();
    await pa;
    const pb = h.get('m', B);           // under way when the unload begins
    const pOther = h.get('keep', A);
    h.pendingSpawns.pop()();            // 'keep' comes up; B's is still pending
    const stopping = h.sw.stopModule('m');
    assert.strictEqual((await h.get('m', C)).err.code, 'MODULE_UNLOADED', 'no new spawn while it stops');
    h.pendingSpawns.shift()();          // B's worker comes up late
    const b = await pb;
    await stopping;
    assert.strictEqual(b.err.code, 'MODULE_UNLOADED');
    assert.deepStrictEqual(h.sw.workersOf('m'), []);
    assert.ok(h.ended.some((wm) => wm.sid === B), 'the late worker was ended');
    assert.ifError((await pOther).err);
    assert.strictEqual(h.sw.workersOf('keep').length, 1, 'another module untouched');
  });

  it('stopSession stops that session\'s workers only, and forgets its exits', async () => {
    const h = harness({max: 4});
    for (let i = 0; i < 3; i++) (await h.get('m', A)).wm.emit('exit');
    await h.get('m', B);
    await h.sw.stopSession(A);
    assert.ifError((await h.get('m', A)).err, 'a session that comes back (a new one) is not suspended');
    await h.sw.stopSession(B);
    assert.deepStrictEqual(h.sw.workersOf('m').map((w) => w.sid), [A]);
  });
});

// B3 x R1 (the hook agreed with B): a session's view changing stops that
// session's workers of the modules it no longer lists; the other session's
// run on. The stores wired as test/sessions/14 wires them.
describe('sessions 30: a session\'s packs and its per-session workers', () => {
  const settings = require('../../lib/session-settings');
  const sessionPacks = require('../../lib/session-packs');
  const ModuleManager = require('../../lib/module-manager');
  before(() => require('../../lib/logger').createLogger(false));
  beforeEach(() => {
    settings.resetForTests();
    sessionPacks.resetForTests();
    settings.configure({ceiling: () => ({state: 'trusted', ceiling: {packs: ['p']}}), defaultOf: () => 8 * 1024 * 1024, isLive: () => true, ceilingMemoMs: 0});
    sessionPacks.configure({
      records: () => [{pack: 'p', modules: ['m']}], moduleOf: () => 'm',
      overridesOf: (id) => settings.packOverridesOf(id), onOverrideChange: (fn) => settings.onChange(fn),
      openSessions: () => [A, B], shared: () => true, allowsOn: settings.packOnAllowed, ceilingNow: settings.ceilingNow, ceilingKey: settings.ceilingKey});
  });

  it('turning off a this-session pack stops that session\'s worker of its module; the other session\'s runs on', async () => {
    const h = harness({max: 4});
    const mm = Object.create(ModuleManager.prototype);
    mm.sessionWorkers = h.sw;
    sessionPacks.onChange((sid) => mm.sessionViewChanged(sid));   // as ModuleManager's constructor wires it
    for (const id of [A, B]) settings.set(id, 'pack.p', true, {loosening: true, version: '1.0.0'});
    assert.deepStrictEqual([sessionPacks.listsModule(A, 'm'), sessionPacks.listsModule(B, 'm')], [true, true]);
    const a = (await h.get('m', A)).wm;
    const b = (await h.get('m', B)).wm;
    settings.set(A, 'pack.p', false, {version: '1.0.0'});
    assert.strictEqual(sessionPacks.listsModule(A, 'm'), false);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.ended, [a], 'A\'s worker stopped');
    assert.deepStrictEqual(h.sw.workersOf('m').map((w) => w.wm), [b], 'B\'s runs on');
    assert.deepStrictEqual(h.told, [], 'a stop for the view is not a reset notice');
  });
});

// The live options (lib/settings-tool.js broadcastLiveOptions) reach every
// running worker: a session's too, which the module map doesn't hold.
describe('sessions 30: every running worker is told the live options', () => {
  it('liveWorkers: the module map\'s workers and every session worker, never a record', async () => {
    const {SessionModuleRecord} = require('../../lib/session-module-record');
    const ModuleManager = require('../../lib/module-manager');
    const h = harness({max: 4});
    const mm = Object.create(ModuleManager.prototype);
    const shared = {sendMessageToWorker: () => {}};
    mm.modules = {shared: shared, m: new SessionModuleRecord({name: 'm', version: '1.0.0', modulePath: '/x', moduleSpec: null})};
    mm.sessionWorkers = h.sw;
    const a = (await h.get('m', A)).wm;
    const b = (await h.get('m', B)).wm;
    assert.deepStrictEqual(mm.liveWorkers(), [shared, a, b]);
    const told = [];
    for (const w of [a, b]) w.sendMessageToWorker = (msg) => told.push([w.sid, msg.command]);
    require('../../lib/settings-tool').broadcastLiveOptions(mm.liveWorkers());
    assert.deepStrictEqual(told, [[A, 'live-options'], [B, 'live-options']]);
  });
});
