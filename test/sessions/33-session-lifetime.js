'use strict';
// R1 Task 6 (lib/session-lifetime.js), in-process: a session's end stops its
// per-session workers and only then removes its partitions, on a bye or an
// expired window and never on the runtime's stop; a start's sweep keeps the
// restored sessions' partitions and removes the rest, never fatally; and the
// first session after a start that reset them is told so, once. The real
// partitions (lib/session-partition.js) over a local store in a temp
// directory; the module manager a stand-in with session workers and a
// per-session module's record. The spawned cases are session-runtime 11.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const ns = require('../../lib/redis-namespace');
const partition = require('../../lib/session-partition');
const lifetime = require('../../lib/session-lifetime');
const {SessionModuleRecord} = require('../../lib/session-module-record');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);

describe('sessions 33: a per-session module\'s partitions over the session\'s life (R1 Task 6)', () => {
  let dir;
  let env;
  let mm;
  let order;
  let releaseStop;
  before(() => require('../../lib/logger').createLogger());
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-life-'));
    fs.mkdirSync(path.join(dir, 'data'));
    env = {dataRoot: path.join(dir, 'data'), kv: new LocalKv({storePath: path.join(dir, 'store')})};
    order = [];
    releaseStop = null;
    mm = {modules: {ps: new SessionModuleRecord({name: 'ps', version: '1.0.0', modulePath: '/m', moduleSpec: null}), shared: {}},
      perSessionModuleNames: require('../../lib/module-manager').prototype.perSessionModuleNames,
      // the module holds no quota here (its quota: the describe below)
      creditSessionEnd: () => false,
      sessionRanModule: () => false,   // so a partition is removed when it is on disk
      forgetSessionModules: () => {},
      sessionSettled: (id) => { order.push(`settled ${id[0]}`); return Promise.resolve({ps: true}); },
      sessionWorkers: {stopSession: (id) => { order.push(`stop ${id[0]}`); return new Promise((r) => { releaseStop = () => { order.push(`stopped ${id[0]}`); r(); }; }); }}};
    lifetime.resetForTests();
    require('../../lib/notices').resetForTests();
  });
  afterEach(() => {
    if (env.kv != null && typeof(env.kv.close) === 'function') env.kv.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });
  const make = async (sid) => {
    await partition.ensure(env.dataRoot, 'ps', sid);
    env.kv.set(`${ns.sessionPrefixFor('ps', sid)}k`, '1');
  };
  const has = (sid) => fs.existsSync(path.join(env.dataRoot, 'ps', 'sessions', sid)) || env.kv.keysWithPrefix(ns.sessionPrefixFor('ps', sid)).length > 0;

  for (const reason of ['bye', 'window']) {
    it(`'${reason}': the session's workers stop first, and only then are its partitions removed; another session's stay`, async () => {
      await make(A);
      await make(B);
      // the store's removal of A's keys, in the same record as the stop
      const deletePrefix = env.kv.deletePrefix.bind(env.kv);
      env.kv.deletePrefix = (prefix) => { order.push(`keys ${prefix.includes(A) ? 'a' : '?'}`); return deletePrefix(prefix); };
      const ending = lifetime.ended(mm, A, reason, env);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(has(A), 'nothing removed while its workers are stopping');
      releaseStop();
      await ending;
      assert.deepStrictEqual(order, ['stop a', 'stopped a', 'settled a', 'keys a'], 'removed only after they stopped, a crashed one\'s broker too');
      assert.ok(!has(A), 'removed once they stopped');
      assert.ok(has(B), 'B\'s kept');
    });
  }

  it('the start\'s sweep keeps a session known here until its end says \'removed\': \'kept\' and \'nothing\' keep it; held or closing keeps all', async () => {
    const registry = {held: new Set(), isClosed: false, closed() { return this.isClosed; }, holds(id) { return this.held.has(id); }};
    const outcome = new Map();
    const guard = lifetime.sweepGuard(registry, null, (id) => Promise.resolve(outcome.get(id)));
    const C = 'c'.repeat(32);
    const D = 'd'.repeat(32);
    const E = 'e'.repeat(32);
    guard.restored([A]);
    guard.opened(B);
    guard.opened(C);
    assert.ok(guard.keep.has(A) && guard.keep.has(B) && guard.keep.has(C), 'restored and opened: kept');
    assert.strictEqual(guard.keep.has(D), false, 'one this process never knew: the sweep\'s');
    outcome.set(A, 'kept');      // a worker still running, or a busy broker
    outcome.set(B, 'nothing');   // 'closed': the daemon keeps it
    outcome.set(C, 'removed');
    assert.strictEqual(await guard.gone(A, 'bye'), 'kept');
    assert.strictEqual(await guard.gone(B, 'closed'), 'nothing');
    assert.strictEqual(await guard.gone(C, 'bye'), 'removed');
    assert.strictEqual(guard.keep.has(A), true, '\'kept\': never swept under a live worker');
    assert.strictEqual(guard.keep.has(B), true, '\'nothing\': the daemon\'s row, kept');
    assert.strictEqual(guard.keep.has(C), false, '\'removed\': what is left is the sweep\'s');
    const failing = lifetime.sweepGuard(registry, null, () => Promise.reject(new Error('x')));
    failing.opened(E);
    assert.strictEqual(await failing.gone(E, 'bye'), undefined, 'never rejects');
    assert.strictEqual(failing.keep.has(E), true, 'an end that failed keeps it');
    registry.held.add(D);
    assert.strictEqual(guard.keep.has(D), true, 'held by the registry: kept');
    registry.held.delete(D);
    registry.isClosed = true;
    assert.strictEqual(guard.keep.has(D), true, 'closing: everything kept');
    registry.isClosed = false;
    guard.done();
    guard.opened(E);
    assert.strictEqual(guard.keep.has(E), false, 'after the sweep: nothing recorded');
  });

  it('sessionSettled reads a late settle the lifecycle has already dropped: a worker whose broker went past the bound counts as busy', async () => {
    const {ModuleLifecycle} = require('../../lib/module-lifecycle');
    const ModuleManager = require('../../lib/module-manager');
    const m = {modules: mm.modules, lifecycle: new ModuleLifecycle(), perSessionModuleNames: ModuleManager.prototype.perSessionModuleNames};
    m.lifecycle.track(`ps\0${A}`, {exited: Promise.resolve(), settled: Promise.resolve(false)});
    m.lifecycle.track(`ps\0${B}`, {exited: Promise.resolve(), settled: Promise.resolve(true)});
    await new Promise((r) => setImmediate(r));   // both entries dropped by now
    assert.deepStrictEqual(await ModuleManager.prototype.sessionSettled.call(m, A), {ps: false});
    assert.deepStrictEqual(await ModuleManager.prototype.sessionSettled.call(m, B), {ps: true});
    assert.deepStrictEqual(await ModuleManager.prototype.sessionSettled.call(m, A), {ps: true}, 'asked once, then forgotten');
  });

  it('a late mark lasts until that broker itself goes idle (a later worker\'s clean settle clears nothing), and a module\'s unload forgets all of its', async () => {
    const {ModuleLifecycle} = require('../../lib/module-lifecycle');
    const lc = new ModuleLifecycle();
    let drain;
    const stillBusy = new Promise((r) => { drain = r; });
    lc.track(`ps\0${A}`, {exited: Promise.resolve(), settled: Promise.resolve(false), idle: () => stillBusy});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lc.wentLate(`ps\0${A}`), true);
    lc.track(`ps\0${A}`, {exited: Promise.resolve(), settled: Promise.resolve(true), idle: () => Promise.resolve()});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lc.wentLate(`ps\0${A}`), true, 'a newer worker\'s clean settle: the old broker\'s op still runs');
    drain();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(lc.wentLate(`ps\0${A}`), false, 'cleared once the late broker went idle');
    lc.track(`ps\0${B}`, {exited: Promise.resolve(), settled: Promise.resolve(false)});
    lc.track(`other\0${B}`, {exited: Promise.resolve(), settled: Promise.resolve(false)});
    await new Promise((r) => setImmediate(r));
    lc.forgetLateUnder('ps\0');
    assert.strictEqual(lc.wentLate(`ps\0${B}`), false);
    assert.strictEqual(lc.wentLate(`other\0${B}`), true, 'another module\'s kept');
  });

  it('a broker still busy past the bound at a session\'s end: that partition is kept, and the end says so (\'kept\')', async () => {
    await make(A);
    mm.sessionSettled = () => Promise.resolve({ps: false});
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    LOG.E = () => {};
    try {
      const ending = lifetime.ended(mm, A, 'bye', env);
      releaseStop();
      assert.strictEqual(await ending, 'kept');
    } finally {
      LOG.E = realE;
    }
    assert.ok(has(A), 'kept for the next start\'s sweep');
  });

  it('the sweep gives each partition\'s share back right after its removal, not at its end', async () => {
    await make(A);
    await make(B);
    // at each credit: its own partition gone, the next one still there
    const seen = [];
    await lifetime.sweepAtStart(new Set(), env, {mm: {creditSessionEnd: (name, sid) => {
      seen.push(`credit ${sid[0]}: ${has(sid) ? 'there' : 'gone'}, ${[A, B].filter((x) => x !== sid && has(x)).length} other left`);
      return Promise.resolve(true);
    }}});
    assert.deepStrictEqual(seen, ['credit a: gone, 1 other left', 'credit b: gone, 0 other left']);
  });

  it('a session\'s end never rejects: a module manager it can\'t ask resolves false, logged', async () => {
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    const logged = [];
    LOG.E = (e) => logged.push(e);
    try {
      const bare = {modules: mm.modules, sessionWorkers: {stopSession: () => Promise.resolve()}};
      assert.strictEqual(await lifetime.ended(bare, A, 'bye', env), 'kept');
      assert.strictEqual(logged.length, 1);
    } finally {
      LOG.E = realE;
    }
  });

  it('\'closed\' (the runtime stopping): the workers stop, and every partition is kept for the next start', async () => {
    await make(A);
    const ending = lifetime.ended(mm, A, 'closed', env);
    releaseStop();
    assert.strictEqual(await ending, 'nothing', 'nothing removed: the daemon keeps it, to restore');
    assert.deepStrictEqual(order, ['stop a', 'stopped a', 'settled a']);
    assert.ok(has(A));
  });

  it('a partition that can\'t be removed is logged, never thrown', async () => {
    await make(A);
    // the links point at a decoy of the test's own, never a shared directory:
    // a regression that followed one would remove the decoy, not /tmp
    const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-sessions-33-decoy-'));
    fs.writeFileSync(path.join(decoy, 'kept'), 'x');
    const LOG = require('../../lib/logger');
    const realE = LOG.E;
    const logged = [];
    LOG.E = (e) => logged.push(String(e && e.message));
    try {
      fs.symlinkSync(decoy, path.join(env.dataRoot, 'ps', 'sessions', 'x'));   // a stray link: not this session's
      fs.rmSync(path.join(env.dataRoot, 'ps', 'sessions'), {recursive: true, force: true});
      fs.symlinkSync(decoy, path.join(env.dataRoot, 'ps', 'sessions'));          // sessions/ itself a link: refused
      fs.mkdirSync(path.join(decoy, A));   // so A's partition seems to be there, through it
      const ending = lifetime.ended(mm, A, 'bye', env);
      releaseStop();
      await ending;   // no throw
      assert.ok(logged.some((m) => /^module: ps: a session's partition was not removed/.test(m)), JSON.stringify(logged));
      assert.ok(fs.existsSync(path.join(decoy, 'kept')) && fs.existsSync(path.join(decoy, A)), 'nothing behind the link touched');
    } finally {
      LOG.E = realE;
      fs.unlinkSync(path.join(env.dataRoot, 'ps', 'sessions'));
      fs.rmSync(decoy, {recursive: true, force: true});
    }
  });

  // The security pass of 11-17 and the reviewer's redesign: the module's fs
  // quota, shared by its session workers, keeps each session's share; a
  // session's end gives back exactly its own. The real ModuleManager and
  // Quota, built as a spawn builds it (one walk per partition).
  describe('the module\'s shared fs quota: each session\'s share', () => {
    const ModuleManager = require('../../lib/module-manager');
    const options = require('../../lib/cli-options');
    const walk = require('../../lib/fs-broker/spawn-walk');
    let saved;
    beforeEach(() => {
      saved = {moduleDataPath: options.moduleDataPath, moduleSandbox: options.moduleSandbox};
      options.moduleDataPath = env.dataRoot;
      options.moduleSandbox = 'enforce';
      for (const m of ['sessionQuota', 'creditSessionEnd', 'emptySessionTmp', 'sessionRanModule', 'forgetSessionModules']) mm[m] = ModuleManager.prototype[m];
      mm.sessionQuotas = new Map();
    });
    const realMeasure = walk.measure;
    afterEach(() => {
      Object.assign(options, saved);
      walk.measure = realMeasure;   // a case that failed with its build held never holds the next
    });
    // a session worker's spawn: the module's quota (built by the first), and
    // the view its broker charges through
    const spawn = (sid, limits = {diskMb: 10, diskEntries: 1000}) => mm.sessionQuota('ps', limits, () => {}, sid).take();
    const quota = () => mm.sessionQuotas.get('ps').quota;
    const total = () => [quota().bytes, quota().entries];
    const data = (sid, name) => path.join(env.dataRoot, 'ps', 'sessions', sid, 'data', name);
    const tmp = (sid, name) => path.join(env.dataRoot, 'ps', 'sessions', sid, 'tmp', name);
    // a write through a broker: charged to the total and the session's share
    const write = (view, file, bytes) => { fs.writeFileSync(file, Buffer.alloc(bytes)); view.reserve(bytes, 1, 'write', '/data/x'); view.settle(bytes, 1, bytes, 1); };
    const end = async (sid, reason = 'bye') => { const ending = lifetime.ended(mm, sid, reason, env); releaseStop(); await ending; };

    it('built one partition at a time; a bye gives back exactly that session\'s share, the others\' stay', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      assert.deepStrictEqual(total(), [5000, 6], 'each partition: data, tmp and f');
      await end(A);
      assert.ok(!has(A) && has(B));
      assert.deepStrictEqual(total(), [2000, 3], 'B\'s share alone');
    });

    it('a partition made after the quota was built: its broker\'s charges are its share, given back whole', async () => {
      await make(B);
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      const before = total();
      await make(A);
      const view = await spawn(A);
      write(view, data(A, 'f'), 3000);
      write(view, tmp(A, 't'), 500);
      await end(A);
      assert.deepStrictEqual(total(), before, 'back to B\'s');
    });

    it('a share is given back whole, whatever its walk did: a failed walk counted 0 (unknown, never pinning the module), a truncated one its count', async () => {
      await make(A);
      await make(B);
      await make(C);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(1000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2 * 1024 * 1024));   // past a 1 MB limit
      fs.writeFileSync(data(C, 'f'), Buffer.alloc(3000));
      const realMeasure = walk.measure;
      walk.measure = (roots, opts) => (roots[0][0].endsWith(A) ? Promise.reject(Object.assign(new Error('raced an rm'), {code: 'ENOENT'})) : realMeasure(roots, opts));
      try {
        await spawn(C, {diskMb: 1, diskEntries: 1000});
      } finally {
        walk.measure = realMeasure;
      }
      const built = quota().bytes;
      const counted = (sid) => quota().shares.get(sid).bytes;
      assert.strictEqual(counted(A), 0, 'A\'s walk failed: counted 0 (the reviewer\'s round 5: no module-wide ENOSPC from one failed walk)');
      assert.strictEqual(quota().knows(A), false, 'and unknown');
      assert.ok(quota().bytes < quota().maxBytes * 3, 'the module is not pinned past its limit by it');
      assert.ok(counted(B) > 1024 * 1024, 'B\'s stopped past 1 MB: it added what it counted');
      const bShare = counted(B);
      const aShare = counted(A);
      await end(A);
      assert.strictEqual(quota().bytes, built - aShare, 'A gave back exactly what it added');
      await end(B);
      assert.strictEqual(quota().bytes, built - aShare - bShare, 'B gave back exactly what it added');
      await end(C);
      assert.strictEqual(quota().bytes, 0, 'C\'s, exactly: nothing left');
    });

    it('every end but \'closed\' removes and gives back: \'unsettled\' too; \'closed\' keeps both', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      await end(A, 'closed');
      assert.ok(has(A));
      assert.deepStrictEqual(total(), [5000, 6]);
      await end(A, 'unsettled');
      assert.ok(!has(A));
      assert.deepStrictEqual(total(), [2000, 3]);
      const ending = lifetime.ended(mm, B, 'bye', env);
      releaseStop();
      assert.strictEqual(await ending, 'removed', 'an end with its partitions dealt with says so');
      assert.deepStrictEqual(total(), [0, 0]);
    });

    it('a removal that fails gives nothing back; a module the session never ran is left alone; sessions/ is kept at runtime', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      await spawn(B);
      const realRemove = partition.remove;
      let removes = 0;
      partition.remove = () => { removes++; return Promise.reject(Object.assign(new Error('partly removed'), {code: 'EBUSY'})); };
      try {
        await end(A);
        assert.strictEqual(quota().bytes, 3000, 'not given back');
        await end(C);   // C never ran ps here, and has no partition: skipped
        assert.strictEqual(removes, 1, 'nothing done for C');
      } finally {
        partition.remove = realRemove;
      }
      fs.rmSync(path.join(env.dataRoot, 'ps', 'sessions', B), {recursive: true, force: true});
      await end(A);
      assert.ok(fs.existsSync(path.join(env.dataRoot, 'ps', 'sessions')), 'an empty sessions/ stays: a new partition may be being made under it');
    });

    it('a spawn and a removal in the same tick: both finish, and the quota counts what is left', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      const ending = end(A);
      const spawning = spawn(B);
      const done = await Promise.race([Promise.all([ending, spawning]).then(() => 'done'), new Promise((r) => setTimeout(r, 3000, 'stuck'))]);
      assert.strictEqual(done, 'done');
      assert.ok(quota().bytes === 2000 || quota().bytes === 5000, `B's alone, or A's still counted (the safe side): ${quota().bytes}`);
    });

    // a build walk held mid-way (its partition's measure waits for release())
    const slowBuild = (sid) => {
      const realMeasure = walk.measure;
      let release = null;
      const held = new Promise((r) => { release = r; });
      walk.measure = (roots, opts) => (roots[0][0].endsWith(sid) ? held.then(() => realMeasure(roots, opts)) : realMeasure(roots, opts));
      return {release: () => { walk.measure = realMeasure; release(); }};
    };

    it('the build\'s promise always settles, resolving, even when its walk throws: a spawn gets its view, an end completes', async () => {
      await make(A);
      await make(B);
      const {Quota} = require('../../lib/fs-broker/quota');
      const realAdd = Quota.prototype.addMeasured;
      Quota.prototype.addMeasured = () => { throw new Error('a walk that throws'); };
      const LOG = require('../../lib/logger');
      const realE = LOG.E;
      LOG.E = () => {};
      let view;
      try {
        view = await spawn(B);
      } finally {
        Quota.prototype.addMeasured = realAdd;
        LOG.E = realE;
      }
      assert.ok(view != null && typeof(view.reserve) === 'function');
      const first = quota();
      assert.strictEqual(first.buildFailed, true, 'marked for a rebuild, still the module\'s one quota');
      await spawn(A);
      assert.strictEqual(quota(), first, 'built again in place: every charge and credit to one quota');
      assert.strictEqual(quota().knows(A), true, 'A, with no share yet, measured whole this time');
      assert.strictEqual(quota().knows(B), false, 'B\'s share, made while it had failed, stays unknown (never walked twice)');
      await end(A);
      assert.ok(!has(A));
    });

    it('a write still in flight when its session ends settles into nothing: its bytes are never given back twice', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      const viewA = await spawn(A);
      viewA.reserve(1000, 1, 'write', '/data/g');   // in flight across the end
      await end(A);
      assert.strictEqual(quota().bytes, 2000, 'A\'s share, its reservation too, given back');
      viewA.settle(1000, 1, 0, 0);   // the write then failed
      viewA.settle(0, 0, 700, 1);   // or another grew
      assert.throws(() => viewA.reserve(500, 1, 'write', '/data/h'), (e) => e.code === 'ENOSPC', 'a share given back refuses any new charge');
      quota().enforce = false;   // under report nothing is refused: nor this, and it isn't counted either
      viewA.reserve(500, 1, 'write', '/data/h');
      assert.strictEqual(quota().bytes, 2000);
      assert.strictEqual(quota().bytes, 2000, 'B\'s 2000 untouched');
    });

    it('a session\'s end removes its other modules\' partitions while one module\'s build still walks', async () => {
      mm.modules.ps2 = new SessionModuleRecord({name: 'ps2', version: '1.0.0', modulePath: '/m2', moduleSpec: null});
      try {
        await make(A);
        await make(B);
        await partition.ensure(env.dataRoot, 'ps2', A);
        const slow = slowBuild(B);
        const spawning = spawn(A);
        await new Promise((r) => setImmediate(r));
        const ending = end(A);
        assert.ok(await (async () => { for (let i = 0; i < 40; i++) { if (!fs.existsSync(path.join(env.dataRoot, 'ps2', 'sessions', A))) return true; await new Promise((r) => setTimeout(r, 25)); } return false; })(),
          'ps2\'s partition removed while ps\'s build walks');
        slow.release();
        await spawning;
        await ending;
        assert.ok(!has(A));
      } finally {
        delete mm.modules.ps2;
      }
    });

    it('a session\'s end stops its workers before it waits for a slow build walk', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      const slow = slowBuild(B);
      const spawning = spawn(A);
      await new Promise((r) => setImmediate(r));
      const ending = lifetime.ended(mm, A, 'bye', env);
      releaseStop();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(order, ['stop a', 'stopped a', 'settled a'], 'stopped while the build still walks');
      slow.release();
      await spawning;
      await ending;
      assert.ok(!has(A));
      assert.strictEqual(quota().bytes, 0, 'A\'s share given back after the build');
    });

    it('a session that ends while the build walks its partition: never counted again, no share left behind', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      const slow = slowBuild(A);
      const spawning = spawn(B);
      await new Promise((r) => setImmediate(r));
      const ending = end(A);
      await new Promise((r) => setTimeout(r, 50));
      slow.release();
      await spawning;
      await ending;
      assert.deepStrictEqual(total(), [2000, 3], 'B\'s alone');
      assert.ok(!quota().shares.has(A), 'A\'s share forgotten');
    });

    it('a negative reservation (a copy over a bigger file) is capped at the share: files never counted can\'t drain the total, nor take the share below 0', async () => {
      await make(B);
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);   // built before A's partition is there
      await make(A);
      fs.writeFileSync(data(A, 'big'), Buffer.alloc(9000));   // on disk, never counted (no broker wrote it)
      const viewA = await spawn(A);
      viewA.reserve(-9000, 0, 'copyfile', '/data/big');   // a small file copied over the big one
      assert.strictEqual(quota().bytes, 2000, 'while the copy runs: B\'s still counted (others can\'t write past the limit meanwhile)');
      viewA.settle(-9000, 0, -9000, 0);
      assert.strictEqual(quota().bytes, 2000, 'B\'s 2000 stay counted');
      assert.strictEqual(quota().shares.get(A).bytes, 0, 'never below 0');
      write(viewA, data(A, 'n'), 100);
      assert.strictEqual(quota().bytes, 2100, 'a later write still charged');
    });

    it('a decrease never takes another op\'s reservation in flight: a share can\'t write uncounted that way', async () => {
      await make(B);
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      await make(A);
      fs.writeFileSync(data(A, 'old'), Buffer.alloc(1024 * 1024));   // on disk, never counted
      const viewA = await spawn(A);
      viewA.reserve(100, 1, 'write', '/data/n');   // op 1, in flight
      viewA.settle(0, 0, -1024 * 1024, -1);         // op 2 removes the uncounted 1 MB
      assert.strictEqual(quota().bytes, 2100, 'op 1\'s 100 still counted');
      viewA.settle(100, 1, 100, 1);                 // op 1 lands
      assert.strictEqual(quota().bytes, 2100, 'and counted once');
    });

    // the reviewer's ruling (round 4): no early stop, no floor: the build
    // walks every partition, each bounded; one past the limits is unknown
    it('the build walks every partition, each bounded by the limits; once each session ends the total falls back to 0', async () => {
      const ids = Array.from({length: 6}, (_, i) => i.toString(16).repeat(32).slice(0, 32));
      for (const id of ids) {
        await partition.ensure(env.dataRoot, 'ps', id);
        fs.writeFileSync(data(id, 'f'), Buffer.alloc(300 * 1024));
      }
      const big = 'f'.repeat(32);
      await partition.ensure(env.dataRoot, 'ps', big);
      fs.writeFileSync(data(big, 'f'), Buffer.alloc(2 * 1024 * 1024));
      let walks = 0;
      const realM = walk.measure;
      walk.measure = (roots, opts) => { walks++; return realM(roots, opts); };
      try {
        await spawn(ids[0], {diskMb: 1, diskEntries: 1000});
      } finally {
        walk.measure = realM;
      }
      assert.strictEqual(walks, 7, 'every partition walked');
      assert.ok(ids.every((id) => quota().knows(id)), 'each under the limit: known');
      assert.strictEqual(quota().knows(big), false, 'one past the limits: unknown, counted to the limit + 1');
      assert.ok(quota().bytes > 1024 * 1024, 'over the limit: writes refused, as they should be');
      for (const id of ids.concat([big])) await end(id);
      assert.strictEqual(quota().bytes, 0, 'no floor: back to 0 once every session has ended');
    });

    it('the build walks a few partitions at a time, never all at once', async () => {
      const ids = Array.from({length: 12}, (_, i) => i.toString(16).repeat(32).slice(0, 32));
      for (const id of ids) await partition.ensure(env.dataRoot, 'ps', id);
      let now = 0;
      let most = 0;
      const realM = walk.measure;
      walk.measure = async(roots, opts) => { now++; most = Math.max(most, now); await new Promise((r) => setTimeout(r, 10)); now--; return realM(roots, opts); };
      try {
        await spawn(ids[0]);
      } finally {
        walk.measure = realM;
      }
      assert.ok(most > 1 && most <= 4, `at most 4 at once: ${most}`);
    });

    it('the start\'s sweep gives back what a live session\'s quota counted of the partitions it removes', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);   // B's spawn built the quota after listen, counting A's ended partition
      assert.strictEqual(quota().bytes, 5000);
      await lifetime.sweepAtStart({has: (id) => id === B}, env, {mm});
      assert.ok(!has(A) && has(B));
      assert.strictEqual(quota().bytes, 2000, 'A\'s share given back with its partition');
    });

    it('a sessions/ that can\'t be read leaves every share unknown', async () => {
      await make(A);
      let viewA;
      const realReaddir = fs.promises.readdir;
      fs.promises.readdir = () => Promise.reject(Object.assign(new Error('too many open files'), {code: 'EMFILE'}));
      try {
        viewA = await spawn(A);
      } finally {
        fs.promises.readdir = realReaddir;
      }
      const first = quota();
      assert.strictEqual(first.bytes, 0, 'nothing pinned');
      write(viewA, data(A, 'w'), 500);   // charged through A's view, and on disk
      await make(B);
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(4000));
      const viewB = await spawn(B);
      assert.strictEqual(quota(), first, 'the same quota, built again in place');
      assert.strictEqual(quota().shares.get(B).bytes, 4000, 'B, with no share yet, read this time');
      assert.strictEqual(quota().knows(A), false, 'A\'s, made while it had failed, stays unknown');
      assert.strictEqual(quota().shares.get(A).bytes, 500, 'and not walked again: its charged write counted once');
      write(viewB, data(B, 'g'), 100);
      await end(B);
      assert.strictEqual(quota().bytes, 500, 'B\'s end credits the quota it charged (A\'s 500 stay)');
    });

    it('only a session id under sessions/ is a partition: a stray entry is never counted', async () => {
      await make(A);
      fs.mkdirSync(path.join(env.dataRoot, 'ps', 'sessions', 'old'), {recursive: true});
      fs.writeFileSync(path.join(env.dataRoot, 'ps', 'sessions', 'old', 'big'), Buffer.alloc(50000));
      fs.writeFileSync(data(A, 'f'), Buffer.alloc(1000));
      await spawn(A);
      assert.strictEqual(quota().bytes, 1000);
      assert.strictEqual(quota().shares.has('old'), false);
    });

    it('a share can\'t drain the total by deleting files it never counted; its own charges are given back at its end', async () => {
      await make(B);
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      await spawn(B);
      await make(A);
      fs.writeFileSync(data(A, 'old'), Buffer.alloc(9000));   // on disk, never counted
      const viewA = await spawn(A);
      write(viewA, data(A, 'new'), 500);
      assert.strictEqual(quota().bytes, 2500);
      viewA.settle(0, 0, -9000, -1);   // A's broker removes the uncounted 9000
      assert.strictEqual(quota().bytes, 2000, 'down by A\'s 500 at most: B\'s 2000 stay counted');
      await end(A);
      assert.strictEqual(quota().bytes, 2000, 'B\'s');
    });

    it('a respawn\'s /tmp gives back only through the view its spawn took: another quota\'s view, or none, gives nothing', async () => {
      await make(A);
      await make(B);
      await spawn(B);
      const view = await spawn(A);
      write(view, tmp(A, 't'), 2500);
      const before = quota().bytes;
      await mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'), null);
      assert.strictEqual(quota().bytes, before, 'no view: emptied, nothing given back');
      write(view, tmp(A, 't2'), 1000);
      const {Quota} = require('../../lib/fs-broker/quota');
      const other = new Quota({maxBytes: 1, maxEntries: 1}).viewFor(A);
      await mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'), other);
      assert.strictEqual(quota().bytes, before + 1000, 'another quota\'s view: nothing given back here');
    });

    it('a /tmp kept (it overlaps module code) is never emptied, and its share is still given back (the high review of #452)', async () => {
      await make(A);
      await make(B);
      await spawn(B);
      const view = await spawn(A);
      write(view, tmp(A, 't'), 2500);
      const before = quota().bytes;
      await mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'), view, {keep: true});
      assert.ok(fs.existsSync(tmp(A, 't')), 'emptied');
      assert.strictEqual(quota().bytes, before - 2500, 'its share given back');
    });

    it('a respawn empties its /tmp: what it held leaves its share and the total; a name in /data keeps those bytes counted', async () => {
      await make(A);
      await make(B);
      await spawn(B);
      const view = await spawn(A);
      write(view, tmp(A, 't'), 2500);
      write(view, data(A, 'kept'), 4000);
      fs.linkSync(data(A, 'kept'), tmp(A, 'alsoKept'));
      const before = quota().bytes;
      await mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'), view);
      assert.strictEqual(quota().bytes, before - 2500, 't only: kept still has a name in /data');
      assert.deepStrictEqual(fs.readdirSync(path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp')), []);
      await end(A);
      assert.strictEqual(quota().bytes, 0, 'the rest of A\'s share at its end');
    });
  });

  it('a start\'s sweep keeps the restored and open sessions\' partitions and removes the rest; with none restored and some there, the next session is told once', async () => {
    await make(A);
    await make(B);
    await make(C);
    await lifetime.checkResetAtStart(false, env);   // A restored: the registry isn't idle
    const open = new Set([C]);   // opened while the sweep runs: kept too
    assert.deepStrictEqual(await lifetime.sweepAtStart({has: (id) => id === A || open.has(id)}, env), {removed: 1, failed: 0, skipped: 0});
    assert.ok(has(A) && !has(B) && has(C));
    const notices = require('../../lib/notices');
    notices.openSession(C, null);
    lifetime.sessionOpened(C);
    assert.deepStrictEqual(notices.take('ps', C), [], 'A was restored: nothing reset for anyone');
    await make(B);
    await lifetime.checkResetAtStart(true, env);
    assert.deepStrictEqual(await lifetime.sweepAtStart(new Set(), env), {removed: 3, failed: 0, skipped: 0});
    notices.openSession(C, null);
    lifetime.sessionOpened(C);
    assert.deepStrictEqual(notices.take('ps', C), [lifetime.RESET_AT_START]);
    notices.openSession(A, null);
    lifetime.sessionOpened(A);
    assert.deepStrictEqual(notices.take('ps', A), [], 'once');
  });

  it('the sweep asks keep as it reaches each partition: once the runtime is stopping (keep says yes), the rest are kept', async () => {
    await make(A);
    await make(B);
    await make(C);
    let stopping = false;
    const keep = {has: () => { const kept = stopping; stopping = true; return kept; }};
    assert.deepStrictEqual(await lifetime.sweepAtStart(keep, env), {removed: 1, failed: 0, skipped: 0}, 'the first only, before the stop');
    assert.strictEqual([A, B, C].filter(has).length, 2);
  });

  it('D3 when the listing before listen() fails: the first session is told (the safe side), once', async () => {
    const broken = {dataRoot: env.dataRoot, kv: {keysWithPrefix: () => { throw new Error('briefly gone'); }}};
    await lifetime.checkResetAtStart(true, broken);
    const notices = require('../../lib/notices');
    notices.openSession(B, null);
    lifetime.sessionOpened(B);
    assert.deepStrictEqual(notices.take('ps', B), [lifetime.RESET_AT_START]);
  });

  it('a sweep that cannot run is logged, never fatal', async () => {
    const broken = {dataRoot: env.dataRoot, kv: {keysWithPrefix: () => { throw new Error('the store is gone'); }}};
    assert.deepStrictEqual(await lifetime.sweepAtStart(new Set(), broken), {removed: 0, failed: 0, skipped: 0});
    await lifetime.checkResetAtStart(true, broken);   // nor its listing
  });
});

// The figures docs/module-development.md and docs/cli-and-api-reference.md
// give for per-session workers are the code's own: a test, so neither can
// drift from the other (the Reviewer, R1 Task 7).
describe('sessions 33: the per-session docs quote the code\'s figures', () => {
  const fs = require('fs');
  const path = require('path');
  const doc = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', f), 'utf8');
  it('the crash suspension (the module supervisor\'s rule) and the cap\'s default', () => {
    const {SUSPEND_AFTER, WINDOW_MS} = require('../../lib/module-supervisor');
    const words = {3: 'Three', 10: 'ten'};
    assert.ok(doc('module-development.md').includes(`${words[SUSPEND_AFTER]} exits within ${words[WINDOW_MS / 60000]} minutes`),
      `module-development.md must say ${SUSPEND_AFTER} exits within ${WINDOW_MS / 60000} minutes`);
    // the flag as a runtime parses it, in a process of its own (this one's
    // options are the suite's), as mcp-contract 21 reads --listPageSize
    const optionsOf = (argv) => JSON.parse(require('child_process').execFileSync(process.execPath, ['-e',
      `const o = require('./lib/cli-options'); o.setOptions(${JSON.stringify(argv)}); process.stdout.write(JSON.stringify({n: o.maxSessionWorkers, bad: o.maxSessionWorkersInvalid}));`],
    {cwd: path.join(__dirname, '..', '..')}).toString());
    assert.deepStrictEqual(optionsOf({}), {n: 16, bad: null});
    assert.deepStrictEqual(optionsOf({maxSessionWorkers: 1}), {n: 1, bad: null});
    for (const v of [0, -1, 1.5, 'x']) assert.strictEqual(optionsOf({maxSessionWorkers: v}).bad.name, 'maxSessionWorkers', String(v));
    assert.ok(doc('module-development.md').includes('`--maxSessionWorkers` (default 16)'));
    assert.ok(doc('cli-and-api-reference.md').includes('| `--maxSessionWorkers <n>` | `16` |'));
    assert.strictEqual(lifetime.RESET_AT_START.startsWith('Per-session module state was reset'), true);
  });
});
