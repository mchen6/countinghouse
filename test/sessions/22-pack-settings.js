'use strict';
// Shared runtime B3, Task 8: packs turned on and off in conversation (the
// guard lifted). Turning a pack off for a session is a tightening: no form,
// the session's override becomes false. Turning one on is a loosening: the
// session's own form, naming the pack, its version from packs.json and "for
// this session"; on the accept, on the pack's chain: the ceiling; a pack
// already loaded only at the staged version; one not loaded loaded once
// (load-pack, shared by every session confirming meanwhile); everything
// checked again after the wait; then the override. The last session leaving
// a pack that isn't global asks its unload, on the same chain. Server-free:
// real shared sessions, settings, confirmations and session-packs; the
// control channel's ask is a stand-in that answers as ch-local's daemon does.
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
options.setOptions({redisUrl: 'redis://127.0.0.1:1'});
require('../../lib/logger').createLogger(false);
const notices = require('../../lib/notices');
const sessions = require('../../lib/sessions');
const settings = require('../../lib/session-settings');
const jobSessions = require('../../lib/job-sessions');
const confirm = require('../../lib/settings-confirm');
const settingsTool = require('../../lib/settings-tool');
const sessionPacks = require('../../lib/session-packs');

describe('sessions 22: packs turned on and off in conversation (shared runtime B3, Task 8)', () => {
  const A = 'a'.repeat(32);
  const B = 'b'.repeat(32);
  const CLIENT = {name: 'claude-code', version: '2.1.323'};
  const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};
  const DECLINE = {approve: {action: 'decline'}};
  let reg;
  let sources;
  let home;
  let file;
  let saved;
  let asked;        // what the runtime asked ch-local's daemon
  let loaded;       // pack -> its loaded version (what the daemon's load-pack did)
  let answer;       // (msg) -> the daemon's reply, or a Promise of it
  let ceiling;
  const openSession = (id) => {
    const s = new EventEmitter();
    s.id = id;
    s.client = {status: 'ok', conditions: 'yes', repo: null};
    s.connected = true;
    s.answer = {status: 'ok', conditions: 'yes', repo: null};
    s.notify = () => {};
    s.record = () => {};
    s.forget = () => {};
    s.askConditions = async() => (s.answer == null ? null : Object.assign({}, s.answer));
    sources[id] = s;
    reg.emit('session', s);
    return s;
  };
  const endSession = (id) => { sources[id].emit('end'); };
  const ctx = (id, over = {}) => Object.assign({shared: true, session: id, clientInfo: CLIENT, capabilities: {elicitation: {form: {}}}}, over);
  const tool = () => settingsTool.create({file, lockWaitMs: 200, ceiling: () => ceiling,
    sessionClient: (c) => ({ok: true, client: c.clientInfo}),
    ask: async(msg) => { asked.push(msg); return answer(msg); }});
  const history = () => (fs.existsSync(path.join(home, 'history.jsonl'))
    ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const refused = async(p, code) => {
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert.ok(err != null, `refused ${code}`);
    assert.strictEqual(err.code, code, err.message);
    return err;
  };
  const packsJson = (version) => fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({packs: {ci: {packages: {'@countinghouse/ch-pack-ci': version}}, docs: {packages: {'@countinghouse/ch-pack-docs': '2.0.0'}}}}));
  const loads = () => asked.filter((m) => m.type === 'load-pack');
  const unloads = () => asked.filter((m) => m.type === 'unload-pack');
  const reset = () => { sessions.resetForTests(); settings.resetForTests(); jobSessions.resetForTests(); notices.resetForTests(); settingsTool.resetForTests(); confirm.resetForTests(); sessionPacks.resetForTests(); };
  // A turns ci on through its form, accepted: -> the confirm's answer
  const turnOn = async(t, id, pack = 'ci') => {
    const r = await t.set(`pack.${pack}`, 'on', 'settings tool', ctx(id));
    assert.ok(r.inputRequired != null, JSON.stringify(r));
    return t.confirm(`pack.${pack}`, 'on', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(id));
  };

  beforeEach(() => {
    saved = {locale: options.locale, maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    Object.assign(options, {locale: 'en-US', maxOutputBytes: 16 * 1024 * 1024, requestTimeout: 30000});
    reset();
    ceiling = {state: 'none'};
    settings.configure({ceiling: () => ceiling, ceilingMemoMs: 0});
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s22-'));
    file = path.join(home, 'settings.json');
    packsJson('1.0.0');
    asked = [];
    loaded = new Map();
    answer = (msg) => {
      if (msg.type === 'load-pack') { loaded.set(msg.name, msg.version); sessionPacks.packChanged(msg.name); }
      if (msg.type === 'unload-pack') { loaded.delete(msg.name); sessionPacks.packGone(msg.name); }
      return {ok: true};
    };
    reg = new EventEmitter();
    sessions.attach(reg);
    sources = {};
    sessionPacks.configure({
      records: () => [...loaded.keys()].map((pack) => ({pack, modules: [`m-${pack}`]})),
      moduleOf: (deviceID) => deviceID.replace(/^d-/, 'm-'),
      overridesOf: settings.packOverridesOf, onOverrideChange: settings.onChange,
      openSessions: () => sessions.ids(), isOpen: (id) => sessions.get(id) != null, shared: () => sessions.shared(),
      allowsOn: settings.packOnAllowed, ceilingNow: settings.ceilingNow, ceilingKey: settings.ceilingKey,
      versionOf: (pack) => (loaded.has(pack) ? loaded.get(pack) : null),
      ask: async(msg) => { asked.push(msg); return answer(msg); }
    });
    for (const id of [A, B]) openSession(id);
  });
  afterEach(() => { Object.assign(options, saved); reset(); fs.rmSync(home, {recursive: true, force: true}); });

  describe('on: the session\'s own form, then one load', () => {
    it('A turns pack.ci on: a form "for this session" naming the pack and its version; one load-pack; A lists it, B doesn\'t; settings.json untouched; the history names A', async() => {
      const t = tool();
      const r = await t.set('pack.ci', 'on', 'settings tool', ctx(A));
      assert.match(r.inputRequired.inputRequests.approve.params.message, /ci 1\.0\.0 .*this session/);
      const done = await t.confirm('pack.ci', 'on', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      assert.strictEqual(done.applies, 'this session');
      assert.deepStrictEqual(loads(), [{type: 'load-pack', name: 'ci', version: '1.0.0'}]);
      assert.deepStrictEqual([sessionPacks.listsDevice(A, 'd-ci'), sessionPacks.listsDevice(B, 'd-ci')], [true, false]);
      assert.strictEqual(fs.existsSync(file), false, 'settings.json is not written');
      const line = history().filter((l) => l.setting === 'pack.ci' && l.change === 'this session');
      assert.deepStrictEqual(line.map((l) => l.session), [A]);
      // B's get: the pack off, and no line of A's
      const got = await t.get(ctx(B));
      const row = got.settings.find((s) => s.name === 'pack.ci');
      assert.ok(row == null || row.value === 'off', JSON.stringify(row));
      assert.ok(!JSON.stringify(got.history).includes(A));
    });

    it('the form in zh says this session too', async() => {
      options.locale = 'zh-CN';
      const r = await tool().set('pack.ci', 'on', 'settings tool', ctx(A));
      assert.match(r.inputRequired.inputRequests.approve.params.message, /ci.*1\.0\.0.*本会话/);
    });

    it('B turns it on too: its own form, no second load-pack, and both list it', async() => {
      const t = tool();
      await turnOn(t, A);
      await turnOn(t, B);
      assert.strictEqual(loads().length, 1);
      assert.deepStrictEqual([sessionPacks.listsDevice(A, 'd-ci'), sessionPacks.listsDevice(B, 'd-ci')], [true, true]);
    });

    it('a pack loaded at another version than the staged one is refused SETTING_NOT_APPLIED, naming no session', async() => {
      const t = tool();
      const r = await t.set('pack.ci', 'on', 'settings tool', ctx(A));
      loaded.set('ci', '1.1.0');   // B's load, at another version, landed meanwhile
      sessionPacks.packChanged('ci');
      const err = await refused(t.confirm('pack.ci', 'on', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A)), 'SETTING_NOT_APPLIED');
      assert.ok(!err.message.includes(A) && !err.message.includes(B), err.message);
      assert.notStrictEqual(settings.packOverridesOf(A).get('ci'), true, 'A has no "on"');
    });

    it('A and B accept within one load: one load-pack; a failed load leaves neither with it', async() => {
      const t = tool();
      let release;
      answer = (msg) => (msg.type === 'load-pack' ? new Promise((r) => { release = () => r({ok: false, code: 'CONTROL_FAILED'}); }) : {ok: true});
      const ra = await t.set('pack.ci', 'on', 'settings tool', ctx(A));
      const rb = await t.set('pack.ci', 'on', 'settings tool', ctx(B));
      const pa = t.confirm('pack.ci', 'on', {requestState: ra.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      const pb = t.confirm('pack.ci', 'on', {requestState: rb.inputRequired.requestState, inputResponses: ACCEPT}, ctx(B));
      // both confirms are waiting on the one load before it answers
      await new Promise((r) => setTimeout(r, 300));
      release();
      await refused(pa, 'SETTING_NOT_APPLIED');
      await refused(pb, 'SETTING_NOT_APPLIED');
      assert.strictEqual(loads().length, 1);
      assert.deepStrictEqual([settings.packOverridesOf(A).size, settings.packOverridesOf(B).size], [0, 0]);
    });
  });

  describe('off: a tightening, no form; the last one out asks the unload', () => {
    it('A ends: no unload-pack while B has it; B turns it off: one unload-pack, and no form', async() => {
      const t = tool();
      await turnOn(t, A);
      await turnOn(t, B);
      endSession(A);
      assert.deepStrictEqual(unloads(), []);
      const off = await t.set('pack.ci', 'off', 'settings tool', ctx(B));
      assert.deepStrictEqual([off.applies, off.new], ['this session', false]);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(unloads(), [{type: 'unload-pack', name: 'ci'}]);
    });

    it('B turns a global pack off: no form, hidden from B, A unchanged, no unload-pack; on again needs a form, and a decline keeps it hidden', async() => {
      const t = tool();
      loaded.set('docs', '2.0.0');
      sessionPacks.setGlobal('docs', true);
      const off = await t.set('pack.docs', 'off', 'settings tool', ctx(B));
      assert.strictEqual(off.applies, 'this session');
      assert.deepStrictEqual([sessionPacks.listsDevice(A, 'd-docs'), sessionPacks.listsDevice(B, 'd-docs')], [true, false]);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(unloads(), []);
      const r = await t.set('pack.docs', 'on', 'settings tool', ctx(B));
      assert.ok(r.inputRequired != null);
      await t.confirm('pack.docs', 'on', {requestState: r.inputRequired.requestState, inputResponses: DECLINE}, ctx(B));
      assert.strictEqual(sessionPacks.listsDevice(B, 'd-docs'), false);
    });
  });

  describe('after the wait, everything is checked again', () => {
    const during = async(happen) => {
      const t = tool();
      let release;
      answer = (msg) => {
        if (msg.type === 'load-pack') {
          return new Promise((r) => { release = () => { loaded.set('ci', msg.version); sessionPacks.packChanged('ci'); r({ok: true}); }; });
        }
        if (msg.type === 'unload-pack') { loaded.delete(msg.name); sessionPacks.packGone(msg.name); }
        return {ok: true};
      };
      const r = await t.set('pack.ci', 'on', 'settings tool', ctx(A));
      const p = t.confirm('pack.ci', 'on', {requestState: r.inputRequired.requestState, inputResponses: ACCEPT}, ctx(A));
      await new Promise((res) => setTimeout(res, 30));
      happen();
      release();
      let err = null;
      try { await p; } catch (e) { err = e; }
      await new Promise((res) => setTimeout(res, 20));
      return err;
    };
    // (once unloaded the pack's module is owned by no pack, and a call to it fails as not found: what
    // A holds is what's checked)
    const nothingApplied = (why) => {
      assert.notStrictEqual(settings.packOverridesOf(A).get('ci'), true, why);
      assert.deepStrictEqual(unloads(), [{type: 'unload-pack', name: 'ci'}], `${why}: one unload after the load`);
      assert.ok(history().some((l) => l.setting === 'pack.ci' && /not applied/.test(String(l.change))), JSON.stringify(history()));
    };
    it('A ends during its load', async() => {
      await during(() => endSession(A));
      nothingApplied('ended');
    });
    it('the ceiling stops allowing the pack during A\'s load', async() => {
      const err = await during(() => { ceiling = {state: 'trusted', ceiling: {packs: ['docs']}}; });
      assert.ok(err != null);
      nothingApplied('ceiling');
    });
    it('a lock falls on A during its load (its client says no)', async() => {
      const err = await during(() => { sources[A].emit('client', {status: 'ok', conditions: 'no', repo: null}); });
      assert.ok(err != null);
      nothingApplied('latched');
    });
    it('A\'s own override for the pack changes during its load', async() => {
      const err = await during(() => { settings.set(A, 'pack.ci', false, {}); });
      assert.ok(err != null);
      assert.strictEqual(settings.packOverridesOf(A).get('ci'), false, 'its own off stands');
      nothingApplied('changed');
    });
  });

  describe('what stays refused', () => {
    it('a pack for all sessions stays the terminal\'s; locale and moduleSandbox too', async() => {
      const t = tool();
      await refused(t.set('pack.ci', 'on', 'settings tool', ctx(A, {scope: 'all-sessions'})), 'SETTING_TERMINAL_ONLY_SHARED');
      await refused(t.set('locale', 'zh', 'settings tool', ctx(A)), 'SETTING_TERMINAL_ONLY_SHARED');
      assert.strictEqual(fs.existsSync(file), false);
    });

    it('a session whose client conditions aren\'t ok and yes gets no form', async() => {
      // its client answering no latches the session (B2's N1): no form, as for a cap
      sources[A].answer = {status: 'ok', conditions: 'no', repo: null};
      await refused(tool().set('pack.ci', 'on', 'settings tool', ctx(A)), 'SETTING_DECLINED_THIS_SESSION');
      // and one whose client is unknown gets none either
      sources[B].answer = null;
      await refused(tool().set('pack.ci', 'on', 'settings tool', ctx(B)), 'SETTING_NEEDS_CONFIRMATION');
      assert.deepStrictEqual(loads(), []);
    });
  });
});
