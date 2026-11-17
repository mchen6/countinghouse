// ValidatorPool.resize (part 3 P2, Task 5): a raise of maxOutputBytes
// confirmed for this start needs validators with a larger heap (a validator
// with the old heap would crash on the bigger value), so each slot is
// replaced in turn, the spare first: it stops taking checks, its held check
// answers within its own deadline, a replacement at the new limits starts and
// is ready before the next slot. Checks keep answering throughout; resizes
// run one at a time; a resize's replacements are no crash and never counted;
// a smaller cap replaces nothing.
const assert = require('assert');

const SERVICE = 'urn:countinghouse-test:serviceID:s';
const MiB = 1024 * 1024;

describe('sandbox 52: the validator pool resized for a larger maxOutputBytes (part 3 P2)', function() {
  this.timeout(180000);
  let ValidatorPool = null;
  let workerOptions = null;
  let pool = null;
  let names = 0;
  // the pool logs a refusal or a slow compile; nothing here is served
  const LOG = require('../../lib/logger');
  let logW = null;
  let logE = null;
  const logged = [];
  before(() => {
    logW = LOG.W;
    logE = LOG.E;
    LOG.W = (line) => { logged.push(String(line)); return line; };
    LOG.E = (e) => { logged.push(String(e && e.message)); return e; };
    const options = require('../../lib/cli-options');
    options.setOptions({workerThread: true});
    workerOptions = options.getOptionsForWorker();
    ({ValidatorPool} = require('../../lib/validator-pool'));
  });
  after(() => {
    require('../../lib/cli-options').setOptions({workerThread: false});
    LOG.W = logW;
    LOG.E = logE;
  });
  afterEach(() => { if (pool != null) pool.close(); pool = null; });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const all = (p) => p.slots.concat([p.spare]);
  async function warmed(p) {
    for (let w = 0; (!all(p).every((s) => s != null && s.ready && s.background.size === 0)) && w < 60000; w += 20) await sleep(20);
  }
  function moduleWith(input, p) {
    const name = `resize-module-${++names}`;
    const api = {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};
    const schema = {$id: '#/', s: {a: {input: input, output: {type: 'object'}}}};
    const key = `${name}#${names}`;
    p.register(key, name, JSON.stringify(api), JSON.stringify(schema));
    return {key, name};
  }
  const checkIn = (p, m, input) => p.check(m.key, SERVICE, 'a', 'input', {input: input});
  // spawned workers' limits, as each slot was started with
  const heaps = (p) => all(p).map((s) => s.limitMb);
  // a deadline a held check meets even while a resize starts workers on a
  // small machine
  const newPool = () => new ValidatorPool({size: 2, timeoutMs: 10000, compileMs: 10000, workerOptions, maxOutputBytes: 8 * MiB});

  it('from 8 MiB to 96 MiB: every slot replaced at 448 MB, the spare first; checks every 10 ms all answer; not counted as respawns', async () => {
    pool = newPool();
    const m = moduleWith({type: 'object', properties: {n: {type: 'integer'}}}, pool);
    await warmed(pool);
    assert.deepStrictEqual(heaps(pool), [256, 256, 256], 'resourceLimitsFor(8 MiB) is the floor');
    const before = pool.respawns.length;
    const order = [];
    const spawn = pool.spawn.bind(pool);
    pool.spawn = (d, r) => { order.push(pool.spare != null && pool.spare.draining ? 'spare' : 'slot'); return spawn(d, r); };
    let stop = false;
    const answers = [];
    const stream = (async () => {
      for (let i = 0; !stop; i++) {
        answers.push(checkIn(pool, m, {n: i}));
        await sleep(10);
      }
    })();
    await pool.resize(96 * MiB);
    stop = true;
    await stream;
    const results = await Promise.all(answers);
    assert.ok(results.length > 5, `${results.length} checks`);
    assert.ok(results.every((r) => r === null), JSON.stringify(results.filter((r) => r !== null).slice(0, 2)));
    assert.deepStrictEqual(heaps(pool), [448, 448, 448]);
    assert.strictEqual(order[0], 'spare');
    assert.strictEqual(order.length, 3);
    assert.strictEqual(pool.respawns.length, before, 'a resize\'s replacements are not respawns');
    assert.ok(all(pool).every((s) => !s.draining));
  });

  it('a smaller (or equal) cap replaces nothing', async () => {
    pool = newPool();
    await warmed(pool);
    const workers = all(pool).map((s) => s.worker);
    await pool.resize(4 * MiB);
    await pool.resize(8 * MiB);
    // by thread id, never the Worker objects (a failure would diff them: #344)
    assert.deepStrictEqual(all(pool).map((s) => s.worker.threadId), workers.map((w) => w.threadId));
  });

  it('a slot holding a check is replaced only after that check answers; two resizes run one after the other', async () => {
    pool = newPool();
    // slow, never past its deadline: a pattern the validator walks for a while
    const m = moduleWith({type: 'array', uniqueItems: true}, pool);
    await warmed(pool);
    const held = checkIn(pool, m, Array.from({length: 3000}, (_, i) => ({i})));
    let slot = null;
    for (let w = 0; slot == null && w < 5000; w += 5) { await sleep(5); slot = pool.slots.find((s) => s.current != null); }
    assert.ok(slot != null, 'a slot holds the check');
    const worker = slot.worker;
    let answered = false;
    held.then(() => { answered = true; });
    const ends = [];
    worker.once('exit', () => ends.push(answered));
    const first = pool.resize(64 * MiB).then(() => 'first');
    const second = pool.resize(96 * MiB).then(() => 'second');
    const done = [];
    first.then((x) => done.push(x));
    second.then((x) => done.push(x));
    await Promise.all([first, second]);
    assert.strictEqual(await held, null, 'the held check answered');
    assert.deepStrictEqual(ends, [true], 'terminated after its check answered');
    assert.deepStrictEqual(done, ['first', 'second']);
    assert.deepStrictEqual(heaps(pool), [448, 448, 448]);
  });

  it('a held request past the wait stops the resize: never terminated by it, nothing left draining; what was resized stays', async () => {
    pool = new ValidatorPool({size: 2, timeoutMs: 30000, compileMs: 10000, workerOptions, maxOutputBytes: 8 * MiB, resizeWaitMs: 300});
    const m = moduleWith({type: 'array', uniqueItems: true}, pool);
    await warmed(pool);
    // the spare goes first; then a validator holding a long check
    const held = checkIn(pool, m, Array.from({length: 9000}, (_, i) => ({i})));
    let slot = null;
    for (let w = 0; slot == null && w < 5000; w += 5) { await sleep(5); slot = pool.slots.find((s) => s.current != null); }
    assert.ok(slot != null);
    const worker = slot.worker;
    let ended = false;
    worker.once('exit', () => { ended = true; });
    await assert.rejects(pool.resize(96 * MiB), {code: 'RESIZE_STOPPED'});
    assert.strictEqual(ended, false, 'the held request\'s worker was not terminated by the resize');
    assert.ok(all(pool).every((s) => !s.draining), 'nothing left draining');
    await held;
    // the same raise confirmed again finishes the resize: never taken as done
    // because the pool's limits were raised (the review of #222)
    pool.resizeWaitMs = 60000;
    assert.ok(heaps(pool).some((mb) => mb < 448), JSON.stringify(heaps(pool)));
    await pool.resize(96 * MiB);
    assert.deepStrictEqual(heaps(pool), [448, 448, 448]);
  });

  it('a slot whose start is still pending is not retired (it starts at the new limits); a draining slot is no share', async () => {
    pool = newPool();
    await warmed(pool);
    // a pending replacement, as fail() makes one after a crash at start
    const pendingSlot = pool.spawn(400, true);
    pool.slots.push(pendingSlot);
    assert.ok(pendingSlot.worker === null, 'no worker yet');
    await pool.resize(96 * MiB);
    assert.strictEqual(pendingSlot.ending, false, 'not retired');
    for (let w = 0; pendingSlot.worker == null && w < 5000; w += 20) await sleep(20);
    assert.strictEqual(pendingSlot.limitMb, 448, 'started at the new limits');
    pool.slots.pop();
    pendingSlot.ending = true;
    await pendingSlot.worker.terminate();
    // the share counts only slots that can serve
    const share = pool.perModuleNow();
    pool.slots[0].draining = true;
    assert.strictEqual(pool.perModuleNow(), Math.max(1, share - 1));
    pool.slots[0].draining = false;
  });

  it('a validator that crashes during a resize is replaced at the new limits as usual, and the resize finishes', async () => {
    pool = newPool();
    const m = moduleWith({type: 'object'}, pool);
    await warmed(pool);
    const resizing = pool.resize(64 * MiB);
    await sleep(30);
    const victim = pool.slots[pool.slots.length - 1];
    await victim.worker.terminate();
    await resizing;
    await warmed(pool);
    assert.deepStrictEqual(heaps(pool), [320, 320, 320]);
    assert.strictEqual(await checkIn(pool, m, {}), null);
  });
});
