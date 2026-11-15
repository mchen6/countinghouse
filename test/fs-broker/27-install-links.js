// The links an install is reached through (lib/fs-broker/install-links.js;
// #280's follow-up). An install run by a spelling that isn't its real path
// (#272) is reached through links: whoever can replace one of them points
// the next start at other code. Each link's own place -- its name in its
// parent's real path -- is a protected path, so no module may declare it or
// a directory above it, however the declared root is spelled.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {linkLocations} = require('../../lib/fs-broker/install-links');
const {createNamespace} = require('../../lib/fs-broker/namespace');
const {mkdtemp} = require('../helpers/test-tmp');

const ROOT = fs.realpathSync.native(path.join(__dirname, '..', '..'));
const WIN = process.platform === 'win32';

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

  // a junction's target is always absolute; a relative one needs a symlink
  (WIN ? it.skip : it)('a relative target is followed from the link\'s real parent', () => {
    dir('real-parent', 'versions', 'one');
    dir('elsewhere', 'two');
    const parent = link(path.join(base, 'real-parent'), 'parent');
    // <base>/real-parent/hop -> ../elsewhere/hop2 -> two
    fs.symlinkSync(path.join('..', 'elsewhere', 'hop2'), path.join(base, 'real-parent', 'hop'));
    fs.symlinkSync('two', path.join(base, 'elsewhere', 'hop2'));
    assert.deepStrictEqual(linkLocations(path.join(parent, 'hop')),
      [parent, path.join(base, 'real-parent', 'hop'), path.join(base, 'elsewhere', 'hop2')]);
  });

  it('a loop of links ends, with the links it met', () => {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.symlinkSync(b, a, 'junction');
    fs.symlinkSync(a, b, 'junction');
    assert.deepStrictEqual(linkLocations(path.join(a, 'install')), [a, b]);
  });

  // What the protection is for: with the install's links among the
  // protected paths, a module that declares the directory one of them is in
  // -- by a spelling that names neither the install nor its real path -- is
  // refused that root (lib/fs-broker/namespace.js prepare).
  it('a module declaring the directory a link is in, by another spelling, is refused that root', async () => {
    dir('q', 'r', 'copy');
    dir('x');
    // run as <base>/install, a link to <base>/x/r/copy, where <base>/x/r is
    // itself a link: really <base>/q/r/copy
    const viaTarget = link(path.join(base, 'q', 'r'), 'x', 'r');
    const install = link(path.join(base, 'x', 'r', 'copy'), 'install');
    // <base>/z is <base>/x, where the link "r" is, under another name:
    // neither the install as written nor its real path is in or above it
    const z = link(path.join(base, 'x'), 'z');
    const n = createNamespace({moduleRoot: dir('m', 'app'), dataDir: dir('m', 'data'), tmpDir: dir('m', 'tmp'),
      protectedPaths: [install].concat(linkLocations(install)),
      declared: [{path: z, access: 'rw'}, {path: dir('unrelated'), access: 'rw'}]});
    await n.prepare();
    assert.deepStrictEqual(n.refused, [{path: z, reason: `overlaps countinghouse's ${viaTarget}`}]);
  });

  // The runtime itself, loaded through links (as --preserve-symlinks-main
  // runs an install by its spelling): what it protects, and what it denies.
  it('the runtime protects the links it is reached through; none is a denied tree', () => {
    dir('realp');
    const p = link(path.join(base, 'realp'), 'p');
    const inner = link(ROOT, 'realp', 'install');
    const options = {modulePath: path.join(base, 'modules'), moduleDataPath: path.join(base, 'data'), authConfigPath: path.join(base, 'auth.json')};
    const code = `const b = require(${JSON.stringify(path.join(p, 'install', 'lib', 'fs-broker'))}); const o = ${JSON.stringify(options)};
      console.log(JSON.stringify({install: b.INSTALL_DIR, protectedPaths: b.protectedPaths(o), deniedTrees: b.deniedTreesFor(o)}));`;
    const seen = JSON.parse(execFileSync(process.execPath, ['--preserve-symlinks', '-e', code], {encoding: 'utf8', timeout: 30000}));
    assert.strictEqual(seen.install, path.join(p, 'install'), 'loaded by its spelling');
    for (const place of [p, inner]) {
      assert.ok(seen.protectedPaths.includes(place), `${place}: ${JSON.stringify(seen.protectedPaths)}`);
      // a denied tree follows its directory to its real path: a link's
      // place as one would refuse the install itself, which stays readable
      // but for its secrets (#260)
      assert.ok(!seen.deniedTrees.includes(place), `${place}: ${JSON.stringify(seen.deniedTrees)}`);
    }
    assert.ok(!seen.deniedTrees.includes(seen.install), JSON.stringify(seen.deniedTrees));
    assert.ok(seen.deniedTrees.includes(options.moduleDataPath), JSON.stringify(seen.deniedTrees));
  });

  // --hardened: the relaunched server may not lstat above its grants, so it
  // could not find the links itself; the parent's list reaches it with the
  // real paths (lib/hardened-launch.js relaunch).
  it('--hardened: the relaunched runtime protects the links its parent found', () => {
    dir('realp');
    const p = link(path.join(base, 'realp'), 'p');
    const inner = link(ROOT, 'realp', 'install');
    const options = {modulePath: path.join(base, 'modules'), moduleDataPath: path.join(base, 'data'), authConfigPath: path.join(base, 'auth.json')};
    // read grants: the spelling it is loaded by, the checkout, and its
    // dependencies where a worktree links them in from elsewhere
    const grants = [base, ROOT, fs.realpathSync.native(path.join(ROOT, 'node_modules'))];
    const script = path.join(p, 'install', 'test', 'fs-broker', 'scripts', 'relaunch-links.js');
    const seen = JSON.parse(execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', script, JSON.stringify(options)].concat(grants),
      {encoding: 'utf8', timeout: 60000}));
    assert.notStrictEqual(seen.lstatAboveGrants, 'allowed', 'the relaunched process may not look above its grants');
    assert.deepStrictEqual(seen.handed, [p, inner]);
    for (const place of [p, inner]) assert.ok(seen.protectedPaths.includes(place), `${place}: ${JSON.stringify(seen.protectedPaths)}`);
  });

  // the relaunched --hardened server may not lstat above its grants: there
  // the list comes from the parent (lib/hardened-realpaths.js); a walk that
  // is refused keeps what it found and never throws
  it('a walk that is refused keeps what it found', () => {
    const install = link(dir('copy'), 'install');
    const refused = () => { throw Object.assign(new Error('Access to this API has been restricted'), {code: 'ERR_ACCESS_DENIED'}); };
    assert.deepStrictEqual(linkLocations(install, {lstatSync: refused, readlinkSync: fs.readlinkSync, realpathSync: fs.realpathSync.native}), []);
    assert.deepStrictEqual(linkLocations(install, {lstatSync: fs.lstatSync, readlinkSync: refused, realpathSync: fs.realpathSync.native}), [install]);
  });
});
