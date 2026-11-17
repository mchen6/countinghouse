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

function harness({max = 2, delay = 0, live = () => true} = {}) {
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
    now: () => clock,
    live
  });
  const get = (name, sid) => new Promise((resolve) => sw.get(name, sid, (err, wm) => resolve({err, wm})));
  return {sw, get, spawned, ended, told, busySet, pendingSpawns, tick: (ms) => { clock += ms; }};
}

const tick = () => new Promise((r) => setImmediate(r));

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
    await tick();
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
    assert.strictEqual(refused.err.code, 'MODULE_SESSION_PAUSED');
    assert.strictEqual((await h.get('m', B)).wm, b, 'B runs on, the same worker');
    assert.ifError((await h.get('other', A)).err, 'another module in the same session runs');
    h.tick(10 * 60 * 1000 + 1);
    assert.ifError((await h.get('m', A)).err, 'past the window it may run again');
  });

  it('stopModule: every session\'s worker of the module stops; one spawning meanwhile is ended once up; none left', async () => {
    const h = harness({max: 4, delay: 'manual'});
    const pa = h.get('m', A);
    await tick();
    h.pendingSpawns.shift()();
    await pa;
    const pb = h.get('m', B);           // under way when the unload begins
    const pOther = h.get('keep', A);
    await tick();
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

  // the review of #356, 3: a worker still spawning when a stop begins keeps
  // its slot, and the stop settles only once that worker has ended
  it('stopModule with a spawn pending settles only once that worker has come up and ended; the cap is never exceeded meanwhile', async () => {
    const h = harness({max: 2, delay: 'manual'});
    const pa = h.get('m', A);                 // spawning
    const pOther = h.get('o', B);             // spawning
    await tick();                             // both spawns under way
    let settled = false;
    const stopping = h.sw.stopModule('m').then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(settled, false, 'not while A\'s worker is still coming up');
    assert.strictEqual(h.sw.size(), 2, 'A\'s slot still counted');
    const pc = h.get('n', C);                 // over the cap: nothing idle to take
    assert.strictEqual((await pc).err.code, 'SESSION_WORKERS_BUSY');
    h.pendingSpawns.shift()();                // A's worker comes up: ended at once
    assert.strictEqual((await pa).err.code, 'MODULE_UNLOADED', 'given up on: MODULE_UNLOADED, never an uncoded error');
    await stopping;
    assert.ok(settled);
    assert.ok(h.ended.some((wm) => wm.sid === A), 'A\'s worker ended before the stop settled');
    h.pendingSpawns.shift()();
    assert.ifError((await pOther).err);
    assert.strictEqual(h.sw.size(), 1);
  });

  it('at the cap the new worker starts only once the evicted one has ended: never more alive than the cap', async () => {
    let alive = 0;
    let most = 0;
    const endWait = [];
    const sw = sessionWorkers.create({
      spawn: (name, sid, wanted, cb) => setImmediate(() => { alive++; most = Math.max(most, alive); const wm = new EventEmitter(); wm.sid = sid; cb(null, wm); }),
      end: (wm) => new Promise((r) => endWait.push(() => { alive--; wm.emit('exit'); r(); })),
      onExit: (wm, fn) => wm.once('exit', fn), busy: () => false, announce: () => {}, max: () => 1
    });
    const get = (n, sid) => new Promise((resolve) => sw.get(n, sid, (err, wm) => resolve({err, wm})));
    await get('m', A);
    const pb = get('m', B);                   // evicts A; B waits for A's end
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(alive, 1, 'B not started while A is still ending');
    endWait.shift()();
    assert.ifError((await pb).err);
    assert.strictEqual(most, 1, 'never more than the cap alive');
  });

  it('a pause (the supervisor\'s rule) says MODULE_SESSION_PAUSED, with its window', async () => {
    const h = harness({max: 4});
    for (let i = 0; i < 3; i++) (await h.get('m', A)).wm.emit('exit');
    const refused = await h.get('m', A);
    assert.strictEqual(refused.err.code, 'MODULE_SESSION_PAUSED');
    assert.match(refused.err.message, /paused for this session; it starts again after 10 minutes/);
  });

  it('stopSession stops that session\'s workers only, and forgets its exits', async () => {
    const h = harness({max: 4});
    for (let i = 0; i < 3; i++) (await h.get('m', A)).wm.emit('exit');
    await h.get('m', B);
    await h.sw.stopSession(A);
    h.sw.sessionClosed(A);   // (its close, as lib/sessions.js tells the pool)
    assert.ifError((await h.get('m', A)).err, 'its exits forgotten: no suspension held for it');
    await h.sw.stopSession(B);
    assert.deepStrictEqual(h.sw.workersOf('m').map((w) => w.sid), [A]);
  });

  // the reviewer's round 5: the rule doesn't rest on listener order. From
  // stopSession on, none is spawned for the session, though it is still open
  // (its own close not run yet); its close clears the mark
  it('stopSession marks the session at once: get refuses it while it is still open, and a spawn under way is not kept; its close clears it', async () => {
    const h = harness({max: 4, delay: 'manual'});
    const pending = h.get('m', A);
    await tick();
    const stopped = h.sw.stopSession(A);
    assert.strictEqual((await h.get('m', A)).err.code, 'DEVICE_NOT_FOUND', 'refused at once, live(sid) still true');
    h.pendingSpawns.shift()();
    const late = await pending;
    assert.ok(late.err != null, 'the spawn under way is given up');
    await stopped;
    assert.strictEqual((await h.get('m', A)).err.code, 'DEVICE_NOT_FOUND', 'still refused after the stop, while open (live): no reuse');
    h.sw.sessionClosed(A);
    const again = h.get('m', A);
    await tick();
    h.pendingSpawns.shift()();
    assert.ifError((await again).err, 'cleared by its close');
  });

  it('a stop whose session has already closed clears its own mark (no close is coming)', async () => {
    const open = new Set([A]);
    const h = harness({max: 4, live: (sid) => open.has(sid)});
    await h.get('m', A);
    const stopped = h.sw.stopSession(A);
    open.delete(A);
    await stopped;
    open.add(A);   // (a test-only reuse: shows the mark is gone)
    assert.ifError((await h.get('m', A)).err);
  });

  // the security pass of 11-17, the reviewer's ruling: a liveness check, no
  // set of ended sessions to bound
  it('a session that has ended gets no worker (a device not hosted), and a spawn under way when it ends is not wanted', async () => {
    const open = new Set([A, B]);
    const h = harness({max: 4, delay: 'manual', live: (sid) => open.has(sid)});
    const pending = h.get('m', A);
    await tick();
    open.delete(A);
    h.pendingSpawns.shift()();
    const late = await pending;
    assert.ok(late.err != null || h.ended.length === 1, 'A\'s spawn under way is not kept');
    const refused = await h.get('m', A);
    assert.strictEqual(refused.err.code, 'DEVICE_NOT_FOUND');
    const b = h.get('m', B);
    await tick();
    h.pendingSpawns.shift()();
    assert.ifError((await b).err, 'B spawns on');
  });
});

// B3 x R1 (the hook agreed with B): a session's view changing stops that
// session's workers of the modules it no longer lists; the other session's
// run on. The stores wired as test/sessions/14 wires them.
describe('sessions 30: a session\'s packs and its per-session workers', () => {
  const settings = require('../../lib/session-settings');
  const sessionPacks = require('../../lib/session-packs');
  const ModuleManager = require('../../lib/module-manager');
  before(() => require('../../lib/logger').createLogger());
  // the packs and the shared mode configured here end with this file: the
  // next file in the same process starts from the defaults
  after(() => { settings.resetForTests(); sessionPacks.resetForTests(); });
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

// the review of #356, 3: an uninstall waits for every session worker of
// the module, tracked under name\0sid (lib/module-lifecycle.js liveUnder,
// settledUnder)
describe('sessions 30: an uninstall sees every session worker of the module', () => {
  it('liveUnder finds one still running; settledUnder waits for each one\'s broker to settle', async () => {
    const {ModuleLifecycle} = require('../../lib/module-lifecycle');
    const lc = new ModuleLifecycle();
    let exitA;
    let settleA;
    let settleB;
    lc.track(`m\0${A}`, {exited: new Promise((r) => { exitA = r; }), settled: new Promise((r) => { settleA = r; }), terminate: () => {}});
    lc.track(`m\0${B}`, {exited: Promise.resolve(), settled: new Promise((r) => { settleB = r; }), terminate: () => {}});
    lc.track(`mm\0${C}`, {exited: new Promise(() => {}), settled: new Promise(() => {}), terminate: () => {}});
    await tick();
    assert.ok(lc.liveUnder('m\0') != null, 'A\'s is running');
    exitA();
    await tick();
    assert.strictEqual(lc.liveUnder('m\0'), null, 'none running; mm\'s is another module\'s');
    let settled = false;
    const waiting = lc.settledUnder('m\0').then(() => { settled = true; });
    settleA();
    await tick();
    assert.strictEqual(settled, false, 'B\'s broker still settling');
    settleB();
    await waiting;
  });
});

// The security pass of 11-17: what counts as a session worker's work in
// flight (lib/worker-message.js inFlight, read by the pool's busy)
describe('sessions 30: a request past its deadline is no longer in flight', () => {
  const WorkerMessage = require('../../lib/worker-message');
  const wm = (queue, deadlines) => ({msgQueue: queue, requestDeadlines: deadlines});
  const f = () => {};
  const inFlight = (w, now) => WorkerMessage.prototype.inFlight.call(w, now, 5000);
  it('a request with no deadline (a load, a job run with no timeout) is always in flight', () => {
    assert.strictEqual(inFlight(wm({1: f}, {}), 1e12), true);
  });
  it('a call is in flight until its deadline and the margin have passed; then not', () => {
    assert.strictEqual(inFlight(wm({1: f}, {1: 10000}), 9000), true, 'before its deadline');
    assert.strictEqual(inFlight(wm({1: f}, {1: 10000}), 15000), true, 'within the margin');
    assert.strictEqual(inFlight(wm({1: f}, {1: 10000}), 15001), false, 'past it');
    assert.strictEqual(inFlight(wm({1: f, 2: f}, {1: 10000, 2: 20000}), 15001), true, 'another still in flight');
    assert.strictEqual(inFlight(wm({}, {1: 10000}), 0), false, 'nothing queued');
  });
});
