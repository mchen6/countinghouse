const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {runBrokered} = require('../helpers/brokered-worker');

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
    const m = await runBrokered(S('grants.js'), {mode: 'enforce', enforceFileDecisions: true, extra: {dir}});
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
});
