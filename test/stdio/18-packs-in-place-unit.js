// Modules in place (#413 rev 3 section 7.2; packs in place before it),
// server-free: confinement to --modulesRoot by real path, and the links a
// module's tree holds. (The pack form's name, allowances and ceiling went in
// M6.)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {realPath} = require('../helpers/real-path');
const {insideRoots, linkOut} = require('../../lib/modules-in-place');

describe('stdio 18: modules in place, server-free: the roots', () => {
  it('inside --modulesRoot is by real path: a link out of the root is outside; a sibling sharing its prefix is outside', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-18-'));
    try {
      const root = path.join(base, 'packs');
      fs.mkdirSync(path.join(root, 'p', 'node_modules', 'm'), {recursive: true});
      fs.mkdirSync(path.join(base, 'packs-evil', 'm'), {recursive: true});
      fs.mkdirSync(path.join(base, 'away'), {recursive: true});
      fs.symlinkSync(path.join(base, 'away'), path.join(root, 'p', 'node_modules', 'link'), 'dir');
      const rs = [realPath(root)];
      assert.strictEqual(insideRoots(path.join(root, 'p', 'node_modules', 'm'), rs), true);
      assert.strictEqual(insideRoots(path.join(root, 'p', 'node_modules', 'link'), rs), false);
      assert.strictEqual(insideRoots(path.join(base, 'packs-evil', 'm'), rs), false);
      assert.strictEqual(insideRoots(path.join(root, 'missing'), rs), false);
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });

  it('a module\'s links are found by walking it: a file link out is named; a link inside the root is not', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-18-'));
    try {
      const root = path.join(base, 'packs');
      const m = path.join(root, 'p', 'node_modules', 'm');
      fs.mkdirSync(path.join(m, 'handlers', 's'), {recursive: true});
      fs.writeFileSync(path.join(root, 'p', 'inside.js'), '');
      fs.symlinkSync(path.join(root, 'p', 'inside.js'), path.join(m, 'handlers', 's', 'ok.js'));
      const rs = [realPath(root)];
      assert.strictEqual(linkOut(realPath(m), rs), null);
      fs.writeFileSync(path.join(base, 'away.js'), '');
      fs.symlinkSync(path.join(base, 'away.js'), path.join(m, 'handlers', 's', 'out.js'));
      assert.strictEqual(linkOut(realPath(m), rs), path.join(realPath(m), 'handlers', 's', 'out.js'));
      fs.rmSync(path.join(m, 'handlers', 's', 'out.js'));
      fs.symlinkSync(path.join(base, 'missing.js'), path.join(m, 'handlers', 's', 'dangling.js'));
      assert.ok(linkOut(realPath(m), rs) != null, 'a dangling link');
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });
});
