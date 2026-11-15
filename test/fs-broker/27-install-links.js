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

  it('a loop of links ends, with the links it met', () => {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.symlinkSync(b, a, 'junction');
    fs.symlinkSync(a, b, 'junction');
    assert.deepStrictEqual(linkLocations(path.join(a, 'install')), [a, b]);
  });

  // A name that is not there, or that this process may not reach (a
  // directory it cannot search), ends the walk: the runtime reaches nothing
  // through what comes after it. The walk says it stopped short, so its
  // answer is not kept as the path's last word (the name may appear later,
  // as a link). Any other failure is the caller's to see: a list cut short
  // in silence would leave a link unprotected.
  it('a name that is missing or cannot be reached ends the walk, said as incomplete; any other failure is thrown', () => {
    const install = link(dir('copy'), 'install');
    assert.deepStrictEqual(walkLinks(install), {places: [install], complete: true});
    assert.deepStrictEqual(walkLinks(path.join(install, 'not', 'there')), {places: [install], complete: false});
    const failing = (code) => () => { throw Object.assign(new Error(code), {code}); };
    const real = {lstatSync: fs.lstatSync, readlinkSync: fs.readlinkSync, realpathSync: fs.realpathSync.native};
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']) {
      assert.deepStrictEqual(walkLinks(install, Object.assign({}, real, {readlinkSync: failing(code)})), {places: [install], complete: false}, code);
      assert.deepStrictEqual(linkLocations(install, Object.assign({}, real, {lstatSync: failing(code)})), [], code);
    }
    for (const code of ['ERR_ACCESS_DENIED', 'EIO', 'ELOOP']) {
      assert.throws(() => linkLocations(install, Object.assign({}, real, {lstatSync: failing(code)})), {code}, code);
      assert.throws(() => linkLocations(install, Object.assign({}, real, {readlinkSync: failing(code)})), {code}, code);
    }
  });

  // In this process (the install and the start file are mocha's own): a
  // configured path whose end is not there yet is asked again at the next
  // spawn, so a link that appears there later is seen without a restart.
  it('a path that did not resolve is walked again: a link made later on it is seen', () => {
    const broker = require('../../lib/fs-broker');
    const options = {modulePath: dir('modules'), moduleDataPath: dir('data'), authConfigPath: path.join(base, 'auth.json'),
      deviceConfigPath: path.join(base, 'devices'), modulePolicy: path.join(base, 'later', 'policy.json')};
    assert.ok(!broker.protectedLinks(options).some((p) => p.startsWith(base)), 'nothing there yet');
    const later = link(dir('elsewhere'), 'later');
    assert.ok(broker.protectedLinks(options).includes(later), JSON.stringify(broker.protectedLinks(options)));
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
      assert.deepStrictEqual(n.refused, [{path: z, reason: `holds ${viaTarget}, a link countinghouse runs through`}]);
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

  // The runtime itself. Its install may be loaded through links (as
  // --preserve-symlinks runs it by its spelling): <out>/p is a link to
  // <out>/realp, and <out>/realp/install a link to this checkout. So may the
  // file it is started from, and any path it is configured with. <out> is
  // outside the checkout: a root inside the install's real path is refused
  // for that alone, whatever links there are.
  describe('the runtime: its install, the file it is started from, and its configured paths', () => {
    let out;
    let made;
    let p;
    let inner;
    let spelled;
    let options;
    let dataLink;
    const outDir = (...names) => { const d = path.join(out, ...names); fs.mkdirSync(d, {recursive: true}); return d; };
    const outLink = (target, ...names) => { const l = path.join(out, ...names); fs.symlinkSync(target, l, 'junction'); made.push(l); return l; };
    const PRESERVE = ['--preserve-symlinks', '--preserve-symlinks-main'];
    const run = (args, flags = PRESERVE) => JSON.parse(execFileSync(process.execPath, flags.concat(args), {encoding: 'utf8', timeout: 60000}));
    const script = (root, name) => path.join(root, 'test', 'fs-broker', 'scripts', name);
    beforeEach(() => {
      out = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-install-links-')));
      made = [];
      outDir('realp');
      p = outLink(path.join(out, 'realp'), 'p');
      inner = outLink(ROOT, 'realp', 'install');
      spelled = path.join(p, 'install');
      // module data configured through a link: <out>/links/dl leads to <out>/store/real-data
      outDir('links');
      dataLink = outLink(outDir('store', 'real-data'), 'links', 'dl');
      options = {modulePath: outDir('modules'), moduleDataPath: path.join(dataLink, 'data'), authConfigPath: path.join(out, 'auth.json'),
        deviceConfigPath: path.join(out, 'devices')};
    });
    afterEach(() => {
      // the links first, so the removal never follows one into the checkout
      for (const l of made.reverse()) { try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { /* gone */ } } }
      fs.rmSync(out, {recursive: true, force: true});
    });

    it('an install loaded through links knows them; its protected paths are as they were', () => {
      const seen = run([script(spelled, 'links-print.js'), JSON.stringify(options)]);
      assert.strictEqual(seen.install, spelled, 'loaded by its spelling');
      for (const place of [p, inner]) {
        assert.ok(seen.links.includes(place), `${place}: ${JSON.stringify(seen.links)}`);
        // a protected path is a denied tree, followed to its real path: a
        // link's place as one would refuse the install itself, which stays
        // readable but for its secrets (#260)
        assert.ok(!seen.protectedPaths.includes(place), JSON.stringify(seen.protectedPaths));
      }
      assert.strictEqual(new Set(seen.links).size, seen.links.length, 'each once');
    });

    it('a configured path given through a link: the link is known, with no install link in play', () => {
      const seen = run([script(ROOT, 'links-print.js'), JSON.stringify(options)], []);
      assert.strictEqual(seen.install, ROOT);
      assert.ok(seen.links.includes(dataLink), JSON.stringify(seen.links));
      assert.ok(!seen.protectedPaths.includes(dataLink), JSON.stringify(seen.protectedPaths));
    });

    it('a --loadModule root given through a link: the link is known', () => {
      const moduleLink = outLink(outDir('store', 'mods'), 'links', 'ml');
      const withLocal = Object.assign({}, options, {localModulePath: [path.join(moduleLink, 'weather')]});
      const seen = run([script(ROOT, 'links-print.js'), JSON.stringify(withLocal)], []);
      assert.ok(seen.links.includes(moduleLink), JSON.stringify(seen.links));
    });

    // The countinghouse launcher is a shell script that finds itself by its
    // real path and runs framework.js by it, so Node never sees the link the
    // operator's command went through. It says how it was started.
    posixIt('the launcher tells the runtime the path it was started by; that path\'s links are known', () => {
      // the launcher script itself, under another name (the suite's port
      // guard takes a spawn of the real one for a server start), reached
      // through a link: <out>/via leads to <out>/tool
      const real = path.join(outDir('tool', 'bin'), 'ch-launcher');
      fs.copyFileSync(path.join(ROOT, 'bin', 'countinghouse'), real);
      fs.chmodSync(real, 0o755);
      const via = outLink(path.join(out, 'tool'), 'via');
      const launcher = path.join(via, 'bin', 'ch-launcher');
      // a stand-in node, first on PATH, that prints what the launcher handed it
      const stub = outDir('stub');
      fs.writeFileSync(path.join(stub, 'node'), '#!/bin/sh\nprintf "%s\\n" "$COUNTINGHOUSE_STARTED_FROM"\n', {mode: 0o755});
      const env = Object.assign({}, process.env, {PATH: `${stub}:/usr/bin:/bin`});
      const said = (cmd, cwd) => execFileSync(cmd, [], {encoding: 'utf8', env, cwd, timeout: 20000}).trim().split('\n').pop();
      assert.strictEqual(said(launcher, out), launcher, 'as it was named, not its real path');
      assert.strictEqual(path.resolve(said('./ch-launcher', path.dirname(real))), real, 'a relative name is made absolute');
      // and the runtime walks it: started by its real path, told the named one
      const seen = JSON.parse(execFileSync(process.execPath, [script(ROOT, 'links-print.js'), JSON.stringify(options)],
        {encoding: 'utf8', timeout: 60000, env: Object.assign({}, process.env, {COUNTINGHOUSE_STARTED_FROM: launcher})}));
      assert.strictEqual(seen.install, ROOT);
      assert.ok(seen.links.includes(via), `${via}: ${JSON.stringify(seen.links)}`);
    });

    // Without --preserve-symlinks Node runs the main file by its real path,
    // so the install has no link in it; the operator's command still goes
    // through one (a "current" link, npm's bin link), and whoever repoints
    // that link chooses what the next start runs.
    posixIt('the file the runtime is started from, through a link: the link is known though the install is its real path', () => {
      const started = path.join(out, 'started.js');
      fs.symlinkSync(script(ROOT, 'links-print.js'), started);
      made.push(started);
      const seen = run([started, JSON.stringify(options)], []);
      assert.strictEqual(seen.install, ROOT, 'the install as Node resolved it');
      assert.ok(seen.links.includes(started), JSON.stringify(seen.links));
    });

    it('a module\'s spawn refuses a writable root that holds an install link, declared by another spelling', () => {
      // <out>/z is <out>/realp, where the link "install" is, under another name
      const z = outLink(path.join(out, 'realp'), 'z');
      const kept = outDir('kept');
      const seen = run([script(spelled, 'links-spawn.js'), outDir('modules', 'm'), outDir('data'),
        JSON.stringify([{path: z, access: 'rw'}, {path: kept, access: 'rw'}])]);
      assert.deepStrictEqual(seen.refused, [{path: z, reason: `holds ${inner}, a link countinghouse runs through`}]);
      assert.deepStrictEqual(seen.reported, [`${z} (holds ${inner}, a link countinghouse runs through)`]);
      assert.deepStrictEqual(seen.declaredRoots, [kept]);
    });

    it('a module\'s spawn refuses a writable root that holds a configured path\'s link, declared by another spelling', () => {
      // <out>/z is <out>/links, where the data path's link "dl" is, under
      // another name; the data itself is elsewhere (<out>/store)
      const z = outLink(path.join(out, 'links'), 'z');
      const kept = outDir('kept');
      const seen = run([script(ROOT, 'links-spawn.js'), outDir('modules', 'm'), options.moduleDataPath,
        JSON.stringify([{path: z, access: 'rw'}, {path: z, access: 'r'}, {path: kept, access: 'rw'}])], []);
      assert.deepStrictEqual(seen.refused, [{path: z, reason: `holds ${dataLink}, a link countinghouse runs through`}]);
      assert.deepStrictEqual(seen.declaredRoots, [z, kept], 'read-only, the same root is kept');
    });

    // --hardened: the relaunched server may not lstat above its grants, so
    // it could not find the links itself; the parent's lists, one a path,
    // reach it with the real paths (lib/hardened-launch.js precompute and
    // relaunch).
    it('--hardened: the relaunched runtime has the links its parent found, for the install, the start file and each configured path', () => {
      // read grants: the spelling it is loaded by, the checkout, and its
      // dependencies where a worktree links them in from elsewhere
      const grants = [out, ROOT, fs.realpathSync.native(path.join(ROOT, 'node_modules'))];
      const started = script(spelled, 'relaunch-links.js');
      // a spawn's own paths: a throwaway inside the server's data path (a
      // validation's), and a policy file the server was not started with
      const stray = path.join(out, 'stray', 'policy.json');
      const spawn = Object.assign({}, options, {moduleDataPath: path.join(options.moduleDataPath, '.validate', '0123456789abcdef'), modulePolicy: stray});
      const seen = run([started, JSON.stringify(options), JSON.stringify(spawn)].concat(grants));
      assert.notStrictEqual(seen.lstatAboveGrants, 'allowed', 'the relaunched process may not look above its grants');
      // the relaunch itself found them (nothing ran before it but the options)
      assert.deepStrictEqual(seen.handed[spelled], [p, inner], JSON.stringify(seen.handed));
      assert.deepStrictEqual(seen.handed[started], [p, inner], 'the start file, as named');
      assert.deepStrictEqual(seen.handed[options.moduleDataPath], [dataLink], JSON.stringify(seen.handed));
      assert.ok(!Object.keys(seen.handed).some((k) => k.includes('.validate')), 'a spawn\'s throwaway is no key');
      for (const place of [p, inner, dataLink]) assert.ok(seen.links.includes(place), `${place}: ${JSON.stringify(seen.links)}`);
      // the throwaway is inside the server's data path: that path's links are its own, and nothing is looked for.
      // The stray path nothing was handed for cannot be looked for: it is said, not passed over
      assert.deepStrictEqual(seen.unchecked, [stray]);
    });

    it('a spawn\'s path inside one of the server\'s own is never walked for itself: no entry is kept for a validation\'s throwaway', () => {
      const spawn = Object.assign({}, options, {moduleDataPath: path.join(options.moduleDataPath, '.validate', '0123456789abcdef')});
      const seen = run([script(ROOT, 'links-print.js'), JSON.stringify(spawn), JSON.stringify(options)], []);
      assert.ok(seen.links.includes(dataLink), JSON.stringify(seen.links));
      assert.ok(Object.keys(seen.server).includes(options.moduleDataPath), JSON.stringify(Object.keys(seen.server)));
      assert.ok(!Object.keys(seen.server).some((k) => k.includes('.validate')), JSON.stringify(Object.keys(seen.server)));
    });
  });
});
