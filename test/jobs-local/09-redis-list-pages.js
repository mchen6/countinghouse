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

  it('at most 50 of the caller\'s own, and a state is read at most 2000 jobs deep', async () => {
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
    assert.ok(deepest < 2000, `read to ${deepest}`);
  });
});
