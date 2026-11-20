'use strict';
// MCP completeness M22, server free: the task-ask record (lib/task-asks.js)
// a task's question is held in, on the local store's kv, and the local job
// runner's passes around it. The record's answer is taken once (a
// compare-and-set); a refused answer asks the same question again under a
// new key, and three rounds with none make it unavailable; a question waits
// at most its time, then the task reads failed ASK_EXPIRED; at most so many
// tasks of an owner's, and in all, wait at once; the record keeps the
// session's hash, never its id. The pass that asks is not billed and spends
// no attempt; the run again keeps the job's session and is billed once.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LocalKv = require('../../lib/local-kv');
const taskAsks = require('../../lib/task-asks');
const moduleAsk = require('../../lib/module-ask');
const {CountinghouseError} = require('../../lib/countinghouse-error');

const KEY = 'k'.repeat(43);
const SESSION = 'a'.repeat(32);
const SCHEMA = {type: 'object', properties: {yes: {type: 'boolean'}}, required: ['yes']};
// who asked, as the main thread holds it: its question declared, its form's
// schema, and the form's check of an answer
const ofAsker = () => ({declared: (name) => (name === 'confirm' ? {schema: '/svc/act/questions/confirm'} : null),
  form: (pointer, content) => (content === undefined ? {schema: SCHEMA} : {schema: SCHEMA, valid: content != null && typeof(content.yes) === 'boolean'})});
// a pass's state as it ends on its question
function asking(state = moduleAsk.newState({askable: true, shownAs: 'm'})) {
  state.pending = {key: KEY, question: 'confirm', text: 'm: Do it?', schema: '/svc/act/questions/confirm', asker: {deviceID: 'd', serviceID: 's', actionName: 'a'}, module: 'm'};
  return state;
}
const id = () => `t-${crypto.randomBytes(16).toString('hex')}`;
// a shared runtime's scope rule (lib/session-scope.js reads the mode at
// each check): there, only the task's own session sees its question
async function inSharedMode(fn) {
  const sessions = require('../../lib/sessions');
  const shared = sessions.shared;
  sessions.shared = () => true;
  try { return await fn(); } finally { sessions.shared = shared; }
}

describe('questions 08: a task\'s question, held on the server (M22)', function() {
  // each case's records are removed even when it fails, so the next one's
  // caps start empty
  const made = new Set();
  afterEach(async () => { for (const t of made) await taskAsks.remove(t); made.clear(); });
  this.timeout(20000);
  let dir = null;
  let kv = null;
  let now = 0;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-questions-06-'));
    now = Date.now();
    kv = new LocalKv({storePath: dir, now: () => now});
    taskAsks.configure({kv: () => kv, now: () => now, maxPerOwner: 3, maxTotal: 5});
  });
  after(() => {
    taskAsks.configure({kv: () => require('../../lib/store').getStore().kv, now: () => Date.now(), maxPerOwner: taskAsks.MAX_PER_OWNER, maxTotal: taskAsks.MAX_TOTAL});
    if (kv != null) clearInterval(kv.timer);
    if (dir != null) fs.rmSync(dir, {recursive: true, force: true});
  });
  const ask = (taskId, opts = {}) => made.add(taskId) && taskAsks.asked(taskId, opts.state || asking(), {owner: opts.owner || 'owner-1', session: opts.session === undefined ? SESSION : opts.session, ofAsker});

  // F2-5: capabilities are per request in 2026-07-28: a waiting task's form goes only to a poll that declared form
  it('tasks/get hands a waiting task\'s form only to a request that declared form elicitation (F2-5)', async () => {
    const t = id();
    await ask(t);
    const gateway = require('../../lib/mcp/gateway');
    const record = {state: 'completed', job: {id: t, timestamp: now - 1000, finishedOn: now - 500, data: {era: 'modern', asks: true, asking: 1}}};
    const without = await gateway.modernTaskView(record, null, {session: SESSION}, {form: false});
    assert.strictEqual(without.status, 'input_required');
    assert.match(without.statusMessage, /form elicitation declared/, 'it says what the poll lacks');
    assert.deepStrictEqual(without.inputRequests, {}, 'no form for a poll that cannot show one (the schema\'s map, empty)');
    const unsaid = await gateway.modernTaskView(record, null, {session: SESSION});
    assert.deepStrictEqual(unsaid.inputRequests, {}, 'and none when nothing is said (fails closed)');
    const withForm = await gateway.modernTaskView(record, null, {session: SESSION}, {form: true});
    assert.deepStrictEqual(withForm.inputRequests, {q1: {method: 'elicitation/create', params: {mode: 'form', message: 'm: Do it?', requestedSchema: SCHEMA}}});
  });

  it('the pass that asks: the record holds the form under q1, the session\'s hash and never its id; the task reads input_required', async () => {
    const t = id();
    const r = await ask(t);
    assert.deepStrictEqual(r, {asked: {round: 1, askedBy: {module: 'm', action: 'a', question: 'confirm'}}});
    const raw = await new Promise((resolve) => kv.get(`task-ask:${t}`, (e, v) => resolve(v)));
    assert.ok(!raw.includes(SESSION), 'the raw session id is never kept');
    assert.strictEqual(JSON.parse(raw).session, crypto.createHash('sha256').update(SESSION).digest('hex'));
    assert.deepStrictEqual(await taskAsks.view(t, SESSION), {status: 'input_required', statusMessage: 'waiting for an answer',
      inputRequests: {q1: {method: 'elicitation/create', params: {mode: 'form', message: 'm: Do it?', requestedSchema: SCHEMA}}}});
    // outside shared mode the owner key decides, as findModernTask's rule;
    // in shared mode another session sees no question
    assert.strictEqual((await taskAsks.view(t, 'b'.repeat(32))).status, 'input_required');
    await inSharedMode(async () => {
      assert.strictEqual((await taskAsks.view(t, SESSION)).status, 'input_required');
      assert.deepStrictEqual(await taskAsks.view(t, 'b'.repeat(32)), {status: 'working'});
      assert.deepStrictEqual(await taskAsks.view(t, null), {status: 'working'});
    });
    await taskAsks.remove(t);
  });

  it('an answer is taken once: two raced on the waiting key, one runs the task again and the other is ignored', async () => {
    const t = id();
    await ask(t);
    const got = await Promise.all([taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}),
      taskAsks.answer(t, {q1: {action: 'accept', content: {yes: false}}}, {session: SESSION, ofAsker})]);
    assert.deepStrictEqual(got.sort(), ['ignored', 'rerun']);
    assert.strictEqual(await taskAsks.take(t, 'q1'), null, 'nothing waits now');
    const r = await taskAsks.get(t);
    assert.strictEqual(r.pending, null);
    assert.ok([true, false].includes(r.answers[KEY].yes));
    // the run again starts with that answer
    const run = await taskAsks.forRun(t, {asks: true, asking: true, owner: 'owner-1', shownAs: 'm'});
    assert.deepStrictEqual(run.state.answers.get(KEY), r.answers[KEY]);
    await taskAsks.remove(t);
  });

  it('take is a compare-and-set: of two raced takes of the waiting key, one gets the record and the other nothing', async () => {
    const t = id();
    await ask(t);
    const got = await Promise.all([taskAsks.take(t, 'q1'), taskAsks.take(t, 'q1')]);
    assert.deepStrictEqual(got.map((r) => (r == null ? null : r.pending.reqKey)).sort(), [null, 'q1']);
    assert.strictEqual((await taskAsks.get(t)).pending, null);
    assert.strictEqual(await taskAsks.take(t, 'q1'), null);
  });

  it('keys not waiting, another session\'s answer, and a missing response are ignored, the question still waiting', async () => {
    const t = id();
    await ask(t);
    for (const responses of [{q2: {action: 'accept', content: {yes: true}}}, {'q1-x': {action: 'decline'}}, {}, null, {q1: 'accept'}]) {
      assert.strictEqual(await taskAsks.answer(t, responses, {session: SESSION, ofAsker}), 'ignored', JSON.stringify(responses));
    }
    await inSharedMode(async () => {
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: 'b'.repeat(32), ofAsker}), 'ignored');
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: null, ofAsker}), 'ignored');
    });
    assert.strictEqual((await taskAsks.get(t)).pending.reqKey, 'q1');
    // a decline: the handler is given null
    assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'decline'}}, {session: SESSION, ofAsker}), 'rerun');
    assert.strictEqual((await taskAsks.get(t)).answers[KEY], null);
    await taskAsks.remove(t);
  });

  // the bounds a task's question is held within, by value (M18's pins, the
  // security model's table): the caps, the wait, and the answers' bytes
  it('the bounds, by value: 64 of an owner\'s waiting tasks, 10,000 in all, an hour\'s wait, 8 KiB of answers', () => {
    assert.deepStrictEqual([taskAsks.MAX_PER_OWNER, taskAsks.MAX_TOTAL, taskAsks.WAIT_MS], [64, 10000, 60 * 60 * 1000]);
    // the bound the record enforces, and the call's request state's, one value
    assert.deepStrictEqual([taskAsks.MAX_ANSWERS_BYTES, require('../../lib/request-state').MAX_ANSWERS_BYTES], [8 * 1024, 8 * 1024]);
  });

  it('answers of 8 KiB run the task again; a byte more is no answer: the same question under a new key, a round on', async () => {
    // the settled answers as the record keeps them, {<question key>: content}
    const sized = (n) => {
      const content = {yes: true, pad: ''};
      content.pad = 'x'.repeat(n - Buffer.byteLength(JSON.stringify({[KEY]: content}), 'utf8'));
      assert.strictEqual(Buffer.byteLength(JSON.stringify({[KEY]: content}), 'utf8'), n);
      return content;
    };
    const over = id();
    await ask(over);
    assert.strictEqual(await taskAsks.answer(over, {q1: {action: 'accept', content: sized(8 * 1024 + 1)}}, {session: SESSION, ofAsker}), 'asked');
    const r = await taskAsks.get(over);
    assert.deepStrictEqual([r.pending.reqKey, r.pending.round, r.answers], ['q2', 2, {}]);
    const within = id();
    await ask(within);
    assert.strictEqual(await taskAsks.answer(within, {q1: {action: 'accept', content: sized(8 * 1024)}}, {session: SESSION, ofAsker}), 'rerun');
    // the answers kept are exactly the bound
    assert.strictEqual(Buffer.byteLength(JSON.stringify((await taskAsks.get(within)).answers), 'utf8'), 8 * 1024);
  });

  it('content its schema refuses: the same question under a new key, a round on; after the third, unavailable and run again', async () => {
    const t = id();
    await ask(t);
    assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: 'no'}}}, {session: SESSION, ofAsker}), 'asked');
    let r = await taskAsks.get(t);
    assert.deepStrictEqual([r.pending.reqKey, r.pending.round, r.callRounds], ['q2', 2, 2]);
    assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}), 'ignored', 'the old key is stale');
    assert.strictEqual(await taskAsks.answer(t, {q2: {action: 'accept', content: {}}}, {session: SESSION, ofAsker}), 'asked');
    assert.strictEqual(await taskAsks.answer(t, {q3: {action: 'accept'}}, {session: SESSION, ofAsker}), 'rerun');
    r = await taskAsks.get(t);
    assert.deepStrictEqual([r.pending, r.unavailable, r.answers], [null, [KEY], {}]);
    // the run again: its ctx.ask of that question is ASK_UNAVAILABLE
    const run = await taskAsks.forRun(t, {asks: true, asking: true, owner: 'owner-1', shownAs: 'm'});
    assert.ok(run.state.unavailable.has(KEY));
    await taskAsks.remove(t);
  });

  it('a task past its rounds in all (eight) is asked nothing more: its next question is unavailable, and the run starts again', async () => {
    const t = id();
    const state = asking();
    state.callRounds = moduleAsk.MAX_CALL_ROUNDS;
    assert.deepStrictEqual(await ask(t, {state}), {rerun: true});
    assert.deepStrictEqual((await taskAsks.get(t)).unavailable, [KEY]);
    await taskAsks.remove(t);
  });

  it('a question past its wait: the task reads expired, an answer is ignored, and a run started again runs nothing', async () => {
    const t = id();
    await ask(t);
    now += taskAsks.WAIT_MS + 1;
    try {
      assert.deepStrictEqual(await taskAsks.view(t, SESSION), {expired: true});
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}), 'ignored');
      assert.deepStrictEqual(await taskAsks.forRun(t, {asks: true, asking: true, owner: 'owner-1', shownAs: 'm'}), {skip: true});
      // and as tasks/get answers it: failed, -32603, ASK_EXPIRED
      const gateway = require('../../lib/mcp/gateway');
      const view = await gateway.modernTaskView({state: 'completed', job: {id: t, timestamp: now - 1000, finishedOn: now - 500, data: {era: 'modern', asks: true, asking: 1}}}, null, {session: SESSION});
      assert.deepStrictEqual([view.status, view.error.code, view.error.data['countinghouse/code'], view.statusMessage], ['failed', -32603, 'ASK_EXPIRED', 'ASK_EXPIRED'], JSON.stringify(view));
      assert.ok(view.result === undefined);
    } finally {
      now -= taskAsks.WAIT_MS + 1;
    }
    await taskAsks.remove(t);
  });

  it('at most so many of an owner\'s tasks wait at once, and so many in all: one more is unavailable at once (#487\'s high, round 1)', async () => {
    const mine = [id(), id(), id()];
    for (const t of mine) assert.ok((await ask(t)).asked != null);
    // the owner is full: a new task of its starts with no one to ask, and a
    // pass that asks anyway finds no room -- unavailable, a round, and the
    // run starts again at once (as on master; the wait for room is cut)
    assert.deepStrictEqual(await taskAsks.forRun(id(), {asks: true, asking: false, owner: 'owner-1', shownAs: 'm'}), {state: null});
    const later = id();
    assert.deepStrictEqual(await ask(later), {rerun: true});
    assert.deepStrictEqual([(await taskAsks.get(later)).callRounds, (await taskAsks.get(later)).unavailable], [1, [KEY]]);
    // another owner still may, up to the total (5)
    const theirs = [id(), id()];
    for (const t of theirs) assert.ok((await ask(t, {owner: 'owner-2'})).asked != null);
    assert.deepStrictEqual(await ask(id(), {owner: 'owner-3'}), {rerun: true}, 'the total is reached');
    // answered or removed, a task no longer counts
    assert.strictEqual(await taskAsks.answer(mine[0], {q1: {action: 'decline'}}, {session: SESSION, ofAsker}), 'rerun');
    assert.ok((await ask(id(), {owner: 'owner-3'})).asked != null);
    for (const t of mine.concat(theirs)) await taskAsks.remove(t);
  });

  // (#487's high, round 1: a record that can't be read -- the store failed --
  // rejects, in forRun and asked alike: never a fresh record, whose counts
  // would start over)
  it('a record that can\'t be read rejects forRun and asked, never a fresh record', async () => {
    const broken = {get: (k, cb) => setImmediate(cb, new Error('store down'))};
    const t = id();
    taskAsks.configure({kv: () => broken});
    try {
      await assert.rejects(taskAsks.forRun(t, {asks: true, asking: true, owner: 'owner-r', shownAs: 'm', rerun: true}), /store down/);
      await assert.rejects(taskAsks.asked(t, asking(), {owner: 'owner-r', session: null, ofAsker}), /store down/);
      // (a task that can never ask -- not asking, or questions off -- reads
      // nothing: the store's failure never fails it; #487's high, round 2)
      assert.deepStrictEqual(await taskAsks.forRun(t, {asks: false, asking: false, owner: 'owner-r', shownAs: 'm'}), {state: null});
    } finally {
      taskAsks.configure({kv: () => kv});
    }
  });

  // the review of #374: L1, L2, L3 (each a function of the kv it runs on, so
  // the Redis store's scripts run them too, below)
  const reviewCases = (label) => {
    it(`${label}an answer before the asking pass has completed is ignored, and the question still waits (L1)`, async () => {
      const t = id();
      await ask(t);
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker, held: false}), 'ignored');
      assert.strictEqual((await taskAsks.get(t)).pending.reqKey, 'q1');
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}), 'rerun');
    });

    it(`${label}a task cancelled during its asking pass: its record goes, and its slot (L2)`, async () => {
      const t = id();
      made.add(t);
      const r = await taskAsks.asked(t, asking(), {owner: 'owner-l2', session: SESSION, ofAsker, cancelled: () => Promise.resolve(true)});
      assert.deepStrictEqual(r, {cancelled: true});
      assert.strictEqual(await taskAsks.get(t), null);
      // its slot is free: three more of that owner's may wait (the cap is 3)
      const more = [id(), id(), id()];
      for (const m of more) assert.ok((await ask(m, {owner: 'owner-l2'})).asked != null);
    });

    it(`${label}the caps hold under concurrent asks: of five of one owner's at once, three wait (L3)`, async () => {
      const five = [id(), id(), id(), id(), id()];
      const got = await Promise.all(five.map((t) => ask(t, {owner: 'owner-l3'})));
      assert.deepStrictEqual([got.filter((r) => r.asked != null).length, got.filter((r) => r.rerun === true).length], [3, 2], JSON.stringify(got));
    });
  };
  reviewCases('');

  // F2-2 (a security pass on asks and tasks): a question no form can be
  // shown for, asked with another value each pass (so another key), counted
  // no round, and the task re-ran for ever, unbilled. Each such pass is a
  // round of the task's now: past its rounds, the handler's ctx.ask is
  // ASK_UNAVAILABLE at once (module-ask's own decide), and it stops asking.
  it('a question no form can be shown for, asked with another value each pass, stops within the task\'s rounds (module-ask\'s decide)', async () => {
    const t = id();
    made.add(t);
    const spec = {device: {serviceList: {s: {actionList: [{name: 'a', questions: {confirm: {message: 'Go {v}?', schema: '/s/a/questions/confirm'}}}]}}}};
    let passes = 0;
    let stopped = null;
    for (; passes < 4 * moduleAsk.MAX_CALL_ROUNDS; passes++) {
      const run = await taskAsks.forRun(t, {asks: true, asking: passes > 0, owner: 'owner-8', shownAs: 'm'});
      assert.ok(run.state != null, JSON.stringify(run));
      try {
        moduleAsk.decide({state: run.state, module: 'm', deviceID: 'd', serviceID: 's', actionName: 'a', spec}, 'confirm', {v: String(passes)});
      } catch (e) {
        if (e.code === 'ASK_UNAVAILABLE') { stopped = e.code; break; }
        assert.strictEqual(e.code, 'ASK_PENDING');
      }
      assert.deepStrictEqual(await taskAsks.asked(t, run.state, {owner: 'owner-8', session: null, ofAsker: () => null}), {rerun: true});
    }
    assert.strictEqual(stopped, 'ASK_UNAVAILABLE', `still asking after ${passes} passes`);
    assert.strictEqual(passes, moduleAsk.MAX_CALL_ROUNDS);
    assert.ok((await taskAsks.get(t)).unavailable.length <= moduleAsk.MAX_CALL_ROUNDS, 'the record grows no further');
  });

  it('a pass of a run started again within itself whose record is missing asks afresh; an answered run\'s still runs nothing', async () => {
    const fresh = await taskAsks.forRun(id(), {asks: true, asking: true, owner: 'owner-r', shownAs: 'm', rerun: true});
    assert.ok(fresh.skip !== true && moduleAsk.isState(fresh.state), JSON.stringify(fresh));
    assert.deepStrictEqual([fresh.state.unavailable.size, fresh.state.callRounds || 0], [0, 0]);
    assert.deepStrictEqual(await taskAsks.forRun(id(), {asks: true, asking: true, owner: 'owner-r', shownAs: 'm'}), {skip: true, gone: true});
  });

  // (#487's high, round 1: no room is unavailable at once and spends a
  // round, so a handler that asks under another key each pass, never given
  // room, is bounded too: eight rounds, and nothing more is asked)
  it('a handler changing its question\'s key each pass, never given room, is bounded: a round each pass, eight in all', async () => {
    const owner = 'owner-keys';
    for (let i = 0; i < 3; i++) await ask(id(), {owner});
    const t = id();
    made.add(t);
    for (let round = 1; round <= 8; round++) {
      const state = asking();
      state.pending.key = `${'k'.repeat(42)}${round}`;
      assert.deepStrictEqual(await taskAsks.asked(t, state, {owner, session: null, ofAsker}), {rerun: true});
      assert.strictEqual((await taskAsks.get(t)).callRounds, round);
    }
    // past its eight rounds: its next pass asks nothing, a new key's
    // question too (module-ask's own decide)
    const next = await taskAsks.forRun(t, {asks: true, asking: true, owner, shownAs: 'm'});
    assert.strictEqual(next.state.callRounds, 8);
    const spec = {device: {serviceList: {s: {actionList: [{name: 'a', questions: {confirm: {message: 'Go {v}?', schema: '/s/a/questions/confirm'}}}]}}}};
    const decided = (state) => { try { moduleAsk.decide({state, module: 'm', deviceID: 'd', serviceID: 's', actionName: 'a', spec}, 'confirm', {v: 'ninth'}); return 'answered'; } catch (e) { return e.code; } };
    // (a control: the same question one round short still asks)
    const short = await taskAsks.forRun(t, {asks: true, asking: true, owner, shownAs: 'm'});
    short.state.callRounds = moduleAsk.MAX_CALL_ROUNDS - 1;
    assert.deepStrictEqual([decided(short.state), decided(next.state)], ['ASK_PENDING', 'ASK_UNAVAILABLE']);
  });

  it('a form that can\'t be shown (its asker gone): unavailable, and the run starts again', async () => {
    const t = id();
    assert.deepStrictEqual(await taskAsks.asked(t, asking(), {owner: 'owner-9', session: null, ofAsker: () => null}), {rerun: true});
    assert.deepStrictEqual((await taskAsks.get(t)).unavailable, [KEY]);
    await taskAsks.remove(t);
  });

  it('a part asks from inside a task (M14): its question is the task\'s, held with the part as who asked, and its answer reaches the part on the run again', async () => {
    const callTokens = require('../../lib/call-tokens');
    const questions = require('../../lib/module-questions');
    const OUTER = {module: 'pack', deviceID: 'dev-outer', serviceID: 'urn:countinghouse-test:serviceID:packService', actionName: 'run'};
    const PART = {module: 'part', deviceID: 'dev-part', serviceID: 'urn:countinghouse-test:serviceID:partService', actionName: 'store'};
    const PART_SPEC = {device: {serviceList: {[PART.serviceID]: {actionList: [{name: PART.actionName, questions: {overwrite: {message: 'Replace {id}?', schema: '/partService/store/questions/overwrite'}}}]}}}};
    const partAsker = (asker) => (asker.deviceID === PART.deviceID ? {declared: (name) => (name === 'overwrite' ? {schema: '/partService/store/questions/overwrite'} : null),
      form: (pointer, content) => (content === undefined ? {schema: SCHEMA} : {schema: SCHEMA, valid: content != null && typeof(content.yes) === 'boolean'})} : null);
    const t = id();
    made.add(t);
    const issued = [];
    // one run of the task: its token as invokeJobs issues it (the job's,
    // with the task's ask state), and a hop under it to the part, which asks
    const runOnce = async () => {
      const {state} = await taskAsks.forRun(t, {asks: true, asking: (await taskAsks.get(t)) != null, owner: 'owner-p', shownAs: OUTER.module});
      const top = callTokens.issue({billingKey: 'k', module: OUTER.module, workerId: 'w-pack', deviceID: OUTER.deviceID, jobID: t, serviceID: OUTER.serviceID, actionName: OUTER.actionName, ask: state});
      const part = callTokens.issue({billingKey: 'k', module: PART.module, workerId: 'w-part', deviceID: PART.deviceID, serviceID: PART.serviceID, actionName: PART.actionName, parent: top});
      issued.push(top, part);
      try {
        return {state, answer: moduleAsk.answer({token: part, name: 'overwrite', values: {id: 'a.txt'}}, 'w-part', PART_SPEC, PART.module)};
      } catch (e) {
        return {state, error: e};
      }
    };
    try {
      const first = await runOnce();
      assert.strictEqual(first.error && first.error.code, 'ASK_PENDING');
      assert.deepStrictEqual((await taskAsks.asked(t, first.state, {owner: 'owner-p', session: null, ofAsker: partAsker})).asked.askedBy, {module: 'part', action: 'store', question: 'overwrite'});
      const held = (await taskAsks.get(t)).pending;
      // the dialog names the listed module, never the part
      assert.deepStrictEqual([held.text, held.asker, held.qKey], ['pack: Replace a.txt?', {deviceID: PART.deviceID, serviceID: PART.serviceID, actionName: PART.actionName},
        questions.keyOf({module: 'part', serviceID: PART.serviceID, action: PART.actionName, question: 'overwrite', text: 'pack: Replace a.txt?'})]);
      // the answer is checked against the part's own form
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: null, ofAsker: partAsker}), 'rerun');
      assert.deepStrictEqual((await runOnce()).answer, {yes: true});
    } finally {
      for (const tok of issued) callTokens.drop(tok);
    }
  });

  // (#487's high, round 1: the gateway's own before hook -- a run started
  // again reads the task's tombstone after its record, and a read that
  // fails, either, rejects: never a run as if nothing were known)
  describe('the gateway\'s before hook', () => {
    const tombstones = require('../../lib/task-tombstones');
    const options = require('../../lib/cli-options');
    let savedGet;
    let saved;
    before(() => { savedGet = tombstones.get; saved = {moduleQuestions: options.moduleQuestions}; options.moduleQuestions = true; });
    after(() => { tombstones.get = savedGet; Object.assign(options, saved); });
    // (no module loaded: the hook's target lookup finds none)
    const cdif = {deviceManager: {getAllDeviceSpecs: () => ({})}};
    const beforeOf = (jobData, t, run) => require('../../lib/mcp/gateway').jobHooks(cdif).ask.before(jobData, t, run);
    const jobData = {era: 'modern', asks: true, asking: 1, deviceID: 'd', serviceID: 's', actionName: 'a'};
    it('a run started again for a task cancelled meanwhile (its tombstone) runs nothing: {skip, cancelled}', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      await taskAsks.answer(t, {q1: {action: 'decline'}}, {session: SESSION, ofAsker});
      tombstones.get = () => Promise.resolve({owner: 'o'});
      assert.deepStrictEqual(await beforeOf(jobData, t, {rerun: false}), {skip: true, cancelled: true});
      tombstones.get = () => Promise.resolve(null);
      const r = await beforeOf(jobData, t, {rerun: false});
      assert.ok(r.skip !== true && moduleAsk.isState(r.state), JSON.stringify(r));
    });
    it('a run whose question still waits stays a skip when the tombstone read fails', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      tombstones.get = () => Promise.reject(new Error('tombstones down'));
      assert.deepStrictEqual(await beforeOf(jobData, t, {rerun: false}), {skip: true});
    });
    // (its record gone -- a cancel took it -- and the tombstone unreadable:
    // the run fails, never held as waiting)
    it('a run whose record is gone rejects when the tombstone read fails', async () => {
      const t = id();
      tombstones.get = () => Promise.reject(new Error('tombstones down'));
      await assert.rejects(beforeOf(jobData, t, {rerun: false}), /tombstones down/);
    });
    // (a cancel whose record removal failed: its question still shows
    // waiting, and its tombstone is read all the same -- ruled M2)
    it('a run for a task cancelled while its question waits (the record left) runs nothing: {skip, cancelled}', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      tombstones.get = () => Promise.resolve({owner: 'o'});
      assert.deepStrictEqual(await beforeOf(jobData, t, {rerun: false}), {skip: true, cancelled: true});
    });
    // (a question past its wait, the tombstone read failing: it stays a
    // skip, to end as ASK_EXPIRED as before)
    it('a run whose question\'s wait is over stays a skip when the tombstone read fails', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      now += taskAsks.WAIT_MS + 1;
      try {
        tombstones.get = () => Promise.reject(new Error('tombstones down'));
        assert.deepStrictEqual(await beforeOf(jobData, t, {rerun: false}), {skip: true});
      } finally { now -= taskAsks.WAIT_MS + 1; }
    });
    // (a real cancel takes the record and leaves the tombstone: the run
    // started again finds neither question nor record, and is cancelled)
    it('a run for a task whose cancel took its record (its tombstone left) runs nothing: {skip, cancelled}', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      await taskAsks.remove(t);
      tombstones.get = () => Promise.resolve({owner: 'o'});
      assert.deepStrictEqual(await beforeOf(jobData, t, {rerun: false}), {skip: true, cancelled: true});
    });
    it('a tombstone that can\'t be read rejects; so does a record that can\'t be read', async () => {
      const t = id();
      assert.ok((await ask(t)).asked != null);
      await taskAsks.answer(t, {q1: {action: 'decline'}}, {session: SESSION, ofAsker});
      tombstones.get = () => Promise.reject(new Error('tombstones down'));
      await assert.rejects(beforeOf(jobData, t, {rerun: false}), /tombstones down/);
      tombstones.get = () => Promise.resolve(null);
      taskAsks.configure({kv: () => ({get: (k, cb) => setImmediate(cb, new Error('store down'))})});
      try {
        await assert.rejects(beforeOf(jobData, t, {rerun: true}), /store down/);
      } finally {
        taskAsks.configure({kv: () => kv});
      }
    });
  });

  // A run started again within itself (a question no form could be shown
  // for, or no room) runs its next pass at once, bounded by the run's time
  // limit counted from its first pass (JOB_TIMEOUT), the same in both
  // runners; each pass's usage call is closed, a failure between two passes
  // gets a call of its own, and a task cancelled between two passes runs
  // nothing more and opens no call (#487's high, round 1). `api` is the
  // runner. Each asking pass takes 100 ms here, as a handler's would.
  const waitOrders = (label, getApi, done = () => {}) => {
    // (every close of a call counted -- the end hook's, the completion
    // hook's, and the asked hook's own when it answers {asked}, as the
    // gateway's closes the call when it writes the question: exactlyOnce
    // asserts each call opened was closed once; ruled M1)
    const harness = (api, {timeout, answers, okAt, before = null, holdMs = () => 60000, authorize = null, askedMs = 0, startThrowsAt = null, attempts}) => {
      const log = {started: [], ended: [], completed: [], at: [], passes: 0, settled: 0, closes: {}, reruns: [], sessions: []};
      const closed = (c) => { log.closes[c] = (log.closes[c] || 0) + 1; };
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          log.passes += 1;
          if (okAt != null && log.passes >= okAt) return setImmediate(callback, null, {output: {done: true}});
          asking(extraArgs.ask);
          // (a worker told its run ended answers nothing more)
          return setTimeout(() => { if (typeof(cancelled) !== 'function' || !cancelled()) callback(new CountinghouseError('ASK_PENDING')); }, 100);
        }};
      let k = 0;
      api.authorizeRun = () => { k += 1; return authorize != null ? authorize(k) : Promise.resolve(); };
      api.initJobProcess(ci);
      let s = 0;
      api.setStartHook((data, session) => {
        s += 1;
        log.sessions.push(session == null ? null : 'session');
        if (s === startThrowsAt) throw new Error('start hook broken');
        log.started.push(log.started.length + 1); log.at.push(Date.now()); return {usageCall: log.started.length};
      });
      // (a pass whose start hook threw has no call: its close is of none)
      api.setEndHook((data, run, outcome) => { if (run.extra != null) closed(run.extra.usageCall); log.ended.push([run.extra != null ? run.extra.usageCall : null, outcome]); });
      api.setCompletionHook((data, results, run) => {
        if (run.extra != null) closed(run.extra.usageCall);
        log.completed.push([run.extra != null ? run.extra.usageCall : null, run.error != null ? String(run.error.message).split(':')[0] : 'ok', Date.now()]);
        return null;
      });
      let n = 0;
      let b = 0;
      api.setAskHooks({
        before: (data, taskId, run) => { b += 1; log.reruns.push(run.rerun); return Promise.resolve(before != null ? before(b, run) : {state: moduleAsk.newState({askable: true, shownAs: 'm'})}); },
        asked: (data, taskId, state, run) => {
          n += 1;
          const r = answers(n);
          return new Promise((resolve) => setTimeout(resolve, askedMs)).then(() => {
            if (r != null && r.asked != null) closed(run.extra.usageCall);
            return r;
          });
        },
        settled: () => { log.settled += 1; return Promise.resolve(); },
        holdMs
      });
      return new Promise((resolve) => api.addJob({appKey: 'k', session: SESSION}, Object.assign({name: 'n', taskId: id(), era: 'modern', asks: true, timeout}, attempts != null ? {attempts} : {}), 'd', 's', 'a', {}, (err) => resolve({err, log})));
    };
    const until = async (check, ms = 10000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); }
      return false;
    };
    const exactlyOnce = (log) => assert.deepStrictEqual(log.started.map((c) => [c, log.closes[c] || 0]), log.started.map((c) => [c, 1]), JSON.stringify(log));
    it(`${label}: a failure after the question was written takes a call of its own; each call closed once`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({asked: {round: 1}}), holdMs: () => { throw new Error('hold broken'); }});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.started, log.completed[0][0], log.completed[0][1]], [[1, 2], 2, 'hold broken'], JSON.stringify(log));
        exactlyOnce(log);
        assert.ok(log.settled >= 1, `its question settled: ${JSON.stringify(log)}`);
      } finally { done(api); }
    });
    // (a waiting skip within a run started again whose hold can't be made:
    // the run fails with a call of its own, never left unsettled)
    it(`${label}: a waiting skip whose hold can't be made fails the run with a call of its own; each call closed once`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}), holdMs: () => { throw new Error('hold broken'); },
          before: (b) => (b === 1 ? {state: moduleAsk.newState({askable: true, shownAs: 'm'})} : {skip: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.passes, log.completed[0][1]], [1, 'hold broken'], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: the run's limit -- JOB_TIMEOUT, counted from the first pass of the run started again, its failure a call of its own`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 500, answers: () => ({rerun: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        const [call, outcome, at] = log.completed[0];
        assert.strictEqual(outcome, 'JOB_TIMEOUT', JSON.stringify(log));
        assert.ok(at - log.at[0] >= 450 && at - log.at[0] < 1500, `failed ${at - log.at[0]} ms after the first pass`);
        // every pass's call closed as unavailable, and the failure's call is
        // none of those closed
        assert.ok(log.ended.length > 0 && log.ended.every(([, o]) => o === 'unavailable'), JSON.stringify(log.ended));
        assert.ok(!log.ended.some(([c]) => c === call), `the failure's call ${call} was closed already: ${JSON.stringify(log)}`);
        await new Promise((r) => setTimeout(r, 300));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: passes with no question shown run again at once, and the run completes`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, okAt: 4, answers: () => ({rerun: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.completed[0][1], log.ended.map(([, o]) => o), log.started.length], ['ok', ['unavailable', 'unavailable', 'unavailable'], 4], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: a before that fails (a store read) runs nothing; the run fails with a call of its own`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}), before: () => Promise.reject(new Error('store down'))});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.passes, log.started, log.completed[0][0], log.completed[0][1]], [0, [1], 1, 'store down'], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: a before that fails between two passes runs nothing more; the run fails with a call of its own`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}),
          before: (b) => (b === 1 ? {state: moduleAsk.newState({askable: true, shownAs: 'm'})} : Promise.reject(new Error('store down')))});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.passes, log.ended, log.completed[0][0], log.completed[0][1]], [1, [[1, 'unavailable']], 2, 'store down'], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    // (#487's high, round 2: one chain deadline, armed across the asked
    // write and the steps before a pass is dispatched, in both runners)
    it(`${label}: an asked write slower than the run's limit fails it JOB_TIMEOUT at the limit, never completed past it`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 300, askedMs: 1200, answers: () => ({rerun: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.strictEqual(log.completed[0][1], 'JOB_TIMEOUT', JSON.stringify(log));
        assert.ok(log.completed[0][2] - log.at[0] < 900, `failed ${log.completed[0][2] - log.at[0]} ms after the first pass`);
        await new Promise((r) => setTimeout(r, 1400));
        assert.strictEqual(log.passes, 1, JSON.stringify(log));
        // (failed for good: its question, whatever the hook wrote, settled --
        // once, after the hook's late write)
        assert.strictEqual(log.settled, 1, `its question settled once: ${JSON.stringify(log)}`);
      } finally { done(api); }
    });
    it(`${label}: a before slower than the run's limit, between two passes, fails it JOB_TIMEOUT and dispatches nothing more`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 400, answers: () => ({rerun: true}),
          before: (b) => (b === 1 ? {state: moduleAsk.newState({askable: true, shownAs: 'm'})}
            : new Promise((r) => setTimeout(r, 1200, {state: moduleAsk.newState({askable: true, shownAs: 'm'})})))});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.strictEqual(log.completed[0][1], 'JOB_TIMEOUT', JSON.stringify(log));
        assert.ok(log.completed[0][2] - log.at[0] < 1000, `failed ${log.completed[0][2] - log.at[0]} ms after the first pass`);
        await new Promise((r) => setTimeout(r, 1400));
        assert.deepStrictEqual([log.passes, log.completed.length], [1, 1], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    // (#487's high, round 2: the owner checked again before every pass of a
    // run started again, in both runners; a refusal there fails the run with
    // a call of its own)
    it(`${label}: a pass of a run started again checks its owner again; a refusal fails the run with a call of its own`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}),
          authorize: (k) => (k === 1 ? Promise.resolve() : Promise.reject(Object.assign(new Error('REFUSED: the grant is gone'), {final: true, retry: false})))});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        await new Promise((r) => setTimeout(r, 300));
        assert.deepStrictEqual([log.passes, log.completed.map(([c, o]) => [c, o])], [1, [[2, 'REFUSED']]], JSON.stringify(log));
        exactlyOnce(log);
        // (the refusal's call has the run's session, as its first pass's)
        assert.deepStrictEqual(log.sessions, ['session', 'session'], JSON.stringify(log));
      } finally { done(api); }
    });
    it(`${label}: a refusal that is no Error, on a run started again, fails it with its text`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}),
          authorize: (k) => (k === 1 ? Promise.resolve() : Promise.reject('REFUSED: plain text'))});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual(log.completed.map(([c, o]) => [c, o]), [[2, 'REFUSED']], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: the first pass's before is no run started again, whatever the owner check answers`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, okAt: 1, answers: () => ({rerun: true}), authorize: () => Promise.resolve(true)});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual(log.reruns, [false], JSON.stringify(log));
      } finally { done(api); }
    });
    // (#487's high, round 2: a read that fails is retried as the job's
    // attempts allow, a failure like any other)
    it(`${label}: a before that fails is retried as the job's attempts allow`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, okAt: 1, attempts: 2, answers: () => ({rerun: true}),
          before: (b) => (b === 1 ? Promise.reject(new Error('store down')) : {state: moduleAsk.newState({askable: true, shownAs: 'm'})})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 2), JSON.stringify(log));
        assert.deepStrictEqual(log.completed.map(([c, o]) => [c, o]), [[1, 'store down'], [2, 'ok']], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    // (#487's high, round 2: a pass whose start hook throws has no call, never
    // the last pass's, closed already)
    it(`${label}: a pass whose start hook throws closes no earlier pass's call again`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, okAt: 3, startThrowsAt: 2, answers: () => ({rerun: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        await new Promise((r) => setTimeout(r, 200));
        assert.deepStrictEqual([log.started, log.completed[0][1]], [[1, 2], 'ok'], JSON.stringify(log));
        exactlyOnce(log);
      } finally { done(api); }
    });
    it(`${label}: a task cancelled between two passes runs no next pass and opens no call`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, answers: () => ({rerun: true}),
          before: (b) => (b === 1 ? {state: moduleAsk.newState({askable: true, shownAs: 'm'})} : {skip: true, cancelled: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.ended.length === 1), JSON.stringify(log));
        await new Promise((r) => setTimeout(r, 400));
        assert.deepStrictEqual([log.passes, log.started, log.ended], [1, [1], [[1, 'unavailable']]], JSON.stringify(log));
        assert.ok(log.settled >= 1, `its question settled: ${JSON.stringify(log)}`);
        exactlyOnce(log);
      } finally { done(api); }
    });
  };

  // The BullMQ runner (the Redis store), against run-local's private Redis:
  // its asking pass completes the job, and BullMQ's completed event must not
  // forget the job's session, which the answered run needs (the review of
  // #374, M1: it ran with no session, so with none of the session's limits).
  describe('the BullMQ job runner', () => {
    const options = require('../../lib/cli-options');
    const jobSessions = require('../../lib/job-sessions');
    const {redisUrlFor} = require('../helpers/test-env');
    let saved;
    let JobControl;
    let serverIdDir = null;
    before(function() {
      if (process.env.CH_TEST_REDIS_URL == null || process.env.CH_TEST_REDIS_URL === '') this.skip();
      saved = {workerThread: options.workerThread, redisUrl: options.redisUrl};
      Object.assign(options, {workerThread: true, redisUrl: redisUrlFor()});
      // the job queue is this server's own, named by its server id (B-j1):
      // made as a start makes it, in a directory of this file's, and the
      // process left with none again after (only if it had none before)
      if (!require('../../lib/server-id').ready()) {
        serverIdDir = require('../helpers/test-tmp').mkdtemp('ch-q08-server-id-');
        require('../../lib/server-id').initSync({moduleDataPath: serverIdDir});
      }
      JobControl = require('../../lib/job-control');
    });
    after(async () => {
      if (saved != null) Object.assign(options, saved);
      // the server id's claim its runner made (B-j1), released
      if (JobControl != null && JobControl.claim != null) { await JobControl.claim.stop(); JobControl.claim = null; }
      if (serverIdDir != null) {
        require('../../lib/server-id').reset();
        require('../helpers/test-tmp').remove(serverIdDir);
      }
    });

    // the record's take and the caps' reserve as scripts on Redis
    describe('the record on Redis', () => {
      let client = null;
      before(async function() {
        if (process.env.CH_TEST_REDIS_URL == null || process.env.CH_TEST_REDIS_URL === '') this.skip();
        client = require('redis').createClient(redisUrlFor(), {db: 5});
        await new Promise((resolve) => client.flushdb(resolve));
        taskAsks.configure({kv: () => client});
      });
      after(() => {
        taskAsks.configure({kv: () => kv});
        if (client != null) client.quit();
      });
      it('take is a compare-and-set on Redis too', async () => {
        const t = id();
        await ask(t);
        const got = await Promise.all([taskAsks.take(t, 'q1'), taskAsks.take(t, 'q1')]);
        assert.deepStrictEqual(got.map((r) => (r == null ? null : r.pending.reqKey)).sort(), [null, 'q1']);
        // the record keeps its expiry and its lists (cjson writes an empty list back as an object)
        const r = await taskAsks.get(t);
        assert.deepStrictEqual([r.pending, Array.isArray(r.unavailable)], [null, true]);
      });
      reviewCases('on Redis: ');
    });

    it('the answered run keeps the job\'s session: the asking pass\'s completed event forgets nothing', async () => {
      jobSessions.resetForTests();
      const passes = [];
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          passes.push(extraArgs.session || null);
          if (passes.length === 1) {
            asking(extraArgs.ask);
            return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
          }
          return setImmediate(callback, null, {output: {done: true}});
        }};
      JobControl.authorizeRun = () => Promise.resolve();
      JobControl.initJobProcess(ci);
      JobControl.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-q', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-q', session: run.session, ofAsker}),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => JobControl.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      const until = async (check, ms = 10000) => {
        for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 25)); }
        return false;
      };
      assert.ok(await until(async () => (await taskAsks.get(t)) != null && (await taskAsks.get(t)).pending != null), 'asked');
      // BullMQ's completed event for the asking pass has had its turn
      await new Promise((r) => setTimeout(r, 500));
      assert.deepStrictEqual(jobSessions.forRun(t).session, SESSION, 'the job\'s session is kept while its question waits');
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}), 'rerun');
      assert.strictEqual(await JobControl.rerunTask(t), true);
      assert.ok(await until(() => passes.length === 2), JSON.stringify(passes));
      assert.deepStrictEqual(passes, [SESSION, SESSION], 'the answered run ran in the job\'s session');
      // done: its entry ends as any finished job's does
      assert.ok(await until(() => jobSessions.forRun(t).session == null), 'forgotten once done');
    });

    // F2-2's code review: BullMQ runs every pass within one run, so a pass
    // with no form shown closes its usage call and the next pass starts its
    // own; a wait for room's delay is kept before the next pass
    // (no room at the run's start: the owner full, its first question has no
    // one to ask -- the pass runs with no ask state, as on master; #487's
    // high, round 1)
    it('a task whose first question finds no room runs one pass with no one to ask (BullMQ)', async () => {
      for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-b'});
      // (the handler, as one with no one to ask: ctx.ask is ASK_UNAVAILABLE,
      // which it catches, and it completes)
      const asks = [];
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asks.push(extraArgs.ask == null ? null : 'a state');
          return setImmediate(callback, null, {output: {done: true}});
        }};
      const started = [];
      const ended = [];
      const completed = [];
      JobControl.authorizeRun = () => Promise.resolve();
      JobControl.initJobProcess(ci);
      JobControl.setStartHook(() => { started.push(started.length + 1); return {usageCall: started.length}; });
      JobControl.setEndHook((data, run, outcome) => ended.push([run.extra.usageCall, outcome]));
      JobControl.setCompletionHook((data, results, run) => { completed.push(run.extra.usageCall); return null; });
      JobControl.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-b', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-b', session: run.session, ofAsker}),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      try {
        const t = id();
        made.add(t);
        const added = await new Promise((resolve) => JobControl.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
        assert.ifError(added.err);
        const until = async (check, ms = 10000) => {
          for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 25)); }
          return false;
        };
        assert.ok(await until(() => completed.length === 1), JSON.stringify({started, ended, completed}));
        assert.deepStrictEqual([started, ended, completed, asks], [[1], [], [1], [null]]);
      } finally {
        JobControl.setStartHook(null);
        JobControl.setEndHook(null);
        JobControl.setCompletionHook(null);
      }
    });

    waitOrders('BullMQ', () => JobControl, (api) => { api.setStartHook(null); api.setEndHook(null); api.setCompletionHook(null); });

    it('a run that times out (JOB_TIMEOUT) while its ask is being written leaves no record and no slot', async () => {
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      JobControl.initJobProcess(ci);
      // the record is written, then the hook is slow: the run's timeout fires first
      JobControl.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-t', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-t', session: run.session, ofAsker}).then((r) => new Promise((res) => setTimeout(() => res(r), 600))),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => JobControl.addJob({appKey: 'k'}, {name: 'n', taskId: t, era: 'modern', asks: true, timeout: 200}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      const until = async (check, ms = 10000) => {
        for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 25)); }
        return false;
      };
      assert.ok(await until(async () => (await taskAsks.get(t)) != null), 'the ask was written');
      assert.ok(await until(async () => (await taskAsks.get(t)) == null), 'the timed-out run left its record');
      // and its slot: three more of that owner's may wait (the cap is 3)
      for (const m of [id(), id(), id()]) assert.ok((await ask(m, {owner: 'owner-t'})).asked != null);
    });
  });

  describe('the local job runner', () => {
    const options = require('../../lib/cli-options');
    const jobSessions = require('../../lib/job-sessions');
    const {createRunner} = require('../../lib/job-control-local');
    const {INTERNAL} = require('../../lib/job-control-common');
    let saved;
    beforeEach(() => {
      jobSessions.resetForTests();
      saved = {workerThread: options.workerThread};
      options.workerThread = true;
    });
    afterEach(() => Object.assign(options, saved));
    const until = async (check, ms = 3000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 10)); }
      return false;
    };

    it('the pass that asks is not billed and spends no attempt; answered, the run again keeps its session and is billed once', async () => {
      const billed = [];
      const passes = [];
      const ci = {recordCall: (k, t, c, cb) => { billed.push(k); if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          passes.push({session: extraArgs.session || null, answers: extraArgs.ask != null ? [...extraArgs.ask.answers.values()] : null});
          if (passes.length === 1) {
            asking(extraArgs.ask);
            return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
          }
          return setImmediate(callback, null, {output: {done: true}});
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      const settled = [];
      runner.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-r', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-r', session: run.session, ofAsker}),
        settled: (data, taskId) => { settled.push(taskId); return taskAsks.remove(taskId); },
        holdMs: () => 60000
      });
      const t = id();
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true, attempts: 2}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      const job = () => new Promise((resolve) => runner.getJob(INTERNAL, t, (err, r) => resolve(r)));
      assert.ok(await until(async () => { const j = await job(); return j != null && j.state === 'completed' && j.job.data.asking === 1; }), 'held, asking');
      assert.deepStrictEqual([billed.length, (await job()).job.attemptsMade], [0, 0], 'not billed, no attempt spent');
      assert.strictEqual(await taskAsks.answer(t, {q1: {action: 'accept', content: {yes: true}}}, {session: SESSION, ofAsker}), 'rerun');
      assert.strictEqual(await runner.rerunTask(t), true);
      assert.ok(await until(async () => { const j = await job(); return j != null && j.state === 'completed' && j.job.data.asking === undefined; }), 'completed');
      assert.deepStrictEqual(passes, [{session: SESSION, answers: []}, {session: SESSION, answers: [{yes: true}]}]);
      assert.ok(await until(() => billed.length === 1), JSON.stringify(billed));
      assert.deepStrictEqual(settled, [t], 'its record goes with its question');
      assert.strictEqual(await taskAsks.get(t), null);
      // not waiting on a question any more: nothing to start again
      assert.strictEqual(await runner.rerunTask(t), false);
      runner.close();
    });

    // F2-2's code review: each pass has a usage call of its own. A pass that
    // ended with no form shown is closed ('unavailable') before the next
    // pass starts its own, so the work after it is counted and billed
    it('a pass with no form shown closes its usage call, and the next pass starts its own (the local runner)', async () => {
      let n = 0;
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          n += 1;
          if (n === 1) { asking(extraArgs.ask); return setImmediate(callback, new CountinghouseError('ASK_PENDING')); }
          return setImmediate(callback, null, {output: {done: true}});
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      const started = [];
      const ended = [];
      const completed = [];
      runner.setStartHook(() => { started.push(started.length + 1); return {usageCall: started.length}; });
      runner.setEndHook((data, run, outcome) => ended.push([run.extra.usageCall, outcome]));
      runner.setCompletionHook((data, results, run) => { completed.push(run.extra.usageCall); return null; });
      runner.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-u', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-u', session: run.session, ofAsker: () => null}),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      assert.ok(await until(() => completed.length === 1), JSON.stringify({started, ended, completed}));
      assert.deepStrictEqual([started, ended, completed], [[1, 2], [[1, 'unavailable']], [2]]);
      runner.close();
    });

    // (no room at the run's start: the owner full, its first question has no
    // one to ask -- the pass runs with no ask state, as on master; #487's
    // high, round 1)
    it('a task whose first question finds no room runs one pass with no one to ask (the local runner)', async () => {
      for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-d'});
      // (the handler, as one with no one to ask: ctx.ask is ASK_UNAVAILABLE,
      // which it catches, and it completes)
      const asks = [];
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asks.push(extraArgs.ask == null ? null : 'a state');
          return setImmediate(callback, null, {output: {done: true}});
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      const ended = [];
      runner.setStartHook(() => ({usageCall: 1}));
      runner.setEndHook((data, run, outcome) => ended.push(outcome));
      runner.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-d', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-d', session: run.session, ofAsker}),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      assert.ok(await until(() => asks.length === 1), JSON.stringify(asks));
      await new Promise((r) => setTimeout(r, 200));
      assert.deepStrictEqual([asks, ended], [[null], []]);
      runner.close();
    });

    waitOrders('the local runner', () => createRunner({jobTimeoutMs: 0}), (api) => api.close());

    // (the asked hook closes the pass's call when it writes the question; a
    // throw after that fails the job with a call of its own, never on the
    // closed one -- the medium of fe7c1d5e)
    it('a throw after the question was written fails the job with a call of its own (the local runner)', async () => {
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      const started = [];
      const completed = [];
      runner.setStartHook(() => { started.push(started.length + 1); return {usageCall: started.length}; });
      runner.setCompletionHook((data, results, run) => { completed.push([run.extra != null ? run.extra.usageCall : null, run.error != null ? 'failed' : 'ok']); return null; });
      runner.setAskHooks({
        before: () => Promise.resolve({state: moduleAsk.newState({askable: true, shownAs: 'm'})}),
        asked: () => Promise.resolve({asked: {round: 1}}),
        settled: () => Promise.resolve(),
        holdMs: () => { throw new Error('hold broken'); }
      });
      try {
        const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: id(), era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
        assert.ifError(added.err);
        assert.ok(await until(() => completed.length === 1), JSON.stringify({started, completed}));
        assert.deepStrictEqual([started, completed], [[1, 2], [[2, 'failed']]]);
      } finally { runner.close(); }
    });

    // (F2-2's medium: a session that ends while its pass's question is being
    // written closes that pass's usage call, never leaves it open)
    // (and when the hook closed nothing -- no question written -- only the
    // runner can close the pass's call: as cancelled, whatever the hook
    // answered, as the runner checks the session before the answer)
    it('a session that ends while a pass whose question was not written is recorded closes its call as cancelled (the local runner)', async () => {
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      const ended = [];
      runner.setStartHook(() => ({usageCall: 1}));
      runner.setEndHook((data, run, outcome) => ended.push(outcome));
      runner.setAskHooks({
        before: () => Promise.resolve({state: moduleAsk.newState({askable: true, shownAs: 'm'})}),
        asked: () => { runner.cancelSession(SESSION); return Promise.resolve({rerun: true}); },
        settled: () => Promise.resolve(),
        holdMs: () => 60000
      });
      try {
        const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: id(), era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
        assert.ifError(added.err);
        assert.ok(await until(() => ended.length === 1), JSON.stringify(ended));
        await new Promise((r) => setTimeout(r, 300));
        assert.deepStrictEqual(ended, ['cancelled']);
      } finally { runner.close(); }
    });

    it('a session that ends while the asking pass is written leaves no call open, closed once as asked (the local runner)', async () => {
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      // (the call's record kept as the usage counters keep it: the asked hook
      // closes it as 'asked', as production's does once the question is
      // written, and a close of a call already closed is nothing)
      const started = [];
      const closed = [];
      const open = new Set();
      const close = (call, outcome) => { if (open.delete(call)) closed.push([call, outcome]); };
      runner.setStartHook(() => { started.push(started.length + 1); open.add(started.length); return {usageCall: started.length}; });
      runner.setEndHook((data, run, outcome) => close(run.extra.usageCall, outcome));
      runner.setAskHooks({
        before: () => Promise.resolve({state: moduleAsk.newState({askable: true, shownAs: 'm'})}),
        asked: (data, taskId, state, run) => { close(run.extra.usageCall, 'asked'); runner.cancelSession(SESSION); return Promise.resolve({asked: {round: 1}}); },
        settled: () => Promise.resolve(),
        holdMs: () => 60000
      });
      try {
        const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: id(), era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
        assert.ifError(added.err);
        await new Promise((r) => setTimeout(r, 100));
        assert.deepStrictEqual([started, closed, open.size], [[1], [[1, 'asked']], 0], JSON.stringify({started, closed}));
      } finally { runner.close(); }
    });

    it('a session that ends while its task waits on a question takes the record with it (B5 Task 4\'s cancel)', async () => {
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      const runner = createRunner({jobTimeoutMs: 0});
      runner.authorizeRun = () => Promise.resolve();
      runner.initJobProcess(ci);
      runner.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: data.asks === true, asking: data.asking != null, owner: 'owner-e', shownAs: 'm'}),
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-e', session: run.session, ofAsker}),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      assert.ok(await until(async () => (await taskAsks.get(t)) != null && (await taskAsks.get(t)).pending != null), 'asked');
      assert.ok(await until(() => new Promise((resolve) => runner.getJob(INTERNAL, t, (err, r) => resolve(r != null && r.job.data.asking === 1)))), 'held');
      assert.deepStrictEqual(runner.cancelSession(SESSION), {removed: 1, finishing: 0});
      assert.ok(await until(async () => (await taskAsks.get(t)) == null), 'the record went with the session');
      // and its slot: three more of that owner's may wait (the cap is 3)
      for (const m of [id(), id(), id()]) assert.ok((await ask(m, {owner: 'owner-e'})).asked != null);
      runner.close();
    });
  });
});
