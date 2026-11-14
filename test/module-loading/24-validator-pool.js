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
  let defaultValidatorWorkers = null;
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
    ({ValidatorPool, respawnDelay, defaultValidatorWorkers} = require('../../lib/validator-pool'));
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
  // Ready, and done compiling in the background: every new validator warms
  // every known module before it takes a call (the review of #165).
  async function warmed(p) {
    await whenReady(p);
    for (let w = 0; (p.slots.some((x) => x.background.size > 0) || !(p.spare && p.spare.ready)) && w < 60000; w += 20) await new Promise((r) => setTimeout(r, 20));
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
  // A module whose request stalled a validator waits a one-second cool-down
  // before it gets another (lib/validator-pool.js COOLDOWN_MS).
  const cooled = () => new Promise((r) => setTimeout(r, 1100));

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
      await warmed(pool);
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
      await warmed(pool);
      assert.strictEqual(codeOf(await checkIn(m, STALLING)), 'VALIDATION_TIMEOUT');
      await cooled();
    }
    assert.strictEqual(pool.isQuarantined(m.name), false);
    await warmed(pool);
    assert.strictEqual(await checkIn(m, [1, 2]), null, 'still validated');
  });

  it('an output\'s timeouts are: three quarantine the module by name, past a restart; an operator\'s load ends it', async () => {
    const m = moduleWith({type: 'object'}, {}, STALL);
    for (let i = 0; i < 3; i++) {
      await warmed(pool);
      assert.strictEqual(codeOf(await checkOut(m, STALLING)), 'VALIDATION_TIMEOUT');
      await cooled();
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
    await warmed(pool);
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
    await cooled();
  });

  // A start delayed until `ms` of the request's budget are left (as a long
  // wait in the queue leaves it), whatever the clock: deterministic.
  const startLate = (p, ms) => {
    const start = p.start;
    p.start = function(slot, req) {
      req.deadlineAt = Date.now() + ms;
      return start.call(this, slot, req);
    };
    return () => { p.start = start; };
  };

  it('a module that has not stalled a validator: its request is started however little of its budget is left (a load\'s check after the validators boot, an innocent call)', async () => {
    const p = newPool();
    try {
      const m = moduleWith({type: 'object'}, {}, {type: 'object'}, p);
      await warmed(p);
      const restore = startLate(p, 40);   // 40 ms of 300: under a quarter
      try {
        assert.strictEqual(await checkIn(m, {}, p), null);
        assert.strictEqual(await p.safety(m.key), null, 'a load-time check too');
      } finally {
        restore();
      }
    } finally {
      p.close();
    }
  });

  // The review of #165 (HIGH 1 and 2, MED 4): an input's stall is held
  // against its caller only; a module's share counts ready validators; one
  // caller has one validation in flight; a replacement starts at once and
  // warms off the call path; a call never waits past its own deadline.
  it('a load\'s safety check and warm compile wait for the validators to boot: their budget runs from when one starts them', async () => {
    // a fresh pool, asked at once (its workers still booting), with a
    // budget shorter than a boot
    const p = newPool({compileMs: 50});
    try {
      const m = moduleWith({type: 'object'}, {}, {type: 'object'}, p);
      assert.strictEqual(await p.safety(m.key), null);
      assert.strictEqual(await p.warm(m.key), null);
    } finally {
      p.close();
    }
  });

  describe('callers, floods and replacements', () => {
    const checkFrom = (p, m, input, caller) => p.check(m.key, SERVICE, 'a', 'input', {input: input}, caller);
    const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length * 0.9)]; };

    // The reviewer's repro: one slow input a second to module B from one
    // caller. Its stalls are held against that caller, and no one else is
    // refused for them. With three validators B always has one beside the
    // attacker's. With two (the default on 2 CPUs) a module holds one at a
    // time, so another caller of B can wait out the attacker's first three
    // stalls, before the attacker is throttled, and never after.
    for (const [size, mayFail] of [[3, 0], [2, 3]]) {
      it(`one slow input a second to module B from one caller (${size} validators): another caller's 15 calls to B pass${mayFail ? `, but for at most ${mayFail} beside the attacker's first stalls` : ''}`, async () => {
        const p = newPool({size: size});
        try {
          const b = moduleWith({type: 'object', properties: {s: {type: 'string', pattern: '^(\\w|a)+$'}}}, {}, {type: 'object'}, p);
          await warmed(p);
          const attack = [];
          const answers = [];
          for (let i = 0; i < 15; i++) {
            if (i % 5 === 0) attack.push(checkFrom(p, b, {s: `${'a'.repeat(30)}!`}, 'u_attacker'));
            answers.push(codeOf(await checkFrom(p, b, {s: 'abc'}, 'u_legit')));
            await new Promise((r) => setTimeout(r, 200));
          }
          await Promise.all(attack);
          assert.ok(!answers.includes('VALIDATION_CALLER_THROTTLED'), JSON.stringify(answers));
          assert.ok(answers.filter((c) => c != null).length <= mayFail, JSON.stringify(answers));
          assert.deepStrictEqual(answers.slice(11), [null, null, null, null], 'once the attacker is throttled, none');
        } finally {
          p.close();
        }
      });
    }

    it('an input\'s stall replaces the validator and nothing else: no cool-down, no late-start refusal for the module', async () => {
      const p = newPool();
      try {
        const m = moduleWith(STALL, {}, {type: 'object'}, p);
        await warmed(p);
        assert.strictEqual(codeOf(await checkFrom(p, m, STALLING, 'u_a')), 'VALIDATION_TIMEOUT');
        assert.strictEqual(p.cooldown.has(m.key), false);
        assert.strictEqual(p.stalledAt.has(m.key), false);
        const t = Date.now();
        assert.strictEqual(await checkFrom(p, m, [1, 2], 'u_b'), null);
        assert.ok(Date.now() - t < 200, `${Date.now() - t} ms`);
      } finally {
        p.close();
      }
    });

    it('a caller whose inputs stall 3 times in 5 minutes is refused VALIDATION_CALLER_THROTTLED for its calls to that module; no one else is', async () => {
      const p = newPool();
      try {
        const m = moduleWith(STALL, {}, {type: 'object'}, p);
        const other = moduleWith({type: 'object'}, {}, {type: 'object'}, p);
        await warmed(p);
        for (let i = 0; i < 3; i++) {
          assert.strictEqual(codeOf(await checkFrom(p, m, STALLING, 'u_flood')), 'VALIDATION_TIMEOUT');
          await warmed(p);
        }
        const throttled = await checkFrom(p, m, [1], 'u_flood');
        assert.strictEqual(codeOf(throttled), 'VALIDATION_CALLER_THROTTLED');
        assert.match(throttled[0].message, new RegExp(`^${m.name}/a: this caller's inputs to the module kept missing the validation deadline \\(3 in 5 minutes\\), so its calls to the module are refused for \\d+ s`));
        assert.ok(!/u_flood/.test(throttled[0].message), 'never the caller id');
        assert.strictEqual(await checkFrom(p, m, [1], 'u_someone'), null, 'another caller');
        assert.strictEqual(await checkFrom(p, other, {}, 'u_flood'), null, 'the same caller, another module');
        assert.strictEqual(p.isQuarantined(m.name), false, 'no strike against the module');
      } finally {
        p.close();
      }
    });

    it('the stall window slides across a block: once a block ends, the next stall within 5 minutes blocks the caller again', async () => {
      const p = newPool({callerCooldownMs: 500});
      try {
        const m = moduleWith(STALL, {}, {type: 'object'}, p);
        await warmed(p);
        for (let i = 0; i < 3; i++) {
          assert.strictEqual(codeOf(await checkFrom(p, m, STALLING, 'u_flood')), 'VALIDATION_TIMEOUT');
          await warmed(p);
        }
        assert.strictEqual(codeOf(await checkFrom(p, m, [1], 'u_flood')), 'VALIDATION_CALLER_THROTTLED');
        await new Promise((r) => setTimeout(r, 600));
        await warmed(p);
        assert.strictEqual(await checkFrom(p, m, [1], 'u_flood'), null, 'the block has ended');
        // a recently stalling caller takes no last free validator: both free
        await warmed(p);
        assert.strictEqual(codeOf(await checkFrom(p, m, STALLING, 'u_flood')), 'VALIDATION_TIMEOUT');
        await warmed(p);
        assert.strictEqual(codeOf(await checkFrom(p, m, [1], 'u_flood')), 'VALIDATION_CALLER_THROTTLED', 'its fourth stall in the window blocks it again');
      } finally {
        p.close();
      }
    });

    it('one caller has one validation in flight across the pool: five slow inputs at once are sent one at a time', async () => {
      const p = newPool({size: 3});
      try {
        const m = moduleWith(STALL, {}, {type: 'object'}, p);
        await warmed(p);
        const sent = p.stats.sent;
        const five = Array.from({length: 5}, () => checkFrom(p, m, STALLING, 'u_one'));
        await new Promise((r) => setTimeout(r, 100));
        assert.strictEqual(p.stats.sent - sent, 1, 'only one in flight');
        await Promise.all(five);
      } finally {
        p.close();
      }
    });

    it('one module flooded by one caller for 3 s: another caller\'s module B has p90 under 50 ms and nothing refused', async () => {
      const p = newPool();
      try {
        const flooded = moduleWith(STALL, {}, {type: 'object'}, p);
        const b = moduleWith({type: 'object', properties: {n: {type: 'integer'}}}, {}, {type: 'object'}, p);
        await warmed(p);
        let flooding = true;
        const yieldNow = () => new Promise((r) => setImmediate(r));
        const flood = (async () => { while (flooding) { await checkFrom(p, flooded, STALLING, 'u_flood'); await yieldNow(); } })();
        const times = [];
        const codes = [];
        const started = Date.now();
        while (Date.now() - started < 3000) {
          const t = Date.now();
          codes.push(codeOf(await checkFrom(p, b, {n: 1}, 'u_b')));
          times.push(Date.now() - t);
          await new Promise((r) => setTimeout(r, 20));
        }
        flooding = false;
        await flood;
        if (process.env.CH_POOL_NUMBERS === '1') console.log(`one flooded: B ${codes.filter((c) => c != null).length}/${codes.length} refused, p90 ${p90(times)} ms`);
        assert.deepStrictEqual(codes.filter((c) => c != null), []);
        assert.ok(p90(times) < 50, `p90 ${p90(times)} ms`);
      } finally {
        p.close();
      }
    });

    it('two modules flooded by two callers for 3 s (three validators): under 1% of B\'s calls refused', async () => {
      const p = newPool({size: 3});
      try {
        const f1 = moduleWith(STALL, {}, {type: 'object'}, p);
        const f2 = moduleWith(STALL, {}, {type: 'object'}, p);
        const b = moduleWith({type: 'object', properties: {n: {type: 'integer'}}}, {}, {type: 'object'}, p);
        await warmed(p);
        let flooding = true;
        const yieldNow = () => new Promise((r) => setImmediate(r));
        const floods = [[f1, 'u_flood1'], [f2, 'u_flood2']].map(([m, who]) => (async () => { while (flooding) { await checkFrom(p, m, STALLING, who); await yieldNow(); } })());
        let calls = 0;
        let refused = 0;
        const started = Date.now();
        while (Date.now() - started < 3000) {
          calls += 1;
          if (codeOf(await checkFrom(p, b, {n: 1}, 'u_b')) != null) refused += 1;
          await new Promise((r) => setTimeout(r, 20));
        }
        flooding = false;
        await Promise.all(floods);
        if (process.env.CH_POOL_NUMBERS === '1') console.log(`two flooded: B ${refused}/${calls} refused`);
        assert.ok(refused / calls < 0.01, `${refused} of ${calls} refused`);
      } finally {
        p.close();
      }
    });

    it('a module\'s own output stall still cools the module down, and a late request of its is refused unstarted', async () => {
      const p = newPool();
      try {
        const m = moduleWith({type: 'object'}, {}, STALL, p);
        await warmed(p);
        // a module loaded after the validators started: its first call
        // compiles the action on the call path, so one passing call first
        assert.strictEqual(await checkOut(m, [1], p), null);
        assert.strictEqual(codeOf(await checkOut(m, STALLING, p)), 'VALIDATION_TIMEOUT');
        assert.ok(p.cooldown.has(m.key) && p.stalledAt.has(m.key));
        await cooled();
        await warmed(p);
        const sent = p.stats.sent;
        const restore = startLate(p, 40);
        try {
          assert.strictEqual(codeOf(await checkOut(m, STALLING, p)), 'VALIDATION_TIMEOUT');
        } finally {
          restore();
        }
        assert.strictEqual(p.stats.sent, sent, 'never sent to a validator');
      } finally {
        p.close();
      }
    });

    it('a replacement starts at once; only workers that end before they are ready back off', async () => {
      const p = newPool();
      try {
        const m = moduleWith(STALL, {}, {type: 'object'}, p);
        await warmed(p);
        assert.strictEqual(codeOf(await checkFrom(p, m, STALLING, 'u_a')), 'VALIDATION_TIMEOUT');
        assert.strictEqual(p.startFailures, 0);
        const t = Date.now();
        await warmed(p);
        assert.ok(Date.now() - t < 5000, `${Date.now() - t} ms to a full, ready pool`);
      } finally {
        p.close();
      }
      assert.deepStrictEqual([1, 2, 3, 4, 10].map(respawnDelay), [0, 100, 200, 400, 5000]);
    });

    it('a call whose action is still compiling is refused at its own deadline, with no strike; a replacement compiles every known module before it takes a call', async () => {
      // slow to compile (seconds), quick to validate once compiled
      const props = Object.fromEntries(Array.from({length: 1500}, (_, i) => [`p${i}`, {type: 'string', maxLength: 10, pattern: `^x${i}`}]));
      const answerFast = async (p, m, caller) => {
        // the first call on a validator pays a one-time cost; the next is quick
        for (let i = 0; i < 2; i++) {
          const t = Date.now();
          const answer = await checkFrom(p, m, {p1: 'x1'}, caller);
          if (answer == null && Date.now() - t < TIMEOUT_MS) return true;
        }
        return false;
      };
      // one validator and its spare: which one compiled what is known
      const p = newPool({size: 1, compileMs: 30000});
      try {
        await warmed(p);
        const m = moduleWith({type: 'object', properties: props}, {}, {type: 'object'}, p);
        const staller = moduleWith(STALL, {}, {type: 'object'}, p);
        const t = Date.now();
        const answer = await checkFrom(p, m, {}, 'u_a');
        assert.strictEqual(codeOf(answer), 'VALIDATION_TIMEOUT');
        assert.ok(Date.now() - t < TIMEOUT_MS + 300, `${Date.now() - t} ms: never past the call's own deadline`);
        assert.strictEqual((p.strikes.get(m.name) || []).length, 0, 'no strike');
        // the compile went on in the background: then the module is served
        await warmed(p);
        assert.ok(await answerFast(p, m, 'u_a'), 'served once compiled');
        // the validator replaced: the spare, which compiled every known
        // module off the call path, serves it at once
        assert.strictEqual(codeOf(await checkFrom(p, staller, STALLING, 'u_b')), 'VALIDATION_TIMEOUT');
        await warmed(p);
        assert.ok(await answerFast(p, m, 'u_c'), 'served by the replacement');
        assert.strictEqual((p.strikes.get(m.name) || []).length, 0);
      } finally {
        p.close();
      }
    });

    it('the default pool: one validator per spare CPU, 2 to 4', () => {
      assert.deepStrictEqual([1, 2, 3, 4, 5, 8, 64].map((c) => defaultValidatorWorkers(c)), [2, 2, 2, 3, 4, 4, 4]);
    });
  });

  it('a module of 50 actions of 30 properties each (135 KB) compiles at load, per action, and every call answers', async () => {
    const props = Object.fromEntries(Array.from({length: 30}, (_, i) => [`p${i}`, {type: 'string', description: 'd'.repeat(60), maxLength: 100}]));
    const api = {device: {friendlyName: 'big-module', serviceList: {[SERVICE]: {actionList: Array.from({length: 50}, (_, i) => ({name: `a${i}`,
      input: {schema: `/s/a${i}/input`}, output: {schema: `/s/a${i}/output`}}))}}}};
    const schema = {$id: '#/', s: Object.fromEntries(Array.from({length: 50}, (_, i) => [`a${i}`, {input: {type: 'object', properties: props}, output: {type: 'object', properties: props}}]))};
    assert.ok(JSON.stringify(schema).length > 130000, String(JSON.stringify(schema).length));
    // the runtime's default compile budget (--validationCompileMs 10000)
    const p = newPool({compileMs: 10000});
    try {
      const key = 'big-module#1';
      p.register(key, 'big-module', JSON.stringify(api), JSON.stringify(schema));
      await warmed(p);
      const started = Date.now();
      assert.strictEqual(await p.warm(key), null);
      const warmMs = Date.now() - started;
      assert.ok(warmMs < 5000, `warm ${warmMs} ms`);
      for (let i = 0; i < 50; i += 7) {
        assert.strictEqual(await p.check(key, SERVICE, `a${i}`, 'input', {input: {p0: 'x'}}), null, `a${i}`);
      }
    } finally {
      p.close();
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
    await warmed(pool);
    assert.strictEqual(await pool.warm(m.key), null);
    for (const slot of pool.slots) await slot.worker.terminate();
    await new Promise((r) => setTimeout(r, 50));
    await warmed(pool);
    assert.strictEqual(await checkIn(m, {n: 1}), null);
    assert.strictEqual(codeOf(await checkIn(m, {n: 'x'})), 'INPUT_DATA_VALIDATION_FAIL');
  });

  it('a validator that ends while it validates refuses its request, and is replaced', async () => {
    const m = moduleWith(STALL);
    await warmed(pool);
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
    await cooled();
    await warmed(pool);
    assert.strictEqual(await checkIn(moduleWith({type: 'object'}), {}), null);
  });

  it('a replaced validator\'s place is taken at once by a ready spare: during a flood just after a replacement, another module still checks in under 50 ms', async () => {
    const p = newPool();
    try {
      await warmed(p);
      for (let w = 0; !(p.spare && p.spare.ready) && w < 30000; w += 20) await new Promise((r) => setTimeout(r, 20));
      const flood = moduleWith(STALL, {}, {type: 'object'}, p);
      const quiet = moduleWith({type: 'object', properties: {n: {type: 'integer'}}}, {}, {type: 'object'}, p);
      // one validator replaced (a slow input), then a flood at once (its
      // module cooled down: the flood itself is refused in the queue)
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
    await warmed(pool);
    const [bad, good] = await Promise.all([checkIn(m, {f: () => 1}), checkIn(m, {})]);
    assert.strictEqual(codeOf(bad), 'DEVICE_INVOKE_EXCEPTION');
    assert.strictEqual(good, null);
  });

  it('a safety check that fails to run refuses the module (fail closed)', async () => {
    pool.register('broken#1', 'broken', JSON.stringify({device: {friendlyName: 'broken'}}), 12345);
    await warmed(pool);
    const problem = await pool.safety('broken#1');
    assert.ok(problem != null && /failed to run/.test(problem.reason), JSON.stringify(problem));
  });

  it('the value checked is the structured clone the module\'s worker receives: a getter on a class is not there', async () => {
    const m = moduleWith({type: 'object', properties: {n: {type: 'integer'}}, required: ['n']});
    class Num { get n() { return 1; } }
    await warmed(pool);
    assert.strictEqual(codeOf(await checkIn(m, new Num())), 'INPUT_DATA_VALIDATION_FAIL');
    assert.strictEqual(await checkIn(m, {n: 1}), null);
  });

  it('ajv\'s log lines are bounded: one per module per level, cut, escaped', async () => {
    warned.length = 0;
    const m = moduleWith({type: 'object', properties: {
      a: {type: 'number', minLength: 1}, b: {type: 'number', maxLength: 2}, c: {type: 'number', pattern: `x\n${'y'.repeat(1000)}`}}});
    await warmed(pool);
    await checkIn(m, {a: 1});
    // ajv warns three times here (strictTypes): one line reaches the log
    const mine = warned.filter((l) => l.includes(m.name));
    assert.strictEqual(mine.length, 1, mine.join('\n'));
    assert.ok(mine[0].length < 600 && !mine[0].includes('\n'));
  });
});
