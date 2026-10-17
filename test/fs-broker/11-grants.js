const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');
const {mkdtemp} = require('../helpers/test-tmp');

const S = (name) => path.join(__dirname, 'scripts', name);

describe('fs-broker 11: path-scoped original-fs grants (L1)', function() {
  this.timeout(60000);
  let dir = null;
  afterEach(() => { if (dir) fs.rmSync(dir, {recursive: true, force: true}); dir = null; });

  it('serves stat calls under a resolve grant, reads of one file under a read grant, and both under the boot grant', async () => {
    // Outside the repo (served by host path until Task 4) and outside /tmp.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-grants-')));
    fs.writeFileSync(path.join(dir, 'f.txt'), 'granted');
    fs.writeFileSync(path.join(dir, 'g.txt'), 'booted');
    const m = await runBrokered(S('grants.js'), {mode: 'enforce', extra: {dir}});
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    const r = m.r;
    assert.strictEqual(r.before, 'ENOENT');
    assert.strictEqual(r.realpathGranted, true);
    assert.strictEqual(r.dotdotNotGranted, 'ENOENT', 'a path that leaves the root through .. is not granted');
    assert.strictEqual(r.readNotGranted, 'ENOENT', 'a resolve grant does not grant reads');
    assert.strictEqual(r.readGranted, 'granted');
    assert.strictEqual(r.otherNotGranted, 'ENOENT');
    assert.strictEqual(r.originalsRead, 'granted');
    assert.strictEqual(r.bootRead, 'booted');
    assert.strictEqual(r.afterBoot, 'ENOENT');
    assert.strictEqual(r.grantNotExported, true);
  });

  it('a countinghouse parent imports an ES-module dependency under live enforce (review I4)', async () => {
    dir = mkdtemp('esm-dep-');
    const ch = path.join(dir, 'ch');
    const mod = path.join(dir, 'mod');
    fs.mkdirSync(path.join(ch, 'lib'), {recursive: true});
    fs.mkdirSync(path.join(ch, 'node_modules', 'esm-dep'), {recursive: true});
    fs.mkdirSync(mod);
    fs.writeFileSync(path.join(ch, 'lib', 'parent.js'), "module.exports = () => import('esm-dep').then((m) => m.default);\n");
    fs.writeFileSync(path.join(ch, 'node_modules', 'esm-dep', 'package.json'), JSON.stringify({name: 'esm-dep', type: 'module', exports: './index.js'}));
    fs.writeFileSync(path.join(ch, 'node_modules', 'esm-dep', 'index.js'), "export default 'esm-ok';\n");
    const m = await runBrokered(S('esm-dep.js'), {mode: 'enforce', extra: {ch, mod}});
    assert.deepStrictEqual(m, {ok: true, r: 'esm-ok'}, JSON.stringify(m));
  });
});
