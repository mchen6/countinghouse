'use strict';
// B2 Task 5b (docs/superpowers/plans/2026-11-15-shared-runtime-b2-session-settings.md;
// the maintainer's decision, 2026-11-14), server-free: in one session of a
// shared runtime the user may ask to change one of the two caps for ALL sessions (the call
// says scope: 'all-sessions'). It is then a global change, as a terminal
// change is: settings.json is written and every live session is told. A
// tightening needs no form; a loosening always needs one, which names all
// sessions, is judged against the default in force (never the asking
// session's own value), and is held to the operator's ceiling. Every other
// setting stays the terminal's.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const confirm = require('../../lib/settings-confirm');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const settingsTool = require('../../lib/settings-tool');
// the module manager the tool reads what is loaded from (#449's high
// review, round 6, 8): none loaded here
const NO_MODULES = {modules: {}};

const MiB = 1024 * 1024;

describe('sessions 12: a change for all sessions (shared runtime B2, Task 5b)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const C = 'c'.repeat(32);
  const CLIENT = {name: 'claude-code', version: '2.1.323'};
  const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};
  const DECLINE = {approve: {action: 'decline'}};
  let reg;
  let sources;
  let home;
  let file;
  let saved;
  let sent;     // live options told to the module workers
  let grown;    // the validators grown for a confirmed raise of the output cap
  const openSession = (id, conditions = {status: 'ok', conditions: 'yes', repo: null}) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = Object.assign({}, conditions);
    s.connected = true;
    s.answer = conditions;
    s.notify = () => {};
    s.record = () => {};
    s.forget = () => {};
    s.askConditions = async () => { if (s.answer != null) Object.assign(s.client, s.answer); return s.answer == null ? null : Object.assign({}, s.answer); };
    sources[id] = s;
    reg.emit('session', s);
    return s;
  };
  const ctx = (id, over = {}) => Object.assign({shared: true, session: id, clientInfo: CLIENT, capabilities: {elicitation: {form: {}}}, scope: 'all-sessions'}, over);
  const tool = (o = {}) => settingsTool.create(Object.assign({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'none'}),
    sessionClient: (c) => ({ok: true, client: c.clientInfo}),
    growValidators: async (bytes) => { grown.push(bytes); }}, o));
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  const history = () => (fs.existsSync(path.join(home, 'history.jsonl'))
    ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const refused = async (p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err != null, `refused ${code}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  };
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); confirm.resetForTests(); };
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout, locale: options.locale};
    Object.assign(options, {maxOutputBytes: 16 * MiB, requestTimeout: 30000, locale: 'en-US'});
    reset();
    settings.configure({ceiling: () => ({state: 'none'})});
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s12-'));
    file = path.join(home, 'settings.json');
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    sent = [];
    grown = [];
    settingsTool.setLiveModules(() => ({m: {sendMessageToWorker: (msg) => sent.push(msg)}}));
    for (const id of [A, B, C]) openSession(id);
  });
  afterEach(() => { Object.assign(options, saved); settingsTool.setLiveModules(null); reset(); fs.rmSync(home, {recursive: true, force: true}); });

  describe('a tightening for all sessions: no form', () => {
    it('settings.json is written, every session is held to it at once, the workers are told, and the other sessions hear of it', async () => {
      const done = await tool().set('maxOutputBytes', '4MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 4 * MiB, applies: 'all sessions'});
      assert.strictEqual(stored().maxOutputBytes, 4 * MiB, 'as a terminal change writes it');
      assert.strictEqual(options.maxOutputBytes, 4 * MiB, 'the default in force');
      for (const id of [A, B, C]) assert.strictEqual(settings.effective(id, 'maxOutputBytes'), 4 * MiB, id);
      assert.deepStrictEqual(sent.map((m) => [m.command, m.options.maxOutputBytes]), [['live-options', 4 * MiB]]);
      // the history names the asking session, and says it was for all
      assert.deepStrictEqual(history().map(({at, ...rest}) => rest), [{by: 'settings tool', setting: 'maxOutputBytes', old: 16 * MiB, new: 4 * MiB, change: 'all sessions', session: A}]);
      // B and C are told it came from another session; A, who asked, is not told that
      for (const id of [B, C]) assert.deepStrictEqual(notices.take(null, id), ['maxOutputBytes changed to 4MiB for all sessions (changed from another session)'], id);
      assert.deepStrictEqual(notices.take(null, A), []);
    });

    it('another session\'s own looser value is dropped, and it is told; one that is tighter is kept', async () => {
      settings.set(B, 'maxOutputBytes', 32 * MiB, {loosening: true, over: 16 * MiB});
      settings.set(C, 'maxOutputBytes', 2 * MiB);
      await tool().set('maxOutputBytes', '4MiB', 'settings tool', ctx(A));
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 4 * MiB);
      assert.strictEqual(settings.effective(C, 'maxOutputBytes'), 2 * MiB, 'C\'s own, tighter');
      assert.deepStrictEqual(notices.take(null, B), ['your this-session loosening of maxOutputBytes ended: the default was lowered to 4MiB',
        'maxOutputBytes changed to 4MiB for all sessions (changed from another session)']);
    });

    // the reviewer's ruling on #296: a change for all drops a session's
    // confirmed LOOSENING above the new value; a session's own tightening is
    // its own choice and survives, held to the default while that is lower
    it('another session\'s own tightening survives a change for all: bounded by it now, and back when the default rises again', async () => {
      const t0 = tool();
      await t0.set('maxOutputBytes', '12MiB', 'settings tool', ctx(B, {scope: undefined}));   // B, for itself
      await t0.set('maxOutputBytes', '8MiB', 'settings tool', ctx(A));                         // A, for all
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 8 * MiB, 'held to the default in force');
      assert.deepStrictEqual(settings.overridesOf(B).map((o) => [o.name, o.value, o.loosening]), [['maxOutputBytes', 12 * MiB, false]], 'B\'s own value is kept');
      assert.deepStrictEqual(notices.take(null, B), ['maxOutputBytes changed to 8MiB for all sessions (changed from another session)'], 'and B is not told a loosening ended: it had none');
      // the default is raised later (A, for all, by its form): B runs at its own 12 MiB, not at the new default
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      await t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 12 * MiB);
      assert.strictEqual(settings.effective(C, 'maxOutputBytes'), 32 * MiB);
    });

    it('it is judged against the default in force, never the asking session\'s own value', async () => {
      // A runs at 2 MiB by its own tightening; 4 MiB for all is still a tightening of the 16 MiB default
      await tool().set('maxOutputBytes', '2MiB', 'settings tool', ctx(A, {scope: undefined}));
      const done = await tool().set('maxOutputBytes', '4MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 4 * MiB, applies: 'all sessions'});
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 2 * MiB, 'A keeps its own, tighter');
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 4 * MiB);
    });

    it('the timeout too: calls under way are re-armed, and the value is stored in ms as the file holds it', async () => {
      const Session = require('../../lib/session');
      const was = Session.rearmAll;
      let rearmed = 0;
      Session.rearmAll = () => { rearmed += 1; };
      try {
        const done = await tool().set('requestTimeout', '20s', 'settings tool', ctx(A));
        assert.deepStrictEqual(done, {name: 'requestTimeout', old: 30000, new: 20000, applies: 'all sessions'});
        assert.strictEqual(stored().requestTimeout, 20000);
        assert.strictEqual(options.requestTimeout, 20000);
        assert.strictEqual(rearmed, 1);
      } finally {
        Session.rearmAll = was;
      }
    });

    it('the value in force and in the file already: nothing changes, nothing is recorded, nobody is told', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * MiB}}));
      const before = fs.readFileSync(file);
      const done = await tool().set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 16 * MiB, applies: 'all sessions'});
      assert.deepStrictEqual(fs.readFileSync(file), before);
      assert.deepStrictEqual(history(), []);
      assert.deepStrictEqual(notices.take(null, B), []);
      assert.deepStrictEqual(sent, []);
    });

    it('a write never raises what the file yields: on a runtime started above it, a value between applies to every session now and is not stored', async () => {
      options.maxOutputBytes = 64 * MiB;   // started above the 16 MiB default by a flag; nothing stored
      const done = await tool().set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 64 * MiB, new: 32 * MiB, applies: 'all sessions, until the runtime restarts'});
      assert.ok(!fs.existsSync(file), 'settings.json not written: 32 MiB is above what it yields (16 MiB)');
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 32 * MiB);
      assert.deepStrictEqual(history().map((h) => [h.new, h.change, h.session]), [[32 * MiB, 'all sessions, until the runtime restarts', A]]);
      // the value in force there, asked for: it cannot be stored and changes nothing, so nothing is recorded
      const same = await tool().set('maxOutputBytes', '32MiB', 'settings tool', ctx(B));
      assert.deepStrictEqual(same, {name: 'maxOutputBytes', old: 32 * MiB, new: 32 * MiB, applies: 'all sessions, until the runtime restarts'});
      assert.strictEqual(history().length, 1);
      assert.ok(!fs.existsSync(file));
    });

    it('what the file yields is the file\'s own value when it holds one: a value above it is not stored, though it tightens what is in force', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 8 * MiB}}));   // the next start's, tighter than what runs
      const done = await tool().set('maxOutputBytes', '12MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 12 * MiB, applies: 'all sessions, until the runtime restarts'});
      assert.strictEqual(stored().maxOutputBytes, 8 * MiB, 'the file is not raised');
      assert.strictEqual(options.maxOutputBytes, 12 * MiB);
    });

    it('a stored raise awaiting the next start, cancelled for all sessions: said from the file\'s value, since nothing in force changes', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB}}));   // ch-local settings set, for the next start
      const done = await tool().set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 64 * MiB, new: 16 * MiB, applies: 'all sessions'});
      assert.strictEqual(stored().maxOutputBytes, 16 * MiB);
      assert.deepStrictEqual(history().map((h) => [h.old, h.new, h.change]), [[64 * MiB, 16 * MiB, 'all sessions']]);
      assert.deepStrictEqual(sent, [], 'nothing in force changed');
    });

    it('a change made for all sessions is in every session\'s history, with no session\'s id; a request that was not made is the asking session\'s only', async () => {
      const t0 = tool();
      await t0.set('maxOutputBytes', '4MiB', 'settings tool', ctx(A));
      const under = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 24 * MiB, forbid: [], conversation: true}})});
      await refused(under.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A)), 'SETTING_ABOVE_CEILING');
      const seen = (got) => got.history.map((h) => [h.setting, h.old !== undefined ? h.old : null, h.new !== undefined ? h.new : (h.asked !== undefined ? h.asked : null), h.change]);
      const made = ['maxOutputBytes', 16 * MiB, 4 * MiB, 'all sessions'];
      assert.deepStrictEqual(seen(await t0.get(ctx(A))), [made, ['maxOutputBytes', null, 32 * MiB, 'refused by the ceiling']]);
      assert.deepStrictEqual(seen(await t0.get(ctx(B))), [made]);
      // a session opened later reads why the value is what it is
      const D = 'd'.repeat(32);
      openSession(D);
      assert.deepStrictEqual(seen(await t0.get(ctx(D))), [made]);
      for (const id of [A, B, D]) assert.ok((await t0.get(ctx(id))).history.every((h) => h.session === undefined), id);
    });

    it('a request for all sessions that is not made says so: its line carries the scope, and is not counted with a this-session one', async () => {
      const under = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 24 * MiB, forbid: [], conversation: true}})});
      await refused(under.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A, {scope: undefined})), 'SETTING_ABOVE_CEILING');
      await refused(under.set('maxOutputBytes', '64MiB', 'settings tool', ctx(A)), 'SETTING_ABOVE_CEILING');
      assert.deepStrictEqual(history().map((h) => [h.asked, h.change, h.scope]), [[32 * MiB, 'refused by the ceiling', undefined], [64 * MiB, 'refused by the ceiling', 'all-sessions']]);
      // a declined form, and one left for another, say what they were for
      const t0 = tool();
      const r = await t0.set('requestTimeout', '60s', 'settings tool', ctx(B));
      await t0.confirm('requestTimeout', '60s', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(B));
      await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(C));
      await t0.set('maxOutputBytes', '48MiB', 'settings tool', ctx(C));
      assert.deepStrictEqual(history().filter((h) => h.session !== A).map((h) => [h.asked, h.change, h.scope]), [[60000, 'declined', 'all-sessions'], [32 * MiB, 'replaced', 'all-sessions']]);
      assert.strictEqual((await t0.get(ctx(B))).history.pop().scope, 'all-sessions', 'and get shows it');
    });

    it('each is one of the asking session\'s 32 recorded changes', async () => {
      const t0 = tool();
      for (let i = 0; i < 32; i++) await t0.set('requestTimeout', String(30000 - 1 - i), 'settings tool', ctx(A));
      await refused(t0.set('maxOutputBytes', '4MiB', 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      assert.ok((await t0.set('maxOutputBytes', '4MiB', 'settings tool', ctx(B))).new === 4 * MiB, 'another session has its own');
    });
  });

  describe('a loosening for all sessions: always the form, which names all sessions', () => {
    it('the form says all sessions; accepted, settings.json holds the value and every session runs under it, unless its own is tighter', async () => {
      settings.set(C, 'maxOutputBytes', 2 * MiB);
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      const form = r.inputRequired.inputRequests.approve;
      assert.strictEqual(form.params.message, 'Allow countinghouse tools in all your sessions to return up to 32MiB per call (now 16MiB)? This changes the setting for every session, now and after a restart.');
      assert.deepStrictEqual(form.params.requestedSchema, {type: 'object', properties: {approve: {type: 'boolean', title: 'Approve'}}, required: ['approve']});
      assert.ok(!fs.existsSync(file), 'nothing yet');
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      const done = await t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 32 * MiB, applies: 'all sessions'});
      assert.strictEqual(stored().maxOutputBytes, 32 * MiB);
      // in force at once, as a confirmed raise is: the validators grown first, the option, the workers told
      assert.deepStrictEqual(grown, [32 * MiB]);
      assert.strictEqual(options.maxOutputBytes, 32 * MiB);
      assert.deepStrictEqual(sent.map((m) => [m.command, m.options.maxOutputBytes]), [['live-options', 32 * MiB]]);
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 32 * MiB);
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 32 * MiB);
      assert.strictEqual(settings.effective(C, 'maxOutputBytes'), 2 * MiB, 'its own, tighter');
      assert.strictEqual(settings.limitsOf(A), null, 'no override of A\'s: it is the default now');
      assert.deepStrictEqual((({at, ...rest}) => rest)(history().pop()), {by: 'settings tool', setting: 'maxOutputBytes', old: 16 * MiB, new: 32 * MiB, change: 'all sessions',
        confirmed: 'elicitation (claude-code 2.1.323)', session: A});
      assert.deepStrictEqual(notices.take(null, B), ['maxOutputBytes changed to 32MiB for all sessions (changed from another session)']);
      assert.deepStrictEqual(notices.take(null, A), ['maxOutputBytes raised from 16MiB to 32MiB for all sessions (confirmed in claude-code)']);
    });

    it('the form\'s text in both languages, for both caps', async () => {
      const en = await tool().set('requestTimeout', '60s', 'settings tool', ctx(A));
      assert.strictEqual(en.inputRequired.inputRequests.approve.params.message,
        'Allow countinghouse tool calls in all your sessions to run for up to 60s (now 30s)? This changes the setting for every session, now and after a restart.');
      options.locale = 'zh-CN';
      const zh = await tool().set('maxOutputBytes', '32MiB', 'settings tool', ctx(B));
      assert.strictEqual(zh.inputRequired.inputRequests.approve.params.message, '允许 countinghouse 工具在你的所有会话中每次调用最多返回 32MiB（当前为 16MiB）吗？此更改对所有会话生效，重启后仍然有效。');
      const zh2 = await tool().set('requestTimeout', '60s', 'settings tool', ctx(C));
      assert.strictEqual(zh2.inputRequired.inputRequests.approve.params.message, '允许 countinghouse 工具在你的所有会话中每次调用最长运行 60s（当前为 30s）吗？此更改对所有会话生效，重启后仍然有效。');
    });

    it('it is judged against the default in force: a value above it needs the form though the asking session runs higher by its own', async () => {
      settings.set(A, 'maxOutputBytes', 64 * MiB, {loosening: true, over: 16 * MiB});
      const r = await tool().set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      assert.match(r.inputRequired.inputRequests.approve.params.message, /up to 32MiB per call \(now 16MiB\)/);
    });

    it('the form a user saw is the change that is made: a this-session form confirms nothing for all sessions, and the other way round', async () => {
      const t0 = tool();
      const own = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A, {scope: undefined}));
      assert.match(own.inputRequired.inputRequests.approve.params.message, /this session only/);
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: own.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CONFIRMATION_INVALID');
      assert.ok(!fs.existsSync(file), 'settings.json not written');
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      const all = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(B));
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: all.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B, {scope: undefined})), 'SETTING_CONFIRMATION_INVALID');
      assert.strictEqual(settings.limitsOf(B), null);
      // B's all-sessions form is still good for what it said
      assert.strictEqual((await t0.confirm('maxOutputBytes', '32MiB', {requestState: all.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B))).applies, 'all sessions');
    });

    it('declined: nothing changes; it counts in the user\'s window and locks the kind for the asking session, as any decline does', async () => {
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      assert.deepStrictEqual(await t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A)),
        {name: 'maxOutputBytes', old: 16 * MiB, new: 16 * MiB, applies: 'declined'});
      assert.ok(!fs.existsSync(file));
      assert.strictEqual(confirm.userWindow().count('maxOutputBytes'), 1);
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 2, 'it spent one of A\'s forms');
      await refused(t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      await refused(t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A, {scope: undefined})), 'SETTING_DECLINED_THIS_SESSION');
      assert.ok(history().some((h) => h.session === A && h.change === 'declined'));
    });

    it('under a 64 MiB ceiling, 128 MiB for all sessions is refused with the ceiling\'s error and no form; the file is unchanged', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * MiB}}));
      const before = fs.readFileSync(file);
      const under = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 64 * MiB, forbid: [], conversation: true}})});
      const e = await refused(under.set('maxOutputBytes', '128MiB', 'settings tool', ctx(A)), 'SETTING_ABOVE_CEILING');
      assert.match(e.message, /at most 64MiB/);
      assert.deepStrictEqual(fs.readFileSync(file), before);
      assert.strictEqual(confirm.confirmations(A).formsLeft(), 3, 'no form was spent');
      // and a ceiling that turns conversation off: no form
      const off = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: false}})});
      await refused(off.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
    });

    it('a session whose client does not answer "ok, yes", or that is latched, gets no all-sessions form (F1, N1)', async () => {
      const t0 = tool();
      for (const answer of [null, {status: 'failed', conditions: null, repo: null}]) {
        sources[B].answer = answer;
        await refused(t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
      }
      sources[C].emit('client', {status: 'ok', conditions: 'no', repo: null});
      await refused(t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(C)), 'SETTING_CLIENT_NOT_CONFIRMED');
      // yes at the form, gone at the confirmation
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      sources[A].answer = null;
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(!fs.existsSync(file));
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
    });

    it('the default changed while the form was up (a terminal change, or another session\'s for all): not applied', async () => {
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      await t0.set('maxOutputBytes', '8MiB', 'settings tool', ctx(B));
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_CHANGED_MEANWHILE');
      assert.strictEqual(stored().maxOutputBytes, 8 * MiB);
      assert.strictEqual(options.maxOutputBytes, 8 * MiB);
    });

    it('a confirmed change that cannot be applied changes nothing: the file is not written', async () => {
      const failing = tool({growValidators: async () => { throw Object.assign(new Error('no'), {code: 'RESIZE_FAILED'}); }});
      const r = await failing.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      const e = await refused(failing.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NOT_APPLIED_ALL_SESSIONS');
      assert.strictEqual(e.message, 'The change to maxOutputBytes for all sessions could not be applied (RESIZE_FAILED); nothing was changed.');
      assert.ok(!fs.existsSync(file));
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      // no line says a change for all sessions was made; one says it was not applied
      assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => [h.change, h.problem]), [['not applied', 'RESIZE_FAILED']]);
      assert.deepStrictEqual(notices.take(null, B), [], 'nobody is told of a change not made');
      assert.deepStrictEqual(sent, []);
    });

    // my /code-review: the validators' growth is a wait (seconds). What is
    // checked is checked after it, in the one lock that also stores the
    // change and puts it in force, with no wait in between.
    describe('whatever happens while the validators grow, the change is checked after it', () => {
      const during = async (what, code, o = {}) => {
        const t0 = tool(Object.assign({growValidators: async (bytes) => { grown.push(bytes); await what(t0); }}, o));
        const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
        const e = await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), code);
        assert.deepStrictEqual(grown, [32 * MiB], 'the growth ran');
        assert.notStrictEqual(options.maxOutputBytes, 32 * MiB, 'not in force');
        assert.ok(!fs.existsSync(file) || stored().maxOutputBytes !== 32 * MiB, 'not stored');
        assert.ok(!history().some((h) => h.change === 'all sessions' && h.new === 32 * MiB), 'no line says it was made');
        assert.deepStrictEqual(notices.take(null, C), [], 'nobody else is told');
        return e;
      };

      it('the asking session latched (its client said no): not applied', async () => {
        await during(async () => { sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null}); }, 'SETTING_CLIENT_NOT_CONFIRMED');
      });

      it('the asking session ended: not applied', async () => {
        await during(async () => { sources[A].emit('end'); }, 'MODULE_NOT_LISTED');
      });

      it('the default changed (another session\'s tightening for all): not applied', async () => {
        await during(async (t0) => { await t0.set('maxOutputBytes', '8MiB', 'settings tool', ctx(B)); notices.take(null, C); }, 'SETTING_CHANGED_MEANWHILE');
        assert.strictEqual(options.maxOutputBytes, 8 * MiB);
        assert.strictEqual(stored().maxOutputBytes, 8 * MiB);
      });

      it('a ceiling put under the value: it is the ceiling as it is then that binds', async () => {
        let c = {state: 'none'};
        await during(async () => { c = {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 24 * MiB, forbid: [], conversation: true}}; },
          'SETTING_ABOVE_CEILING', {ceiling: () => c});
        assert.deepStrictEqual(history().filter((h) => h.session === A).map((h) => [h.asked, h.change, h.scope]), [[32 * MiB, 'not applied (above the ceiling)', 'all-sessions']]);
      });

      it('the file changed since the form was shown (a terminal change written, its control set not here yet): the terminal\'s wins, and is not overwritten', async () => {
        await during(async () => { fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 8 * MiB}})); }, 'SETTING_CHANGED_MEANWHILE');
        assert.strictEqual(stored().maxOutputBytes, 8 * MiB, 'the terminal\'s value is still the file\'s');
        assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      });
    });

    it('the confirmation is held to the ceiling as it is then, and to the asking session\'s 32 recorded changes', async () => {
      // a ceiling that allowed the form, lowered before the answer
      let max = 64 * MiB;
      const under = tool({ceiling: () => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: max, forbid: [], conversation: true}})});
      const r = await under.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      max = 24 * MiB;
      await refused(under.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_ABOVE_CEILING');
      assert.ok(!fs.existsSync(file));
      // 31 tightenings, a form, a 32nd change, then the accept
      const t0 = tool();
      for (let i = 0; i < 31; i++) await t0.set('requestTimeout', String(30000 - 1 - i), 'settings tool', ctx(B, {scope: undefined}));
      const rb = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(B));
      await t0.set('requestTimeout', '20s', 'settings tool', ctx(B, {scope: undefined}));
      await refused(t0.confirm('maxOutputBytes', '32MiB', {requestState: rb.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      assert.ok(!fs.existsSync(file));
    });

    it('a settings file that cannot be written: nothing is put in force, and nobody is told', async () => {
      const t0 = tool();
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      fs.mkdirSync(file);   // no file can be renamed onto a directory that holds something
      fs.writeFileSync(path.join(file, 'x'), '');
      let err = null;
      try { await t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)); } catch (e) { err = e; }
      assert.ok(err != null && err.code === 'SETTINGS_FILE_INVALID', String(err && err.code));
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(notices.take(null, B), []);
      fs.rmSync(file, {recursive: true});
    });

    it('the session that asked gets the value too: its own lower value for that cap goes, and it is told; a higher one of its own stays', async () => {
      const t0 = tool();
      settings.set(A, 'maxOutputBytes', 2 * MiB);
      const r = await t0.set('maxOutputBytes', '32MiB', 'settings tool', ctx(A));
      await t0.confirm('maxOutputBytes', '32MiB', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.strictEqual(settings.effective(A, 'maxOutputBytes'), 32 * MiB, 'A asked for all sessions, itself included');
      assert.strictEqual(settings.limitsOf(A), null);
      assert.deepStrictEqual(notices.take(null, A), ['maxOutputBytes raised from 16MiB to 32MiB for all sessions (confirmed in claude-code); this session\'s own 2MiB no longer applies']);
      // B, with a confirmed value of its own above the new default, asks 48 MiB for all: its own 64 MiB stays
      settings.set(B, 'maxOutputBytes', 64 * MiB, {loosening: true, over: 32 * MiB});
      const rb = await t0.set('maxOutputBytes', '48MiB', 'settings tool', ctx(B));
      await t0.confirm('maxOutputBytes', '48MiB', {requestState: rb.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B));
      assert.strictEqual(settings.effective(B, 'maxOutputBytes'), 64 * MiB);
    });
  });

  describe('what it is not', () => {
    it('any other setting stays the terminal\'s for all sessions too: refused, and the file\'s bytes are unchanged', async () => {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * MiB}}));
      const before = fs.readFileSync(file);
      // (a module's on/off is every session's, whatever the scope: sessions 37)
      for (const [name, value] of [['moduleSandbox', 'audit'], ['moduleSandbox', 'enforce'], ['locale', 'zh'], ['autoUpgrade', 'off'], ['upgradeCheck', 'never']]) {
        const e = await refused(tool().set(name, value, 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
        assert.match(e.message, /ch-local settings set/);
      }
      assert.deepStrictEqual(fs.readFileSync(file), before);
    });

    it('a scope that is not one is refused, in a set and in a retry', async () => {
      for (const scope of ['everyone', '', 7, null, 'ALL-SESSIONS', 'this-session']) {
        await refused(tool().set('maxOutputBytes', '4MiB', 'settings tool', ctx(A, {scope})), 'ARGUMENTS_INVALID');
        await refused(tool().confirm('maxOutputBytes', '32MiB', {requestState: 'x', inputResponses: ACCEPT}, ctx(A, {scope})), 'ARGUMENTS_INVALID');
      }
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
    });

    it('it is a shared runtime\'s: under --stdio, where there is one session, the scope is refused', async () => {
      const stdio = settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'none'})});
      await refused(stdio.set('maxOutputBytes', '4MiB', 'settings tool', {scope: 'all-sessions'}), 'ARGUMENTS_INVALID');
      assert.ok(!fs.existsSync(file));
    });

    it('a session that has ended changes nothing for anyone', async () => {
      sources[A].emit('end');
      await refused(tool().set('maxOutputBytes', '4MiB', 'settings tool', ctx(A)), 'MODULE_NOT_LISTED');
      assert.ok(!fs.existsSync(file));
      assert.strictEqual(options.maxOutputBytes, 16 * MiB);
    });
  });

  describe('the confirmation store binds the scope (lib/settings-confirm.js)', () => {
    const change = (over = {}) => Object.assign({name: 'maxOutputBytes', old: 16 * MiB, next: 32 * MiB, client: CLIENT, session: A}, over);
    const retry = (over = {}) => Object.assign({name: 'maxOutputBytes', next: 32 * MiB, session: A}, over);

    it('a state staged for all sessions verifies only as that; one staged with no scope only as that', () => {
      const a = confirm.confirmations(A);
      const all = a.stage(change({scope: 'all-sessions'}));
      assert.strictEqual(a.verify(all.requestState, retry(), {consume: false}).ok, false);
      assert.strictEqual(a.verify(all.requestState, retry({scope: 'all-sessions'}), {consume: false}).ok, true);
      assert.strictEqual(a.verify(all.requestState, retry({scope: 'all-sessions'})).staged.scope, 'all-sessions');
      const own = a.stage(change());
      assert.strictEqual(a.verify(own.requestState, retry({scope: 'all-sessions'}), {consume: false}).ok, false);
      assert.strictEqual(a.verify(own.requestState, retry()).staged.scope, undefined, 'a change with no scope is the shape it always was');
    });

    it('the scope is in the MAC, and a state with none is byte for byte what it was', () => {
      const a = confirm.confirmations(A);
      const nonce = 'N'.repeat(22);
      assert.notStrictEqual(a.macOf(nonce, retry()), a.macOf(nonce, retry({scope: 'all-sessions'})));
      const crypto = require('crypto');
      assert.strictEqual(a.macOf(nonce, retry()), crypto.createHmac('sha256', a.key).update(JSON.stringify(['countinghouse-confirm/1', nonce, A, 'maxOutputBytes', 32 * MiB])).digest('base64url'));
    });
  });
});
