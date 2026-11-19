'use strict';
// Shared runtime B5, Task 3 (docs/superpowers/plans/2026-11-16-shared-runtime-b5-session-views.md):
// the settings history, what was left after B2's Task 4. `get` reads the
// history back from its end until it has the lines the session may see, or
// reaches the file's start, or has read 1 MiB: another session's lines
// can't push a session's own, or a line for every session, out of its view.
// And every line written in a session's path names that session: a writer
// asked to write one that doesn't writes nothing and throws. Server-free:
// real shared sessions, settings and confirmations; the file is the test's.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const confirm = require('../../lib/settings-confirm');
const settingsTool = require('../../lib/settings-tool');
// the module manager the tool reads what is loaded from (#449's high
// review, round 6, 8): none loaded here
const NO_MODULES = {modules: {}};

const MiB = 1024 * 1024;

describe('sessions 25: the settings history, per session (shared runtime B5, Task 3)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const CLIENT = {name: 'claude-code', version: '2.1.323'};
  const DECLINE = {approve: {action: 'decline'}};
  let reg;
  let sources;
  let home;
  let file;
  let historyFile;
  let saved;
  const openSession = (id, conditions = {status: 'ok', conditions: 'yes', repo: null}) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = Object.assign({}, conditions);
    s.connected = true;
    s.answer = conditions;
    s.notify = () => {};
    s.record = () => {};
    s.forget = () => {};
    s.askConditions = async () => (s.answer == null ? null : Object.assign({}, s.answer));
    sources[id] = s;
    reg.emit('session', s);
    return s;
  };
  const ctx = (id, over = {}) => Object.assign({shared: true, session: id, clientInfo: CLIENT, capabilities: {elicitation: {form: {}}}}, over);
  const tool = () => settingsTool.create({mm: NO_MODULES, file, lockWaitMs: 200, ceiling: () => ({state: 'none'}),
    sessionClient: (c) => (c.clientInfo != null ? {ok: true, client: c.clientInfo} : {ok: false, why: 'client unknown'}),
    growValidators: async () => {}});
  const lines = () => (fs.existsSync(historyFile) ? fs.readFileSync(historyFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const write = (entries) => fs.appendFileSync(historyFile, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  // a line of a session's own change; n tells them apart
  const own = (session, n) => ({at: '2026-11-17T00:00:00.000Z', by: 'settings tool', setting: 'requestTimeout', old: 30000, new: 30000 - n, change: 'this session', session});
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); confirm.resetForTests(); };

  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout, locale: options.locale, settingsFile: options.settingsFile};
    Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000, locale: 'en-US'});
    reset();
    settings.configure({ceiling: () => ({state: 'none'})});
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s25-'));
    file = path.join(home, 'settings.json');
    historyFile = path.join(home, 'history.jsonl');
    options.settingsFile = file;
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    openSession(A);
    openSession(B);
  });
  afterEach(() => { Object.assign(options, saved); reset(); fs.rmSync(home, {recursive: true, force: true}); });

  describe('the look-back', () => {
    it('three of B\'s, 400 of A\'s (over 64 KiB), one for everyone: B sees its three and that one; A its last 50', async () => {
      const global = {at: '2026-11-17T00:00:01.000Z', by: 'ch-local', setting: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, change: 'this start'};
      write([own(B, 1), own(B, 2), own(B, 3)]);
      write(Array.from({length: 400}, (_, i) => own(A, 100 + i)));
      write([global]);
      assert.ok(fs.statSync(historyFile).size > 64 * 1024, 'the file is past the first step');
      const ofB = (await tool().get(ctx(B))).history;
      assert.deepStrictEqual(ofB.map((h) => [h.new, h.change]), [[29999, 'this session'], [29998, 'this session'], [29997, 'this session'], [4 * MiB, 'this start']]);
      const ofA = (await tool().get(ctx(A))).history;
      assert.strictEqual(ofA.length, 50);
      assert.deepStrictEqual(ofA[ofA.length - 1], global);
      assert.strictEqual(ofA[0].new, 30000 - 451, 'the last 49 of A\'s, then the global one');
    });

    it('a line A made for all sessions, behind 400 of A\'s own, is still shown to B, without its session', async () => {
      write([{at: '2026-11-17T00:00:00.000Z', by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, change: 'all sessions, until the runtime restarts', session: A}]);
      write(Array.from({length: 400}, (_, i) => own(A, 100 + i)));
      const ofB = (await tool().get(ctx(B))).history;
      assert.deepStrictEqual(ofB, [{at: '2026-11-17T00:00:00.000Z', by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, change: 'all sessions, until the runtime restarts'}]);
    });

    it('over 1 MiB of A\'s after B\'s: B\'s get stops at the bound and returns what it found', async () => {
      write([own(B, 1)]);
      const chunk = Array.from({length: 1000}, (_, i) => own(A, i));
      while (fs.statSync(historyFile).size <= 1.2 * MiB) write(chunk);
      const started = Date.now();
      const ofB = (await tool().get(ctx(B))).history;
      assert.deepStrictEqual(ofB, [], 'B\'s line is past the bound');
      assert.ok(Date.now() - started < 2000);
    });

    it('a line cut at a step\'s edge is read whole, a two-byte character split by the edge too', async () => {
      // B's line ends in "é"}\n; A's lines after it are 64 KiB less 4 bytes, so
      // the first step's edge falls between the two bytes of its é
      const bytes = (e) => Buffer.byteLength(`${JSON.stringify(e)}\n`);
      const mine = Object.assign(own(B, 1), {problem: 'xxé'});
      write([own(B, 2), mine]);
      let left = 64 * 1024 - 4;
      let n = 0;
      while (left > 2 * bytes(own(A, 999))) { const e = own(A, n++); write([e]); left -= bytes(e); }
      const last = own(A, n);
      last.problem = 'y'.repeat(left - bytes(Object.assign({}, last, {problem: ''})));
      write([last]);
      const size = fs.statSync(historyFile).size;
      const raw = fs.readFileSync(historyFile);
      assert.deepStrictEqual([raw[size - 64 * 1024 - 1], raw[size - 64 * 1024]], [0xc3, 0xa9], 'the edge splits é');
      const ofB = (await tool().get(ctx(B))).history;
      assert.deepStrictEqual(ofB.map((h) => [h.new, h.problem]), [[29998, undefined], [29999, 'xxé']]);
    });

    it('under --stdio (no session) get\'s history is the file\'s last 50, as before', async () => {
      sessions.resetForTests();
      const stdio = Array.from({length: 60}, (_, i) => ({at: '2026-11-17T00:00:00.000Z', by: 'settings tool', setting: 'requestTimeout', old: 30000, new: 20000 + i, change: 'this start', host: 'h', pid: 1}));
      write(stdio);
      const got = (await tool().get()).history;
      assert.deepStrictEqual(got, stdio.slice(-50).map(({host, pid, ...rest}) => rest));
    });
  });

  describe('every line a session writes names it', () => {
    it('a tightening, a refused loosening, a decline, a replay, the counts and the unanswered form at its end: each line A\'s, none shown to B, no id in any answer', async () => {
      const t = tool();
      await t.set('requestTimeout', '20s', 'settings tool', ctx(A));                                       // a tightening
      for (let i = 0; i < 2; i++) await t.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A, {clientInfo: null})).catch(() => {});   // refused, then counted
      const r = await t.set('maxOutputBytes', '16MiB', 'settings tool', ctx(A));
      await t.confirm('maxOutputBytes', '16MiB', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(A));   // a decline
      await t.set('requestTimeout', '40s', 'settings tool', ctx(A));                                       // a form left pending
      sources[A].emit('replay', [{requestTimeout: 15000}]);                                                 // a replay
      const ofB = await tool().get(ctx(B));
      const ofA = await tool().get(ctx(A));
      sources[A].emit('end');                                                                               // the counts, the unanswered form
      const all = lines();
      const changes = all.map((l) => l.change);
      for (const want of ['this session', 'declined', 'this session (replayed after a restart)', 'expired']) assert.ok(changes.includes(want), `${want}: ${JSON.stringify(changes)}`);
      assert.ok(changes.some((c) => /asked again$/.test(c)), 'the counts');
      assert.ok(changes.some((c) => /^not confirmed/.test(c)), 'the refused loosening');
      assert.deepStrictEqual(all.filter((l) => l.session !== A), [], 'every line names A');
      assert.deepStrictEqual(ofB.history, []);
      assert.ok(ofA.history.length >= 4);
      for (const answer of [ofA, ofB, await tool().get(ctx(B))]) {
        assert.ok(!JSON.stringify(answer).includes(A) && !JSON.stringify(answer).includes(B), 'no session id in a get answer');
      }
    });

    const UNNAMED = /a history line written in a session's path names that session/;
    it('a writer asked, in a session\'s path, for a line that names no session or another one writes nothing and throws', async () => {
      assert.throws(() => settingsTool.recordUnanswered(undefined, [{name: 'maxOutputBytes', next: 16 * MiB}]), UNNAMED);
      assert.throws(() => settingsTool.recordUnanswered(null, [{name: 'maxOutputBytes', next: 16 * MiB}]), UNNAMED);
      assert.throws(() => settingsTool.recordReplayed(undefined, [{name: 'requestTimeout', old: 30000, next: 15000}]), UNNAMED);
      assert.throws(() => settingsTool.inSessionPath(A, () => settingsTool.appendHistoryLine(historyFile, {by: 'settings tool', setting: 'requestTimeout', change: 'this session'})), UNNAMED);
      assert.throws(() => settingsTool.inSessionPath(A, () => settingsTool.appendHistoryLine(historyFile, {by: 'settings tool', setting: 'requestTimeout', change: 'this session', session: B})), UNNAMED);
      assert.deepStrictEqual(lines(), [], 'nothing written');
      // its own: written; outside a session's path, as before
      settingsTool.inSessionPath(A, () => settingsTool.appendHistoryLine(historyFile, {by: 'settings tool', setting: 'requestTimeout', change: 'this session', session: A}));
      settingsTool.appendHistoryLine(historyFile, {by: 'settings tool', setting: 'requestTimeout', change: 'this start'});
      assert.deepStrictEqual(lines().map((l) => l.session), [A, undefined]);
    });
  });
});
