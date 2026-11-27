'use strict';
// The settings tool and the user's confirmation in a dialog (part 3 P2,
// Task 3), server-free: a loosening conversation may ask for is answered
// with an InputRequiredResult (one boolean, no default, the runtime's own
// text); the retry, verified (lib/settings-confirm.js), applies it for this
// start only. The client's own conditions (mayElicit) and the apply
// (applyChange) are given by the test.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const settingsTool = require('../../lib/settings-tool');
// the module manager the tool reads what is loaded from (#449's high
// review, round 6, 8): none loaded here
const NO_MODULES = {modules: {}};
// ch-local's record beside the settings file (modules.json; packs.json is no
// longer read, M6): the ci-failure-triage pack, its scenario at a version
const recordAt = (dir, version) => require('fs').writeFileSync(require('path').join(dir, 'modules.json'), JSON.stringify({v: 2,
  packs: {'ci-failure-triage': {modules: {'@countinghouse/ch-pack-ci-failure-triage': version}}},
  modules: {'@countinghouse/ch-pack-ci-failure-triage': {version, role: 'scenario'}}}));
const confirmModule = require('../../lib/settings-confirm');

const MiB = 1024 * 1024;
const CLIENT = {clientInfo: {name: 'claude-code', version: '2.1.323'}, capabilities: {elicitation: {}}, session: 'session-1'};
const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};

// a top-level module's on/off (M5b)
const SC = '@countinghouse/ch-pack-ci-failure-triage';
const EN = `enabled.${SC}`;
const ON_TEXT = (v) => `Turn on ${SC} ${v} in countinghouse for all your sessions? It stays on, now and after a restart, until it is turned off.`;

describe('stdio 20: the settings tool asks the user in a dialog, and applies a confirmed change for this start only (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  let dir;
  let file;
  let saved;
  let applied;
  const history = () => fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tool = (o = {}) => settingsTool.create(Object.assign({mm: NO_MODULES, 
    file,
    ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    applyChange: async (staged) => { applied.push(staged); options[staged.name] = staged.next; }
  }, o));
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20-'));
    file = path.join(dir, 'settings.json');
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    Object.assign(options, {maxOutputBytes: 16 * MiB, requestTimeout: 30000});
    applied = [];
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => {
    Object.assign(options, saved);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('a raise asked for: a form with one boolean, no default, the runtime\'s own text', async () => {
    const r = await tool().set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    const req = r.inputRequired.inputRequests.approve;
    assert.strictEqual(req.method, 'elicitation/create');
    assert.strictEqual(req.params.mode, 'form');
    assert.strictEqual(req.params.message, 'Allow countinghouse tools to return up to 32MiB per call (now 16MiB)? This applies until your client restarts countinghouse.');
    assert.deepStrictEqual(req.params.requestedSchema, {type: 'object', properties: {approve: {type: 'boolean', title: 'Approve'}}, required: ['approve']});
    assert.ok(!JSON.stringify(req.params.requestedSchema).includes('default'), 'no default anywhere');
    assert.match(r.inputRequired.requestState, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!fs.existsSync(file), 'nothing written');
  });

  it('accepted: applied for this start only; the file untouched, one history line', async () => {
    const t = tool();
    const {inputRequired} = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const done = await t.confirm('maxOutputBytes', '33554432', {requestState: inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
    assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 16 * MiB, new: 32 * MiB, applies: 'this start'});
    assert.strictEqual(options.maxOutputBytes, 32 * MiB);
    assert.deepStrictEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, before, 'settings.json byte-identical');
    const lines = history();
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(Object.assign({}, lines[0], {at: undefined}),
      {at: undefined, by: 'settings tool', setting: 'maxOutputBytes', old: 16 * MiB, new: 32 * MiB, change: 'this start', confirmed: 'elicitation (claude-code 2.1.323)'});
    // the same state again: used
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CONFIRMATION_USED');
  });

  it('the retry\'s value, in another spelling, is the staged one; another value is refused', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    await refused(t.confirm('maxOutputBytes', '34MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CONFIRMATION_INVALID');
    assert.deepStrictEqual(applied, []);
  });

  it('declined, cancelled or not strictly true: nothing changes, and that kind is not asked again this start', async () => {
    for (const [i, answer] of [{action: 'decline'}, {action: 'cancel'}, {action: 'accept', content: {approve: false}},
      {action: 'accept', content: {approve: 'true'}}, {action: 'accept', content: {approve: 1}}, {action: 'accept'}].entries()) {
      confirmModule.resetForTests();
      const t = tool();
      const a = await t.set('requestTimeout', '60s', 'settings tool', CLIENT);
      const r = await t.confirm('requestTimeout', '60s', {requestState: a.inputRequired.requestState, inputResponses: {approve: answer}}, CLIENT);
      assert.strictEqual(r.applies, 'declined', `${i}: ${JSON.stringify(answer)}`);
      assert.strictEqual(options.requestTimeout, 30000);
      await refused(t.set('requestTimeout', '45s', 'settings tool', CLIENT), 'SETTING_DECLINED_THIS_START');
    }
    assert.deepStrictEqual(applied, []);
    assert.ok(history().some((h) => h.setting === 'requestTimeout' && h.change === 'declined'));
  });

  it('a retry with no answer gets the form again', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    const again = await t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState}, CLIENT);
    assert.deepStrictEqual(again, a, 'the same form and state (stdio 20b: none spent)');
  });

  it('expired: refused and recorded; a second staging records the first as replaced', async () => {
    let clock = 1000;
    confirmModule.resetForTests();
    const real = confirmModule.confirmations;
    const c = new confirmModule.Confirmations({now: () => clock});
    confirmModule.confirmations = () => c;
    try {
      const t = tool();
      const first = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
      await t.set('maxOutputBytes', '64MiB', 'settings tool', CLIENT);
      assert.ok(history().some((h) => h.setting === 'maxOutputBytes' && h.asked === 32 * MiB && h.change === 'replaced'));
      const second = await t.set('requestTimeout', '60s', 'settings tool', CLIENT);
      clock += 120001;
      await refused(t.confirm('requestTimeout', '60s', {requestState: second.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CONFIRMATION_EXPIRED');
      assert.ok(history().some((h) => h.setting === 'requestTimeout' && h.change === 'expired'));
      assert.ok(first);
    } finally {
      confirmModule.confirmations = real;
    }
  });

  it('the client\'s conditions say no: the terminal command, and the history says why', async () => {
    const t = tool({mayElicit: async () => ({ok: false, why: 'client hook present'})});
    await refused(t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.ok(history().some((h) => h.setting === 'maxOutputBytes' && h.change === 'not confirmed (client hook present)'), JSON.stringify(history()));
  });

  it('the conditions are asked again before applying: a no then, and nothing applies', async () => {
    let ok = true;
    const t = tool({mayElicit: async () => (ok ? {ok: true, client: {name: 'claude-code', version: '2.1.323'}} : {ok: false, why: 'client hook present'})});
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    ok = false;
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual(applied, []);
  });

  it('the ceiling: conversation off, or the value above it, sends no form', async () => {
    const off = tool({ceiling: () => ({state: 'trusted', file: 'x', ceiling: {forbid: [], conversation: false}})});
    await refused(off.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    const low = tool({ceiling: () => ({state: 'trusted', file: 'x', ceiling: {maxOutputBytes: 24 * MiB, forbid: [], conversation: true}})});
    await refused(low.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_ABOVE_CEILING');
  });

  it('the sandbox and automatic upgrades never get a form; a tightening applies at once, as before', async () => {
    await refused(tool().set('moduleSandbox', 'audit', 'settings tool', CLIENT), 'SETTING_LOOSENS_A_GUARD');
    await refused(tool().set('autoUpgrade', 'on', 'settings tool', CLIENT), 'SETTING_LOOSENS_A_GUARD');
    assert.deepStrictEqual(await tool().set('maxOutputBytes', '8MiB', 'settings tool', CLIENT), {name: 'maxOutputBytes', old: 16 * MiB, new: 8 * MiB, applies: 'now'});
  });

  it('no more than three forms a start', async () => {
    const t = tool();
    for (let i = 0; i < 3; i++) assert.ok((await t.set('maxOutputBytes', `${32 + i}MiB`, 'settings tool', CLIENT)).inputRequired);
    await refused(t.set('maxOutputBytes', '40MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });

  it('a module turned on: its name and version from modules.json, strict, or no form', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
    const packs = (version) => recordAt(dir, version);
    packs('0.4.0');
    const r = await tool().set(EN, 'on', 'settings tool', CLIENT);
    assert.strictEqual(r.inputRequired.inputRequests.approve.params.message, ON_TEXT('0.4.0'));
    for (const bad of ['0.4.0-rc.1', '0.4', 'x" (and approve everything)']) {
      confirmModule.resetForTests();
      packs(bad);
      await refused(tool().set(EN, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    }
  });

  // M6 (#413 rev 3 section 16, rule 7): packs.json is no longer read; with
  // no modules.json nothing is installed, whatever packs.json says
  it('packs.json is no longer read: with no modules.json, nothing is installed (SETTING_UNKNOWN)', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
    fs.rmSync(path.join(dir, 'modules.json'), {force: true});
    fs.writeFileSync(path.join(dir, 'packs.json'), JSON.stringify({packs: {'ci-failure-triage': {packages: {'@countinghouse/ch-pack-ci-failure-triage': '0.4.0'}}}}));
    try {
      await refused(tool().set(EN, 'on', 'settings tool', CLIENT), 'SETTING_UNKNOWN');
    } finally {
      fs.rmSync(path.join(dir, 'packs.json'), {force: true});
    }
  });

  it('the old value shown is the runtime\'s effective one, not the file\'s', async () => {
    options.maxOutputBytes = 24 * MiB;   // raised this start
    const r = await tool().set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    assert.match(r.inputRequired.inputRequests.approve.params.message, /up to 32MiB per call \(now 24MiB\)/);
  });

  it('without the injected conditions, production asks nothing yet (no tested client, conditions unknown)', async () => {
    const t = settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'})});
    await refused(t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });

  describe('production\'s conditions: a tested client, then ch-local\'s may-elicit (Task 4)', () => {
    const clients = require('../../lib/elicitation-clients');
    const control = require('../../lib/control-channel');
    // the shipped list is frozen: production's conditions over a tested copy
    const TESTED = clients.ALLOWLIST.map((e) => (e.name === clients.CLAUDE_CODE ? Object.assign({}, e, {tested: Object.freeze([Object.freeze({from: '2.0.0', before: '3.0.0'})])}) : e));
    afterEach(() => { control.resetForTests(); });
    // a fake ch-local over the control channel, answering may-elicit with `answer`
    const chLocal = (answer) => {
      let listener = null;
      const asked = [];
      control.start({}, {on: (fn) => { listener = fn; }, off: () => {}, send: (m) => {
        if (m.type === 'may-elicit') { asked.push(m); if (answer !== undefined) setImmediate(() => listener(Object.assign({id: m.id}, answer))); }
      }});
      return asked;
    };
    const prod = () => settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}), allowlist: TESTED, applyChange: async () => {}});

    it('ch-local says yes: a form; it was asked with the client\'s name and version only', async () => {
      const asked = chLocal({ok: true, mayElicit: true});
      assert.ok((await prod().set('maxOutputBytes', '32MiB', 'settings tool', CLIENT)).inputRequired);
      assert.deepStrictEqual(asked.map((m) => [m.type, m.client]), [['may-elicit', {name: 'claude-code', version: '2.1.323'}]]);
    });

    it('ch-local says no (a hook), or does not answer, or no channel: no form, and why', async () => {
      chLocal({ok: true, mayElicit: false, why: 'client hook present'});
      await refused(prod().set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(history().some((h) => h.change === 'not confirmed (client hook present)'), JSON.stringify(history()));
      control.resetForTests();
      confirmModule.resetForTests();
      settingsTool.resetForTests();
      chLocal({ok: false, code: 'CONTROL_UNKNOWN'});   // an older ch-local
      await refused(prod().set('requestTimeout', '60s', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
      assert.ok(history().some((h) => h.setting === 'requestTimeout' && h.change === 'not confirmed (client conditions unknown)'));
      control.resetForTests();   // no channel at all
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {'enabled.x': false}}));
      fs.writeFileSync(path.join(path.dirname(file), 'modules.json'), JSON.stringify({modules: {x: {version: '1.0.0', role: 'scenario'}}, packs: {x: {modules: {x: '1.0.0'}}}}));
      await refused(prod().set('enabled.x', 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    });
  });
});

describe('stdio 20b: the review of Tasks 1-3 (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const MiB2 = 1024 * 1024;
  let dir;
  let file;
  let saved;
  let applied;
  const history = () => (fs.existsSync(path.join(dir, 'history.jsonl')) ? fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const tool = (o = {}) => settingsTool.create(Object.assign({mm: NO_MODULES, 
    file,
    ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    applyChange: async (staged) => { applied.push(staged); if (!/^pack\./.test(staged.name)) options[staged.name] = staged.next; }
  }, o));
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };
  const confirmed = async (t, name, value) => {
    const a = await t.set(name, value, 'settings tool', CLIENT);
    return t.confirm(name, value, {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20b-'));
    file = path.join(dir, 'settings.json');
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    Object.assign(options, {maxOutputBytes: 16 * MiB2, requestTimeout: 30000});
    applied = [];
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => { Object.assign(options, saved); fs.rmSync(dir, {recursive: true, force: true}); });

  it('after a raise this start: the same value is a no-op; one between is applied this start, no form, nothing written', async () => {
    const t = tool();
    await confirmed(t, 'maxOutputBytes', '32MiB');
    assert.deepStrictEqual(await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), {name: 'maxOutputBytes', old: 16 * MiB2, new: 32 * MiB2, applies: 'this start'});
    const between = await t.set('maxOutputBytes', '24MiB', 'settings tool', CLIENT);
    assert.deepStrictEqual(between, {name: 'maxOutputBytes', old: 32 * MiB2, new: 24 * MiB2, applies: 'this start'});
    assert.strictEqual(options.maxOutputBytes, 24 * MiB2);
    assert.ok(!fs.existsSync(file), 'never written');
    // back to the file's value: this start's raise undone, nothing written
    assert.strictEqual((await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT)).new, 16 * MiB2);
    assert.strictEqual(options.maxOutputBytes, 16 * MiB2);
    assert.ok(!fs.existsSync(file));
  });

  // M5b: a module turned on is the file's (never this start's): written
  // with the version confirmed, and turned off again on request
  it('a module turned on in conversation is written; off again is on request, written too; nothing is applied here', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
    recordAt(dir, '0.4.0');
    const t = tool();
    const on = await confirmed(t, EN, 'on');
    assert.deepStrictEqual({old: on.old, new: on.new, applies: on.applies}, {old: 'off', new: 'on', applies: 'now'});
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values[EN], true);
    const off = await t.set(EN, 'off', 'settings tool', CLIENT);
    assert.deepStrictEqual({old: off.old, new: off.new, applies: off.applies}, {old: 'on', new: 'off', applies: 'now'});
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).values[EN], false);
    assert.deepStrictEqual(applied, [], 'ch-local loads and unloads it: nothing applied by the tool');
  });

  it('accepting re-checks conversation off and the decline lock, as set does', async () => {
    let conversation = true;
    const t = tool({ceiling: () => ({state: 'trusted', file: 'x', ceiling: {forbid: [], conversation}})});
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    conversation = false;
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual(applied, []);
  });

  it('history: one line per kind and outcome whatever the reasons; an outside reason cleaned and cut', async () => {
    const reasons = ['not tested yet', 'version below the tested floor', 'client hook present', 'x\u0000\nINJECTED '.repeat(40)];
    let i = 0;
    const t = tool({mayElicit: async () => ({ok: false, why: reasons[i++ % reasons.length]})});
    for (let n = 0; n < 8; n++) await refused(t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    const lines = history().filter((h) => h.setting === 'maxOutputBytes' && h.asked != null);
    assert.strictEqual(lines.length, 1, JSON.stringify(lines));
    const t2 = tool({mayElicit: async () => ({ok: false, why: reasons[3]})});
    confirmModule.resetForTests();
    settingsTool.resetForTests();
    await refused(t2.set('requestTimeout', '60s', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    const line = history().find((h) => h.setting === 'requestTimeout');
    assert.ok(line.change.length <= 120 && !/[\u0000\n]/.test(line.change), line.change);
  });

  it('history: an outside reason by the one module-text rule: a bidi override, isolate, mark or zero-width character a space, runs made one', async () => {
    const t = tool({mayElicit: async () => ({ok: false, why: 'hook\u202e  present\u2066\u200f\u200bnow'})});
    await refused(t.set('requestTimeout', '61s', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    const line = history().find((h) => h.setting === 'requestTimeout');
    assert.strictEqual(line.change, 'not confirmed (hook present now)', JSON.stringify(line));
  });

  it('a retry with no answer gets the same form back, spending no other', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    for (let n = 0; n < 4; n++) {
      const again = await t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState}, CLIENT);
      assert.strictEqual(again.inputRequired.requestState, a.inputRequired.requestState);
    }
    assert.strictEqual(confirmModule.confirmations().formsLeft(), 2);
    assert.strictEqual((await t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT)).applies, 'this start');
    // a forged state with no answer: invalid, no form
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: 'nope'}, CLIENT), 'SETTING_CONFIRMATION_INVALID');
  });

  it('forms run out cleanly, and a client-less yes is no', async () => {
    const t = tool();
    for (let n = 0; n < 3; n++) await t.set('maxOutputBytes', `${32 + n}MiB`, 'settings tool', CLIENT);
    await refused(t.set('maxOutputBytes', '40MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    confirmModule.resetForTests();
    await refused(tool({mayElicit: async () => ({ok: true})}).set('requestTimeout', '60s', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });
});

describe('stdio 20c: the security review of #213 (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  let dir;
  let file;
  let saved;
  const history = () => (fs.existsSync(path.join(dir, 'history.jsonl')) ? fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf8')).values;
  const tool = (o = {}) => settingsTool.create(Object.assign({mm: NO_MODULES, 
    file,
    ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    applyChange: async (staged) => { if (!/^pack\./.test(staged.name)) options[staged.name] = staged.next; }
  }, o));
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20c-'));
    file = path.join(dir, 'settings.json');
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.maxOutputBytes = 16 * M;
    options.requestTimeout = 30000;
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => { Object.assign(options, saved); fs.rmSync(dir, {recursive: true, force: true}); });

  it('a value tighter than the file\'s is always written (a terminal raise awaiting restart: file 128 MiB, runtime 16 MiB)', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * M}}));
    const at8 = await tool().set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    assert.deepStrictEqual(at8, {name: 'maxOutputBytes', old: 128 * M, new: 16 * M, applies: 'now'});
    assert.strictEqual(stored().maxOutputBytes, 16 * M, 'written');
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * M}}));
    const at32 = await tool().set('maxOutputBytes', '64MiB', 'settings tool', CLIENT);
    assert.strictEqual(at32.new, 64 * M);
    assert.strictEqual(stored().maxOutputBytes, 64 * M);
    assert.strictEqual(options.maxOutputBytes, 16 * M, 'the runtime is lowered only below what it runs');
    // the file's own value again: nothing to write, nothing raised
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * M}}));
    const same = await tool().set('maxOutputBytes', '128MiB', 'settings tool', CLIENT);
    assert.deepStrictEqual([same.new, same.applies, options.maxOutputBytes], [128 * M, 'next start', 16 * M]);
  });

  it('a this-start tightening that cannot be applied leaves "not applied" after its line', async () => {
    // an apply that fails (a pack ch-local would not unload, a resize gone wrong)
    const t = settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}), mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
      applyChange: async () => { throw new Error('boom'); }});
    options.maxOutputBytes = 32 * M;   // raised this start (the file says 16 MiB)
    await refused(t.set('maxOutputBytes', '24MiB', 'settings tool', CLIENT), 'SETTING_NOT_APPLIED');
    assert.deepStrictEqual(history().map((h) => h.change), ['this start', 'not applied']);
  });

  it('a second expiry found before the third form: declined this start, no form sent', async () => {
    let clock = 1000;
    const real = confirmModule.confirmations;
    const c = new confirmModule.Confirmations({now: () => clock});
    confirmModule.confirmations = () => c;
    try {
      const t = tool();
      await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
      clock += 120001;
      await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);   // replaces the expired first: one expiry
      clock += 120001;
      await refused(t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT), 'SETTING_DECLINED_THIS_START');
      assert.strictEqual(c.formsLeft(), 1, 'the third form was not spent');
    } finally {
      confirmModule.confirmations = real;
    }
  });

  it('refusals at accept leave a history line; the no-answer path records an expiry', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    options.maxOutputBytes = 24 * M;   // changed meanwhile
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CHANGED_MEANWHILE');
    assert.ok(history().some((h) => h.change === 'not applied (changed meanwhile)'), JSON.stringify(history()));
    let clock = 1000;
    const real = confirmModule.confirmations;
    const c = new confirmModule.Confirmations({now: () => clock});
    confirmModule.confirmations = () => c;
    try {
      const b = await t.set('requestTimeout', '60s', 'settings tool', CLIENT);
      clock += 120001;
      await refused(t.confirm('requestTimeout', '60s', {requestState: b.inputRequired.requestState}, CLIENT), 'SETTING_CONFIRMATION_EXPIRED');
      assert.ok(history().some((h) => h.setting === 'requestTimeout' && h.change === 'expired'));
    } finally {
      confirmModule.confirmations = real;
    }
  });

  it('a module version over 32 characters is no plain version: no form', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
    recordAt(dir, `1.0.${'9'.repeat(5000)}`);
    await refused(tool().set(EN, 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });

  it('no session: no form, and a confirmation is never bound to the string "undefined"', async () => {
    const noSession = Object.assign({}, CLIENT, {session: undefined});
    await refused(tool().set('maxOutputBytes', '32MiB', 'settings tool', noSession), 'SETTING_NEEDS_CONFIRMATION');
    const c = new confirmModule.Confirmations();
    assert.strictEqual(c.stage({name: 'maxOutputBytes', old: 1, next: 2, client: {name: 'a', version: '1.0.0'}, session: ''}), null);
    const s = c.stage({name: 'maxOutputBytes', old: 1, next: 2, client: {name: 'a', version: '1.0.0'}, session: 'undefined'});
    assert.strictEqual(c.verify(s.requestState, {name: 'maxOutputBytes', next: 2}).code, 'SETTING_CONFIRMATION_INVALID');
  });

  it('the exported allowlist is frozen', () => {
    const clients = require('../../lib/elicitation-clients');
    assert.ok(Object.isFrozen(clients.ALLOWLIST) && clients.ALLOWLIST.every((e) => Object.isFrozen(e)));
    assert.throws(() => { 'use strict'; clients.ALLOWLIST[0].tested.push({from: '0.0.0', before: '9.0.0'}); });
  });
});

describe('stdio 20d: #213\'s nits (part 3 P2, Task 4)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  let dir;
  let file;
  let saved;
  const history = () => (fs.existsSync(path.join(dir, 'history.jsonl')) ? fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20d-'));
    file = path.join(dir, 'settings.json');
    saved = options.maxOutputBytes;
    options.maxOutputBytes = 16 * M;
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => { options.maxOutputBytes = saved; fs.rmSync(dir, {recursive: true, force: true}); });
  const withCeiling = (ceiling) => settingsTool.create({mm: NO_MODULES, file, ceiling,
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
    applyChange: async (st) => { options[st.name] = st.next; }});
  const trusted = (o = {}) => ({state: 'trusted', file: 'c', ceiling: Object.assign({forbid: []}, o)});

  it('the lock reads the ceiling from the cache only: a miss, or a ceiling changed since, refuses with its line', async () => {
    const calls = [];
    let value = trusted({maxOutputBytes: 128 * M});
    let miss = false;
    const t = withCeiling((o) => { calls.push(o && o.cacheOnly === true); return o && o.cacheOnly && miss ? undefined : value; });
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    miss = true;
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CEILING_CHANGED_MEANWHILE');
    assert.ok(calls.includes(true), 'the lock asked the cache only');
    assert.ok(history().some((h) => h.change === 'not applied (ceiling changed meanwhile)'), JSON.stringify(history()));
    miss = false;
    confirmModule.resetForTests();
    const b = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    value = trusted({maxOutputBytes: 128 * M});
    const changing = withCeiling((o) => (o && o.cacheOnly ? trusted({maxOutputBytes: 24 * M}) : value));
    await refused(changing.confirm('maxOutputBytes', '32MiB', {requestState: b.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CEILING_CHANGED_MEANWHILE');
    assert.strictEqual(options.maxOutputBytes, 16 * M);
  });

  it('a ceiling refusal at accept says which: untrusted, forbidden, or above', async () => {
    const cases = [
      [{state: 'untrusted', file: 'c', problem: 'group-writable'}, 'SETTING_CEILING_UNTRUSTED', 'not applied (ceiling untrusted)'],
      [trusted({forbid: ['maxOutputBytes']}), 'SETTING_FORBIDDEN_BY_CEILING', 'not applied (forbidden by the ceiling)'],
      [trusted({maxOutputBytes: 24 * M}), 'SETTING_ABOVE_CEILING', 'not applied (above the ceiling)']
    ];
    for (const [later, code, line] of cases) {
      confirmModule.resetForTests();
      settingsTool.resetForTests();
      let current = {state: 'none'};
      const t = withCeiling(() => current);
      const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
      current = later;
      await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), code);
      assert.ok(history().some((h) => h.change === line), `${line}: ${JSON.stringify(history())}`);
    }
  });

  it('the apply\'s refusal does not call an unconfirmed change confirmed', async () => {
    // the default apply, for a setting it cannot apply (a module's on/off is
    // the file's: ch-local applies it, never this)
    const e = await refused(settingsTool.applyConfirmed({name: 'enabled.x', old: true, next: false, version: null},
      {pool: null, modules: () => null, ask: (m, o) => require('../../lib/control-channel').ask(m, o)}), 'SETTING_NOT_APPLIED');
    assert.match(e.message, /not live/);
    assert.match(e.message, /enabled\.x/);
    assert.doesNotMatch(e.message, /confirmed/i);
  });
});

describe('stdio 20e: Task 4\'s review (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  let dir;
  let file;
  let saved;
  const refused = async (p, code) => {
    try { await p; } catch (e) { assert.strictEqual(e.code, code, `${e.code}: ${e.message}`); return e; }
    assert.fail(`expected ${code}`);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20e-'));
    file = path.join(dir, 'settings.json');
    saved = options.maxOutputBytes;
    options.maxOutputBytes = 16 * M;
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => { options.maxOutputBytes = saved; fs.rmSync(dir, {recursive: true, force: true}); });

  it('the re-check at accept is for the client the form was staged for; another refuses', async () => {
    let client = {name: 'claude-code', version: '2.1.323'};
    const t = settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}), mayElicit: async () => ({ok: true, client}),
      applyChange: async (st) => { options[st.name] = st.next; }});
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    client = {name: 'claude-code', version: '2.1.400'};
    await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.strictEqual(options.maxOutputBytes, 16 * M);
  });

  it('a ceiling changed while the user was asked says so, not that the setting changed', async () => {
    let current = {state: 'none'};
    const t = settingsTool.create({mm: NO_MODULES, file, ceiling: (o) => (o && o.cacheOnly ? {state: 'trusted', file: 'c', ceiling: {forbid: []}} : current),
      mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}), applyChange: async () => {}});
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    const e = await refused(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CEILING_CHANGED_MEANWHILE');
    assert.match(e.message, /ceiling/);
    current = null;
  });
});

describe('stdio 20f: #216\'s review (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  it('cacheOnly compares the key only: the Windows 5-minute re-read never makes a fresh pre-lock read look changed', () => {
    settingsTool.resetForTests();
    let t = 1000;
    let reads = 0;
    const read = () => ({state: 'none', n: ++reads});
    const at = (o = {}) => settingsTool.cachedCeiling(read, Object.assign({platform: 'win32', now: () => t}, o));
    assert.deepStrictEqual(at(), {state: 'none', n: 1});
    t += 5 * 60 * 1000 + 1;
    assert.deepStrictEqual(at({cacheOnly: true}), {state: 'none', n: 1}, 'past the age rule, the same key: the cached value');
    assert.deepStrictEqual(at(), {state: 'none', n: 2}, 'a read re-reads past it');
    settingsTool.resetForTests();
    assert.strictEqual(at({cacheOnly: true}), undefined, 'nothing cached: a miss');
  });
});

describe('stdio 20g: the confirmed change applied, this start only (part 3 P2, Task 5)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  let saved;
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.maxOutputBytes = 16 * M;
    options.requestTimeout = 30000;
    settingsTool.resetForTests();
    settingsTool.captureAtStart();
  });
  afterEach(() => { Object.assign(options, saved); settingsTool.resetForTests(); settingsTool.ceilingForControl(() => ({state: 'none'})); });
  const deps = (o = {}) => {
    const sent = [];
    const asked = [];
    return Object.assign({sent, asked,
      pool: null,
      modules: () => ({m: {sendMessageToWorker: (msg) => sent.push(msg)}}),
      ask: async (msg, opts) => { asked.push([msg, opts]); return {ok: true}; }}, o);
  };

  it('maxOutputBytes: the pool resized first, the option only once that resolves; every worker told; a later control set up to it applies', async () => {
    let release;
    const resized = [];
    const d = deps({pool: {resize: (n) => { resized.push(n); return new Promise((r) => { release = r; }); }}});
    const p = settingsTool.applyConfirmed({name: 'maxOutputBytes', old: 16 * M, next: 64 * M}, d);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(resized, [64 * M]);
    assert.strictEqual(options.maxOutputBytes, 16 * M, 'not before the resize resolves');
    release();
    await p;
    assert.strictEqual(options.maxOutputBytes, 64 * M);
    assert.deepStrictEqual(d.sent.map((m) => [m.command, m.options.maxOutputBytes]), [['live-options', 64 * M]]);
    settingsTool.ceilingForControl(() => ({state: 'none'}));
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 32 * M}), {ok: true});
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 64 * M}), {ok: true}, 'the start cap lifted for this value');
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 66 * M}), {ok: false, code: 'CONTROL_APPLIES_AT_START'});
  });

  it('a value changed while the pool resized: SETTING_CHANGED_MEANWHILE, nothing assigned', async () => {
    const d = deps({pool: {resize: async () => { options.maxOutputBytes = 8 * M; }}});
    await assert.rejects(settingsTool.applyConfirmed({name: 'maxOutputBytes', old: 16 * M, next: 64 * M}, d), {code: 'SETTING_CHANGED_MEANWHILE'});
    assert.strictEqual(options.maxOutputBytes, 8 * M);
    assert.deepStrictEqual(d.sent, []);
  });

  it('requestTimeout: applied at once, every worker told; no pool asked', async () => {
    const d = deps({pool: {resize: () => assert.fail('no resize for a timeout')}});
    await settingsTool.applyConfirmed({name: 'requestTimeout', old: 30000, next: 60000}, d);
    assert.strictEqual(options.requestTimeout, 60000);
    assert.strictEqual(d.sent[0].options.requestTimeout, 60000);
  });

  // M5b: no load-pack or unload-pack is asked of ch-local (a module's on/off
  // is the file's; its watcher loads or unloads the module)
  it('a module\'s on/off is never applied here, and nothing is asked of ch-local', async () => {
    for (const next of [true, false]) {
      const d = deps();
      await assert.rejects(settingsTool.applyConfirmed({name: EN, old: !next, next, version: '0.4.0'}, d), (e) => e.code === 'SETTING_NOT_APPLIED' && /not live/.test(e.message));
      assert.deepStrictEqual(d.asked, []);
    }
  });

  it('atStart is captured at start: a value raised before the first control set is not taken as the start value', () => {
    options.maxOutputBytes = 128 * M;   // say, raised this start
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 64 * M}), {ok: false, code: 'CONTROL_APPLIES_AT_START'});
  });
});

describe('stdio 20h: never silent, for confirmed changes (part 3 P2, Task 6)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  const notices = require('../../lib/notices');
  const LOG = require('../../lib/logger');
  let dir;
  let file;
  let saved;
  let logI;
  const logged = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20h-'));
    file = path.join(dir, 'settings.json');
    saved = options.maxOutputBytes;
    options.maxOutputBytes = 16 * M;
    confirmModule.resetForTests();
    settingsTool.resetForTests();
    notices.take(null);
    logI = LOG.I;
    logged.length = 0;
    LOG.I = (line) => { logged.push(String(line)); return line; };
  });
  afterEach(() => { LOG.I = logI; options.maxOutputBytes = saved; fs.rmSync(dir, {recursive: true, force: true}); notices.take(null); });
  const tool = (applyChange = async (st) => { options[st.name] = st.next; }) => settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}),
    mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}), applyChange});

  it('an applied confirmation is told as a notice and logged, in the same words; a decline tells nothing', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    await t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
    const text = 'maxOutputBytes raised from 16MiB to 32MiB for this start (confirmed in claude-code)';
    assert.deepStrictEqual(notices.take(null), [text]);
    assert.ok(logged.includes(`countinghouse_settings: ${text}`), JSON.stringify(logged));
    confirmModule.resetForTests();
    settingsTool.resetForTests();
    const t2 = tool();
    const b = await t2.set('requestTimeout', '60s', 'settings tool', CLIENT);
    await t2.confirm('requestTimeout', '60s', {requestState: b.inputRequired.requestState, inputResponses: {approve: {action: 'decline'}}}, CLIENT);
    assert.deepStrictEqual(notices.take(null), []);
  });

  it('a confirmed change that could not be applied is told too', async () => {
    const t = tool(async () => { throw Object.assign(new Error('x'), {code: 'CONTROL_NO_ANSWER'}); });
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    await assert.rejects(t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), {code: 'SETTING_NOT_APPLIED'});
    assert.deepStrictEqual(notices.take(null), ['maxOutputBytes not changed: the change you confirmed could not be applied (CONTROL_NO_ANSWER)']);
  });
});

describe('stdio 20i: Task 5\'s review (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  let saved;
  beforeEach(() => {
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout};
    options.maxOutputBytes = 16 * M;
    options.requestTimeout = 30000;
    settingsTool.resetForTests();
    settingsTool.captureAtStart();
  });
  afterEach(() => { Object.assign(options, saved); settingsTool.resetForTests(); });
  const base = (o = {}) => Object.assign({pool: null, modules: () => ({}), ask: async () => ({ok: true})}, o);
  const trusted = (c) => ({state: 'trusted', file: 'c', ceiling: Object.assign({forbid: []}, c)});

  it('the ceiling is checked again once the resize resolves: one lowered meanwhile wins, nothing set', async () => {
    let c = trusted({maxOutputBytes: 256 * M});
    const d = base({ceiling: () => c, pool: {resize: async () => { c = trusted({maxOutputBytes: 32 * M}); }}});
    await assert.rejects(settingsTool.applyConfirmed({name: 'maxOutputBytes', old: 16 * M, next: 192 * M}, d), {code: 'SETTING_CEILING_CHANGED_MEANWHILE'});
    assert.strictEqual(options.maxOutputBytes, 16 * M);
    assert.deepStrictEqual(settingsTool.applyControlSet({name: 'maxOutputBytes', value: 192 * M}), {ok: false, code: 'CONTROL_APPLIES_AT_START'}, 'the start cap not lifted');
    // conversation turned off meanwhile, or the ceiling untrusted: the same
    for (const later of [trusted({conversation: false}), {state: 'untrusted', file: 'c', problem: 'p'}]) {
      c = later;
      await assert.rejects(settingsTool.applyConfirmed({name: 'requestTimeout', old: 30000, next: 60000}, base({ceiling: () => c})), {code: 'SETTING_CEILING_CHANGED_MEANWHILE'});
    }
    // a tightening is never refused by it
    c = {state: 'untrusted', file: 'c', problem: 'p'};
    options.maxOutputBytes = 32 * M;
    await settingsTool.applyConfirmed({name: 'maxOutputBytes', old: 32 * M, next: 24 * M}, base({ceiling: () => c}));
    assert.strictEqual(options.maxOutputBytes, 24 * M);
  });

  it('a resize that stopped, or no modules to tell, applies nothing', async () => {
    await assert.rejects(settingsTool.applyConfirmed({name: 'maxOutputBytes', old: 16 * M, next: 64 * M},
      base({pool: {resize: async () => { throw Object.assign(new Error('x'), {code: 'RESIZE_STOPPED'}); }}})), (e) => e.code === 'SETTING_NOT_APPLIED' && /RESIZE_STOPPED/.test(e.message));
    assert.strictEqual(options.maxOutputBytes, 16 * M);
    await assert.rejects(settingsTool.applyConfirmed({name: 'requestTimeout', old: 30000, next: 60000}, base({modules: undefined})), {code: 'SETTING_NOT_APPLIED'});
    assert.strictEqual(options.requestTimeout, 30000);
  });

  // M5b: on is the file's: on again is a no-op while the file says on, and
  // asked again once the file says off (a terminal, or ch-local, wrote it)
  it('a module turned on stays on while the file says so; written off by someone else, it is asked for again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20i-'));
    const file = path.join(dir, 'settings.json');
    try {
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
      recordAt(dir, '0.4.0');
      confirmModule.resetForTests();
      const t = settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}), mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}), applyChange: async () => {}});
      const a = await t.set(EN, 'on', 'settings tool', CLIENT);
      await t.confirm(EN, 'on', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
      assert.strictEqual((await t.set(EN, 'on', 'settings tool', CLIENT)).applies, 'now', 'on already: a no-op');
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {[EN]: false}}));
      const again = await t.set(EN, 'on', 'settings tool', CLIENT);
      assert.ok(again.inputRequired != null, 'off again: asked again');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('stdio 20j: #222\'s review (part 3 P2)', function() {
  // (each case's work -- stages, confirms, history lines on disk -- ends
  // with itself; a slow Windows runner took over mocha's 2 s default on one,
  // master's run 46040609989: 20 s at most, as stdio 01's)
  this.timeout(20000);
  const M = 1024 * 1024;
  const notices = require('../../lib/notices');
  let dir;
  let saved;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-s20j-')); saved = options.maxOutputBytes; options.maxOutputBytes = 16 * M; confirmModule.resetForTests(); settingsTool.resetForTests(); notices.take(null); });
  afterEach(() => { options.maxOutputBytes = saved; fs.rmSync(dir, {recursive: true, force: true}); notices.take(null); });

  it('an apply that fails with no code says "error", never its message (in the notice, the history and the refusal)', async () => {
    const file = path.join(dir, 'settings.json');
    const t = settingsTool.create({mm: NO_MODULES, file, ceiling: () => ({state: 'none'}), mayElicit: async () => ({ok: true, client: {name: 'claude-code', version: '2.1.323'}}),
      applyChange: async () => { throw new Error('a message that could carry /home/someone or a key'); }});
    const a = await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
    const e = await t.confirm('maxOutputBytes', '32MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT).then(() => null, (err) => err);
    assert.strictEqual(e.code, 'SETTING_NOT_APPLIED');
    const said = JSON.stringify([notices.take(null), fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8'), e.message]);
    assert.ok(!said.includes('could carry'), said);
    assert.ok(said.includes('(error)'), said);
  });
});
