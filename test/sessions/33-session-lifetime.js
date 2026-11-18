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
      // the module holds no quota here (its quota: the describe below)
      creditSessionEnd: () => false,
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
      assert.deepStrictEqual(order, ['stop a', 'stopped a', 'keys a'], 'removed only after they stopped');
      assert.ok(!has(A), 'removed once they stopped');
      assert.ok(has(B), 'B\'s kept');
    });
  }

  it('\'closed\' (the runtime stopping): the workers stop, and every partition is kept for the next start', async () => {
    await make(A);
    const ending = lifetime.ended(mm, A, 'closed', env);
    releaseStop();
    await ending;
    assert.deepStrictEqual(order, ['stop a', 'stopped a']);
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
      for (const m of ['sessionQuota', 'creditSessionEnd', 'emptySessionTmp']) mm[m] = ModuleManager.prototype[m];
      mm.sessionQuotas = new Map();
    });
    afterEach(() => Object.assign(options, saved));
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

    it('a share is given back whole, whatever its walk did: a failed walk added nothing, a truncated one its count', async () => {
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
      assert.strictEqual(counted(A), 0, 'A\'s walk failed: it added nothing');
      assert.ok(counted(B) > 1024 * 1024, 'B\'s stopped past 1 MB: it added what it counted');
      const bShare = counted(B);
      await end(A);
      assert.strictEqual(quota().bytes, built, 'A gave back the nothing it added');
      await end(B);
      assert.strictEqual(quota().bytes, built - bShare, 'B gave back exactly what it added');
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
        await end(C);   // C never ran ps: no partition
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
      await spawn(A);   // its share made now, after the failed build
      assert.strictEqual(quota().knows(A), false, 'a partition the failed walk didn\'t reach is unknown, never falsely known');
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
      viewA.reserve(500, 1, 'write', '/data/h');
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
      assert.deepStrictEqual(order, ['stop a', 'stopped a'], 'stopped while the build still walks');
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

    it('a share not known can\'t drain the total by deleting uncounted files; its own charges are given back at its end', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'old'), Buffer.alloc(9000));   // uncounted: A's walk fails
      fs.writeFileSync(data(B, 'f'), Buffer.alloc(2000));
      const realMeasure = walk.measure;
      walk.measure = (roots, opts) => (roots[0][0].endsWith(A) ? Promise.reject(new Error('failed')) : realMeasure(roots, opts));
      try {
        await spawn(B);
      } finally {
        walk.measure = realMeasure;
      }
      const viewA = await spawn(A);
      write(viewA, data(A, 'new'), 500);
      assert.strictEqual(quota().bytes, 2500);
      viewA.settle(0, 0, -9000, -1);   // A's broker removes the uncounted 9000
      assert.strictEqual(quota().bytes, 2000, 'down by A\'s 500 at most: B\'s 2000 stay counted');
      await end(A);
      assert.strictEqual(quota().bytes, 2000, 'B\'s');
    });

    it('a respawn\'s /tmp emptied during the build waits for it: the walk never measures it half emptied', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(data(A, 'd'), Buffer.alloc(4000));
      fs.writeFileSync(tmp(A, 't'), Buffer.alloc(2500));
      const slow = slowBuild(A);
      const spawning = spawn(B);
      await new Promise((r) => setImmediate(r));
      const emptying = mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'));
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(tmp(A, 't')), 'not emptied before the build walked it');
      slow.release();
      await spawning;
      await emptying;
      assert.strictEqual(quota().shares.get(A).bytes, 4000, 'A\'s /data alone left in its share');
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
      await mm.emptySessionTmp('ps', A, path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp'));
      assert.strictEqual(quota().bytes, before - 2500, 't only: kept still has a name in /data');
      assert.deepStrictEqual(fs.readdirSync(path.join(env.dataRoot, 'ps', 'sessions', A, 'tmp')), []);
      await end(A);
      assert.strictEqual(quota().bytes, 0, 'the rest of A\'s share at its end');
    });
  });

  it('a start\'s sweep keeps the restored sessions\' partitions and removes the rest; with none restored, the next session is told once', async () => {
    await make(A);
    await make(B);
    assert.deepStrictEqual(await lifetime.sweepAtStart([A], env), {removed: 1, failed: 0, skipped: 0});
    assert.ok(has(A) && !has(B));
    const notices = require('../../lib/notices');
    notices.openSession(C, null);
    lifetime.sessionOpened(C);
    assert.deepStrictEqual(notices.take('ps', C), [], 'A was restored: nothing reset for anyone');
    await make(B);
    assert.deepStrictEqual(await lifetime.sweepAtStart([], env), {removed: 2, failed: 0, skipped: 0});
    notices.openSession(C, null);
    lifetime.sessionOpened(C);
    assert.deepStrictEqual(notices.take('ps', C), [lifetime.RESET_AT_START]);
    notices.openSession(A, null);
    lifetime.sessionOpened(A);
    assert.deepStrictEqual(notices.take('ps', A), [], 'once');
  });

  it('a sweep that cannot run is logged, never fatal', async () => {
    const broken = {dataRoot: env.dataRoot, kv: {keysWithPrefix: () => { throw new Error('the store is gone'); }}};
    assert.deepStrictEqual(await lifetime.sweepAtStart([], broken), {removed: 0, failed: 0, skipped: 0});
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
