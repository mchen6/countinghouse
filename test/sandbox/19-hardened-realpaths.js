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

const LIB = path.join(__dirname, '..', '..', 'lib', 'hardened-realpaths');

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
