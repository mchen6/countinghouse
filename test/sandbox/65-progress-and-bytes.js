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

function worker({rate = 1000, tokens = 1000, progress = 1000} = {}) {
  const posted = [];
  const ended = [];
  const wm = new WorkerMessage({on() {}, postMessage: (m) => posted.push(m), terminate: () => { ended.push(true); return Promise.resolve(); }});
  wm.messageRate = rate;
  wm.rateTokens = tokens;
  wm.rateRefillAt = performance.now();
  wm.progressTokens = progress;
  wm.progressRefillAt = performance.now();
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

describe('sandbox 65: progress messages and a worker\'s bytes, on the main thread (F4-3, F4-4)', () => {
  describe('F4-3: progress spends a bucket of its own', () => {
    it('jobprogress and callprogress with their bucket empty are dropped quietly (counted): no handler, no answer', () => {
      for (const id of ['jobprogress', 'callprogress']) {
        const {wm, posted} = worker({rate: 1, tokens: 1, progress: 0});
        let seen = false;
        wm.on(id, () => { seen = true; });
        wm.onWorkerMessage({id, data: {jobID: 'j1', progress: 5}});
        assert.strictEqual(seen, false, id);
        assert.deepStrictEqual(posted, [], id);
      }
    });

    it('each spends one of its own, never the requests\'; with the requests\' bucket empty, progress still flows', () => {
      const {wm} = worker({rate: 1000, tokens: 0, progress: 10});
      let seen = 0;
      wm.on('jobprogress', () => { seen += 1; });
      wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 5}});
      assert.strictEqual(seen, 1);
      assert.ok(wm.progressTokens < 10 && wm.progressTokens >= 9, String(wm.progressTokens));
      assert.ok(wm.rateTokens < 1, 'the requests\' bucket untouched');
      assert.strictEqual(wm.progressDropped, 0);
      const {wm: empty} = worker({progress: 0});
      empty.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 5}});
      assert.strictEqual(empty.progressDropped + (empty.progressDroppedLoggedAt != null ? 1 : 0) >= 1, true, 'counted');
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
        await tick(400);
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
        await tick(400);
        assert.deepStrictEqual(h.updates.sort(), [[7, 3], ['j1', 100]].sort());
        // and a job whose run ends inside the window gets its last progress all the same (invokeJobs writes it
        // before the run's answer; here the flush, which takes it whatever the run's state)
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 77}});
        wm.jobsInFlight.delete('j1');
        await tick(400);
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
        // a token that is no live run of this job's is the job's own key
        wm.onWorkerMessage({id: 'jobprogress', data: {jobID: 'j1', progress: 90, token: 'made-up'}});
        assert.strictEqual(wm.progressPending.size, 3);
        assert.ok(wm.progressPending.has(DeviceManager.runKey('j1', null)), 'the made-up token is the job\'s');
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
    });

    it('for a job not its own: never reaches the queue, and is logged once for the worker', async () => {
      const {wm} = worker();
      wm.jobsInFlight = new Map([['j1', 1]]);
      const h = handled(wm);
      try {
        for (let n = 0; n < 50; n++) wm.onWorkerMessage({id: 'jobprogress', data: {jobID: `other-${n}`, progress: 1}});
        await tick(400);
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
      await tick(800);
      assert.strictEqual(decoded.length, 6, 'decoded as the budget refilled');
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
        await tick(1200);
        assert.strictEqual(wm.heldCount(), 0, 'all read');
        assert.strictEqual(decoded.length, 2, 'the one after the throw too');
      } finally { LOG.E = savedE; }
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
