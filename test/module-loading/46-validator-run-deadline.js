// A running check's deadline (lib/validator-pool.js runDeadline) is judged one
// turn of the main thread's loop after its timer: what the validator posted,
// and its end, are read first. The deadline is a main-thread timer on the
// wall clock, and timers run before messages, so a pause of the main thread
// longer than the deadline used to count a check that had passed as the
// validator's stall: it was terminated, its answer thrown away, and the module
// took a strike (three quarantine it). And what a refusal says: a validator
// that ended was not timed, and a quarantine names what clears it here.
//
// Nothing here races a clock. A validator of the test's own stands behind a
// slot's real one (its messages and its end go to the pool through the
// pool's own listeners), and sets a shared flag once it has posted its
// answer. The main thread is held on that flag (Atomics.wait), then past the
// request's deadline: the answer is known to be waiting when the loop turns,
// however slow the machine.
const assert = require('assert');
const {Worker} = require('worker_threads');

const SERVICE = 'urn:countinghouse-test:serviceID:s';
const TAKE_MS = 20000;
const turn = () => new Promise((r) => setImmediate(r));

// mode: 'answer' (with `refused`), 'held' (answered once told to, taken[1]),
// 'silent', or 'exit' (it ends, no answer)
const VALIDATOR = `
const {parentPort: port, workerData: {flag, mode, refused}} = require('worker_threads');
const taken = new Int32Array(flag);
const say = () => { Atomics.store(taken, 0, 1); Atomics.notify(taken, 0); };
port.on('message', (m) => {
  if (m.type === 'compile') return port.postMessage({type: 'answer', id: m.id, compiled: true});
  if (m.type !== 'check') return undefined;
  if (mode === 'held') Atomics.wait(taken, 1, 0, 20000);
  if (mode === 'answer' || mode === 'held') port.postMessage({type: 'answer', id: m.id, refused: refused});
  say();
  if (mode === 'exit') process.exit(0);
  return undefined;
});
`;

describe('module-loading 46: a running check\'s deadline', function() {
  this.timeout(120000);
  let ValidatorPool = null;
  let CountinghouseError = null;
  let workerOptions = null;
  const LOG = require('../../lib/logger');
  let logE = null;
  let names = 0;
  const errors = [];
  const ends = [];
  before(() => {
    const options = require('../../lib/cli-options');
    options.setOptions({workerThread: true});
    workerOptions = options.getOptionsForWorker();
    ({ValidatorPool} = require('../../lib/validator-pool'));
    ({CountinghouseError} = require('../../lib/countinghouse-error'));
    logE = LOG.E;
    LOG.E = (e) => { errors.push(String(e && e.message)); return e; };
  });
  // (each test's pool closed with it: never thirteen of them at once)
  afterEach(async () => { for (const end of ends.splice(0)) await end(); });
  after(() => {
    LOG.E = logE;
    require('../../lib/cli-options').setOptions({workerThread: false});
  });

  // A pool of one validator, the test's own behind its slot, and a module of
  // one action in it, compiled there.
  async function poolWith(mode, {timeoutMs = 100, refused = null} = {}) {
    const p = new ValidatorPool({size: 1, timeoutMs, compileMs: 60000, workerOptions});
    let real = null;
    let own = null;
    // (closed whatever happens next: a boot that fails too)
    ends.push(async () => {
      p.close();
      if (real != null) real.removeAllListeners();
      await Promise.all([real, own].map((x) => (x != null ? x.terminate() : null)));
    });
    for (let w = 0; !(p.slots[0].ready && p.spare.ready) && w < 60000; w += 20) await new Promise((r) => setTimeout(r, 20));
    const slot = p.slots[0];
    assert.ok(slot.ready && p.spare.ready, 'the validators booted');
    real = slot.worker;
    const taken = new Int32Array(new SharedArrayBuffer(8));
    own = new Worker(VALIDATOR, {eval: true, workerData: {flag: taken.buffer, mode, refused}});
    for (const event of ['message', 'error', 'exit']) own.on(event, (x) => real.emit(event, x));
    slot.worker = {postMessage: (m, transfer) => own.postMessage(m, transfer), terminate: () => own.terminate(), emit: (...a) => real.emit(...a)};
    const name = `deadline-module-${++names}`;
    const api = {device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};
    const m = {key: `${name}#1`, name};
    p.register(m.key, name, JSON.stringify(api), JSON.stringify({$id: '#/', s: {a: {input: {type: 'object'}, output: {type: 'object'}}}}));
    assert.strictEqual(await p.warm(m.key), null);
    return {p, m, slot, taken, own, respawned: p.respawns.length};
  }
  const check = ({p, m}) => p.check(m.key, SERVICE, 'a', 'output', {output: {}});
  const codeOf = (answer) => (answer == null ? null : answer[0].code);
  const strikes = ({p, m}) => (p.strikes.get(m.name) || []).length;
  const respawns = ({p, respawned}) => p.respawns.length - respawned;
  const said = ({m}) => errors.filter((e) => e.includes(`${m.name}/a: output not validated`));

  // Holds the main thread until the validator has taken the check (and, when
  // it answers, posted its answer), then until the deadline is past. No turn
  // of the loop in between: the timer and the answer are both waiting after.
  function hold({taken}, req) {
    const got = Atomics.wait(taken, 0, 0, TAKE_MS);
    assert.notStrictEqual(got, 'timed-out', `the test's own validator did not take the check within ${TAKE_MS} ms: the machine, not the pool`);
    Atomics.store(taken, 0, 0);
    while (Date.now() <= req.deadlineAt + 20);
  }
  // From the loop's check phase, so that its next phase is the timers': the
  // order a pause of the main thread gives.
  async function paused(w) {
    await turn();
    const pending = check(w);
    assert.ok(w.slot.current != null && w.slot.current.phase === 'run', 'the check runs');
    hold(w, w.slot.current);
    return pending;
  }

  describe('the main thread paused past the deadline', () => {
    it('a check its validator answered meanwhile passes: no strike, no replacement', async () => {
      const w = await poolWith('answer');
      assert.strictEqual(await paused(w), null);
      assert.deepStrictEqual([strikes(w), respawns(w), said(w)], [0, 0, []]);
    });

    it('three such pauses never quarantine the module', async () => {
      const w = await poolWith('answer');
      for (let i = 0; i < 3; i++) assert.strictEqual(await paused(w), null, `pause ${i + 1}`);
      assert.strictEqual(w.p.isQuarantined(w.m.name), false);
      assert.deepStrictEqual([strikes(w), respawns(w)], [0, 0]);
    });

    it('an answer that refuses the value is that refusal, not a timeout', async () => {
      const refused = {fields: CountinghouseError.replyFields(new CountinghouseError('OUTPUT_DATA_VALIDATION_FAIL')), data: null};
      const w = await poolWith('answer', {refused});
      assert.strictEqual(codeOf(await paused(w)), 'OUTPUT_DATA_VALIDATION_FAIL');
      assert.deepStrictEqual([strikes(w), respawns(w)], [0, 0]);
    });

    it('a check started late, answered meanwhile, passes too (it was refused as a wait)', async () => {
      const w = await poolWith('answer', {timeoutMs: 400});
      await turn();
      w.p.servable = () => false;
      const pending = check(w);
      const queued = w.p.queues.get(w.m.key)[0];
      while (Date.now() < queued.queuedAt + 200);   // half its deadline in the queue
      delete w.p.servable;
      w.p.dispatch();
      assert.ok(w.slot.current === queued, 'the check runs');
      hold(w, queued);
      assert.strictEqual(await pending, null);
      assert.deepStrictEqual([strikes(w), respawns(w), said(w)], [0, 0, []]);
    });

    it('one started late that never answers: refused as a wait, and a strike once it has run a full budget', async () => {
      // (its budget is far longer than any pause of the machine's: how much of
      // it has run is what the test says has; the rest is the re-armed timer's)
      const w = await poolWith('silent', {timeoutMs: 600000});
      const pending = check(w);
      const req = w.slot.current;
      req.startedAt = Date.now() - 596000;
      w.p.onDeadline(req);
      assert.strictEqual(codeOf(await pending), 'VALIDATION_TIMEOUT');
      assert.deepStrictEqual([strikes(w), respawns(w)], [0, 0], 'a wait is no strike');
      assert.ok(w.slot.current === req, 'and its validator still has its budget');
      for (let i = 0; respawns(w) === 0 && i < 3000; i++) await new Promise((r) => setTimeout(r, 10));
      assert.deepStrictEqual([strikes(w), respawns(w), said(w).length], [1, 1, 1]);
      assert.match(said(w)[0], /its wait in the queue/);
      assert.ok(errors.some((e) => e.includes(`${w.m.name}/a: output ran past a full budget (its deadline); a strike`)), errors.join('\n'));
    });

    it('one started late, refused as a wait, and answered while the main thread is paused past its full budget: no strike, no replacement', async () => {
      const w = await poolWith('held', {timeoutMs: 600000});
      const pending = check(w);
      const req = w.slot.current;
      req.startedAt = Date.now() - 596000;
      w.p.onDeadline(req);
      assert.strictEqual(codeOf(await pending), 'VALIDATION_TIMEOUT');
      assert.ok(w.slot.current === req, 'its validator has the rest of its budget');
      // from the check phase, as paused(): the re-armed timer and the answer are both waiting after
      await turn();
      Atomics.store(w.taken, 1, 1);
      Atomics.notify(w.taken, 1);
      assert.notStrictEqual(Atomics.wait(w.taken, 0, 0, TAKE_MS), 'timed-out', 'the test\'s own validator did not answer: the machine, not the pool');
      while (Date.now() <= req.startedAt + 600020);
      for (let i = 0; w.slot.current != null && i < 1000; i++) await turn();
      await turn();
      assert.deepStrictEqual([strikes(w), respawns(w), said(w).length], [0, 0, 1]);
      assert.ok(w.slot.current == null && w.p.slots[0] === w.slot, 'the same validator, free again');
      assert.ok(!errors.some((e) => e.includes(`${w.m.name}/a: output ran past a full budget`)), errors.join('\n'));
    });

    it('one that never answers is still failed: refused, one strike, one replacement', async () => {
      const w = await poolWith('silent');
      const answer = await paused(w);
      assert.strictEqual(codeOf(answer), 'VALIDATION_TIMEOUT');
      assert.strictEqual(answer[0].message, `${w.m.name}/a: its output was not validated within 100 ms, so the call was refused`);
      assert.deepStrictEqual([strikes(w), respawns(w), said(w).length], [1, 1, 1]);
      assert.match(said(w)[0], /its deadline/);
    });
  });

  // The validator ends in the turn the deadline is judged in: exactly one
  // answer, at most one strike, one replacement, whatever the order.
  describe('the validator ends in the same turn', () => {
    async function at(drive) {
      const w = await poolWith('silent', {timeoutMs: 60000});
      let answers = 0;
      const pending = check(w).then((a) => { answers++; return a; });
      const req = w.slot.current;
      assert.strictEqual(req.phase, 'run');
      req.startedAt = Date.now() - 60001;   // its full budget has run
      w.p.onDeadline(req);
      drive(w, req);
      const answer = await pending;
      await turn();
      await turn();
      return {answer, answers, strikes: strikes(w), respawns: respawns(w), said: said(w)};
    }

    it('its end, with no answer: refused once, as its end', async () => {
      const r = await at(({slot}) => { slot.worker.emit('exit', 1); });
      assert.deepStrictEqual([codeOf(r.answer), r.answers, r.strikes, r.respawns, r.said.length], ['VALIDATION_TIMEOUT', 1, 1, 1, 1]);
      assert.match(r.said[0], /its end/);
    });

    it('its answer, then its end: the check passes, and the idle slot is replaced', async () => {
      const r = await at(({slot}, req) => {
        slot.worker.emit('message', {type: 'answer', id: req.msg.id, refused: null});
        slot.worker.emit('exit', 0);
      });
      assert.deepStrictEqual([r.answer, r.answers, r.strikes, r.respawns, r.said.length], [null, 1, 0, 1, 0]);
    });

    it('an error and its exit (a memory limit gives both): refused once', async () => {
      const r = await at(({slot}) => { slot.worker.emit('error', new Error('out of memory')); slot.worker.emit('exit', 1); });
      assert.deepStrictEqual([codeOf(r.answer), r.answers, r.strikes, r.respawns, r.said.length], ['VALIDATION_TIMEOUT', 1, 1, 1, 1]);
    });

    it('alive and silent: failed as its deadline, within a turn', async () => {
      const r = await at(() => {});
      assert.deepStrictEqual([codeOf(r.answer), r.answers, r.strikes, r.respawns, r.said.length], ['VALIDATION_TIMEOUT', 1, 1, 1, 1]);
      assert.match(r.said[0], /its deadline/);
    });

    // (whether its end is seen before the deadline is judged or after is the
    // machine's: once either way)
    it('one that really ends while the main thread is paused past the deadline: refused once', async () => {
      const w = await poolWith('exit');
      const ended = new Promise((r) => w.own.once('exit', r));
      const answer = await paused(w);
      await ended;
      await turn();
      assert.strictEqual(codeOf(answer), 'VALIDATION_TIMEOUT');
      assert.deepStrictEqual([strikes(w), respawns(w), said(w).length], [1, 1, 1]);
    });
  });

  // What runDeadline rests on, in this Node.
  describe('the order Node gives', () => {
    it('after a pause: the timer, then the message already posted, then the immediate the timer set', async () => {
      const taken = new Int32Array(new SharedArrayBuffer(4));
      const own = new Worker(VALIDATOR, {eval: true, workerData: {flag: taken.buffer, mode: 'answer', refused: null}});
      try {
        const order = [];
        own.on('message', () => order.push('message'));
        await new Promise((r) => own.once('online', r));
        await turn();
        const due = Date.now() + 1;
        setTimeout(() => { order.push('timer'); setImmediate(() => order.push('immediate')); }, 1);
        own.postMessage({type: 'check', id: 1});
        hold({taken}, {deadlineAt: due});
        for (let i = 0; order.length < 3 && i < 1000; i++) await turn();
        assert.deepStrictEqual(order, ['timer', 'message', 'immediate']);
      } finally {
        await own.terminate();
      }
    });

    it('an answer posted as its worker exits is read before its exit', async () => {
      const own = new Worker('const {parentPort: p} = require("worker_threads"); p.on("message", () => { p.postMessage("answer"); process.exit(0); });', {eval: true});
      const order = [];
      own.on('message', () => order.push('message'));
      const ended = new Promise((r) => own.once('exit', () => { order.push('exit'); r(); }));
      own.postMessage('go');
      await ended;
      await turn();
      assert.deepStrictEqual(order, ['message', 'exit']);
    });
  });

  // `new Worker` can throw (no thread to be had): the options here cannot be
  // cloned, so it really does, at once, with nothing stubbed. fail() used to
  // start the replacement before it refused the request the validator held: a
  // throw there left that request with no answer at all, and the queue
  // unserved. (The error itself goes where it did, to what called fail(): a
  // worker's event, a timer, and the process's own log.)
  describe('the replacement cannot be started', () => {
    const UNCLONEABLE = {f: () => {}};
    const LATE_MS = 10000;
    let handlers = [];
    const uncaught = [];
    beforeEach(() => {
      uncaught.length = 0;
      handlers = process.listeners('uncaughtException');
      process.removeAllListeners('uncaughtException');
      process.on('uncaughtException', (e) => uncaught.push(`${e && e.name}: ${e && e.message}`));
    });
    afterEach(() => {
      process.removeAllListeners('uncaughtException');
      for (const h of handlers) process.on('uncaughtException', h);
    });
    const answered = (pending) => {
      let timer = null;
      return Promise.race([pending, new Promise((r) => { timer = setTimeout(r, LATE_MS, 'no answer'); })]).finally(() => clearTimeout(timer));
    };
    const apiOf = (name) => JSON.stringify({device: {friendlyName: name, serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}});
    const SCHEMAS = JSON.stringify({$id: '#/', s: {a: {input: {type: 'object'}, output: {type: 'object'}}}});
    const notCloned = (e) => e.name === 'DataCloneError';

    // what a validator can hold when it fails: its refusal's code, and what it
    // counts against (the module's strikes and cool-down, or the caller)
    const timeoutOf = (r) => (r != null && r.timeout != null ? r.timeout.code : null);
    const bytes = () => { const u = require('v8').serialize({output: {}}); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
    const OWN = {strikes: 1, cooldown: true, caller: 0};
    const CALLER = {strikes: 0, cooldown: false, caller: 1};
    const NEITHER = {strikes: 0, cooldown: false, caller: 0};
    const HELD = {
      'an output\'s check': {ask: (w) => check(w), code: codeOf, counts: OWN},
      'a hop\'s result (its bytes)': {ask: ({p, m}) => p.checkSerialized(m.key, SERVICE, 'a', 'output', bytes()), code: (r) => codeOf(r.refused), counts: OWN},
      'a load\'s compile': {ask: ({p, m}) => p.warm(m.key), code: timeoutOf, counts: OWN},
      'an input\'s check': {ask: ({p, m}) => p.check(m.key, SERVICE, 'a', 'input', {input: {}}, 'u_caller'), code: codeOf, counts: CALLER},
      'a load\'s safety check': {ask: ({p, m}) => p.safety(m.key), code: timeoutOf, counts: NEITHER},
      'a question': {ask: ({p, m}) => p.question(m.key, '/s/a/input', {}), code: timeoutOf, counts: NEITHER}
    };
    const counts = ({p, m}) => ({strikes: (p.strikes.get(m.name) || []).length, cooldown: p.cooldown.has(m.key), caller: (p.callerStalls.get(`u_caller\n${m.name}`) || []).length});
    // `what` held by the pool's one validator, another module's check behind
    // it, and no thread to be had from here on
    async function held(what, {spareReady = true} = {}) {
      const w = await poolWith('silent', {timeoutMs: 60000});
      const name = `deadline-module-${++names}`;
      const other = `${name}#1`;
      w.p.register(other, name, apiOf(name), SCHEMAS);
      assert.strictEqual(await w.p.warm(other), null);
      w.slot.worker.postMessage = () => {};   // it answers nothing from here on
      let answers = 0;
      const pending = HELD[what].ask(w).then((r) => { answers++; return r; });
      const req = w.slot.current;
      assert.ok(req != null && req.phase === 'run', 'the request runs');
      const behind = w.p.check(other, SERVICE, 'a', 'output', {output: {}});
      const waits = (w.p.queues.get(other) || [])[0];
      assert.ok(waits != null, 'the other module\'s check waits');
      // (their timers are 60 s: none outlives the test)
      ends.push(async () => { clearTimeout(req.timer); clearTimeout(waits.timer); });
      if (!spareReady) w.p.spare.ready = false;
      w.p.workerOptions = UNCLONEABLE;
      const refused = async () => {
        const answer = await answered(pending);
        assert.notStrictEqual(answer, 'no answer', 'the request the validator held was never answered');
        assert.strictEqual(HELD[what].code(answer), 'VALIDATION_TIMEOUT');
        await turn();
        assert.strictEqual(answers, 1);
      };
      // in the same turn, on the validator in its place: not by a timer later
      const servedNow = () => assert.ok(w.p.slots[0] !== w.slot && w.p.slots[0].current === waits, 'the queue was not served at once');
      // (a check of the module's own, so it passes)
      const passes = async () => {
        const answer = await answered(behind);
        assert.notStrictEqual(answer, 'no answer', `the waiting check had no answer within ${LATE_MS} ms on the validator put in its place`);
        assert.strictEqual(answer, null);
      };
      return {w, req, waits, behind, refused, servedNow, passes, answers: () => answers};
    }
    // each error that reached the process, when one did
    const thrown = () => uncaught.splice(0).map((e) => e.split(':')[0]);

    for (const what of Object.keys(HELD)) {
      it(`${what}, its validator ended: refused once and counted once, and the queue is served`, async () => {
        const {w, refused, servedNow, passes} = await held(what);
        assert.throws(() => { w.slot.worker.emit('error', new Error('out of memory')); }, notCloned);
        servedNow();
        assert.deepStrictEqual(counts(w), HELD[what].counts);
        w.slot.worker.emit('exit', 1);
        await refused();
        assert.deepStrictEqual(counts(w), HELD[what].counts);
        await passes();
        assert.deepStrictEqual(thrown(), []);
      });
    }

    it('at its deadline: refused, and the queue is served', async () => {
      const {w, refused, servedNow, passes} = await held('an output\'s check');
      const req = w.slot.current;
      req.startedAt = Date.now() - 60001;   // its full budget has run
      w.p.onDeadline(req);
      await turn();
      await turn();
      servedNow();
      await refused();
      assert.deepStrictEqual([counts(w), said(w).length], [OWN, 1]);
      await passes();
      assert.deepStrictEqual(thrown(), ['DataCloneError']);
    });

    it('one refused as a wait already, its full budget run: its strike is counted', async () => {
      const {w, refused, servedNow, passes} = await held('an output\'s check');
      w.p.onDeadline(w.slot.current);   // started late: refused as a wait, and still held
      await turn();
      await turn();
      await refused();
      assert.deepStrictEqual(counts(w), NEITHER);
      assert.throws(() => { w.slot.worker.emit('exit', 1); }, notCloned);
      servedNow();
      assert.deepStrictEqual(counts(w), OWN);
      await passes();
      assert.deepStrictEqual(thrown(), []);
    });

    it('with no spare ready either: refused', async () => {
      const {w, waits, behind, refused} = await held('an output\'s check', {spareReady: false});
      assert.throws(() => { w.slot.worker.emit('exit', 1); }, notCloned);
      await refused();
      w.p.onDeadline(waits);   // nothing can serve it: its own deadline
      assert.strictEqual(codeOf(await answered(behind)), 'VALIDATION_TIMEOUT');
      assert.deepStrictEqual(thrown(), []);
    });

    // (what the refusal meets is another matter: the place is taken all the same)
    it('a refusal that throws: the validator is replaced and the queue served', async () => {
      const {w, req, servedNow, passes, answers} = await held('an output\'s check');
      w.p.workerOptions = workerOptions;
      const was = LOG.E;
      LOG.E = () => { throw new Error('no log'); };
      try {
        assert.throws(() => { w.slot.worker.emit('exit', 1); }, /^Error: no log$/);
      } finally {
        LOG.E = was;
      }
      servedNow();
      await passes();
      // the refusal that threw answered nothing: the held request's own answer
      // is taken after its log (the old order too; a later row)
      await turn();
      assert.deepStrictEqual([answers(), req.done], [0, false]);
      assert.deepStrictEqual(thrown(), []);
    });

    // (a control: it holds nothing, so its check waits for its own deadline on
    // any order)
    it('one that ended before it was online: a check waiting for it is refused at its deadline', async () => {
      const p = new ValidatorPool({size: 1, timeoutMs: 500, compileMs: 60000, workerOptions});
      const spare = p.spare;
      ends.push(async () => { p.close(); await spare.worker.terminate(); });
      const name = `deadline-module-${++names}`;
      p.register(`${name}#1`, name, apiOf(name), SCHEMAS);
      const pending = p.check(`${name}#1`, SERVICE, 'a', 'output', {output: {}});
      assert.ok(!p.slots[0].ready, 'not online yet');
      p.workerOptions = UNCLONEABLE;
      assert.throws(() => { p.slots[0].worker.emit('exit', 1); }, notCloned);
      assert.strictEqual(codeOf(await answered(pending)), 'VALIDATION_TIMEOUT');
      assert.deepStrictEqual(thrown(), []);
    });
  });

  describe('what the refusals say', () => {
    it('a validator that ended: no time is said', async () => {
      const w = await poolWith('exit', {timeoutMs: 60000});
      const answer = await check(w);
      assert.strictEqual(codeOf(answer), 'VALIDATION_TIMEOUT');
      assert.strictEqual(answer[0].message, `${w.m.name}/a: its output was not validated, because the validator stopped before it answered, so the call was refused`);
    });

    it('a quarantine: why, and what clears it here', async () => {
      const options = require('../../lib/cli-options');
      const sessions = require('../../lib/sessions');
      const heldBack = require('../../lib/held-back');
      const w = await poolWith('answer');
      w.p.quarantined.add(w.m.name);
      const first = `${w.m.name}: its calls are refused, because checking its outputs or compiling its schemas did not finish 3 times in 5 minutes. `;
      const message = async () => { const a = await check(w); assert.strictEqual(codeOf(a), 'VALIDATION_QUARANTINED'); return a[0].message; };
      const was = options.stdio;
      const shared = sessions.shared();
      try {
        options.stdio = false;
        assert.strictEqual(await message(), `${first}Loading the module again clears this.`);
        options.stdio = true;
        assert.strictEqual(await message(), `${first}Restarting your client clears this.`);
        // a shared runtime: a client's restart attaches to the same one
        sessions.sharedForTests(true);
        assert.strictEqual(await message(), `${first}Restarting countinghouse clears this: run \`ch-local restart\` in your own terminal.`);
        // (the launcher ch-local gave is a path under the user's home, and a
        // calling module reads this text: never in it)
        const commandWith = heldBack.commandWith('/home/example/bin/ch-local.js', 'restart');
        const terminalCommand = heldBack.terminalCommand;
        heldBack.terminalCommand = () => commandWith;
        try {
          assert.ok(!(await message()).includes('/home/example'), await message());
        } finally {
          heldBack.terminalCommand = terminalCommand;
        }
      } finally {
        sessions.sharedForTests(shared);
        options.stdio = was;
      }
    });
  });
});
