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
    return {asked, getJobCountByTypes(t) { return Promise.resolve((byState[t] || []).length); }, getJobs(types, start, end) {
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

  it('at most 50 of the caller\'s own, and a state is read at most 200 jobs deep', async () => {
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
    assert.ok(deepest < 200, `read to ${deepest}`);
  });

  // (the medium on PR 2) one bound on what one list reads, across every
  // state; and a job seen twice (an offset that moved between pages) listed once
  it('one list reads at most 200 jobs a state, 1000 in all, and lists a job once', async () => {
    const others = [];
    for (let i = 0; i < 5000; i++) others.push(job(90000 - i, 'theirs-key'));
    const q = queue({waiting: others, active: others, delayed: others, completed: others, failed: others});
    const jc = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: q});
    await new Promise((resolve) => jc.listJobs({appKey: 'mine-key'}, () => resolve()));
    const read = q.asked.reduce((n, [start, end]) => n + (end - start + 1), 0);
    assert.ok(read <= 1000, `read ${read}`);
    assert.ok(q.asked.every(([, end]) => end < 200), JSON.stringify(q.asked.slice(-2)));
    // the same job in two pages (one shifted in between) and two states
    const mine = job(77, 'mine-key');
    const shifting = {asked: [], getJobCountByTypes: () => Promise.resolve(51), getJobs(types, start) { this.asked.push(start); return Promise.resolve(start === 0 ? Array.from({length: 49}, (_, i) => job(500 + i, 'theirs-key')).concat([mine]) : start === 50 ? [mine] : []); }};
    const jd = Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: shifting});
    const list = await new Promise((resolve) => jd.listJobs({appKey: 'mine-key'}, (err, r) => resolve(r)));
    assert.deepStrictEqual(list.map((x) => x.job.id), ['77']);
  });

  // (#531's high, M2) each state its own read bound, master's newest page of
  // every state the floor: 800 of others' completed tasks never hide the
  // caller's failed one; LIST_MAX a state, as master; and a list cut short
  // says so (the third argument), never "no more"
  const list = (q, key = 'mine-key') => new Promise((resolve) => Object.assign(Object.create(require('../../lib/job-control')), {jobQueue: q})
    .listJobs({appKey: key}, (err, r, more) => resolve({err, ids: r != null ? r.map((x) => x.job.id) : null, more})));
  it('a caller\'s failed task behind 800 of others\' completed ones is listed; the cut is said', async () => {
    const completed = [];
    for (let i = 0; i < 800; i++) completed.push(job(50000 - i, 'theirs-key'));
    const got = await list(queue({completed, failed: [job(7, 'mine-key')]}));
    assert.deepStrictEqual(got.ids, ['7']);
    assert.deepStrictEqual(got.more, {truncated: true}, 'completed was read only to its bound');
    const whole = await list(queue({completed: completed.slice(0, 100), failed: [job(7, 'mine-key')]}));
    assert.deepStrictEqual(whole.more, {truncated: false});
    // tasks/list says it: _meta's countinghouse/truncated, only when cut
    const {tasksListResult} = require('../../lib/mcp/gateway');
    assert.deepStrictEqual(tasksListResult([], {truncated: true}), {tasks: [], _meta: {'countinghouse/truncated': true}});
    assert.deepStrictEqual(tasksListResult([], {truncated: false}), {tasks: []});
    assert.deepStrictEqual(tasksListResult([], undefined), {tasks: []}, 'the local runner passes none');
  });
  it('the caller\'s own: 50 a state, as master listed them', async () => {
    const waiting = [];
    const failed = [];
    for (let i = 0; i < 60; i++) { waiting.push(job(3000 - i, 'mine-key')); failed.push(job(2000 - i, 'mine-key')); }
    const got = await list(queue({waiting, failed}));
    assert.strictEqual(got.ids.length, 100);
  });
  // (#531's high, L2) BullMQ drops a job removed mid-read: a short page is
  // not the state's end, its count is
  it('a page one short (a job removed mid-read) does not end the state', async () => {
    const mine = job(9, 'mine-key');
    const q = {getJobCountByTypes: () => Promise.resolve(60), getJobs: (types, start) => Promise.resolve(types[0] !== 'completed' ? [] : start === 0 ? Array.from({length: 49}, (_, i) => job(800 + i, 'theirs-key')) : start === 50 ? [mine] : [])};
    assert.deepStrictEqual((await list(q)).ids, ['9']);
  });
  // (the medium on #531's round, 4) cut only when one of the caller's is
  // left out: exactly 50 of its own is the whole list
  it('exactly 50 of the caller\'s own is no cut; 51 is', async () => {
    const own = (n) => Array.from({length: n}, (_, i) => job(4000 - i, 'mine-key'));
    assert.deepStrictEqual((await list(queue({failed: own(50).concat([job(1, 'theirs-key')])}))).more, {truncated: false});
    assert.deepStrictEqual((await list(queue({failed: own(51)}))).more, {truncated: true});
  });
  // (the medium on #531's round, 3) a state that changed while it was read
  // (a count that moved, a page come back short) may have hidden one: said
  it('a state that changed while it was read is said to be cut', async () => {
    let counts = 0;
    const grew = {getJobCountByTypes: (t) => Promise.resolve(t === 'completed' ? (counts++ === 0 ? 60 : 62) : 0),
      getJobs: (types, start) => Promise.resolve(types[0] !== 'completed' ? [] : Array.from({length: Math.min(50, 60 - start)}, (_, i) => job(900 - start - i, 'theirs-key')))};
    assert.deepStrictEqual((await list(grew)).more, {truncated: true}, 'the count moved');
    const short = {getJobCountByTypes: (t) => Promise.resolve(t === 'completed' ? 60 : 0),
      getJobs: (types, start) => Promise.resolve(types[0] !== 'completed' ? [] : Array.from({length: start === 0 ? 49 : 10}, (_, i) => job(700 - start - i, 'theirs-key')))};
    assert.deepStrictEqual((await list(short)).more, {truncated: true}, 'a page short');
  });
});
