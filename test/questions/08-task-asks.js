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

  it('at most so many of an owner\'s tasks wait at once, and so many in all: one more waits for room (F2-2\'s ruling: no round, a backoff)', async () => {
    const mine = [id(), id(), id()];
    for (const t of mine) assert.ok((await ask(t)).asked != null);
    // the owner is full: a new task of its may still ask (ruled, F2-2's
    // medium: its first question waits for room as any other), and its pass
    // waits for room, run again after a backoff -- never ASK_UNAVAILABLE at
    // once
    const first = await taskAsks.forRun(id(), {asks: true, asking: false, owner: 'owner-1', shownAs: 'm'});
    assert.ok(moduleAsk.isState(first.state), JSON.stringify(first));
    assert.deepStrictEqual(await ask(id()), {rerun: true, delayMs: 1000, waited: true});
    // another owner still may, up to the total (5)
    const theirs = [id(), id()];
    for (const t of theirs) assert.ok((await ask(t, {owner: 'owner-2'})).asked != null);
    assert.deepStrictEqual(await ask(id(), {owner: 'owner-3'}), {rerun: true, delayMs: 1000, waited: true}, 'the total is reached');
    // answered or removed, a task no longer counts
    assert.strictEqual(await taskAsks.answer(mine[0], {q1: {action: 'decline'}}, {session: SESSION, ofAsker}), 'rerun');
    assert.ok((await ask(id(), {owner: 'owner-3'})).asked != null);
    for (const t of mine.concat(theirs)) await taskAsks.remove(t);
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

  // the reviewer's ruling on F2-2 (a): a pass refused only because the
  // waiting caps are full is no round: it waits for room, rate-bounded (a
  // backoff from 1 s doubling to 30 s), and past a question's wait the
  // question is unavailable, as one no form can be shown for
  it('no room among the waiting tasks: no round spent, a backoff that doubles to 30 s, and unavailable past the question\'s wait', async () => {
    for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-full'});
    const t = id();
    made.add(t);
    const delays = [];
    for (let i = 0; i < 7; i++) {
      const r = await taskAsks.asked(t, asking(), {owner: 'owner-full', session: null, ofAsker});
      assert.strictEqual(r.rerun, true, JSON.stringify(r));
      delays.push(r.delayMs);
    }
    assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    assert.strictEqual((await taskAsks.get(t)).callRounds, 0, 'no round spent waiting for room');
    // past the question's wait with still no room (the owner's waiting tasks
    // asked again since, so live): unavailable, a round, at once
    now += taskAsks.WAIT_MS;
    try {
      for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-full'});
      // (as a runner gets there: the run started again is no run that runs
      // nothing -- its record waits for room, no question shown -- and its
      // view is working; F2-2's medium)
      const next = await taskAsks.forRun(t, {asks: true, asking: true, owner: 'owner-full', shownAs: 'm'});
      assert.ok(next.skip !== true && moduleAsk.isState(next.state), JSON.stringify(next));
      assert.deepStrictEqual(await taskAsks.view(t, SESSION), {status: 'working'});
      assert.deepStrictEqual(await taskAsks.asked(t, asking(), {owner: 'owner-full', session: null, ofAsker}), {rerun: true});
      const r = await taskAsks.get(t);
      assert.deepStrictEqual([r.callRounds, r.unavailable], [1, [KEY]]);
    } finally {
      now -= taskAsks.WAIT_MS;
    }
  });

  // (ruled on F2-2's medium: inside a run started again, a record that is
  // missing -- a read that failed -- is a fresh state, never a skip; a run
  // started again after an answer whose record is gone still runs nothing)
  it('a pass of a run started again within itself whose record is missing asks afresh; an answered run\'s still runs nothing', async () => {
    const fresh = await taskAsks.forRun(id(), {asks: true, asking: true, owner: 'owner-r', shownAs: 'm', rerun: true});
    assert.ok(fresh.skip !== true && moduleAsk.isState(fresh.state), JSON.stringify(fresh));
    assert.deepStrictEqual([fresh.state.unavailable.size, fresh.state.callRounds || 0], [0, 0]);
    assert.deepStrictEqual(await taskAsks.forRun(id(), {asks: true, asking: true, owner: 'owner-r', shownAs: 'm'}), {skip: true});
  });

  // (ruled on F2-2's medium: a wait for room spends no round while it
  // waits, and one when it reaches the question's wait with still no room;
  // so a handler that asks under another key each pass is bounded too:
  // eight such waits, eight rounds, and nothing more is asked)
  it('a handler changing its question\'s key each pass, never given room, is bounded: a round at each wait\'s end, eight in all', async () => {
    const owner = 'owner-keys';
    for (let i = 0; i < 3; i++) await ask(id(), {owner});
    const t = id();
    made.add(t);
    let shifted = 0;
    try {
      for (let round = 1; round <= 8; round++) {
        const state = asking();
        state.pending.key = `${'k'.repeat(42)}${round}`;
        const waited = await taskAsks.asked(t, state, {owner, session: null, ofAsker});
        assert.strictEqual(waited.waited, true, JSON.stringify(waited));
        assert.strictEqual((await taskAsks.get(t)).callRounds || 0, round - 1, 'no round while waiting');
        now += taskAsks.WAIT_MS;
        shifted += 1;
        for (let i = 0; i < 3; i++) await ask(id(), {owner});
        const again = asking();
        again.pending.key = state.pending.key;
        assert.deepStrictEqual(await taskAsks.asked(t, again, {owner, session: null, ofAsker}), {rerun: true});
        assert.strictEqual((await taskAsks.get(t)).callRounds, round, 'a round at the wait\'s end');
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
    } finally {
      now -= shifted * taskAsks.WAIT_MS;
    }
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

  // The BullMQ runner (the Redis store), against run-local's private Redis:
  // its asking pass completes the job, and BullMQ's completed event must not
  // forget the job's session, which the answered run needs (the review of
  // #374, M1: it ran with no session, so with none of the session's limits).
  // A wait for room ends at whichever comes first, the question's wait
  // (unavailable, from the ask hook) or the run's time limit counted from
  // the pass that began it (JOB_TIMEOUT): the same in both runners (F2-2's
  // medium, ruled). `api` is the runner; each pass's usage call is closed,
  // and a failure between two passes gets a call of its own.
  const waitOrders = (label, getApi, done = () => {}) => {
    const harness = (api, {timeout, answers, okAt}) => {
      let passes = 0;
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          passes += 1;
          if (okAt != null && passes >= okAt) return setImmediate(callback, null, {output: {done: true}});
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      api.authorizeRun = () => Promise.resolve();
      api.initJobProcess(ci);
      const log = {started: [], ended: [], completed: [], at: []};
      api.setStartHook(() => { log.started.push(log.started.length + 1); log.at.push(Date.now()); return {usageCall: log.started.length}; });
      api.setEndHook((data, run, outcome) => log.ended.push([run.extra.usageCall, outcome]));
      api.setCompletionHook((data, results, run) => { log.completed.push([run.extra.usageCall, run.error != null ? String(run.error.message).split(':')[0] : 'ok', Date.now()]); return null; });
      let n = 0;
      api.setAskHooks({
        before: () => Promise.resolve({state: moduleAsk.newState({askable: true, shownAs: 'm'})}),
        asked: () => { n += 1; return Promise.resolve(answers(n)); },
        settled: () => Promise.resolve(),
        holdMs: () => 60000
      });
      return new Promise((resolve) => api.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: id(), era: 'modern', asks: true, timeout}, 'd', 's', 'a', {}, (err) => resolve({err, log})));
    };
    const until = async (check, ms = 10000) => {
      for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); }
      return false;
    };
    it(`${label}: the run's limit first -- JOB_TIMEOUT, counted from the first pass of the run started again, its failure a call of its own`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 500, answers: () => ({rerun: true, delayMs: 200, waited: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        const [call, outcome, at] = log.completed[0];
        assert.strictEqual(outcome, 'JOB_TIMEOUT', JSON.stringify(log));
        assert.ok(at - log.at[0] >= 450 && at - log.at[0] < 1500, `failed ${at - log.at[0]} ms after the first pass`);
        // every pass's call closed as waited (for room), and the failure's own call
        // is none of them
        assert.ok(log.ended.length > 0 && log.ended.every(([, o]) => o === 'waited'), JSON.stringify(log.ended));
        assert.ok(!log.ended.some(([c]) => c === call), `the failure's call ${call} was closed already: ${JSON.stringify(log)}`);
      } finally { done(api); }
    });
    // (the same order through task-asks itself, as the runners call it: the
    // owner full, two passes wait for room, then the question's wait ends
    // with still no room -- unavailable by forRun and asked, the run goes on)
    it(`${label}: the question's wait first, through task-asks -- unavailable at its end, the run completes`, async () => {
      const api = getApi();
      const owner = `owner-w-${label.length}`;
      for (let i = 0; i < 3; i++) await ask(id(), {owner});
      let passes = 0;
      let shifted = false;
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          passes += 1;
          if (extraArgs.ask != null && extraArgs.ask.unavailable.has(KEY)) return setImmediate(callback, null, {output: {done: true}});
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      api.authorizeRun = () => Promise.resolve();
      api.initJobProcess(ci);
      const log = {ended: [], completed: []};
      api.setStartHook(() => ({usageCall: 1}));
      api.setEndHook((data, run, outcome) => log.ended.push(outcome));
      api.setCompletionHook((data, results, run) => { log.completed.push(run.error != null ? String(run.error.message).split(':')[0] : 'ok'); return null; });
      let n = 0;
      api.setAskHooks({
        before: (data, taskId) => taskAsks.forRun(taskId, {asks: true, asking: data.asking != null, owner, shownAs: 'm'}),
        asked: async (data, taskId, state, run) => {
          n += 1;
          if (n === 3) {
            // the question's wait over, the owner still full
            now += taskAsks.WAIT_MS;
            shifted = true;
            for (let i = 0; i < 3; i++) await ask(id(), {owner});
          }
          const r = await taskAsks.asked(taskId, state, {owner, session: run.session, ofAsker});
          return (r != null && r.delayMs != null) ? Object.assign({}, r, {delayMs: 50}) : r;
        },
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      try {
        const added = await new Promise((resolve) => api.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true, timeout: 10000}, 'd', 's', 'a', {}, (err) => resolve({err})));
        assert.ifError(added.err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify({passes, log}));
        assert.deepStrictEqual([log.completed, log.ended, passes, (await taskAsks.get(t) || {}).callRounds], [['ok'], ['waited', 'waited', 'unavailable'], 4, undefined], JSON.stringify({passes, log}));
      } finally {
        if (shifted) now -= taskAsks.WAIT_MS;
        done(api);
      }
    });
    it(`${label}: the question's wait first -- unavailable, the run goes on and completes`, async () => {
      const api = getApi();
      try {
        const {err, log} = await harness(api, {timeout: 5000, okAt: 4, answers: (n) => (n < 3 ? {rerun: true, delayMs: 100, waited: true} : {rerun: true})});
        assert.ifError(err);
        assert.ok(await until(() => log.completed.length === 1), JSON.stringify(log));
        assert.deepStrictEqual([log.completed[0][1], log.ended.map(([, o]) => o), log.started.length], ['ok', ['waited', 'waited', 'unavailable'], 4], JSON.stringify(log));
      } finally { done(api); }
    });
  };

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
    // (a real wait for room: the owner full, task-asks' own answer, its
    // delay shortened; F2-2's medium)
    it('a pass that waited for room closes its usage call as waited, and the next pass starts its own after the delay (BullMQ)', async () => {
      for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-b'});
      const starts = [];
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          starts.push(Date.now());
          if (starts.length === 1) { asking(extraArgs.ask); return setImmediate(callback, new CountinghouseError('ASK_PENDING')); }
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
        // no form shown (its record written), and a wait's delay as a wait for room asks
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-b', session: run.session, ofAsker}).then((r) => Object.assign({}, r, r.delayMs != null ? {delayMs: 300} : {})),
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
        assert.deepStrictEqual([started, ended, completed], [[1, 2], [[1, 'waited']], [2]]);
        assert.ok(starts[1] - starts[0] >= 290, `the next pass waited: ${starts[1] - starts[0]} ms`);
      } finally {
        JobControl.setStartHook(null);
        JobControl.setEndHook(null);
        JobControl.setCompletionHook(null);
      }
    });

    // (F2-2's medium: a task cancelled during a wait for room's backoff runs
    // no next pass; the call opened for it closes as cancelled)
    it('a task cancelled during a wait for room\'s backoff runs no next pass (BullMQ)', async () => {
      let passes = 0;
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          passes += 1;
          asking(extraArgs.ask);
          return setImmediate(callback, new CountinghouseError('ASK_PENDING'));
        }};
      JobControl.authorizeRun = () => Promise.resolve();
      JobControl.initJobProcess(ci);
      const ended = [];
      JobControl.setStartHook(() => ({usageCall: ended.length + 1}));
      JobControl.setEndHook((data, run, outcome) => ended.push(outcome));
      let gone = false;
      JobControl.setAskHooks({
        before: () => Promise.resolve({state: moduleAsk.newState({askable: true, shownAs: 'm'})}),
        asked: () => { gone = true; return Promise.resolve({rerun: true, delayMs: 200, waited: true}); },
        cancelled: () => Promise.resolve(gone),
        settled: () => Promise.resolve(),
        holdMs: () => 60000
      });
      try {
        const added = await new Promise((resolve) => JobControl.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: id(), era: 'modern', asks: true, timeout: 5000}, 'd', 's', 'a', {}, (err) => resolve({err})));
        assert.ifError(added.err);
        const until = async (check, ms = 5000) => {
          for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise((r) => setTimeout(r, 25)); }
          return false;
        };
        assert.ok(await until(() => ended.length === 2), JSON.stringify({passes, ended}));
        await new Promise((r) => setTimeout(r, 400));
        assert.deepStrictEqual([passes, ended], [1, ['waited', 'cancelled']]);
      } finally {
        JobControl.setStartHook(null);
        JobControl.setEndHook(null);
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

    // (a real wait for room: the owner full, task-asks' own answer, its
    // delay shortened; F2-2's medium)
    it('a wait for room\'s delay is kept before the next pass, its pass closed as waited (the local runner)', async () => {
      for (let i = 0; i < 3; i++) await ask(id(), {owner: 'owner-d'});
      const starts = [];
      const ci = {recordCall: (k, t, c, cb) => { if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback, cancelled, extraArgs) => {
          starts.push(Date.now());
          if (starts.length === 1) { asking(extraArgs.ask); return setImmediate(callback, new CountinghouseError('ASK_PENDING')); }
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
        // no form shown (its record written), and a wait's delay as a wait for room asks
        asked: (data, taskId, state, run) => taskAsks.asked(taskId, state, {owner: 'owner-d', session: run.session, ofAsker}).then((r) => Object.assign({}, r, r.delayMs != null ? {delayMs: 300} : {})),
        settled: (data, taskId) => taskAsks.remove(taskId),
        holdMs: () => 60000
      });
      const t = id();
      made.add(t);
      const added = await new Promise((resolve) => runner.addJob({appKey: 'k', session: SESSION}, {name: 'n', taskId: t, era: 'modern', asks: true}, 'd', 's', 'a', {}, (err, r) => resolve({err, r})));
      assert.ifError(added.err);
      assert.ok(await until(() => starts.length === 2), JSON.stringify(starts));
      assert.ok(starts[1] - starts[0] >= 290, `the next pass waited: ${starts[1] - starts[0]} ms`);
      assert.deepStrictEqual(ended, ['waited']);
      runner.close();
    });

    waitOrders('the local runner', () => createRunner({jobTimeoutMs: 0}), (api) => api.close());

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
        asked: () => { runner.cancelSession(SESSION); return Promise.resolve({rerun: true, delayMs: 100, waited: true}); },
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
