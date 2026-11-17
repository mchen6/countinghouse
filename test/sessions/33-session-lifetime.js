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
  before(() => require('../../lib/logger').createLogger(false));
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
    fs.symlinkSync(os.tmpdir(), path.join(env.dataRoot, 'ps', 'sessions', 'x'));   // a stray link: not this session's
    fs.rmSync(path.join(env.dataRoot, 'ps', 'sessions'), {recursive: true, force: true});
    fs.symlinkSync(os.tmpdir(), path.join(env.dataRoot, 'ps', 'sessions'));          // sessions/ itself a link: refused
    const ending = lifetime.ended(mm, A, 'bye', env);
    releaseStop();
    await ending;   // no throw
    fs.unlinkSync(path.join(env.dataRoot, 'ps', 'sessions'));
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
