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
    const marks = await ownership.readMarker(d.root);
    assert.deepStrictEqual(Object.keys(marks).sort(), ['data', 'tmp']);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(d.root, ownership.MARKER)).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(d.tmp, 'old'), 'x');
    assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root}), true);
    assert.deepStrictEqual(fs.readdirSync(d.tmp), []);
    // found again: still the same directories, still owned
    await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    assert.strictEqual(await ownership.ownedDir(d.root, 'tmp', d.tmp), true);
  });

  it('a /tmp the runtime did not make, holding another module\'s code: kept, said once', async () => {
    const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
    writeB(path.join(d.tmp, 'b'));
    fs.mkdirSync(d.data);
    // (found, not made: ensureDirs records nothing)
    await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    const said = [];
    for (let i = 0; i < 2; i++) assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root, say: (t) => said.push(t)}), false);
    assert.ok(survived(path.join(d.tmp, 'b')));
    assert.strictEqual(said.length, 1, JSON.stringify(said));
    assert.match(said[0], /was not made by this runtime \(no ownership mark for it\), so it is not emptied/);
  });

  // (rm -r then mkdir: ext4 hands the new directory the same inode number at
  // once; its birth time tells them apart)
  it('a /tmp swapped since it was made (another directory at its path, even with the same inode number) is kept', async () => {
    const d = await moduleData.ensureDirs(path.join(base, 'store'), 'm');
    fs.rmSync(d.tmp, {recursive: true});
    writeB(path.join(d.tmp, 'b'));
    assert.strictEqual(await walk.emptyTmp(d.tmp, {holder: d.root}), false);
    assert.ok(survived(path.join(d.tmp, 'b')));
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
      assert.strictEqual(await ownership.ownedDir(d.root, 'tmp', d.tmp), false, what);
    }
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
        assert.deepStrictEqual(await ownership.readMarker(path.join(base, 'store', 'm')), {}, 'nothing adopted');
        assert.strictEqual(said.filter(([rule]) => rule === 'unowned').length, 1, JSON.stringify(said));
      });
    }

    it('an unmarked data and tmp at their expected path, overlapping nothing, are adopted at the spawn and /tmp is emptied', async () => {
      const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
      fs.mkdirSync(d.data, {recursive: true});
      fs.mkdirSync(d.tmp, {recursive: true});
      fs.writeFileSync(path.join(d.tmp, 'old'), 'x');
      await spawn('audit');
      assert.deepStrictEqual(Object.keys(await ownership.readMarker(d.root)).sort(), ['data', 'tmp']);
      assert.deepStrictEqual(fs.readdirSync(d.tmp), []);
    });

    it('an unmarked /tmp holding a module the runtime knows is kept and never adopted', async () => {
      const d = moduleData.dirsFor(path.join(base, 'store'), 'm');
      fs.mkdirSync(d.data, {recursive: true});
      writeB(path.join(d.tmp, 'b'));
      await spawn('audit', {knownModules: [{name: 'b', root: path.join(d.tmp, 'b')}]});
      assert.ok(survived(path.join(d.tmp, 'b')));
      const marks = await ownership.readMarker(d.root);
      assert.strictEqual(marks.tmp, undefined, 'not adopted');
      assert.ok(marks.data != null, 'its data, overlapping nothing, is');
    });
  });
});
