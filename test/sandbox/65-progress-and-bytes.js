'use strict';
// The main thread's handling of a worker's progress messages and of its
// bytes (the Fable worker-sandbox pass, F4-3 and F4-4). Module code reaches
// its worker's WorkerMessage (sandbox 14), so nothing here rests on what the
// worker checks:
// - F4-3: jobprogress and callprogress were dispatched before the message
//   limiter, and jobprogress read message.data.jobID unchecked (data null
//   threw into the uncaught log), logged a line per message for a job not
//   the worker's own, and passed any-typed progress to a Redis read and
//   write per message. Now both spend the message rate (dropped quietly past
//   it), jobprogress takes {jobID: string | number, progress: finite 0..100}
//   only and is coalesced per job, and a refused one is logged once per
//   worker. The handlers that read message.data take a null one.
// - F4-4: the limiter ran after the decode, so every message, refused ones
//   too, was deserialised first. Now a module worker's messages are charged
//   against a bytes-per-second budget from the envelope's length, before
//   anything is decoded; past it the worker is ended.
// Server-free.
const assert = require('assert');
require('../../lib/cli-options').setOptions({workerThread: false});
require('../../lib/logger').createLogger();
const WorkerMessage = require('../../lib/worker-message');
const DeviceManager = require('../../lib/device-manager');
const JobControl = require('../../lib/job-control');
const envelope = require('../../lib/message-envelope');
const LOG = require('../../lib/logger');

const {performance} = require('perf_hooks');
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
// until what a case waits for is true, polled, at most `ms` (never a fixed
// sleep a loaded runner can outlast); on the monotonic clock, as the buckets.
// The cases' own timeout (WAIT_TIMEOUT) is above every wait they chain.
const UNTIL_MS = 5000;
const WAIT_TIMEOUT = 30000;
const until = async(test, ms = UNTIL_MS) => {
  const end = performance.now() + ms;
  while (!test() && performance.now() < end) await tick(20);
  return test();
};
// nothing held for a later write, and no flush to come: no write can follow
const noWriteToCome = (wm) => wm.progressFlush == null && (wm.progressPending == null || wm.progressPending.size === 0);

function worker({rate = 1000, tokens = 1000, progress = 1000} = {}) {
  const posted = [];
  const ended = [];
  const wm = new WorkerMessage({on() {}, postMessage: (m) => posted.push(m), terminate: () => { ended.push(true); return Promise.resolve(); }});
  wm.messageRate = rate;
  wm.rateTokens = tokens;
  wm.progressTokens = progress;
  // no refill of the message or the progress bucket during a test: a refillAt
  // ahead of now holds it (lib/worker-message.js), so a loaded runner's clock
  // never adds a token between two lines (the bytes bucket keeps its own)
  wm.rateRefillAt = performance.now() + 60000;
  wm.progressRefillAt = performance.now() + 60000;
  return {wm, posted, ended};
}

// the device manager's handlers on that worker, with JobControl.updateJobProgress and LOG.I observed
function handled(wm) {
  const updates = [];
  const logged = [];
  const saved = {update: JobControl.updateJobProgress, info: LOG.I};
  JobControl.updateJobProgress = (jobID, progress) => updates.push([jobID, progress]);
  LOG.I = (m) => logged.push(String(m));
  DeviceManager.prototype.onWorkerLoaded.call(Object.create(DeviceManager.prototype), wm);
  return {updates, logged, restore: () => { JobControl.updateJobProgress = saved.update; LOG.I = saved.info; }};
}

describe('sandbox 65: progress messages and a worker\'s bytes, on the main thread (F4-3, F4-4)', function() {
  this.timeout(WAIT_TIMEOUT);
  describe('F4-3: progress spends a bucket of its own', () => {
    it('jobprogress spends no bucket at all, the requests\' or the progress one: a final 100 always reaches its handler', () => {
      const {wm} = worker({rate: 1, tokens: 0, progress: 0});
      let seen = 0;
      wm.on('jobprogress', () => { seen += 1; });
      for (let i = 0; i < 5; i++) wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 100}});
      assert.strictEqual(seen, 5);
      assert.strictEqual(wm.rateTokens, 0);
      assert.strictEqual(wm.progressTokens, 0);
    });

    it('callprogress with its bucket empty is dropped quietly (counted); jobprogress always reaches its handler (which bounds the writes)', () => {
      const {wm, posted} = worker({rate: 1, tokens: 1, progress: 0});
      const seen = [];
      wm.on('callprogress', () => seen.push('call'));
      wm.on('jobprogress', () => seen.push('job'));
      wm.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 100}});
      assert.deepStrictEqual(seen, ['job'], 'the last job progress (100) always survives');
      assert.deepStrictEqual(posted, []);
      assert.ok(wm.progressDropped >= 1 || wm.progressDroppedLoggedAt != null, 'the call\'s progress counted as dropped');
    });

    it('each spends one of its own, never the requests\'; with the requests\' bucket empty, progress still flows', () => {
      const {wm} = worker({rate: 1000, tokens: 0, progress: 10});
      let seen = 0;
      wm.on('callprogress', () => { seen += 1; });
      wm.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      assert.strictEqual(seen, 1);
      assert.strictEqual(wm.progressTokens, 9);
      assert.strictEqual(wm.rateTokens, 0, 'the requests\' bucket untouched');
      assert.strictEqual(wm.progressDropped, 0);
      const {wm: empty} = worker({progress: 0});
      empty.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      assert.strictEqual(empty.progressDropped + (empty.progressDroppedLoggedAt != null ? 1 : 0) >= 1, true, 'counted');
    });

    it('the progress bucket refills at the message rate, up to it', () => {
      const {wm} = worker({rate: 10, tokens: 0, progress: 0});
      let seen = 0;
      wm.on('callprogress', () => { seen += 1; });
      wm.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      assert.strictEqual(seen, 0, 'empty, held');
      // half a second's refill at 10 a second: 5 more
      wm.progressRefillAt = performance.now() - 500;
      for (let i = 0; i < 8; i++) wm.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      assert.strictEqual(seen, 5);
      // ten seconds' worth refills no more than the rate (10)
      wm.progressRefillAt = performance.now() - 10000;
      for (let i = 0; i < 20; i++) wm.onWorkerMessage({id: 'callprogress', data: {token: 't', progress: 5}});
      assert.strictEqual(seen, 15);
    });
  });

  describe('F4-3: jobprogress is checked and coalesced', () => {
    it('takes only {jobID: string | number, progress: finite 0..100}; null data does not throw', async () => {
      const {wm} = worker();
      wm.jobsInFlight = new Map([['j1', 1]]);
      const h = handled(wm);
      try {
        for (const data of [null, undefined, 'x', {}, {jobID: {}, progress: 5}, {jobID: 'j1', progress: '50'}, {jobID: 'j1', progress: NaN},
          {jobID: 'j1', progress: 101}, {jobID: 'j1', progress: -1}, {jobID: 'j1', progress: {a: 1}}]) {
          wm.onWorkerMessage({id: 'jobprogress', data});
        }
        assert.ok(noWriteToCome(wm), 'none held, no flush scheduled');
        await tick(300);
        assert.deepStrictEqual(h.updates, []);
      } finally { h.restore(); }
    });

    it('many for its own job reach the queue once, with the latest', async () => {
      const {wm} = worker();
      wm.jobsInFlight = new Map([['j1', 1], ['7', 1]]);
      const h = handled(wm);
      try {
        for (let n = 0; n <= 100; n++) wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: n}});
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 7, progress: 3}});
        assert.ok(await until(() => h.updates.length >= 2 && noWriteToCome(wm)), `the flush ran: ${JSON.stringify(h.updates)}`);
        // and no third: one write per job, and nothing left to write
        assert.deepStrictEqual(h.updates.sort(), [[7, 3], ['j1', 100]].sort());
        // and a job whose run ends inside the window gets its last progress all the same (invokeJobs writes it
        // before the run's answer; here the flush, which takes it whatever the run's state)
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 77}});
        wm.jobsInFlight.delete('j1');
        assert.ok(await until(() => h.updates.some(([j, p]) => j === 'j1' && p === 77)), `the flush ran: ${JSON.stringify(h.updates)}`);
        assert.deepStrictEqual(h.updates.filter(([j]) => j === 'j1').pop(), ['j1', 77]);
      } finally { h.restore(); }
    });

    it('two runs of one job on one worker keep their progress apart (keyed by run); a run\'s end writes its own, bounded', async () => {
      const callTokens = require('../../lib/call-tokens');
      const {wm} = worker();
      wm.workerId = 'w-65';
      wm.jobsInFlight = new Map([['j1', 2]]);
      const runToken = () => callTokens.issue({billingKey: 'k', workerId: 'w-65', jobID: 'j1', ttlMs: 60000});
      const [a, b] = [runToken(), runToken()];
      const h = handled(wm);
      try {
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 30, token: a}});
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 60, token: b}});
        // a token named that is no live run of this job's (a timed-out run's): dropped, never the re-run's
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 99, token: 'made-up'}});
        // no token at all (CHUtil.jobProgress from module code): the job's own key
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 90}});
        assert.strictEqual(wm.progressPending.size, 3);
        assert.ok(wm.progressPending.has(DeviceManager.runKey('j1', null)), 'the tokenless one is the job\'s');
        assert.ok(![...wm.progressPending.values()].some((p) => p.progress === 99), 'the stale token\'s is dropped');
        // run a ends: its own written now, and the job's own; b's left for the flush
        await DeviceManager.runProgressWritten(wm, DeviceManager.runKey('j1', a), 2000);
        assert.deepStrictEqual(h.updates.sort(), [['j1', 30], ['j1', 90]].sort());
        assert.strictEqual(wm.progressPending.size, 1);
      } finally { wm.endWith('MODULE_UNLOADED', 'm', 'test end'); h.restore(); callTokens.drop(a); callTokens.drop(b); }
      // a stalled store: the run's end waits no longer than its bound
      const {wm: w2} = worker();
      w2.jobsInFlight = new Map([['j2', 1]]);
      const h2 = handled(w2);
      JobControl.updateJobProgress = () => new Promise(() => {});
      try {
        w2.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j2', progress: 10}});
        const start = Date.now();
        await DeviceManager.runProgressWritten(w2, DeviceManager.runKey('j2', null), 150);
        assert.ok(Date.now() - start < 1000, 'bounded');
      } finally { w2.endWith('MODULE_UNLOADED', 'm', 'test end'); h2.restore(); }
      // the run's own writer (its processor's Job), when it has one: no read first, and after a write under way
      const {wm: w3} = worker();
      w3.jobsInFlight = new Map([['j3', 1]]);
      const h3 = handled(w3);
      try {
        const order = [];
        let finishFirst;
        JobControl.updateJobProgress = (jobID, p) => new Promise((r) => { finishFirst = () => { order.push(`queue ${p}`); r(); }; });
        w3.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j3', progress: 60}});
        assert.ok(await until(() => typeof finishFirst === 'function'), 'the flush\'s write of 60 is under way');
        w3.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j3', progress: 100}});
        const done = DeviceManager.runProgressWritten(w3, DeviceManager.runKey('j3', null), 2000, (p) => { order.push(`job ${p}`); });
        await tick(20);
        finishFirst();
        await done;
        assert.deepStrictEqual(order, ['queue 60', 'job 100'], 'the last value lands last');
      } finally { w3.endWith('MODULE_UNLOADED', 'm', 'test end'); h3.restore(); }
    });

    it('for a job not its own: never reaches the queue, and is logged once for the worker', async () => {
      const {wm} = worker();
      wm.jobsInFlight = new Map([['j1', 1]]);
      const h = handled(wm);
      try {
        for (let n = 0; n < 50; n++) wm.onWorkerMessage({id: 'jobprogress', data: {jobID: `other-${n}`, progress: 1}});
        assert.ok(noWriteToCome(wm), 'none held, no flush scheduled');
        await tick(300);
        assert.deepStrictEqual(h.updates, []);
        assert.strictEqual(h.logged.filter((l) => /job progress refused/.test(l)).length, 1, h.logged.join('\n'));
      } finally { h.restore(); }
    });
  });

  describe('F4-3: the handlers that read message.data take a null one', () => {
    it('devicelog, rediscommand, getjobinfo and invokeforeignaction answer, and nothing throws', () => {
      const {wm, posted} = worker();
      const h = handled(wm);
      try {
        for (const command of ['devicelog', 'rediscommand', 'getjobinfo', 'invokeforeignaction']) {
          for (const data of [null, 'x']) {
            assert.doesNotThrow(() => wm.onWorkerMessage({id: 11, category: 'child', command, data}), `${command} ${data}`);
          }
        }
        assert.ok(posted.length >= 6, `answered: ${JSON.stringify(posted).slice(0, 400)}`);
      } finally { h.restore(); }
    });
  });

  describe('F4-4: a module worker\'s bytes, before any decode', () => {
    const cap = envelope.capFor(1024 * 1024);
    // about 1 MB each: four fit the budget (4 caps) with a quarter of one left, and the fifth would need
    // 150 ms of refill; the copies are made before any is sent, so sending takes no time to speak of
    const big = () => envelope.wrap({id: 1, category: 'child', command: 'log', data: 'x'.repeat(1000 * 1024)}, cap).envelope;
    const copies = (count) => { const one = big(); return Array.from({length: count}, () => ({b: one.b.slice(0)})); };
    function decoding() {
      const {wm, ended} = worker();
      wm.messageCap = cap;
      const decoded = [];
      wm.onWorkerMessage = (m) => decoded.push(m);
      return {wm, ended, decoded};
    }

    it('past its bytes a second the rest wait undecoded, in order, and are decoded as the budget refills', async () => {
      const {wm, ended, decoded} = decoding();
      for (const e of copies(6)) wm.onEnvelope(e);
      assert.strictEqual(decoded.length, 4, 'a burst of four caps decoded at once');
      assert.strictEqual(wm.heldCount(), 2, 'the rest held, not decoded');
      assert.ok(await until(() => decoded.length === 6), `decoded as the budget refilled (${decoded.length} of 6)`);
      assert.strictEqual(ended.length, 0);
    });

    it('past as much again held, it is ended; what it held is never decoded', () => {
      const {wm, ended, decoded} = decoding();
      const all = copies(20);
      let n = 0;
      while (ended.length === 0 && n < all.length) { wm.onEnvelope(all[n]); n++; }
      assert.strictEqual(ended.length, 1, 'ended');
      assert.strictEqual(decoded.length, 4);
      assert.strictEqual(n, 9, 'four decoded, four held, the ninth ends it');
      assert.match(wm.killReason, /bytes a second of messages, and as much held/);
      assert.strictEqual(wm.heldCount(), 0, 'what it held is dropped');
    });

    it('a carried buffer counts up to the cap: one hop input over it is its own path\'s (INPUT_TOO_LARGE), never the end of the worker; a body over the cap is unwrap\'s to refuse, as before', () => {
      const a = decoding();
      const hop = envelope.wrap({id: 1, category: 'child', command: 'invokeforeignaction', data: {deviceID: 'd'}}, cap).envelope;
      a.wm.onEnvelope({b: hop.b, t: [new ArrayBuffer(5 * cap)]});
      assert.strictEqual(a.ended.length, 0, 'not ended');
      assert.strictEqual(a.decoded.length, 1, 'decoded, for its own path to refuse');
      // a message of any other kind carrying buffers is a tampered worker's
      const c = decoding();
      c.wm.onEnvelope({b: big().b, t: [new ArrayBuffer(16)]});
      assert.strictEqual(c.ended.length, 1);
      assert.match(c.wm.killReason, /carrying buffers it may not/);
      const b = decoding();
      b.wm.onEnvelope({b: new ArrayBuffer(cap + 1)});
      assert.strictEqual(b.ended.length, 1);
      assert.match(b.wm.killReason, /a message of \d+ bytes, over \d+/);
    });

    it('a worker that ends with messages held reads them first: a reply that came is answered as it came', () => {
      const {wm, ended} = worker();
      wm.messageCap = cap;
      const replies = [];
      wm.msgQueue[42] = (err, data) => replies.push(err != null ? err.code : data);
      // the budget spent (as by a burst just now): what comes next is held
      wm.byteTokens = 0;
      wm.byteRefillAt = performance.now();
      wm.onEnvelope(envelope.wrap({id: 42, category: 'reply', data: 'x'.repeat(1000 * 1024)}, cap).envelope);
      assert.strictEqual(wm.heldCount(), 1, 'premise: the reply is held');
      wm.endWith('MODULE_CRASHED', 'm', 'exit code 1');
      assert.deepStrictEqual(replies.map((r) => (typeof(r) === 'string' ? r.length : r)), [1000 * 1024], 'its real reply, not MODULE_CRASHED');
      assert.strictEqual(ended.length, 0);
    });

    it('a held message that throws is its own: the rest are still read', async () => {
      const {wm, decoded} = decoding();
      const realOn = wm.onWorkerMessage;
      wm.onWorkerMessage = (m) => { if (m != null && m.boom === true) throw new Error('boom'); return realOn(m); };
      const savedE = LOG.E;
      LOG.E = () => {};
      try {
        wm.byteTokens = 0;
        wm.byteRefillAt = performance.now();
        const [one, two] = copies(2);
        wm.onEnvelope(one);
        wm.onEnvelope(envelope.wrap({id: 1, category: 'child', command: 'log', data: 'x', boom: true}, cap).envelope);
        wm.onEnvelope(two);
        assert.strictEqual(wm.heldCount(), 3, 'premise: a copy, the throwing one and one after are held');
        assert.ok(await until(() => wm.heldCount() === 0), `all read (${wm.heldCount()} held)`);
        assert.strictEqual(decoded.length, 2, 'the one after the throw too');
      } finally { LOG.E = savedE; }
    });

    it('at most 1024 held, whatever their size: past it the worker is ended', () => {
      const {wm, ended} = decoding();
      wm.byteTokens = 0;
      wm.byteRefillAt = performance.now() + 60000;   // no refill
      const tiny = envelope.wrap({id: 1, category: 'child', command: 'log', data: 'x'}, cap).envelope;
      let n = 0;
      while (ended.length === 0 && n < 5000) { wm.onEnvelope({b: tiny.b.slice(0)}); n++; }
      assert.strictEqual(ended.length, 1);
      assert.strictEqual(n, 1025, 'the 1025th ends it');
    });

    it('budgeted from its spawn (byteBudgeted), before any message rate is set', () => {
      const {wm, ended, decoded} = decoding();
      wm.messageRate = null;
      wm.byteBudgeted = true;
      for (const e of copies(6)) wm.onEnvelope(e);
      assert.strictEqual(decoded.length, 4);
      assert.strictEqual(wm.heldCount(), 2);
      assert.strictEqual(ended.length, 0);
      wm.dropHeld();
    });

    it('a worker ended for anything else (its watchdog, its load\'s timeout) still has what it sent read: a reply is answered', () => {
      const {wm} = worker();
      wm.messageCap = cap;
      const replies = [];
      wm.msgQueue[9] = (err, data) => replies.push(err != null ? err.code : data);
      wm.killReason = 'blocked event loop';
      wm.onEnvelope(envelope.wrap({id: 9, category: 'reply', data: 'done'}, cap).envelope);
      assert.deepStrictEqual(replies, ['done']);
    });

    it('once condemned for what it sent, nothing more of it is read', () => {
      const {wm, decoded} = decoding();
      wm.onEnvelope({b: new ArrayBuffer(cap + 1)});
      assert.ok(wm.killReason != null);
      for (const e of copies(2)) wm.onEnvelope(e);
      assert.strictEqual(decoded.length, 0);
    });

    it('an end reads held replies only until one condemns the worker', () => {
      const {wm} = worker();
      wm.messageCap = cap;
      wm.byteTokens = 0;
      wm.byteRefillAt = performance.now() + 60000;
      const replies = [];
      wm.msgQueue[7] = (err, data) => replies.push(err != null ? err.code : data);
      wm.onEnvelope({b: new Uint8Array([0xff, 0x0f, 0x01]).buffer});   // held; it can't be read
      wm.onEnvelope(envelope.wrap({id: 7, category: 'reply', data: 'after the bad one'}, cap).envelope);
      assert.strictEqual(wm.heldCount(), 2);
      wm.endWith('MODULE_CRASHED', 'm', 'exit');
      assert.deepStrictEqual(replies, ['MODULE_CRASHED'], 'the reply after the condemning one is not read');
    });

    it('a worker with no message rate (not a module\'s) is not budgeted', () => {
      const {wm, ended, decoded} = decoding();
      wm.messageRate = null;
      for (const e of copies(50)) wm.onEnvelope(e);
      assert.strictEqual(ended.length, 0);
      assert.strictEqual(decoded.length, 50);
    });

    it('a message that decodes to null, or to no object, is ignored, never thrown on', () => {
      const {wm} = worker();
      wm.messageCap = cap;
      for (const m of [null, 7, 'x']) assert.doesNotThrow(() => wm.onEnvelope(envelope.wrap(m, cap).envelope), String(m));
    });
  });
});
