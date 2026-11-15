// --hardened: the unrestricted parent resolves the directories the server
// realpaths at startup (the install directory, module roots, protected paths,
// each dependency in the code-root walk) and hands them to the relaunched
// child on fd 3, because Node 24.22+ refuses a sync realpath of a granted
// directory whose name another grant extends (nodejs/node#66812). Grants are
// unchanged; the child just never makes that call (user decision, 2026-11-04).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const realpaths = require('../../lib/hardened-realpaths');
const {mkdtemp} = require('../helpers/test-tmp');

const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(ROOT, 'lib', 'hardened-realpaths');

// A child under --permission with only these read grants, given `known` on
// fd 3 as the relaunch does; it prints what realpathSync gave for `ask`.
function childSees(grants, known, ask) {
  return new Promise((resolve) => {
    const code = `const r = require(${JSON.stringify(LIB)}); r.receive();
      const out = {}; for (const p of ${JSON.stringify(ask)}) { try { out[p] = r.realpathSync(p); } catch (e) { out[p] = e.code; } }
      out.env = process.env[r.ENV] == null ? 'gone' : 'still set';
      process.stdout.write(JSON.stringify(out));`;
    const flags = ['--permission'].concat(grants.map((g) => `--allow-fs-read=${g}`), [`--allow-fs-read=${path.dirname(LIB)}`]);
    const child = spawn(process.execPath, flags.concat(['-e', code]),
      {env: Object.assign({}, process.env, realpaths.childEnv()), stdio: ['ignore', 'pipe', 'inherit', 'pipe']});
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('exit', () => resolve(JSON.parse(out)));
    realpaths.send(child, known);
  });
}

// The same child, handed the install's links as well (undefined: none
// handed); it prints what the expression `ask` gives, with r the library.
function childGives(grants, known, links, ask) {
  return new Promise((resolve, reject) => {
    const code = `const r = require(${JSON.stringify(LIB)}); r.receive(); process.stdout.write(JSON.stringify(${ask}));`;
    const flags = ['--permission'].concat(grants.map((g) => `--allow-fs-read=${g}`), [`--allow-fs-read=${path.dirname(LIB)}`]);
    const child = spawn(process.execPath, flags.concat(['-e', code]),
      {env: Object.assign({}, process.env, realpaths.childEnv()), stdio: ['ignore', 'pipe', 'pipe', 'pipe']});
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`the child printed ${JSON.stringify(out)}; stderr: ${err.slice(-2000)}`)); } });
    realpaths.send(child, known, links);
  });
}

describe('sandbox 19: --hardened precomputed real paths', function() {
  this.timeout(30000);
  let base = null;
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  it('records what a realpath function resolved, keyed by the spelling asked', () => {
    base = mkdtemp('realpaths-');
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
    const rec = realpaths.recorder(fs.realpathSync);
    assert.strictEqual(rec.realpath(path.join(base, 'link')), path.join(base, 'real'));
    assert.throws(() => rec.realpath(path.join(base, 'missing')), {code: 'ENOENT'});
    assert.deepStrictEqual(rec.known(), {[path.join(base, 'link')]: path.join(base, 'real')});
  });

  it('a child under --permission gets an overlapping directory\'s real path without a refused realpath', async () => {
    base = mkdtemp('realpaths-');
    const ch = path.join(base, 'ch');
    ['ch', 'ch_data'].forEach((d) => fs.mkdirSync(path.join(base, d)));
    const seen = await childSees([ch, `${ch}_data`], {[ch]: ch}, [ch]);
    assert.strictEqual(seen[ch], ch, JSON.stringify(seen));
    assert.strictEqual(seen.env, 'gone', 'the marker is removed so descendants never read fd 3');
  });

  it('a differently written spelling of a precomputed path is answered too (review)', async () => {
    base = mkdtemp('realpaths-');
    const ch = path.join(base, 'ch');
    ['ch', 'ch_data'].forEach((d) => fs.mkdirSync(path.join(base, d)));
    const rec = realpaths.recorder(fs.realpathSync);
    rec.realpath(`${ch}/`);
    assert.deepStrictEqual(rec.known(), {[ch]: ch}, 'recorded under the resolved spelling');
    const seen = await childSees([ch, `${ch}_data`], rec.known(), [`${ch}/`, `${ch}/.`]);
    assert.strictEqual(seen[`${ch}/`], ch, JSON.stringify(seen));
    assert.strictEqual(seen[`${ch}/.`], ch, JSON.stringify(seen));
  });

  it('anything not precomputed falls back to the real call', async () => {
    base = mkdtemp('realpaths-');
    fs.mkdirSync(path.join(base, 'other'));
    const other = path.join(base, 'other');
    const seen = await childSees([base], {}, [other, path.join(base, 'missing')]);
    assert.strictEqual(seen[other], other);
    assert.strictEqual(seen[path.join(base, 'missing')], 'ENOENT');
  });

  // #280's follow-up: the links the install is reached through
  // (lib/fs-broker/install-links.js) are found by lstat-ing every directory
  // above it, which the child may not do. The parent's list travels with the
  // real paths.
  it('the install\'s links travel with the real paths, and are no real path\'s answer', async () => {
    base = mkdtemp('realpaths-');
    const place = path.join(base, 'r', 'install');
    const seen = await childGives([base], {[base]: base}, [place], `({links: r.installLinks(), real: r.realpathSync(${JSON.stringify(base)})})`);
    assert.deepStrictEqual(seen, {links: [place], real: base});
    assert.deepStrictEqual(await childGives([base], {}, [], 'r.installLinks()'), [], 'none found is an answer too: the child does not look');
    assert.strictEqual(await childGives([base], {}, undefined, 'r.installLinks()'), null, 'nothing handed over');
    assert.strictEqual(realpaths.installLinks(), null, 'and never in a process that received nothing');
  });

  it('the relaunched server protects the links its parent found, where it may not look above its grants', async () => {
    base = mkdtemp('realpaths-');
    const place = path.join(base, 'r', 'install');
    const options = {modulePath: path.join(base, 'modules'), moduleDataPath: path.join(base, 'data'), authConfigPath: path.join(base, 'auth.json')};
    const ask = `(() => { const b = require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))}); const o = ${JSON.stringify(options)};
      return {protectedPaths: b.protectedPaths(o), deniedTrees: b.deniedTreesFor(o)}; })()`;
    const handed = await childGives([ROOT, base], {}, [place], ask);
    assert.ok(handed.protectedPaths.includes(place), JSON.stringify(handed.protectedPaths));
    // a denied tree follows its directory to its real path: a link's place
    // as one would refuse the install itself, which stays readable (#260)
    assert.ok(!handed.deniedTrees.includes(place), JSON.stringify(handed.deniedTrees));
    assert.ok(handed.deniedTrees.includes(options.moduleDataPath), JSON.stringify(handed.deniedTrees));
  });

  it('without the marker it reads nothing (an ordinary start)', () => {
    const was = process.env[realpaths.ENV];
    delete process.env[realpaths.ENV];
    try {
      realpaths.receive();
      assert.strictEqual(realpaths.realpathSync(__dirname), fs.realpathSync(__dirname));
    } finally {
      if (was != null) process.env[realpaths.ENV] = was;
    }
  });
});
