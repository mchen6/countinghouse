'use strict';
// The Redis runner's listJobs (legacy tasks/list): it asked BullMQ for 50
// jobs of each state across EVERY caller and then kept the caller's own, so a
// caller's tasks dropped out of its list once other callers had 50 newer ones
// (the final pass's gateway part, A9). It now pages on until the caller's 50
// are found or the queue runs out, within a bound on what it reads.
// Server-free: lib/job-control.js's listJobs over a stub queue that pages as
// BullMQ's getJobs(types, start, end, asc) does, per state.
const assert = require('assert');
const options = require('../../lib/cli-options');
const identity = require('../../lib/identity');
const {useIdentity} = require('../helpers/identity-scope');

describe('jobs-local 09: the Redis runner lists a caller\'s own tasks past other callers\' newer ones (A9)', function() {
  this.timeout(20000);
  useIdentity(['mine-key', 'theirs-key']);
  let saved;
  before(() => { saved = options.workerThread; options.workerThread = true; });
  after(() => { options.workerThread = saved; });

  // newest first, as getJobs(..., false) answers: {state: [job]} by state
  function queue(byState) {
    const asked = [];
    return {asked, getJobs(types, start, end) {
      asked.push([start, end]);
      const out = [];
      for (const t of types) out.push(...(byState[t] || []).slice(start, end + 1));
      return Promise.resolve(out);
    }};
  }
  const job = (id, key) => ({id: String(id), name: 'n', data: {ownerId: identity.idForKey(key), deviceID: 'd', serviceID: 's', actionName: 'a'},
    timestamp: 0, getState: () => Promise.resolve('completed'), opts: {}});

  it('a caller with 3 completed tasks behind another caller\'s 60 newer ones lists all 3', async () => {
    const completed = [];
    for (let i = 0; i < 60; i++) completed.push(job(1000 - i, 'theirs-key'));
    for (let i = 0; i < 3; i++) completed.push(job(100 - i, 'mine-key'));
    const jc = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: queue({completed})});
    const list = await new Promise((resolve) => jc.listJobs({appKey: 'mine-key'}, (err, r) => resolve(err != null ? err.code : r)));
    assert.deepStrictEqual(Array.isArray(list) ? list.map((x) => x.job.id) : list, ['100', '99', '98']);
  });

  it('at most 50 of the caller\'s own, and a state is read at most 1000 jobs deep', async () => {
    const completed = [];
    for (let i = 0; i < 120; i++) completed.push(job(5000 - i, 'mine-key'));
    const full = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: queue({completed})});
    const list = await new Promise((resolve) => full.listJobs({appKey: 'mine-key'}, (err, r) => resolve(err != null ? err.code : r)));
    assert.strictEqual(list.length, 50);
    const others = [];
    for (let i = 0; i < 5000; i++) others.push(job(90000 - i, 'theirs-key'));
    const q = queue({completed: others});
    const none = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: q});
    const empty = await new Promise((resolve) => none.listJobs({appKey: 'mine-key'}, (err, r) => resolve(err != null ? err.code : r)));
    assert.deepStrictEqual(empty, []);
    const deepest = Math.max(...q.asked.map(([, end]) => end));
    assert.ok(deepest < 1000, `read to ${deepest}`);
  });

  // (the medium on PR 2) one bound on what one list reads, across every
  // state; and a job seen twice (an offset that moved between pages) listed once
  it('one list reads at most 1000 jobs in all states together, and lists a job once', async () => {
    const others = [];
    for (let i = 0; i < 5000; i++) others.push(job(90000 - i, 'theirs-key'));
    const q = queue({waiting: others, active: others, delayed: others, completed: others, failed: others});
    const jc = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: q});
    await new Promise((resolve) => jc.listJobs({appKey: 'mine-key'}, () => resolve()));
    const read = q.asked.reduce((n, [start, end]) => n + (end - start + 1), 0);
    assert.ok(read <= 1000, `read ${read}`);
    // the same job in two pages (one shifted in between) and two states
    const mine = job(77, 'mine-key');
    const shifting = {asked: [], getJobs(types, start) { this.asked.push(start); return Promise.resolve(start === 0 ? Array.from({length: 49}, (_, i) => job(500 + i, 'theirs-key')).concat([mine]) : start === 50 ? [mine] : []); }};
    const jd = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: shifting});
    const list = await new Promise((resolve) => jd.listJobs({appKey: 'mine-key'}, (err, r) => resolve(r)));
    assert.deepStrictEqual(list.map((x) => x.job.id), ['77']);
  });
});
