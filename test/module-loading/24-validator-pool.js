// The validator pool (lib/validator-pool.js; lean worker step 1(b) as the
// reviewer revised it on #152, 2026-11-13), server-free, with real validator
// workers. JSON Schema validation of a module's schema cannot be bounded by a
// check made beforehand: the reviewer's inputs below pass any such check and
// still take seconds (a pattern with overlapping alternatives, repeated
// stars, \s+$ on 50 KB, uniqueItems over 20000 items, an anyOf schema of
// 700 bytes that takes seconds to compile). So each request has a deadline:
// - the call is refused VALIDATION_TIMEOUT within it, naming the module, the
//   action and the side, never the value;
// - the main thread's event loop keeps running meanwhile (a 10 ms timer
//   fires on time);
// - the validator is replaced, and the next request answers;
// - a request queued behind a stalled one is not refused: its deadline
//   counts its own work;
// - three timeouts in five minutes quarantine the module, and only it;
// - a validator that ends (a crash) refuses its request and is replaced;
// - the value checked is the structured clone the module's worker receives;
// - ajv's log lines are bounded and escaped.
const assert = require('assert');

const TIMEOUT_MS = 300;
const SERVICE = 'urn:countinghouse-test:serviceID:s';

describe('module-loading 24: the validator pool', function() {
  this.timeout(60000);
  let ValidatorPool = null;
  let pool = null;
  let names = 0;
  const LOG = require('../../lib/logger');
  let logW = null;
  let logE = null;
  const warned = [];
  const errors = [];
  before(() => {
    const options = require('../../lib/cli-options');
    options.setOptions({workerThread: true});
    ValidatorPool = require('../../lib/validator-pool').ValidatorPool;
    logW = LOG.W;
    logE = LOG.E;
    LOG.W = (line) => { warned.push(String(line)); return line; };
    LOG.E = (e) => { errors.push(String(e && e.message)); return e; };
    pool = new ValidatorPool({size: 2, timeoutMs: TIMEOUT_MS, workerOptions: options.getOptionsForWorker()});
    return whenReady(pool);
  });
  // The pool's workers have started (a start is no request's time).
  async function whenReady(p) {
    for (let waited = 0; !p.slots.every((s) => s.ready) && waited < 20000; waited += 20) await new Promise((r) => setTimeout(r, 20));
  }
  after(() => {
    if (pool != null) pool.close();
    LOG.W = logW;
    LOG.E = logE;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });

  // A module with one action `a` whose input is `input`, and `extra` in its
  // schema.json; -> its key in the pool.
  function moduleWith(input, extra = {}) {
    const name = `pool-module-${++names}`;
    const api = {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}}]}}}};
    const schema = {$id: '#/', s: {a: {input: input}}, ...extra};
    const key = `${name}#test`;
    pool.register(key, name, JSON.stringify(api), JSON.stringify(schema));
    return {key, name};
  }
  const checkIn = (m, input) => pool.check(m.key, SERVICE, 'a', 'input', {input: input});
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

  const SLOW = [
    ['a pattern with overlapping alternatives', {type: 'string', pattern: '^(\\w|a)+$'}, `${'a'.repeat(40)}!`],
    ['repeated stars', {type: 'string', pattern: '^\\d*\\d*\\d*\\d*$'}, `${'1'.repeat(5000)}x`],
    ['\\s+$ on 50 KB', {type: 'string', pattern: '\\s+$'}, `${' '.repeat(50000)}x`],
    ['uniqueItems over 20000 items', {type: 'array', uniqueItems: true}, Array.from({length: 20000}, (_, i) => ({i}))]
  ];
  // A regular expression's backtracking either outlasts the deadline
  // (VALIDATION_TIMEOUT) or, compiled to native code in a validator's small
  // stack, overflows it, which the validator answers as a failed validation
  // (INPUT_DATA_VALIDATION_FAIL, 'data validation threw'): refused within the
  // deadline either way.
  for (const [label, schema, value] of SLOW) {
    it(`${label}: refused within the deadline, the main thread running all along`, async () => {
      const m = moduleWith(schema);
      await whenReady(pool);
      const {answer, ms, worst} = await whileTimed(() => checkIn(m, value));
      if (process.env.CH_POOL_DEBUG) console.log(label, codeOf(answer), ms, worst);
      assert.ok(['VALIDATION_TIMEOUT', 'INPUT_DATA_VALIDATION_FAIL'].includes(codeOf(answer)), JSON.stringify(answer && answer[0].message));
      assert.ok(ms < TIMEOUT_MS + 700, `${ms} ms`);
      assert.ok(worst < 100, `a 10 ms timer was ${worst} ms late`);
      if (codeOf(answer) === 'VALIDATION_TIMEOUT') assert.match(answer[0].message, new RegExp(`^${m.name}/a: its input was not validated within ${TIMEOUT_MS} ms`));
      assert.ok(!answer[0].message.includes('aaaa') && !answer[0].message.includes('1111'), 'never the value');
    });
  }

  // uniqueItems over 20000 objects: a loop, not a regular expression, so it
  // always outlasts the deadline.
  const STALL = {type: 'array', uniqueItems: true};
  const STALLING = Array.from({length: 20000}, (_, i) => ({i}));

  it('a schema that takes seconds to compile (700 bytes of anyOf): its first request is refused within the deadline', async () => {
    const defs = {l0: {type: 'object', properties: {a: {type: 'string'}, b: {type: 'integer'}}}};
    for (let i = 1; i <= 7; i++) defs[`l${i}`] = {anyOf: Array.from({length: 3}, () => ({$ref: `#/defs/l${i - 1}`}))};
    const m = moduleWith({$ref: '#/defs/l7'}, {defs});
    const {answer, ms, worst} = await whileTimed(() => checkIn(m, {a: 'x'}));
    assert.strictEqual(codeOf(answer), 'VALIDATION_TIMEOUT');
    assert.ok(ms < TIMEOUT_MS + 700, `${ms} ms`);
    assert.ok(worst < 100, `${worst} ms late`);
  });

  it('after a timeout the replaced validator answers, and a request queued behind the stalled one is not refused', async () => {
    const slow = moduleWith(STALL);
    const quick = moduleWith({type: 'object', properties: {n: {type: 'integer'}}});
    const one = new ValidatorPool({size: 1, timeoutMs: TIMEOUT_MS, workerOptions: require('../../lib/cli-options').getOptionsForWorker()});
    try {
      for (const m of [slow, quick]) one.register(m.key, m.name, ...registered(m));
      const stalled = one.check(slow.key, SERVICE, 'a', 'input', {input: STALLING});
      const queued = one.check(quick.key, SERVICE, 'a', 'input', {input: {n: 1}});
      assert.strictEqual(codeOf(await stalled), 'VALIDATION_TIMEOUT');
      assert.strictEqual(await queued, null, 'its own work, on the replacement');
      assert.strictEqual(codeOf(await one.check(quick.key, SERVICE, 'a', 'input', {input: {n: 'x'}})), 'INPUT_DATA_VALIDATION_FAIL');
    } finally {
      one.close();
    }
  });
  // what pool.register was given for `m`
  function registered(m) {
    const r = pool.modules.get(m.key);
    return [r.apiText, r.schemaText];
  }

  it('three timeouts in five minutes quarantine the module, and only it; a new start (a new key) is not', async () => {
    const m = moduleWith(STALL);
    const other = moduleWith({type: 'object', properties: {n: {type: 'integer'}}});
    for (let i = 0; i < 3; i++) assert.strictEqual(codeOf(await checkIn(m, STALLING)), 'VALIDATION_TIMEOUT');
    assert.ok(pool.isQuarantined(m.key));
    assert.ok(errors.some((l) => l.includes(`${m.name}: quarantined after 3 validation timeouts`)), errors.join('\n'));
    const started = Date.now();
    const refused = await checkIn(m, []);
    assert.strictEqual(codeOf(refused), 'VALIDATION_QUARANTINED');
    assert.ok(Date.now() - started < 50, 'at once, never sent');
    assert.strictEqual(await checkIn(other, {n: 1}), null, 'another module is validated');
    const again = {key: `${m.name}#again`, name: m.name};
    pool.register(again.key, again.name, ...registered(m));
    assert.strictEqual(await checkIn(again, [1, 2]), null, 'reloaded: validated again');
  });

  it('a validator that ends while it validates refuses its request, and is replaced', async () => {
    const m = moduleWith(STALL);
    const pending = checkIn(m, STALLING);
    let slot = null;
    for (let waited = 0; slot == null && waited < 5000; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
      slot = pool.slots.find((s) => s.current != null && s.current.key === m.key);
    }
    assert.ok(slot != null, 'the request is being validated');
    await slot.worker.terminate();
    const started = Date.now();
    assert.strictEqual(codeOf(await pending), 'VALIDATION_TIMEOUT');
    assert.ok(Date.now() - started < TIMEOUT_MS, 'refused when it ended, not at the deadline');
    const quick = moduleWith({type: 'object', properties: {n: {type: 'integer'}}});
    assert.strictEqual(await checkIn(quick, {n: 1}), null);
  });

  it('the value checked is the structured clone the module\'s worker receives: a getter on a class is not there', async () => {
    const m = moduleWith({type: 'object', properties: {n: {type: 'integer'}}, required: ['n']});
    class Num { get n() { return 1; } }
    assert.strictEqual(codeOf(await checkIn(m, new Num())), 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(await checkIn(m, {n: 1}), null);
  });

  it('ajv\'s log lines are bounded: one per module per level, cut, escaped', async () => {
    warned.length = 0;
    const m = moduleWith({type: 'object', properties: {
      a: {type: 'number', minLength: 1}, b: {type: 'number', maxLength: 2}, c: {type: 'number', pattern: `x\n${'y'.repeat(1000)}`}}});
    await checkIn(m, {a: 1});
    // ajv warns three times here (strictTypes): one line reaches the log
    const mine = warned.filter((l) => l.includes(m.name));
    assert.strictEqual(mine.length, 1, mine.join('\n'));
    for (const l of mine) {
      assert.ok(l.length < 600, String(l.length));
      assert.ok(!l.includes('\n'), 'escaped: one line');
    }
  });

  it('a value that cannot be cloned is refused, not sent', async () => {
    const m = moduleWith({type: 'object'});
    const answer = await checkIn(m, {f: () => 1});
    assert.strictEqual(codeOf(answer), 'DEVICE_INVOKE_EXCEPTION');
  });
});
