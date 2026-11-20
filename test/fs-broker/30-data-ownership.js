// The runtime deletes only directories it made (lib/data-ownership.js;
// A-overlap-rm, the reviewer's ruling split out of #452 round 3): ensureDirs
// records each data and tmp it creates in an ownership marker beside them;
// /tmp is emptied only when the marker names it as it is now; one not made
// here is kept and said once; one from before markers is adopted at its
// first spawn only at the expected path, under the overlap judgement.
// Server-free.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ownership = require('../../lib/data-ownership');
const moduleData = require('../../lib/module-data');
const walk = require('../../lib/fs-broker/spawn-walk');
const {mkdtemp} = require('../helpers/test-tmp');

// another module's code, where it must survive
const writeB = (dir) => {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name": "b"}');
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = 1;');
};
const survived = (dir) => fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, 'package.json'));

describe('fs-broker 30: the runtime deletes only directories it made', () => {
  let base = null;
  beforeEach(() => { ownership.resetForTests(); base = fs.realpathSync(mkdtemp('owned-')); });
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  it('ensureDirs records the data and tmp it makes; a /tmp the runtime made is emptied', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const marks = await ownership.readMarker(d.root, path.join(base, 'store'));
    assert.deepStrictEqual(Object.keys(marks).sort(), ['data', 'tmp']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(d.root, ownership.MARKER)).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(d.tmp, 'old'), 'x');
    assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root, base: path.join(base, 'store')}), true);
    assert.deepStrictEqual(fs.readdirSync(d.tmp), []);
    // found again: still the same directories, still owned
    await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    assert.strictEqual(await ownership.ownedDir(d.root, 'tmp', d.tmp, path.join(base, 'store')), true);
  });

  it('a /tmp the runtime did not make, holding another module\'s code: kept, said once', async () => {
    const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
    writeB(path.join(d.tmp, 'b'));
    fs.mkdirSync(d.data);
    // (found, not made: ensureDirs records nothing)
    await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const said = [];
    for (let i = 0; i < 2; i++) assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root, base: path.join(base, 'store'), say: (t) => said.push(t)}), false);
    assert.ok(survived(path.join(d.tmp, 'b')));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], /was not made by this runtime \(no ownership mark for it\), so it is not emptied/);
    // (and the recovery for a restored --moduleDataPath, naming the marker)
    assert.ok(said[0].endsWith(`-- if --moduleDataPath was restored from a backup or moved, stop the runtime and delete ${path.join(d.root, ownership.MARKER)}: it is adopted again at its next start`), said[0]);
  });

  // (a sibling made first and renamed into place: another inode, always --
  // the reviewer's high on #467, 6)
  it('a /tmp swapped since it was made (another directory renamed into its path) is kept', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const sibling = path.join(d.root, 'swap');
    writeB(path.join(sibling, 'b'));
    assert.notStrictEqual(fs.lstatSync(sibling, {bigint: true}).ino, fs.lstatSync(d.tmp, {bigint: true}).ino);
    fs.rmSync(d.tmp, {recursive: true});
    fs.renameSync(sibling, d.tmp);
    assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root, base: path.join(base, 'store')}), false);
    assert.ok(survived(path.join(d.tmp, 'b')));
  });

  // the reviewer's high on #467, 3: a <name>/ (or @scope) that is a link
  // leads to another module's marker, which must never vouch for it
  it('a <name>/ that is a link to another module\'s: its marker vouches for nothing, the other module\'s /tmp survives', async () => {
    const store = path.join(base, 'store');
    const m = await moduleData.ensureDirs(store, 'm');
    writeB(path.join(m.tmp, 'live'));
    fs.symlinkSync(m.root, path.join(store, 'm2'), 'junction');
    const m2 = moduleData.dirsFor(store, 'm2');
    assert.strictEqual(await ownership.ownedDir(m2.root, 'tmp', m2.tmp, store), false);
    assert.deepStrictEqual(await ownership.readMarker(m2.root, store), {});
    assert.strictEqual(await walk.emptyTmp(m2.tmp, {holder: m2.root, base: store}), false);
    assert.deepStrictEqual(await ownership.removeOwned(m2.root, m2, store), [m2.data, m2.tmp]);
    assert.ok(survived(path.join(m.tmp, 'live')), 'm\'s live /tmp emptied through m2');
    // and an @scope that is a link
    const s = await moduleData.ensureDirs(store, '@real/p');
    writeB(path.join(s.tmp, 'live'));
    fs.symlinkSync(path.join(store, '@real'), path.join(store, '@fake'), 'junction');
    const f = moduleData.dirsFor(store, '@fake/p');
    assert.strictEqual(await walk.emptyTmp(f.tmp, {holder: f.root, base: store}), false);
    assert.ok(survived(path.join(s.tmp, 'live')));
  });

  // the reviewer's high on #467, 1 and 2: birth is compared only where both
  // sides have one; a probe that fails is not remembered
  it('a recorded birth of 0 (birth times not real there) compares dev and ino only; a failed probe is asked again', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const marker = path.join(d.root, ownership.MARKER);
    const doc = JSON.parse(fs.readFileSync(marker, 'utf8'));
    doc.dirs.tmp.birth = '0';
    fs.writeFileSync(marker, JSON.stringify(doc), {mode: 0o600});
    assert.strictEqual(await ownership.ownedDir(d.root, 'tmp', d.tmp, path.join(base, 'store')), true);
    ownership.resetForTests();
    assert.strictEqual(await ownership.birthIsReal(path.join(base, 'no-such-holder'), 'probe-dev'), null, 'a probe that cannot run');
    assert.strictEqual(typeof(await ownership.birthIsReal(d.root, 'probe-dev')), 'boolean', 'not remembered: asked again');
  });

  it('a marker that is a link, not owner-only, too large or not its shape names nothing', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const marker = path.join(d.root, ownership.MARKER);
    const good = fs.readFileSync(marker, 'utf8');
    const elsewhere = path.join(base, 'elsewhere.json');
    fs.writeFileSync(elsewhere, good, {mode: 0o600});
    const cases = [
      ['a link', () => { fs.symlinkSync(elsewhere, marker); }],
      ['too large', () => { fs.writeFileSync(marker, good.replace('}\n', `, "pad": "${'x'.repeat(ownership.MAX_BYTES)}"}\n`), {mode: 0o600}); }],
      ['not JSON', () => { fs.writeFileSync(marker, 'not json', {mode: 0o600}); }],
      ['another version', () => { fs.writeFileSync(marker, good.replace('"v":1', '"v":2'), {mode: 0o600}); }]
    ];
    if (process.platform !== 'win32') cases.push(['not owner-only', () => { fs.writeFileSync(marker, good); fs.chmodSync(marker, 0o644); }]);
    for (const [what, make] of cases) {
      fs.rmSync(marker, {force: true});
      make();
      assert.strictEqual(await ownership.ownedDir(d.root, 'tmp', d.tmp, path.join(base, 'store')), false, what);
    }
  });

  it('a directory the runtime made that holds module code it knows is kept, never removed; one free of it is', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    writeB(path.join(d.data, 'b'));
    const said = [];
    const kept = await ownership.removeOwned(d.root, d, path.join(base, 'store'), (t) => said.push(t), {roots: [path.join(d.data, 'b')]});
    assert.deepStrictEqual(kept, [d.data]);
    assert.ok(survived(path.join(d.data, 'b')));
    assert.ok(!fs.existsSync(d.tmp), 'its tmp, made here and holding none, removed');
    assert.match(said.join('\n'), /holds module code this runtime knows, so it is not removed/);
    // single-thread's emptying likewise (no broker judgement before it)
    const e = await moduleData.ensureDirs(path.join(base, 'store'), 'n');
    writeB(path.join(e.tmp, 'b'));
    assert.strictEqual(await walk.emptyTmp(e.tmp, {holder: e.root, base: path.join(base, 'store'), code: {roots: [path.join(e.tmp, 'b')]}}), false);
    assert.ok(survived(path.join(e.tmp, 'b')));
    // a --modulePath folder inside it counts too
    assert.strictEqual(await ownership.codeInside(e.tmp, {folders: [path.join(e.tmp, 'b')]}), true);
    assert.strictEqual(await ownership.codeInside(e.tmp, {folders: [path.join(base)]}), false, 'a folder around it is not code inside it');
  });

  it('a fresh marker a crash left mid-write, or a birth-time probe, never keeps the holder from going', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    fs.writeFileSync(path.join(d.root, `${ownership.MARKER}.0123456789ab`), '{}', {mode: 0o600});
    fs.mkdirSync(path.join(d.root, `${ownership.MARKER}-probe-abc`));
    assert.deepStrictEqual(await ownership.removeOwned(d.root, d, path.join(base, 'store')), []);
    fs.rmdirSync(d.root);
  });

  describe('at a spawn (createForWorker)', () => {
    const {createForWorker} = require('../../lib/fs-broker');
    const spawn = async (mode, extra = {}) => {
      const mod = path.join(base, 'mod');
      fs.mkdirSync(mod, {recursive: true});
      fs.writeFileSync(path.join(mod, 'package.json'), '{"name": "m"}');
      const said = [];
      const fsb = await createForWorker(Object.assign({name: 'm', mode, modulePath: mod, declared: [],
        options: {moduleDataPath: path.join(base, 'store'), modulePath: base}, report: (rule, text) => said.push([rule, text])}, extra));
      await fsb.bridge.close();
      return said;
    };

    for (const mode of ['audit', 'off']) {
      it(`${mode}: a /tmp reached through a link at <name>/ is not the runtime's: another module's code in it survives, said once`, async () => {
        const real = path.join(base, 'elsewhere', 'm');
        writeB(path.join(real, 'tmp', 'b'));
        fs.mkdirSync(path.join(real, 'data'));
        fs.mkdirSync(path.join(base, 'store'));
        fs.symlinkSync(real, path.join(base, 'store', 'm'), 'junction');
        const said = await spawn(mode);
        await spawn(mode);
        assert.ok(survived(path.join(real, 'tmp', 'b')), 'emptied through the link');
        assert.deepStrictEqual(await ownership.readMarker(path.join(base, 'store', 'm'), path.join(base, 'store')), {}, 'nothing adopted');
        assert.strictEqual(said.filter(([rule]) => rule === 'unowned').length, 1, JSON.stringify(said));
      });
    }

    it('an unmarked data and tmp at their expected path, overlapping nothing, are adopted at the spawn and /tmp is emptied', async () => {
      const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
      fs.mkdirSync(d.data, {recursive: true});
      fs.mkdirSync(d.tmp, {recursive: true});
      fs.writeFileSync(path.join(d.tmp, 'old'), 'x');
      await spawn('audit');
      assert.deepStrictEqual(Object.keys(await ownership.readMarker(d.root, path.join(base, 'store'))).sort(), ['data', 'tmp']);
      assert.deepStrictEqual(fs.readdirSync(d.tmp), []);
    });

    it('an unmarked /tmp holding a module the runtime knows is kept and never adopted', async () => {
      const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
      fs.mkdirSync(d.data, {recursive: true});
      writeB(path.join(d.tmp, 'b'));
      await spawn('audit', {knownModules: [{name: 'b', root: path.join(d.tmp, 'b')}]});
      assert.ok(survived(path.join(d.tmp, 'b')));
      const marks = await ownership.readMarker(d.root, path.join(base, 'store'));
      assert.strictEqual(marks.tmp, undefined, 'not adopted');
      assert.ok(marks.data != null, 'its data, overlapping nothing, is');
    });
  });
});
