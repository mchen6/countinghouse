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

// mode: 'answer' (with `refused`), 'silent', or 'exit' (it ends, no answer)
const VALIDATOR = `
const {parentPort: port, workerData: {flag, mode, refused}} = require('worker_threads');
const taken = new Int32Array(flag);
const say = () => { Atomics.store(taken, 0, 1); Atomics.notify(taken, 0); };
port.on('message', (m) => {
  if (m.type === 'compile') return port.postMessage({type: 'answer', id: m.id, compiled: true});
  if (m.type !== 'check') return undefined;
  if (mode === 'answer') port.postMessage({type: 'answer', id: m.id, refused: refused});
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
    for (let w = 0; !(p.slots[0].ready && p.spare.ready) && w < 60000; w += 20) await new Promise((r) => setTimeout(r, 20));
    const slot = p.slots[0];
    assert.ok(slot.ready && p.spare.ready, 'the validators booted');
    const real = slot.worker;
    const taken = new Int32Array(new SharedArrayBuffer(4));
    const own = new Worker(VALIDATOR, {eval: true, workerData: {flag: taken.buffer, mode, refused}});
    for (const event of ['message', 'error', 'exit']) own.on(event, (x) => real.emit(event, x));
    slot.worker = {postMessage: (m, transfer) => own.postMessage(m, transfer), terminate: () => own.terminate(), emit: (...a) => real.emit(...a)};
    ends.push(async () => { p.close(); real.removeAllListeners(); await Promise.all([real.terminate(), own.terminate()]); });
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
