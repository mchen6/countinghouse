'use strict';
// #518's high round, at the runner (the local one; BullMQ's shares
// job-control-common's two steps):
//   M1: a miss inside the refill throttle (a refill ran moments ago) waits
//       for a refill that asks the provider, and finds an owner the
//       provider lists -- never "owner removed", which fails the job for
//       good and deletes a scheduler;
//   M2: a session that ends while the owner is being made known (the
//       provider read for a new key) gets no job, as one that ended before
//       the gateway's own check does.
// In child processes, as jobs-local 04: user-auth and lib/auth's
// identitySource stubbed, the provider's reads counted and delayed.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {identityLines} = require('../helpers/identity-scope');

const LIB = path.join(__dirname, '..', '..', 'lib');

function child(body, keys = []) {
  const script = `
    const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
    options.workerThread = true;
    options.mcpToolCallCost = 1;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) => setImmediate(() => cb(null, {}))};
    // the provider lib/auth hands the identity index (its reads counted, delayed)
    const provider = {reads: 0, delayMs: 0, list: [], entries(cb) { this.reads++; setTimeout(() => cb(null, this.list.slice()), this.delayMs); }};
    const libAuth = require.resolve(${JSON.stringify(path.join(LIB, 'auth'))});
    require.cache[libAuth] = {id: libAuth, filename: libAuth, loaded: true, exports: {identitySource: () => provider, getAuthProvider: () => provider}};
    ${identityLines(LIB, keys)}
    const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
    const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
    const {INTERNAL} = require(${JSON.stringify(path.join(LIB, 'job-control-common'))});
    const runner = createRunner({jobTimeoutMs: 0});
    const billed = [];
    runner.initJobProcess({recordCall: (k, t, c, cb) => { billed.push(k); if (cb) cb(null); },
      invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => setImmediate(callback, null, {ok: 1})});
    // the refill throttle's clock: its wait passes at once, its deadline is
    // real (identity.stateForTests().setClock; never a real 5 s wait)
    identity.stateForTests().setClock({now: () => Date.now(), setTimeout: (fn, ms) => (ms <= 5000 ? setImmediate(fn) : setTimeout(fn, ms))});
    const add = (ctx, opts = {name: 'n'}) => new Promise((resolve) => runner.addJob(ctx, opts, 'dev', 'svc', 'act', {}, (err, r) => resolve({err, r})));
    const stateOf = (id) => new Promise((resolve) => runner.getJob(INTERNAL, id, (e, rec) => resolve(rec)));
    (async () => { const out = await (async () => { ${body} })(); process.stdout.write('OUT ' + JSON.stringify(out) + '\\n'); process.exit(0); })()
      .catch((e) => { process.stdout.write('OUT ' + JSON.stringify({thrown: String(e && e.message)}) + '\\n'); process.exit(0); });`;
  const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 40000});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
  assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice(4));
}

describe('jobs-local 07: the owner refill a run waits for, and a session ending during the add (#518\'s high, M1, M2)', function() {
  this.timeout(90000);

  it('M1: an owner missing from the index just after a refill is found by the next one, and the run is billed to it', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-m1', userName: 'o'}];
      // (its run after the owner leaves the index, below)
      const added = await add({appKey: 'owner-m1'}, {name: 'n', delay: 500});
      if (added.err) return {addErr: added.err.code || added.err.message};
      // a refill moments ago (another miss's), then the owner gone from the
      // index -- the provider still lists it
      await identity.freshRefill(provider);
      const readsBefore = provider.reads;
      identity.stateForTests().forget();
      const t0 = Date.now();
      let rec = null;
      while (Date.now() - t0 < 20000) {
        rec = await stateOf(added.r.id);
        if (rec != null && (rec.state === 'completed' || rec.state === 'failed')) break;
        await sleep(50);
      }
      return {state: rec && rec.state, reason: rec && rec.job ? rec.job.failedReason || null : null, billed, askedAgain: provider.reads > readsBefore};`);
    assert.deepStrictEqual(out, {state: 'completed', reason: null, billed: ['owner-m1'], askedAgain: true}, JSON.stringify(out));
  });

  // (the final pass's gateway part, A2) a key rotated under a stable id on a
  // provider with no change signal (sqlite, CouchDB: no reload ran): the index
  // still holds the old key, which auth no longer knows. One refill finds the
  // new key, and the run goes on under it -- never "owner removed", which
  // fails the job for good and deletes a scheduler.
  it('A2: a key rotated under a stable id is found by a refill when the old one is refused, and the run is billed to the new key', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-old', userName: 'o', id: 'stable-o'}];
      await identity.freshRefill(provider);
      const added = await add({appKey: 'owner-old'}, {name: 'n', delay: 500});
      if (added.err) return {addErr: added.err.code || added.err.message};
      // rotated in the provider, the index not rebuilt; auth now refuses the old key
      provider.list = [{apiKey: 'owner-new', userName: 'o', id: 'stable-o'}];
      require.cache[authPath].exports = (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) =>
        setImmediate(() => cb(appKey === 'owner-old' ? Object.assign(new Error('unknown'), {code: 'SYSTEM_ERROR_UNKNOWN_USER'}) : null, {}));
      const readsBefore = provider.reads;
      const t0 = Date.now();
      let rec = null;
      while (Date.now() - t0 < 20000) {
        rec = await stateOf(added.r.id);
        if (rec != null && (rec.state === 'completed' || rec.state === 'failed')) break;
        await sleep(50);
      }
      return {state: rec && rec.state, reason: rec && rec.job ? rec.job.failedReason || null : null, billed, askedAgain: provider.reads > readsBefore};`);
    assert.deepStrictEqual(out, {state: 'completed', reason: null, billed: ['owner-new'], askedAgain: true}, JSON.stringify(out));
  });

  // (A2, at the door) after such a rotation the new key used to get a
  // key-derived id until any rebuild, so the user's own jobs read
  // JOB_NOT_FOUND. A key the provider accepts but the index doesn't hold is
  // made known (identity.know) before user-auth answers: it is indexed under
  // its stable id. A key the provider refuses is still refused.
  it('A2: the rotated key, once authenticated, is its user: the stable id, so it reads, lists and cancels the user\'s own job; a key the provider refuses is still refused', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-old', userName: 'o', id: 'stable-o'}];
      provider.authenticate = function(appKey, deviceID, serviceID, actionName, cb) {
        const e = this.list.find((x) => x.apiKey === appKey);
        setImmediate(() => cb(null, e != null ? {ok: true, userName: e.userName, isAdmin: false} : {ok: false}));
      };
      await identity.freshRefill(provider);
      const stableId = identity.idForKey('owner-old');
      const added = await add({appKey: 'owner-old'}, {name: 'n', delay: 60000});
      if (added.err) return {addErr: added.err.code || added.err.message};
      // rotated in the provider, the index not rebuilt
      provider.list = [{apiKey: 'owner-new', userName: 'o', id: 'stable-o'}];
      delete require.cache[authPath];
      const userAuth = require(authPath);
      const auth = (key) => new Promise((resolve) => userAuth(null, null, 'dev', key, null, null, () => {}, (err) => resolve(err == null ? 'ok' : err.code)));
      const asNew = await auth('owner-new');
      const idNew = identity.idForKey('owner-new');
      const own = await new Promise((resolve) => runner.getJob({appKey: 'owner-new'}, added.r.id, (e, rec) => resolve(e != null ? e.code : (rec != null ? 'found' : null))));
      const listed = await new Promise((resolve) => runner.listJobs({appKey: 'owner-new'}, (e, list) => resolve(e != null ? e.code : (list || []).some((j) => j.job != null && String(j.job.id) === String(added.r.id)))));
      const cancelled = await new Promise((resolve) => runner.removeJob({appKey: 'owner-new'}, 'n', added.r.id, false, (e) => resolve(e != null ? e.code : 'removed')));
      const stranger = await auth('nobody-listed');
      return {asNew, sameId: idNew === stableId, own, listed, cancelled, stranger};`);
    assert.deepStrictEqual(out, {asNew: 'ok', sameId: true, own: 'found', listed: true, cancelled: 'removed', stranger: 'SYSTEM_ERROR_UNKNOWN_USER'}, JSON.stringify(out));
  });

  // (the medium on A2's door, and #526's high, L1/L4) a key the provider
  // authenticates but its listing doesn't show yet gets no key-derived id at
  // the door, and nothing is remembered for it, and asking again before the
  // index changes doesn't wait again. A slow listing holds a request only
  // until the door's timer (injected here) fires, and the refill still lands:
  // the key then has its stable id.
  it('A2\'s door: a lagging key is not remembered and not waited for twice; a slow listing holds the request until the door\'s timer, the refill landing after', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-x', userName: 'x', id: 'stable-x'}];
      provider.authenticate = function(appKey, deviceID, serviceID, actionName, cb) { setImmediate(() => cb(null, {ok: true, userName: 'u', isAdmin: false})); };
      await identity.freshRefill(provider);
      delete require.cache[authPath];
      const userAuth = require(authPath);
      // the door's timer: fired by the test, never by the wall clock
      const pending = [];
      let clockNow = 0;
      userAuth.setDoorClockForTests({setTimeout: (fn) => { pending.push(fn); return pending.length; }, clearTimeout: () => {}, now: () => clockNow});
      const auth = (key) => new Promise((resolve) => userAuth(null, null, 'dev', key, null, null, () => {}, (err) => resolve(err == null ? 'ok' : err.code)));
      // authenticated, not (yet) listed: answered once the refill says so, nothing remembered
      const readsBefore = provider.reads;
      const lagging = await auth('lagging-key');
      const laggingAsked = provider.reads > readsBefore;
      const laggingIndexed = identity.isIndexed('lagging-key');
      // asked again, the index unchanged: no second wait, no second read
      const readsAgain = provider.reads;
      const again = await auth('lagging-key');
      const askedAgain = provider.reads > readsAgain;
      // 30 s later, the index unchanged: the listing is asked again (the
      // medium on #526's round, 1)
      clockNow = 31000;
      const readsLater = provider.reads;
      await auth('lagging-key');
      const askedLater = provider.reads > readsLater;
      // a listing that takes 2 s: the request is answered when the door's timer fires
      provider.delayMs = 2000;
      provider.list = provider.list.concat([{apiKey: 'slow-key', userName: 's', id: 'stable-s'}]);
      let slow = null;
      const slowDone = auth('slow-key').then((r) => { slow = r; });
      for (const t1 = Date.now(); pending.length === 0 && Date.now() - t1 < 10000;) await sleep(5);
      if (pending.length === 0) return {timerNeverArmed: true};
      const beforeTimer = slow;
      pending.shift()();
      await slowDone;
      // the refill lands afterwards: the key is indexed under its stable id
      const t0 = Date.now();
      while (!identity.isIndexed('slow-key') && Date.now() - t0 < 10000) await sleep(20);
      return {lagging, laggingAsked, laggingIndexed, again, askedAgain, askedLater, beforeTimer, slow,
        slowStable: identity.idForKey('slow-key') === identity.idFor({id: 'stable-s'}, 'slow-key')};`);
    assert.deepStrictEqual(out, {lagging: 'ok', laggingAsked: true, laggingIndexed: false, again: 'ok', askedAgain: false, askedLater: true, beforeTimer: null, slow: 'ok', slowStable: true}, JSON.stringify(out));
  });

  // the medium on the round: an owned repeating job whose key does not come
  // back from authorizeRun is refused for good AND its scheduler stops
  it('an owned scheduler whose authorization brings back no key stops, as a final refusal\'s does', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-rep', userName: 'o'}];
      runner.authorizeRun = () => Promise.resolve(null);
      const ctx = {appKey: 'owner-rep'};
      const added = await add(ctx, {name: 'rep', repeat: {every: 1000}});
      if (added.err) return {addErr: added.err.code || added.err.message};
      const t0 = Date.now();
      let rec = null;
      while (Date.now() - t0 < 10000) {
        rec = await stateOf(added.r.id);
        if (rec != null && rec.state === 'failed') break;
        await sleep(50);
      }
      const removed = await new Promise((resolve) => runner.removeJob(ctx, 'rep', null, true, (err) => resolve(err != null ? err.code : 'removed')));
      return {state: rec && rec.state, scheduler: removed, billed};`);
    assert.deepStrictEqual(out, {state: 'failed', scheduler: 'JOB_NOT_FOUND', billed: []}, JSON.stringify(out));
  });

  it('M2: a session that ends while its owner is being made known gets no job', () => {
    const out = child(`
      provider.list = [{apiKey: 'owner-m2', userName: 'o'}];
      provider.delayMs = 400;
      let open = true;
      setTimeout(() => { open = false; }, 100);
      const added = await add({appKey: 'owner-m2', session: 's-m2', stillOpen: () => open});
      const listed = await new Promise((resolve) => runner.listJobs(INTERNAL, (e, list) => resolve(list || [])));
      return {sessionEnded: added.err != null && added.err.sessionEnded === true, code: added.err && added.err.code, jobs: listed.length};`);
    assert.deepStrictEqual(out, {sessionEnded: true, code: 'MODULE_NOT_LISTED', jobs: 0}, JSON.stringify(out));
  });
});
