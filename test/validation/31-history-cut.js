'use strict';
// A module setting's value in the history (#413 rev 3 section 4.2): a string
// of more than 64 code points is written cut, with the SHA-256 of the whole
// beside it, one shape for countinghouse's lines and ch-local's reader (the
// shared vectors' historyCut; lib/history-cut.js). Every writer of a
// module.* value: a change (old, new), a request refused, declined or
// expired (asked), a value not applied (kept). Server-free.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../../lib/cli-options');
const historyCut = require('../../lib/history-cut');
const settingsTool = require('../../lib/settings-tool');
const ms = require('../../lib/module-settings');
const V = require('../../docs/superpowers/specs/shared-runtime-wire/vectors.json').historyCut;

const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex');

describe('validation 31: a module setting\'s value in the history', () => {
  it('the shared vectors\' historyCut: each case written as the vector says', () => {
    assert.ok(V.cases.length >= 5);
    for (const c of V.cases) {
      const got = historyCut.cut(c.value);
      assert.deepStrictEqual({value: got.value, sha256: got.sha256}, {value: c.written, sha256: c.sha256}, c.why);
      if (c.sha256 != null) assert.strictEqual(c.sha256, sha(c.value), `${c.why}: the hash is of the whole`);
    }
  });

  it('a module.* line\'s old, new, asked and kept are cut; any other line, and a short value, as given', () => {
    const long = 'x'.repeat(70);
    const line = historyCut.cutLine({by: 't', setting: 'module.w.repo', old: long, new: 'short', asked: long, kept: long, problem: long});
    for (const f of ['old', 'asked', 'kept']) {
      assert.strictEqual(line[f], 'x'.repeat(64), f);
      assert.strictEqual(line[`${f}Sha256`], sha(long), f);
    }
    assert.strictEqual(line.new, 'short');
    assert.strictEqual(line.newSha256, undefined);
    assert.strictEqual(line.problem, long, 'only the value fields');
    const cap = {by: 't', setting: 'maxOutputBytes', old: long, new: long};
    assert.strictEqual(historyCut.cutLine(cap), cap, 'a line of another setting is not touched');
  });

  describe('the settings tool and the reread, writing', () => {
    let home;
    let file;
    let saved;
    const lines = () => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const N = {name: 'note-tool', version: '1.0.0', countinghouse: {settings: {note: {type: 'string', maxLength: 200}}}};
    beforeEach(() => {
      require('../../lib/settings-confirm').resetForTests();
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-validation-31-'));
      file = path.join(home, 'settings.json');
      saved = {settingsFile: options.settingsFile};
      options.settingsFile = file;
    });
    // this file's state ends with it (CI runs a folder in one process)
    afterEach(() => { settingsTool.resetForTests(); require('../../lib/settings-confirm').resetForTests(); Object.assign(options, saved); fs.rmSync(home, {recursive: true, force: true}); });

    it('a confirmed change of a long string: old and new cut, each with the hash of its whole', async () => {
      const before = `${'o'.repeat(66)}`;
      const after = `${'n'.repeat(64)}é`;
      fs.writeFileSync(file, JSON.stringify({version: 1, values: {'module.note-tool.note': before}}));
      let modules = [{name: N.name, version: N.version, part: false, state: ms.stateFor(N.name, N, {operator: false, net: []})}];
      const tool = settingsTool.create({file, lockWaitMs: 200, ceiling: () => ({state: 'none'}), moduleStates: () => modules,
        applyModuleSettings: async () => { modules = [{name: N.name, version: N.version, part: false, state: ms.stateFor(N.name, N, {operator: false, net: []})}]; return {applied: 1, refused: []}; },
        mayElicit: async () => ({ok: true, client: {name: 'tested-client', version: '1.0.0'}})});
      const ctx = {session: 'cut-1'};
      const asked = await tool.set('module.note-tool.note', after, 'settings tool', ctx);
      await tool.confirm('module.note-tool.note', after, {requestState: asked.inputRequired.requestState, inputResponses: {approve: {action: 'accept', content: {approve: true}}}}, ctx);
      const line = lines().find((l) => l.setting === 'module.note-tool.note' && l.new !== undefined);
      assert.deepStrictEqual({old: line.old, oldSha256: line.oldSha256, new: line.new, newSha256: line.newSha256},
        {old: 'o'.repeat(64), oldSha256: sha(before), new: 'n'.repeat(64), newSha256: sha(after)});
      // the file holds the whole value; the history's hash matches it, as ch-local's outside-edits compares
      assert.strictEqual(sha(JSON.parse(fs.readFileSync(file, 'utf8')).values['module.note-tool.note']), line.newSha256);
      // get shows the line as written, its hash beside the cut value
      const shown = (await tool.get()).history.find((h) => h.setting === 'module.note-tool.note' && h.new !== undefined);
      assert.deepStrictEqual({new: shown.new, newSha256: shown.newSha256, old: shown.old, oldSha256: shown.oldSha256},
        {new: 'n'.repeat(64), newSha256: sha(after), old: 'o'.repeat(64), oldSha256: sha(before)});
    });

    it('a value not applied (the reread\'s and a load\'s line): kept cut, with the hash of the whole; a key with a pair at its edge is never split', () => {
      const long = `${'k'.repeat(63)}😀tail`;
      assert.strictEqual(ms.historyLine('note-tool', 'note', 'not applied', {stored: long}), true);
      const key = `${'k'.repeat(63)}😀x`;
      assert.strictEqual(ms.historyLine('note-tool', key, 'not applied', {stored: 7}), true);
      const [first, second] = lines();
      assert.deepStrictEqual({kept: first.kept, keptSha256: first.keptSha256}, {kept: `${'k'.repeat(63)}😀`, keptSha256: sha(long)});
      assert.strictEqual(second.setting, `module.note-tool.${'k'.repeat(63)}😀…`);
      assert.deepStrictEqual({kept: second.kept, keptSha256: second.keptSha256}, {kept: 7, keptSha256: undefined});
    });

    it('a request that expired unanswered: its asked value cut, with the hash of the whole', () => {
      const long = 'q'.repeat(80);
      settingsTool.recordUnanswered('a'.repeat(32), [{name: 'module.note-tool.note', next: long, scope: null}]);
      const line = lines().find((l) => l.change === 'expired');
      assert.deepStrictEqual({asked: line.asked, askedSha256: line.askedSha256}, {asked: 'q'.repeat(64), askedSha256: sha(long)});
    });
  });
});
