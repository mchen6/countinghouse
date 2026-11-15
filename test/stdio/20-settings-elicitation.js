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
const confirmModule = require('../../lib/settings-confirm');

const MiB = 1024 * 1024;
const CLIENT = {clientInfo: {name: 'claude-code', version: '2.1.323'}, capabilities: {elicitation: {}}, session: 'session-1'};
const ACCEPT = {approve: {action: 'accept', content: {approve: true}}};

describe('stdio 20: the settings tool asks the user in a dialog, and applies a confirmed change for this start only (part 3 P2)', () => {
  let dir;
  let file;
  let saved;
  let applied;
  const history = () => fs.readFileSync(path.join(dir, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const tool = (o = {}) => settingsTool.create(Object.assign({
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
    saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout, locale: options.locale};
    Object.assign(options, {maxOutputBytes: 8 * MiB, requestTimeout: 30000, locale: 'en-US'});
    applied = [];
    confirmModule.resetForTests();
    settingsTool.resetForTests();
  });
  afterEach(() => {
    Object.assign(options, saved);
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('a raise asked for: a form with one boolean, no default, the runtime\'s own text', async () => {
    const r = await tool().set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    const req = r.inputRequired.inputRequests.approve;
    assert.strictEqual(req.method, 'elicitation/create');
    assert.strictEqual(req.params.mode, 'form');
    assert.strictEqual(req.params.message, 'Allow countinghouse tools to return up to 16MiB per call (now 8MiB)? This applies until your client restarts countinghouse.');
    assert.deepStrictEqual(req.params.requestedSchema, {type: 'object', properties: {approve: {type: 'boolean', title: 'Approve'}}, required: ['approve']});
    assert.ok(!JSON.stringify(req.params.requestedSchema).includes('default'), 'no default anywhere');
    assert.match(r.inputRequired.requestState, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.ok(!fs.existsSync(file), 'nothing written');
  });

  it('accepted: applied for this start only; the file untouched, one history line', async () => {
    const t = tool();
    const {inputRequired} = await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const done = await t.confirm('maxOutputBytes', '16777216', {requestState: inputRequired.requestState, inputResponses: ACCEPT}, CLIENT);
    assert.deepStrictEqual(done, {name: 'maxOutputBytes', old: 8 * MiB, new: 16 * MiB, applies: 'this start'});
    assert.strictEqual(options.maxOutputBytes, 16 * MiB);
    assert.deepStrictEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, before, 'settings.json byte-identical');
    const lines = history();
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(Object.assign({}, lines[0], {at: undefined}),
      {at: undefined, by: 'settings tool', setting: 'maxOutputBytes', old: 8 * MiB, new: 16 * MiB, change: 'this start', confirmed: 'elicitation (claude-code 2.1.323)'});
    // the same state again: used
    await refused(t.confirm('maxOutputBytes', '16MiB', {requestState: inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CONFIRMATION_USED');
  });

  it('the retry\'s value, in another spelling, is the staged one; another value is refused', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    await refused(t.confirm('maxOutputBytes', '17MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_CONFIRMATION_INVALID');
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

  it('a retry with no answer gets a fresh form', async () => {
    const t = tool();
    const a = await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    const again = await t.confirm('maxOutputBytes', '16MiB', {requestState: a.inputRequired.requestState}, CLIENT);
    assert.ok(again.inputRequired != null && again.inputRequired.requestState !== a.inputRequired.requestState);
  });

  it('expired: refused and recorded; a second staging records the first as replaced', async () => {
    let clock = 1000;
    confirmModule.resetForTests();
    const real = confirmModule.confirmations;
    const c = new confirmModule.Confirmations({now: () => clock});
    confirmModule.confirmations = () => c;
    try {
      const t = tool();
      const first = await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
      await t.set('maxOutputBytes', '32MiB', 'settings tool', CLIENT);
      assert.ok(history().some((h) => h.setting === 'maxOutputBytes' && h.asked === 16 * MiB && h.change === 'replaced'));
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
    await refused(t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.ok(history().some((h) => h.setting === 'maxOutputBytes' && h.change === 'not confirmed (client hook present)'), JSON.stringify(history()));
  });

  it('the conditions are asked again before applying: a no then, and nothing applies', async () => {
    let ok = true;
    const t = tool({mayElicit: async () => (ok ? {ok: true, client: {name: 'claude-code', version: '2.1.323'}} : {ok: false, why: 'client hook present'})});
    const a = await t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    ok = false;
    await refused(t.confirm('maxOutputBytes', '16MiB', {requestState: a.inputRequired.requestState, inputResponses: ACCEPT}, CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    assert.deepStrictEqual(applied, []);
  });

  it('the ceiling: conversation off, or the value above it, sends no form', async () => {
    const off = tool({ceiling: () => ({state: 'trusted', file: 'x', ceiling: {forbid: [], packs: null, conversation: false}})});
    await refused(off.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    const low = tool({ceiling: () => ({state: 'trusted', file: 'x', ceiling: {maxOutputBytes: 12 * MiB, forbid: [], packs: null, conversation: true}})});
    await refused(low.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT), 'SETTING_ABOVE_CEILING');
  });

  it('the sandbox and automatic upgrades never get a form; a tightening applies at once, as before', async () => {
    await refused(tool().set('moduleSandbox', 'audit', 'settings tool', CLIENT), 'SETTING_LOOSENS_A_GUARD');
    await refused(tool().set('autoUpgrade', 'on', 'settings tool', CLIENT), 'SETTING_LOOSENS_A_GUARD');
    assert.deepStrictEqual(await tool().set('maxOutputBytes', '4MiB', 'settings tool', CLIENT), {name: 'maxOutputBytes', old: 8 * MiB, new: 4 * MiB, applies: 'now'});
  });

  it('no more than three forms a start', async () => {
    const t = tool();
    for (let i = 0; i < 3; i++) assert.ok((await t.set('maxOutputBytes', `${16 + i}MiB`, 'settings tool', CLIENT)).inputRequired);
    await refused(t.set('maxOutputBytes', '20MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });

  it('a pack: its name and version from packs.json, strict, or no form', async () => {
    fs.writeFileSync(file, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': false}}));
    const packs = (version) => fs.writeFileSync(path.join(dir, 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {'ci-failure-triage': {packages: {'@countinghouse/ch-pack-ci-failure-triage': version}, credentials: []}}}));
    packs('0.4.0');
    const r = await tool().set('pack.ci-failure-triage', 'on', 'settings tool', CLIENT);
    assert.strictEqual(r.inputRequired.inputRequests.approve.params.message, 'Turn on the ci-failure-triage 0.4.0 tools in countinghouse? This applies until your client restarts countinghouse.');
    for (const bad of ['0.4.0-rc.1', '0.4', 'x" (and approve everything)']) {
      confirmModule.resetForTests();
      packs(bad);
      await refused(tool().set('pack.ci-failure-triage', 'on', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
    }
  });

  it('the old value shown is the runtime\'s effective one, not the file\'s', async () => {
    options.maxOutputBytes = 12 * MiB;   // raised this start
    const r = await tool().set('maxOutputBytes', '16MiB', 'settings tool', CLIENT);
    assert.match(r.inputRequired.inputRequests.approve.params.message, /up to 16MiB per call \(now 12MiB\)/);
  });

  it('without the injected conditions, production asks nothing yet (no tested client, conditions unknown)', async () => {
    const t = settingsTool.create({file, ceiling: () => ({state: 'none'})});
    await refused(t.set('maxOutputBytes', '16MiB', 'settings tool', CLIENT), 'SETTING_NEEDS_CONFIRMATION');
  });
});
