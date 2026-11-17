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
      const ending = lifetime.ended(mm, A, 'bye', env);
      releaseStop();
      await ending;   // no throw
      assert.ok(logged.some((m) => /^module: ps: a session's partition was not removed/.test(m)), JSON.stringify(logged));
      assert.ok(fs.existsSync(path.join(decoy, 'kept')), 'nothing behind the link touched');
    } finally {
      LOG.E = realE;
      fs.unlinkSync(path.join(env.dataRoot, 'ps', 'sessions'));
      fs.rmSync(decoy, {recursive: true, force: true});
    }
  });

  // The security pass of 11-17: the module's fs quota is one counter shared
  // by its session workers (module-manager sessionQuota), and a partition
  // removed outside the broker must leave it, without ever giving back more
  // than it counted. The real ModuleManager methods, the quota measured by
  // its own walk (take()), over the test's data root.
  describe('the module\'s shared fs quota (module-manager removeSessionPartition)', () => {
    const ModuleManager = require('../../lib/module-manager');
    const options = require('../../lib/cli-options');
    let saved;
    let quota;
    beforeEach(() => {
      saved = {moduleDataPath: options.moduleDataPath, moduleSandbox: options.moduleSandbox};
      options.moduleDataPath = env.dataRoot;
      options.moduleSandbox = 'enforce';
      for (const m of ['sessionQuota', 'underSessionQuota', 'removeSessionPartition', 'measureSessionPartition', 'creditSessionRemoval']) mm[m] = ModuleManager.prototype[m];
      mm.sessionQuotas = new Map();
    });
    afterEach(() => Object.assign(options, saved));
    // the module's quota taken as a spawn takes it: its walk over sessions/
    const take = async (limits = {diskMb: 10, diskEntries: 1000}) => { quota = await mm.sessionQuota('ps', limits, () => {}).take(); return quota; };
    const file = (sid, name) => path.join(env.dataRoot, 'ps', 'sessions', sid, 'data', name);
    const bye = async (sid) => { const ending = lifetime.ended(mm, sid, 'bye', env); releaseStop(); await ending; };

    it('a partition the quota counted: its files\' bytes and entries leave it; its three directories stay counted (the safe direction)', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(file(B, 'f'), Buffer.alloc(2000));
      await take();
      assert.deepStrictEqual([quota.bytes, quota.entries], [5000, 8], 'the walk: each session\'s dir, data, tmp and f');
      await bye(A);
      assert.ok(!has(A) && has(B));
      assert.deepStrictEqual([quota.bytes, quota.entries], [2000, 7], 'A\'s f left; A\'s three directories stay counted');
    });

    it('a partition made after the quota was measured (its directories never counted): only what its broker counted leaves', async () => {
      await make(B);
      fs.writeFileSync(file(B, 'f'), Buffer.alloc(2000));
      await take();
      const before = [quota.bytes, quota.entries];
      await make(A);   // as a later session's spawn makes it: outside the broker, uncounted
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(3000));
      quota.settle(0, 0, 3000, 1);   // as A's broker counted its write
      await bye(A);
      assert.deepStrictEqual([quota.bytes, quota.entries], before, 'back to what B holds: nothing uncounted was given back');
    });

    it('hard links: a file with a name outside the partition gives nothing back; one linked twice inside gives its bytes once', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(file(B, 'shared'), Buffer.alloc(4000));
      fs.linkSync(file(B, 'shared'), file(A, 'alsoB'));   // nlink 2, one name in B
      fs.writeFileSync(file(A, 'own'), Buffer.alloc(1000));
      fs.linkSync(file(A, 'own'), file(A, 'own2'));   // two names, both in A
      await take();
      const bytes = quota.bytes;
      await bye(A);
      assert.strictEqual(quota.bytes, bytes - 1000, 'A\'s own file once; B\'s file, which still exists, not at all');
    });

    it('nothing is given back when either walk stopped past the limits, when the removal fails, or when the module holds no quota', async () => {
      // the quota's walk stopped past 1 MB (B's 3 MB), A's own walk doesn't
      await make(A);
      await make(B);
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(1000));
      fs.writeFileSync(file(B, 'f'), Buffer.alloc(3 * 1024 * 1024));
      await take({diskMb: 1, diskEntries: 1000});
      let counted = quota.bytes;
      await bye(A);
      assert.strictEqual(quota.bytes, counted, 'the quota\'s walk stopped: what it counted isn\'t known');
      // and A's own walk stopped: A over the limit, the quota's walk not (A alone, a limit it passes later)
      mm.sessionQuotas = new Map();
      fs.rmSync(path.join(env.dataRoot, 'ps', 'sessions', B), {recursive: true, force: true});
      await make(A);
      await take({diskMb: 1, diskEntries: 1000});
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(2 * 1024 * 1024));
      quota.settle(0, 0, 2 * 1024 * 1024, 1);
      counted = quota.bytes;
      await bye(A);
      assert.strictEqual(quota.bytes, counted, 'A\'s walk stopped: nothing given back');
      mm.sessionQuotas = new Map();
      await make(A);
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(3000));
      await take();
      const realRemove = partition.remove;
      partition.remove = () => Promise.reject(Object.assign(new Error('partly removed'), {code: 'EBUSY'}));
      try {
        await bye(A);
      } finally {
        partition.remove = realRemove;
      }
      assert.strictEqual(quota.bytes, 3000, 'a failed removal gives nothing back');
      mm.sessionQuotas = new Map();
      assert.strictEqual(await mm.measureSessionPartition('ps', A), null, 'no quota held: nothing measured');
    });

    it('a quota dropped and measured again meanwhile is not credited; clamped at zero', async () => {
      await make(A);
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(3000));
      await take();
      const ticket = await mm.measureSessionPartition('ps', A);
      assert.deepStrictEqual([ticket.bytes, ticket.entries], [3000, 1]);
      mm.sessionQuotas = new Map();
      await take();   // measured again
      assert.strictEqual(mm.creditSessionRemoval('ps', ticket), false);
      quota.settle(0, 0, -quota.bytes + 100, 0);   // counts less than the partition holds
      assert.strictEqual(mm.creditSessionRemoval('ps', Object.assign({}, ticket, {q: mm.sessionQuotas.get('ps'), quota})), true);
      assert.strictEqual(quota.bytes, 0, 'clamped');
    });

    it('the quota\'s walk waits for a removal under way (never races an rm into counting nothing)', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(file(B, 'f'), Buffer.alloc(2000));
      let release = null;
      const removing = mm.removeSessionPartition('ps', A, () => new Promise((r) => { release = () => r(partition.remove(env.dataRoot, env.kv, 'ps', A)); }));
      await new Promise((r) => setImmediate(r));
      let measured = false;
      const taking = take().then((q) => { measured = true; return q; });
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(measured, false, 'held while A\'s partition is being removed');
      release();
      await removing;
      await taking;
      assert.deepStrictEqual([quota.bytes, quota.entries], [2000, 4], 'measured after: B\'s alone');
    });

    it('a spawn\'s quota taken in the same tick as a removal is queued: neither waits for the other forever, and it counts without the partition', async () => {
      await make(A);
      await make(B);
      fs.writeFileSync(file(A, 'f'), Buffer.alloc(3000));
      fs.writeFileSync(file(B, 'f'), Buffer.alloc(2000));
      const removing = mm.removeSessionPartition('ps', A, () => partition.remove(env.dataRoot, env.kv, 'ps', A));
      const taking = take();   // its walk queued behind the removal; the removal sees a quota not yet measured
      const done = await Promise.race([Promise.all([removing, taking]).then(() => 'done'), new Promise((r) => setTimeout(r, 3000, 'stuck'))]);
      assert.strictEqual(done, 'done', 'no deadlock');
      assert.deepStrictEqual([quota.bytes, quota.entries], [2000, 4], 'measured after the removal: B\'s alone, nothing credited twice');
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
