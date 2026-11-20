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
// fd 3 as the relaunch does, and the install's links with it (undefined:
// none handed). It prints what the expression `ask` gives, with r the
// library, read once its output has closed.
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
    child.on('close', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`the child printed ${JSON.stringify(out)}; stderr: ${err.slice(-2000)}`)); } });
    realpaths.send(child, known, links);
  });
}

// What realpathSync gave that child for each of `ask`, and whether the
// marker is still in its environment.
function childSees(grants, known, ask) {
  return childGives(grants, known, undefined, `(() => {
    const out = {}; for (const p of ${JSON.stringify(ask)}) { try { out[p] = r.realpathSync(p); } catch (e) { out[p] = e.code; } }
    out.env = process.env[r.ENV] == null ? 'gone' : 'still set';
    return out; })()`);
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

  // #280's follow-up: the links countinghouse is reached through
  // (lib/fs-broker/index.js protectedLinks) are found by lstat-ing every
  // directory above each path, which the child may not do. The parent's
  // lists, one a path, travel with the real paths.
  it('each path\'s links travel with the real paths, and are no real path\'s answer', async () => {
    base = mkdtemp('realpaths-');
    const place = path.join(base, 'r', 'install');
    const handed = {[path.join(base, 'install')]: [place], [path.join(base, 'data')]: []};
    const seen = await childGives([base], {[base]: base}, handed, `({links: r.linkPlaces(), real: r.realpathSync(${JSON.stringify(base)})})`);
    assert.deepStrictEqual(seen, {links: handed, real: base});
    assert.deepStrictEqual(await childGives([base], {}, {}, 'r.linkPlaces()'), {}, 'none found is an answer too');
    // a relaunched server handed none has an empty map, not "look for yourself": it may not
    assert.deepStrictEqual(await childGives([base], {}, undefined, 'r.linkPlaces()'), {}, 'nothing handed over');
    assert.strictEqual(realpaths.linkPlaces(), null, 'null only in a process that was not relaunched');
    // the map has no prototype to replace, and "__proto__" is no path
    assert.deepStrictEqual(await childGives([base], {}, {['__proto__']: [place]},
      '({proto: Object.getPrototypeOf(r.linkPlaces()), own: Object.keys(r.linkPlaces()), inherited: r.linkPlaces().toString === undefined})'),
    {proto: null, own: [], inherited: true});
    // what is not a list of places for a path is dropped, never taken for
    // one; a path and a place are absolute, or they are not one (the review of #282, M2)
    assert.deepStrictEqual(await childGives([base], {}, {[base]: 'x', [path.join(base, 'ok')]: [place, 7, 'relative/x', ''], 'relative/key': [place]}, 'r.linkPlaces()'),
      {[path.join(base, 'ok')]: [place]});
  });

  it('the broker goes by the parent\'s list for a path; for one it was handed none for, it cannot look, and has none', async () => {
    base = mkdtemp('realpaths-');
    const place = path.join(base, 'r', 'data-link');
    const options = {modulePath: path.join(base, 'modules'), moduleDataPath: path.join(base, 'data'), authConfigPath: path.join(base, 'auth.json'),
      deviceConfigPath: path.join(base, 'devices')};
    const broker = `require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))})`;
    const ask = `(() => { try { return {links: ${broker}.protectedLinks(${JSON.stringify(options)})}; } catch (e) { return {refused: [e.code, e.message]}; } })()`;
    // handed a list for every path it asks about: the parent's lists, nothing looked for
    const every = `(() => { const b = ${broker}; const all = {}; for (const p of b.pathsWalked(${JSON.stringify(options)})) all[p] = []; return Object.keys(all); })()`;
    const paths = await childGives([ROOT, base], {}, {}, every);
    const handed = Object.fromEntries(paths.map((p) => [p, p === options.moduleDataPath ? [place] : []]));
    assert.deepStrictEqual(await childGives([ROOT, base], {}, handed, ask), {links: [place]});
    // one path it was handed nothing for: it may not lstat above its grants,
    // and does not go on without it (the review of #282, M1)
    delete handed[options.modulePath];
    const some = await childGives([ROOT, base], {}, handed, ask);
    assert.strictEqual(some.refused[0], 'MODULE_SANDBOX_REFUSED');
    assert.ok(some.refused[1].includes(options.modulePath) && /--permission.*--hardened/.test(some.refused[1]), some.refused[1]);
    // framework.js asks this when it starts under the permission model, and
    // refuses the start with what it says: nothing for a --hardened
    // relaunch, the reason for a process restricted another way
    const problem = `require(${JSON.stringify(path.join(ROOT, 'lib', 'hardened-launch'))}).startProblem()`;
    assert.match(await childGives([ROOT, base], {}, undefined, problem), /--permission.*--hardened/);
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
