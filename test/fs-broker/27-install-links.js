// The links an install is reached through (lib/fs-broker/install-links.js;
// #280's follow-up). An install run by a spelling that isn't its real path
// (#272) is reached through links: whoever can replace one of them points
// the next start at other code. Each link's own place -- its name in its
// parent's real path -- is known to the declaration check, so no module is
// given a writable root that holds one, however the root is spelled.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');
const {linkLocations, walkLinks} = require('../../lib/fs-broker/install-links');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {mkdtemp} = require('../helpers/test-tmp');

const ROOT = fs.realpathSync.native(path.join(__dirname, '..', '..'));
const WIN = process.platform === 'win32';
// a junction's target is always absolute; a relative one needs a symlink
const posixIt = WIN ? it.skip : it;

describe('fs-broker 27: the links an install is reached through', () => {
  let base = null;
  // the real path, so nothing above the test's own tree is a link
  beforeEach(() => { base = fs.realpathSync.native(mkdtemp('install-links-')); });
  afterEach(() => { fs.rmSync(base, {recursive: true, force: true}); });
  const dir = (...names) => { const p = path.join(base, ...names); fs.mkdirSync(p, {recursive: true}); return p; };
  const link = (target, ...names) => { const p = path.join(base, ...names); fs.symlinkSync(target, p, 'junction'); return p; };

  it('an install reached through no link has none', () => {
    assert.deepStrictEqual(linkLocations(dir('plain', 'install')), []);
  });

  it('an install that is a link: the link, where it is', () => {
    const install = link(dir('copy'), 'install');
    assert.deepStrictEqual(linkLocations(install), [install]);
  });

  it('a link in the middle, under a parent that is itself a link: each by its name in its parent\'s real path', () => {
    dir('r', 'a');
    dir('b', 'real', 'sub', 'install');
    const a = link(path.join(base, 'r', 'a'), 'a');
    const inner = link(path.join(base, 'b', 'real'), 'r', 'a', 'link');
    // spelled <base>/a/link/sub/install: "link" is found in <base>/r/a, never <base>/a
    assert.deepStrictEqual(linkLocations(path.join(a, 'link', 'sub', 'install')), [a, inner]);
  });

  it('a link met while following a link\'s target is one too', () => {
    dir('q', 'r', 'copy');
    dir('x');
    const viaTarget = link(path.join(base, 'q', 'r'), 'x', 'r');
    const install = link(path.join(base, 'x', 'r', 'copy'), 'install');
    assert.deepStrictEqual(linkLocations(install), [install, viaTarget]);
  });

  posixIt('a relative target is followed from the link\'s real parent', () => {
    dir('real-parent', 'versions', 'one');
    dir('elsewhere', 'two');
    const parent = link(path.join(base, 'real-parent'), 'parent');
    // <base>/real-parent/hop -> ../elsewhere/hop2 -> two
    fs.symlinkSync(path.join('..', 'elsewhere', 'hop2'), path.join(base, 'real-parent', 'hop'));
    fs.symlinkSync('two', path.join(base, 'elsewhere', 'hop2'));
    assert.deepStrictEqual(linkLocations(path.join(parent, 'hop')),
      [parent, path.join(base, 'real-parent', 'hop'), path.join(base, 'elsewhere', 'hop2')]);
  });

  // The host takes a target's names one at a time: "stage/../v1" goes
  // through the link "stage" before the "..", and so to the directory above
  // where stage leads -- not to the "v1" beside the link.
  posixIt('a ".." in a target is taken after the link before it, as the host takes it', () => {
    dir('other', 'x');
    const real = dir('other', 'v1');
    dir('p', 'v1');   // beside the links: where reading the target as text would go
    const stage = link(path.join(base, 'other', 'x'), 'p', 'stage');
    const install = path.join(base, 'p', 'install');
    fs.symlinkSync('stage/../v1', install);   // as text: path.join would fold the ".." away
    assert.strictEqual(fs.realpathSync.native(install), real, 'the host\'s own reading');
    assert.deepStrictEqual(linkLocations(install), [install, stage]);
  });

  // The reviewer's security review of #282 (I1). A target that goes into a
  // directory and leaves it again with ".." puts that directory on the
  // host's path: replace it with a link and ".." leaves somewhere else. So
  // every name the walk passes is on the path, not only the links, and a
  // writable root that holds one is refused.
  posixIt('a directory a target passes through and leaves with ".." is on the path: a writable root that holds it is refused (I1)', async () => {
    dir('srv');
    dir('data', 'x');
    const v1 = dir('opt', 'v1', 'ch');
    const current = path.join(base, 'srv', 'current');
    fs.symlinkSync('../data/x/../../opt/v1', current);
    const install = path.join(current, 'ch');
    assert.strictEqual(fs.realpathSync.native(install), v1);
    assert.deepStrictEqual(linkLocations(install), [current], 'the one link');
    const walk = walkLinks(install);
    const x = path.join(base, 'data', 'x');
    assert.ok(walk.passed.includes(x), `${x}: ${JSON.stringify(walk.passed)}`);
    assert.ok(walk.passed.includes(path.join(base, 'data')) && walk.passed.includes(path.join(base, 'opt', 'v1')), JSON.stringify(walk.passed));
    // the declared root holds neither a link nor the install, as written or really
    const data = path.join(base, 'data');
    const n = createNamespace({moduleRoot: dir('m', 'app'), dataDir: dir('m', 'data'), tmpDir: dir('m', 'tmp'),
      protectedPaths: [install], protectedLinks: walk.places.concat(walk.passed),
      declared: [{path: data, access: 'rw'}, {path: dir('unrelated'), access: 'rw'}]});
    await n.prepare();
    assert.deepStrictEqual(n.refused.map((r) => r.path), [data]);
    assert.match(n.refused[0].reason, /^holds .*, on a path countinghouse runs through$/);
    // what that root could do with a rename and a symlink of its own:
    // the host then reaches a directory inside the root
    fs.renameSync(x, path.join(data, 'x-was'));
    fs.mkdirSync(path.join(data, 'evil', 'a', 'b'), {recursive: true});
    const reached = path.join(data, 'evil', 'opt', 'v1', 'ch');
    fs.mkdirSync(reached, {recursive: true});
    fs.symlinkSync('evil/a/b', x);
    assert.strictEqual(fs.realpathSync.native(install), reached, 'the re-pointing the refusal prevents');
  });

  it('the names passed, for a path with no ".." in a target, are the directories above it: nothing more is refused', () => {
    const install = link(dir('copy', 'sub'), 'install');
    const walk = walkLinks(install);
    assert.deepStrictEqual(walk.places, [install]);
    // every one is the real target, or above the link or the target
    for (const p of walk.passed) assert.ok([install, path.join(base, 'copy', 'sub')].some((q) => q === p || q.startsWith(p.endsWith(path.sep) ? p : p + path.sep)), p);
  });

  it('a loop of links ends, with the links it met', () => {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.symlinkSync(b, a, 'junction');
    fs.symlinkSync(a, b, 'junction');
    assert.deepStrictEqual(linkLocations(path.join(a, 'install')), [a, b]);
  });

  // A name that is not there ends the walk: nothing is reached through what
  // comes after it. Any other failure is the caller's to see: a list cut
  // short in silence would leave a link unprotected.
  it('a missing name ends the walk with what it found; any other failure is thrown', () => {
    const install = link(dir('copy'), 'install');
    assert.deepStrictEqual(linkLocations(path.join(install, 'not', 'there')), [install]);
    const failing = (code) => () => { throw Object.assign(new Error(code), {code}); };
    const real = {lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, realpathSync: fs.realpathSync.native};
    for (const code of ['ERR_ACCESS_DENIED', 'EIO', 'EACCES']) {
      assert.throws(() => linkLocations(install, Object.assign({}, real, {lstatSync: failing(code)})), {code}, code);
      assert.throws(() => linkLocations(install, Object.assign({}, real, {readlinkSync: failing(code)})), {code}, code);
    }
  });

  // What the protection is for. The install is run as <base>/install, a
  // link to <base>/x/r/copy, where <base>/x/r is itself a link: really
  // <base>/q/r/copy. <base>/z is <base>/x, where the link "r" is, under
  // another name: neither the install as written nor its real path is in or
  // above it, so only the link's place tells.
  describe('a module\'s declared roots (lib/fs-broker/namespace.js prepare)', () => {
    let install;
    let viaTarget;
    const prepared = async (declared) => {
      const n = createNamespace({moduleRoot: dir('m', 'app'), dataDir: dir('m', 'data'), tmpDir: dir('m', 'tmp'),
        protectedPaths: [install], protectedLinks: linkLocations(install), declared: declared});
      await n.prepare();
      return n;
    };
    beforeEach(() => {
      dir('q', 'r', 'copy');
      dir('x');
      viaTarget = link(path.join(base, 'q', 'r'), 'x', 'r');
      install = link(path.join(base, 'x', 'r', 'copy'), 'install');
    });

    it('a writable root that holds a link, declared by another spelling of the link\'s directory, is refused', async () => {
      const z = link(path.join(base, 'x'), 'z');
      const n = await prepared([{path: z, access: 'rw'}, {path: dir('unrelated'), access: 'rw'}]);
      assert.deepStrictEqual(n.refused, [{path: z, reason: `holds ${viaTarget}, on a path countinghouse runs through`}]);
    });

    it('declared as written it is refused too, and so is a directory above it', async () => {
      const n = await prepared([{path: path.join(base, 'x'), access: 'rw'}, {path: path.join(base, 'x', 'r'), access: 'rw'}]);
      assert.deepStrictEqual(n.refused.map((r) => r.path), [path.join(base, 'x'), path.join(base, 'x', 'r')]);
    });

    it('a read-only root that holds the link is kept: it cannot repoint it', async () => {
      const z = link(path.join(base, 'x'), 'z');
      const n = await prepared([{path: z, access: 'r'}]);
      assert.deepStrictEqual(n.refused, []);
    });

    it('a root beside the install, inside what a link leads to, is kept: the link is protected, not its target', async () => {
      const beside = dir('q', 'r', 'beside');
      const n = await prepared([{path: beside, access: 'rw'}]);
      assert.deepStrictEqual(n.refused, []);
    });
  });

  // The runtime itself, loaded through links (as --preserve-symlinks runs an
  // install by its spelling). <out>/p is a link to <out>/realp, and
  // <out>/realp/install a link to this checkout. <out> is outside the
  // checkout: a root inside the install's real path is refused for that
  // alone, whatever links there are.
  describe('the runtime, loaded as <out>/p/install', () => {
    let out;
    let made;
    let p;
    let inner;
    let spelled;
    const outDir = (...names) => { const d = path.join(out, ...names); fs.mkdirSync(d, {recursive: true}); return d; };
    const outLink = (target, ...names) => { const l = path.join(out, ...names); fs.symlinkSync(target, l, 'junction'); made.push(l); return l; };
    const run = (args) => JSON.parse(execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main'].concat(args), {encoding: 'utf8', timeout: 60000}));
    beforeEach(() => {
      out = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-install-links-')));
      made = [];
      outDir('realp');
      p = outLink(path.join(out, 'realp'), 'p');
      inner = outLink(ROOT, 'realp', 'install');
      spelled = path.join(p, 'install');
    });
    afterEach(() => {
      // the links first, so the removal never follows one into the checkout
      for (const l of made.reverse()) { try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { /* gone */ } } }
      fs.rmSync(out, {recursive: true, force: true});
    });

    it('knows the links it is reached through; its protected paths are as they were', () => {
      const options = {modulePath: path.join(out, 'modules'), moduleDataPath: path.join(out, 'data'), authConfigPath: path.join(out, 'auth.json')};
      const code = `const b = require(${JSON.stringify(path.join(spelled, 'lib', 'fs-broker'))});
        console.log(JSON.stringify({install: b.INSTALL_DIR, links: b.installLinkPlaces(), protectedPaths: b.protectedPaths(${JSON.stringify(options)})}));`;
      const seen = run(['-e', code]);
      assert.strictEqual(seen.install, spelled, 'loaded by its spelling');
      // the two links, and the other names on the path (the directories above them and above the checkout)
      for (const place of [p, inner]) assert.ok(seen.links.includes(place), `${place}: ${JSON.stringify(seen.links)}`);
      assert.ok(seen.links.includes(out) && seen.links.includes(path.dirname(ROOT)), JSON.stringify(seen.links));
      // a protected path is a denied tree, followed to its real path: a
      // link's place as one would refuse the install itself, which stays
      // readable but for its secrets (#260)
      for (const place of [p, inner]) assert.ok(!seen.protectedPaths.includes(place), JSON.stringify(seen.protectedPaths));
    });

    it('a module\'s spawn refuses a writable root that holds one of them, declared by another spelling', () => {
      // <out>/z is <out>/realp, where the link "install" is, under another name
      const z = outLink(path.join(out, 'realp'), 'z');
      const kept = outDir('kept');
      const seen = run([path.join(spelled, 'test', 'fs-broker', 'scripts', 'links-spawn.js'), outDir('modules', 'm'), outDir('data'),
        JSON.stringify([{path: z, access: 'rw'}, {path: kept, access: 'rw'}])]);
      assert.deepStrictEqual(seen.refused, [{path: z, reason: `holds ${inner}, on a path countinghouse runs through`}]);
      assert.deepStrictEqual(seen.reported, [`${z} (holds ${inner}, on a path countinghouse runs through)`]);
      assert.deepStrictEqual(seen.declaredRoots, [kept]);
    });

    // --hardened: the relaunched server may not lstat above its grants, so
    // it could not find the links itself; the parent's list reaches it with
    // the real paths (lib/hardened-launch.js relaunch).
    it('--hardened: the relaunched runtime has the links its parent found', () => {
      // read grants: the spelling it is loaded by, the checkout, and its
      // dependencies where a worktree links them in from elsewhere
      const grants = [out, ROOT, fs.realpathSync.native(path.join(ROOT, 'node_modules'))];
      const seen = run([path.join(spelled, 'test', 'fs-broker', 'scripts', 'relaunch-links.js')].concat(grants));
      assert.notStrictEqual(seen.lstatAboveGrants, 'allowed', 'the relaunched process may not look above its grants');
      for (const place of [p, inner]) assert.ok(seen.handed.includes(place), `${place}: ${JSON.stringify(seen.handed)}`);
      assert.deepStrictEqual(seen.links, seen.handed, 'the broker goes by the parent\'s list');
    });
  });
});
