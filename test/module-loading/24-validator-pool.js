// The validator pool (lib/validator-pool.js; lean worker step 1(b) as the
// reviewer corrected it on #152, 2026-11-13), server-free, with real validator
// workers. JSON Schema validation of a module's schema cannot be bounded by a
// check made beforehand: the reviewer's inputs below pass any such check and
// still take seconds. So:
// - each request has a deadline from when it is queued, and is refused
//   within it while the main thread's event loop keeps time; one still
//   queued is dropped, never validated nor sent on;
// - one queue per module, round-robin, and a module holds at most one of two
//   validators: another module's trivial check stays under 50 ms during a
//   flood;
// - only an output's or a compile's timeout is a strike against the module
//   (a caller can send a slow input); three quarantine it, by name, until an
//   operator loads it again;
// - a module's actions are compiled per action under their own budget: at
//   load (warm), and again in a validator that replaced one; a module of 50
//   actions of 30 properties each (135 KB) compiles at load and answers;
// - a validator that ends refuses its request and is replaced, with a
//   backoff when it keeps happening; an uncloneable value is refused and the
//   queue goes on; a safety check that fails to run refuses the module;
// - the value checked is the structured clone the module's worker receives,
//   and ajv's log lines are bounded and escaped.
const assert = require('assert');

const TIMEOUT_MS = 300;
const COMPILE_MS = 2000;
const SERVICE = 'urn:countinghouse-test:serviceID:s';

describe('module-loading 24: the validator pool', function() {
  this.timeout(120000);
  let ValidatorPool = null;
  let respawnDelay = null;
  let pool = null;
  let names = 0;
  const LOG = require('../../lib/logger');
  let logW = null;
  let logE = null;
  const warned = [];
  const errors = [];
  let workerOptions = null;
  before(() => {
    const options = require('../../lib/cli-options');
    options.setOptions({workerThread: true});
    workerOptions = options.getOptionsForWorker();
    ({ValidatorPool, respawnDelay} = require('../../lib/validator-pool'));
    logW = LOG.W;
    logE = LOG.E;
    LOG.W = (line) => { warned.push(String(line)); return line; };
    LOG.E = (e) => { errors.push(String(e && e.message)); return e; };
    pool = newPool();
    return whenReady(pool);
  });
  after(() => {
    if (pool != null) pool.close();
    LOG.W = logW;
    LOG.E = logE;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });
  const newPool = (opts = {}) => new ValidatorPool(Object.assign({size: 2, timeoutMs: TIMEOUT_MS, compileMs: COMPILE_MS, workerOptions}, opts));
  async function whenReady(p) {
    for (let waited = 0; !p.slots.every((s) => s.ready) && waited < 30000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  }

  // A module with one action `a` whose input is `input` and output `output`,
  // and `extra` in its schema.json, registered in `p`; -> {key, name}.
  function moduleWith(input, extra = {}, output = {type: 'object'}, p = pool, name = `pool-module-${++names}`) {
    const api = {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};
    const schema = {$id: '#/', s: {a: {input: input, output: output}}, ...extra};
    const key = `${name}#${names}`;
    p.register(key, name, JSON.stringify(api), JSON.stringify(schema));
    return {key, name};
  }
  const checkIn = (m, input, p = pool) => p.check(m.key, SERVICE, 'a', 'input', {input: input});
  const checkOut = (m, output, p = pool) => p.check(m.key, SERVICE, 'a', 'output', {output: output});
  const codeOf = (answer) => (answer == null ? null : answer[0].code);

  // Runs `work` while a 10 ms timer on this thread records its worst lateness.
  async function whileTimed(work) {
    let last = Date.now();
    let worst = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last - 10);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      const answer = await work();
      return {answer, ms: Date.now() - started, worst};
    } finally {
      clearInterval(timer);
    }
  }

  // uniqueItems over 20000 objects: a loop, not a regular expression, so it
  // always outlasts the deadline (a regular expression may instead overflow
  // a validator's small stack, refused at once as a failed validation).
  const STALL = {type: 'array', uniqueItems: true};
  const STALLING = Array.from({length: 20000}, (_, i) => ({i}));

  const SLOW = [
    ['a pattern with overlapping alternatives', {type: 'string', pattern: '^(\\w|a)+$'}, `${'a'.repeat(40)}!`],
    ['repeated stars', {type: 'string', pattern: '^\\d*\\d*\\d*\\d*$'}, `${'1'.repeat(5000)}x`],
    ['\\s+$ on 50 KB', {type: 'string', pattern: '\\s+$'}, `${' '.repeat(50000)}x`],
    ['uniqueItems over 20000 items', STALL, STALLING]
  ];
  for (const [label, schema, value] of SLOW) {
    it(`${label}: refused within the deadline, the main thread running all along`, async () => {
      const m = moduleWith(schema);
      await whenReady(pool);
      const {answer, ms, worst} = await whileTimed(() => checkIn(m, value));
      assert.ok(['VALIDATION_TIMEOUT', 'INPUT_DATA_VALIDATION_FAIL'].includes(codeOf(answer)), JSON.stringify(answer && answer[0].message));
      assert.ok(ms < TIMEOUT_MS + 300, `${ms} ms`);
      assert.ok(worst < 100, `a 10 ms timer was ${worst} ms late`);
      if (codeOf(answer) === 'VALIDATION_TIMEOUT') assert.match(answer[0].message, new RegExp(`^${m.name}/a: its input was not validated within ${TIMEOUT_MS} ms`));
      assert.ok(!answer[0].message.includes('aaaa') && !answer[0].message.includes('1111'), 'never the value');
    });
  }

  it('an input\'s timeout is no strike: any number of slow inputs never quarantine a module', async () => {
    const m = moduleWith(STALL);
    for (let i = 0; i < 4; i++) {
      await whenReady(pool);
      assert.strictEqual(codeOf(await checkIn(m, STALLING)), 'VALIDATION_TIMEOUT');
    }
    assert.strictEqual(pool.isQuarantined(m.name), false);
    await whenReady(pool);
    assert.strictEqual(await checkIn(m, [1, 2]), null, 'still validated');
  });

  it('an output\'s timeouts are: three quarantine the module by name, past a restart; an operator\'s load ends it', async () => {
    const m = moduleWith({type: 'object'}, {}, STALL);
    for (let i = 0; i < 3; i++) {
      await whenReady(pool);
      assert.strictEqual(codeOf(await checkOut(m, STALLING)), 'VALIDATION_TIMEOUT');
    }
    assert.ok(pool.isQuarantined(m.name));
    assert.ok(errors.some((l) => l.includes(`${m.name}: quarantined after 3`)), errors.join('\n'));
    const started = Date.now();
    assert.strictEqual(codeOf(await checkIn(m, {})), 'VALIDATION_QUARANTINED');
    assert.ok(Date.now() - started < 50, 'at once, never sent');
    // a supervisor's restart: the same name, a new key
    pool.forget(m.key);
    const restarted = moduleWith({type: 'object'}, {}, STALL, pool, m.name);
    assert.strictEqual(codeOf(await checkIn(restarted, {})), 'VALIDATION_QUARANTINED', 'kept by name');
    pool.clearQuarantine(m.name);
    assert.strictEqual(await checkIn(restarted, {}), null, 'an operator\'s load ends it');
  });

  it('fairness: during a flood of one module\'s slow inputs, another module\'s trivial check takes under 50 ms; a request timed out in the queue is never sent', async () => {
    await whenReady(pool);
    const flood = moduleWith(STALL);
    const quiet = moduleWith({type: 'object', properties: {n: {type: 'integer'}}});
    assert.strictEqual(await checkIn(quiet, {n: 1}), null);   // compiled in one validator
    const sentBefore = pool.stats.sent;
    const flooded = Array.from({length: 20}, () => checkIn(flood, STALLING));
    await new Promise((r) => setTimeout(r, 30));
    const timings = [];
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      assert.strictEqual(await checkIn(quiet, {n: i}), null);
      timings.push(Date.now() - started);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(Math.max(...timings) < 50, `the quiet module's checks took ${timings.join(', ')} ms`);
    const answers = await Promise.all(flooded);
    assert.ok(answers.every((a) => codeOf(a) === 'VALIDATION_TIMEOUT'));
    const floodSent = pool.stats.sent - sentBefore - 5;
    assert.ok(floodSent <= 2, `only the flood's running requests were sent to a validator (${floodSent} of 20)`);
  });

  it('a module of 50 actions of 30 properties each (135 KB) compiles at load, per action, and every call answers', async () => {
    const props = Object.fromEntries(Array.from({length: 30}, (_, i) => [`p${i}`, {type: 'string', description: 'd'.repeat(60), maxLength: 100}]));
    const api = {device: {friendlyName: 'big-module', serviceList: {[SERVICE]: {actionList: Array.from({length: 50}, (_, i) => ({name: `a${i}`,
      input: {schema: `/s/a${i}/input`}, output: {schema: `/s/a${i}/output`}}))}}}};
    const schema = {$id: '#/', s: Object.fromEntries(Array.from({length: 50}, (_, i) => [`a${i}`, {input: {type: 'object', properties: props}, output: {type: 'object', properties: props}}]))};
    assert.ok(JSON.stringify(schema).length > 130000, String(JSON.stringify(schema).length));
    const key = 'big-module#1';
    pool.register(key, 'big-module', JSON.stringify(api), JSON.stringify(schema));
    await whenReady(pool);
    const started = Date.now();
    assert.strictEqual(await pool.warm(key), null);
    const warmMs = Date.now() - started;
    assert.ok(warmMs < COMPILE_MS, `warm ${warmMs} ms`);
    for (let i = 0; i < 50; i += 7) {
      assert.strictEqual(await pool.check(key, SERVICE, `a${i}`, 'input', {input: {p0: 'x'}}), null, `a${i}`);
    }
  });

  it('a schema too slow to compile (700 bytes of anyOf) is refused at load within the compile budget, and is a strike', async () => {
    const defs = {l0: {type: 'object', properties: {a: {type: 'string'}, b: {type: 'integer'}}}};
    for (let i = 1; i <= 7; i++) defs[`l${i}`] = {anyOf: Array.from({length: 3}, () => ({$ref: `#/defs/l${i - 1}`}))};
    const quick = newPool({compileMs: 500});
    try {
      await whenReady(quick);
      const m = moduleWith({$ref: '#/defs/l7'}, {defs}, {type: 'object'}, quick);
      const {answer, ms, worst} = await whileTimed(() => quick.warm(m.key));
      assert.ok(answer != null && answer.timeout != null, JSON.stringify(answer));
      assert.ok(ms < 1100, `${ms} ms`);
      assert.ok(worst < 100, `${worst} ms late`);
    } finally {
      quick.close();
    }
  });

  it('a validator that replaced one compiles an action again before its check, and the check answers', async () => {
    const m = moduleWith({type: 'object', properties: {n: {type: 'integer'}}});
    await whenReady(pool);
    assert.strictEqual(await pool.warm(m.key), null);
    for (const slot of pool.slots) await slot.worker.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await whenReady(pool);
    assert.strictEqual(await checkIn(m, {n: 1}), null);
    assert.strictEqual(codeOf(await checkIn(m, {n: 'x'})), 'INPUT_DATA_VALIDATION_FAIL');
  });

  it('a validator that ends while it validates refuses its request, and is replaced', async () => {
    const m = moduleWith(STALL);
    await whenReady(pool);
    const pending = checkIn(m, STALLING);
    let slot = null;
    for (let waited = 0; slot == null && waited < 5000; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
      slot = pool.slots.find((s) => s.current != null && s.current.key === m.key && s.current.phase === 'run');
    }
    assert.ok(slot != null, 'the request is being validated');
    await slot.worker.terminate();
    const started = Date.now();
    assert.strictEqual(codeOf(await pending), 'VALIDATION_TIMEOUT');
    assert.ok(Date.now() - started < TIMEOUT_MS, 'refused when it ended, not at the deadline');
    await whenReady(pool);
    assert.strictEqual(await checkIn(moduleWith({type: 'object'}), {}), null);
  });

  it('a replaced validator\'s place is taken at once by a ready spare: during a flood just after a replacement, another module still checks in under 50 ms', async () => {
    const p = newPool();
    try {
      await whenReady(p);
      for (let w = 0; !(p.spare && p.spare.ready) && w < 30000; w += 20) await new Promise((r) => setTimeout(r, 20));
      const flood = moduleWith(STALL, {}, {type: 'object'}, p);
      const quiet = moduleWith({type: 'object', properties: {n: {type: 'integer'}}}, {}, {type: 'object'}, p);
      // one validator replaced (a slow input), then a flood at once
      assert.strictEqual(codeOf(await checkIn(flood, STALLING, p)), 'VALIDATION_TIMEOUT');
      const flooded = Array.from({length: 5}, () => checkIn(flood, STALLING, p));
      await new Promise((r) => setTimeout(r, 30));
      const started = Date.now();
      assert.strictEqual(await checkIn(quiet, {n: 1}, p), null);
      assert.ok(Date.now() - started < 50, `${Date.now() - started} ms`);
      await Promise.all(flooded);
    } finally {
      p.close();
    }
  });

  it('replacements back off when they keep happening: none, then 100 ms, doubling, up to 5 s', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 8, 20].map(respawnDelay), [0, 100, 200, 400, 5000, 5000]);
  });

  it('a value that cannot be cloned is refused, not sent, and the queue goes on', async () => {
    const m = moduleWith({type: 'object'});
    await whenReady(pool);
    const [bad, good] = await Promise.all([checkIn(m, {f: () => 1}), checkIn(m, {})]);
    assert.strictEqual(codeOf(bad), 'DEVICE_INVOKE_EXCEPTION');
    assert.strictEqual(good, null);
  });

  it('a safety check that fails to run refuses the module (fail closed)', async () => {
    pool.register('broken#1', 'broken', JSON.stringify({device: {friendlyName: 'broken'}}), 12345);
    await whenReady(pool);
    const problem = await pool.safety('broken#1');
    assert.ok(problem != null && /failed to run/.test(problem.reason), JSON.stringify(problem));
  });

  it('the value checked is the structured clone the module\'s worker receives: a getter on a class is not there', async () => {
    const m = moduleWith({type: 'object', properties: {n: {type: 'integer'}}, required: ['n']});
    class Num { get n() { return 1; } }
    await whenReady(pool);
    assert.strictEqual(codeOf(await checkIn(m, new Num())), 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(await checkIn(m, {n: 1}), null);
  });

  it('ajv\'s log lines are bounded: one per module per level, cut, escaped', async () => {
    warned.length = 0;
    const m = moduleWith({type: 'object', properties: {
      a: {type: 'number', minLength: 1}, b: {type: 'number', maxLength: 2}, c: {type: 'number', pattern: `x\n${'y'.repeat(1000)}`}}});
    await whenReady(pool);
    await checkIn(m, {a: 1});
    // ajv warns three times here (strictTypes): one line reaches the log
    const mine = warned.filter((l) => l.includes(m.name));
    assert.strictEqual(mine.length, 1, mine.join('\n'));
    assert.ok(mine[0].length < 600 && !mine[0].includes('\n'));
  });
});
