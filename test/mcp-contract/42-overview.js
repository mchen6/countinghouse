'use strict';
// B-firstrun (the first-run design, (b)): countinghouse_overview's answer
// (lib/overview.js build) and ch-local's held-back list (lib/held-back.js).
// The fixed sentences are pinned word for word: each went through
// business's claim check, and a change is a business review.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const overview = require('../../lib/overview');
const heldBack = require('../../lib/held-back');
const tmp = require('../helpers/test-tmp').forFile(['ch-mcp-42-']);

const GUIDE = 'https://github.com/mchen6/countinghouse/blob/master/docs/module-development.md';
const pack = (over = {}) => Object.assign({name: 'ch-pack-demo', module: 'ch-demo', loaded: true, description: 'Does a thing.', tools: ['demo_run'], examples: [], held: null}, over);

describe('mcp-contract 42: countinghouse_overview (B-firstrun)', () => {
  describe('the fixed sentences', () => {
    it('word for word, as business passed them', () => {
      const F = overview.FIXED;
      assert.strictEqual(F.none, 'No packs are installed.');
      assert.strictEqual(F.omitted(3), '3 more packs not shown.');
      assert.strictEqual(F.omitted(1), '1 more pack not shown.');
      assert.strictEqual(F.credential('ch-access-github', null), 'In your own terminal run `ch-local credentials add ch-access-github`.');
      assert.strictEqual(F.credential('ch-access-github', '/home/u/.ch/bin/ch-local.js'), 'In your own terminal run `node "/home/u/.ch/bin/ch-local.js" credentials add ch-access-github`.');
      assert.strictEqual(F.notLoaded(null), 'Not loaded: run `ch-local status` in your own terminal to see why.');
      assert.strictEqual(F.notLoaded('/home/u/.ch/bin/ch-local.js'), 'Not loaded: run `node "/home/u/.ch/bin/ch-local.js" status` in your own terminal to see why.');
      assert.strictEqual(F.notLoadedHosted, 'Not loaded on this runtime.');
      assert.strictEqual(F.scenarios, `To build a scenario that combines modules, see the module development guide (${GUIDE}).`);
      assert.strictEqual(F.authoring, 'The authoring tools are enabled for you: countinghouse_validate_plan, countinghouse_validate_module and countinghouse_load_module.');
    });
  });

  describe('build', () => {
    it('a loaded pack: ready, its description and example asks cleaned and bounded, its tools; the scenarios line', () => {
      const {data, text} = overview.build({version: '7.1.2', packs: [pack({description: 'Triage‮ a failed​ run.\nSecond line.',
        examples: ['Triage the latest⁦ failed run', '​​', 'x'.repeat(300), 'Who touched it?', 'Is it flaky?', 'A fifth']})]});
      assert.strictEqual(data.version, '7.1.2');
      const p = data.packs[0];
      assert.deepStrictEqual([p.name, p.module, p.state, p.tools], ['ch-pack-demo', 'ch-demo', 'ready', ['demo_run']]);
      assert.strictEqual(p.description, 'Triage a failed run.\nSecond line.');
      assert.strictEqual(p.examples.length, overview.MAX_EXAMPLES);
      assert.strictEqual(p.examples[0], 'Triage the latest failed run');
      assert.strictEqual(p.examples[1].length, overview.MAX_EXAMPLE);
      assert.ok(!/[‮​⁦]/.test(text), text);
      assert.strictEqual(p.next, undefined);
      assert.strictEqual(data.scenarios, overview.FIXED.scenarios);
      assert.ok(text.startsWith('countinghouse 7.1.2\n'), text);
      assert.ok(text.includes('ch-pack-demo (ready)') && text.includes('Tools: demo_run') && text.includes('Try: "Triage the latest failed run"'), text);
    });

    it('a pack not loaded, by why: off; a missing credential, its own or its part\'s; anything else the status hint; hosted, the runtime\'s line', () => {
      const L = '/home/u/.ch/bin/ch-local.js';
      const {data} = overview.build({version: '1', settingsProfile: true, launcher: L, packs: [
        pack({name: 'p-off', module: 'm-off', loaded: false, held: {reason: 'off', root: null, via: null}}),
        pack({name: 'p-cred', module: 'm-cred', loaded: false, held: {reason: 'credential', root: null, via: null}}),
        pack({name: 'p-part', module: 'm-part', loaded: false, held: {reason: 'calls', root: 'credential', via: 'ch-access-github'}}),
        pack({name: 'p-pin', module: 'm-pin', loaded: false, held: {reason: 'pin', root: null, via: null}}),
        pack({name: 'p-none', module: 'm-none', loaded: false, held: null})]});
      const by = Object.fromEntries(data.packs.map((p) => [p.name, p]));
      assert.deepStrictEqual([by['p-off'].state, by['p-off'].next], ['off', undefined]);
      assert.deepStrictEqual([by['p-cred'].state, by['p-cred'].next], ['not loaded', overview.FIXED.credential('m-cred', L)]);
      assert.strictEqual(by['p-part'].next, overview.FIXED.credential('ch-access-github', L));
      assert.strictEqual(by['p-pin'].next, overview.FIXED.notLoaded(L));
      assert.strictEqual(by['p-none'].next, overview.FIXED.notLoaded(L));
      assert.deepStrictEqual(by['p-cred'].tools, [], 'a pack not loaded lists no tools');
      const hosted = overview.build({version: '1', settingsProfile: false, launcher: L, packs: [pack({loaded: false, held: {reason: 'credential'}})]});
      assert.strictEqual(hosted.data.packs[0].next, overview.FIXED.notLoadedHosted, 'no ch-local command on a hosted runtime');
      const bare = overview.build({version: '1', settingsProfile: true, launcher: null, packs: [pack({loaded: false, held: {reason: 'credential'}})]});
      assert.strictEqual(bare.data.packs[0].next, overview.FIXED.credential('ch-demo', null));
    });

    it('no pack: the fixed line; an admin with the authoring tools: their line after the guide', () => {
      const none = overview.build({version: '1', packs: []});
      assert.ok(none.text.includes(overview.FIXED.none), none.text);
      const admin = overview.build({version: '1', packs: [], authoring: true});
      assert.strictEqual(admin.data.scenarios, `${overview.FIXED.scenarios} ${overview.FIXED.authoring}`);
    });

    it('at most 8 KiB, structured and text alike: packs past it left out, and counted', () => {
      const many = Array.from({length: 200}, (_, i) => pack({name: `ch-pack-${i}`, module: `ch-m-${i}`, description: 'd'.repeat(400), tools: [`t_${i}_a`, `t_${i}_b`]}));
      const {data, text} = overview.build({version: '1', packs: many});
      assert.ok(Buffer.byteLength(text) <= overview.MAX_BYTES && Buffer.byteLength(JSON.stringify(data)) <= overview.MAX_BYTES);
      assert.ok(data.omitted > 0 && data.packs.length + data.omitted === 200, JSON.stringify({kept: data.packs.length, omitted: data.omitted}));
      assert.ok(text.includes(overview.FIXED.omitted(data.omitted)), text.slice(-300));
    });

    it('the answer is what its output schema says', () => {
      const Ajv = require('ajv/dist/2020');
      const validate = new Ajv({strict: false}).compile(overview.OUTPUT_SCHEMA);
      const {data} = overview.build({version: '1', settingsProfile: true, packs: [pack(), pack({name: 'b', module: 'b', loaded: false, held: null})]});
      assert.ok(validate(data), JSON.stringify(validate.errors));
    });
  });

  describe('the held-back list (lib/held-back.js)', () => {
    const home = () => {
      const dir = tmp.mkdtemp('ch-mcp-42-');
      fs.mkdirSync(path.join(dir, 'bin'));
      fs.writeFileSync(path.join(dir, 'bin', 'ch-local.js'), '// launcher');
      return {dir, settings: path.join(dir, 'settings.json'), launcher: path.join(dir, 'bin', 'ch-local.js')};
    };
    const doc = (modules, extra = {}) => JSON.stringify(Object.assign({v: 1, modules}, extra));

    it('reads each module, its reason, a calls entry\'s root and via, and the home\'s launcher', () => {
      const h = home();
      const l = heldBack.parse(doc([{name: '@acme/a', reason: 'credential'}, {name: 'b', reason: 'calls', root: 'credential', via: 'ch-access-github'}, {name: 'c', reason: 'off'}],
        {launcher: h.launcher}), h.settings);
      assert.deepStrictEqual([...l.modules.entries()], [['@acme/a', {reason: 'credential', root: null, via: null}],
        ['b', {reason: 'calls', root: 'credential', via: 'ch-access-github'}], ['c', {reason: 'off', root: null, via: null}]]);
      assert.strictEqual(l.launcher, h.launcher);
    });

    it('refuses the whole of anything else: never "all ready"', () => {
      const h = home();
      const outside = path.join(tmp.mkdtemp('ch-mcp-42-'), 'bin');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'ch-local.js'), '// not the home\'s');
      const linked = path.join(h.dir, 'bin', 'linked');
      fs.mkdirSync(linked);
      fs.symlinkSync(path.join(outside, 'ch-local.js'), path.join(linked, 'ch-local.js'));
      for (const [label, text] of [
        ['not JSON', '{'], ['another version', JSON.stringify({v: 2, modules: []})],
        ['a name twice', doc([{name: 'a', reason: 'off'}, {name: 'a', reason: 'pin'}])],
        ['not a package name', doc([{name: '../x', reason: 'off'}])],
        ['a reason not known', doc([{name: 'a', reason: 'gone'}])],
        ['a root without via', doc([{name: 'a', reason: 'calls', root: 'credential'}])],
        ['a root on a non-calls entry', doc([{name: 'a', reason: 'off', root: 'credential', via: 'b'}])],
        ['a field not read', doc([{name: 'a', reason: 'off', key: 'x'}])],
        ['a top-level field not read', doc([], {token: 'x'})],
        ['too many', doc(Array.from({length: heldBack.MAX_MODULES + 1}, (_, i) => ({name: `m${i}`, reason: 'off'})))],
        ['a relative launcher', doc([], {launcher: 'bin/ch-local.js'})],
        ['another script', doc([], {launcher: path.join(h.dir, 'bin', 'other.js')})],
        ['a launcher outside the home', doc([], {launcher: path.join(outside, 'ch-local.js')})],
        ['a launcher linked out of the home', doc([], {launcher: path.join(linked, 'ch-local.js')})]]) {
        assert.throws(() => heldBack.parse(text, h.settings), Error, label);
      }
    });

    it('read from --heldBackFile, beside --settingsFile only; one that cannot be read is empty, and reread says so', () => {
      const options = require('../../lib/cli-options');
      const kept = {heldBackFile: options.heldBackFile, settingsFile: options.settingsFile};
      const h = home();
      const file = path.join(h.dir, 'held-back.json');
      const LOG = require('../../lib/logger');
      const realW = LOG.W;
      LOG.W = () => undefined;
      try {
        Object.assign(options, {settingsFile: h.settings, heldBackFile: file});
        fs.writeFileSync(file, doc([{name: 'a', reason: 'credential'}]));
        heldBack.resetForTests();
        assert.deepStrictEqual([...heldBack.list().modules.keys()], ['a']);
        fs.writeFileSync(file, '{');
        assert.throws(() => heldBack.reread(), (e) => e.code === 'CONTROL_FAILED');
        assert.strictEqual(heldBack.list().modules.size, 0, 'a file that cannot be read: no module held back (never "all ready")');
        fs.writeFileSync(file, doc([{name: 'b', reason: 'off'}]));
        assert.deepStrictEqual(heldBack.reread(), {});
        assert.deepStrictEqual([...heldBack.list().modules.keys()], ['b']);
        Object.assign(options, {heldBackFile: null});
        assert.throws(() => heldBack.reread(), (e) => e.code === 'CONTROL_FAILED');
      } finally {
        LOG.W = realW;
        Object.assign(options, kept);
        heldBack.resetForTests();
      }
    });
  });

  tmp.hooks();
});
