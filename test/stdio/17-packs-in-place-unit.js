// Packs in place (part 2, plan Task A3; #205's review), server-free: the
// pack name the control channel takes, a shared module's merged remote
// allowance, and confinement to --packsRoot by real path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {PACK_NAME, insideRoots, linkOut} = require('../../lib/packs-in-place');
const {mergedAllowance, START_ALLOWANCE} = require('../../lib/module-manager');

describe('stdio 17: packs in place, server-free', () => {
  it('a pack name is a scenario package name in the characters pack.<name> takes', () => {
    for (const ok of ['ch-pack-x', '@countinghouse/ch-pack-ci-failure-triage', 'a', `${'a'.repeat(64)}`]) assert.ok(PACK_NAME.test(ok), ok);
    for (const no of ['Ch-pack', 'a.b', 'a_b', '-a', '@x/', '@/a', `${'a'.repeat(65)}`, 'a/b', '@a/b/c', '']) assert.ok(!PACK_NAME.test(no), no);
  });

  it('a shared module\'s allowance is every pack\'s merged, and the process\'s beside them; one pack\'s removal leaves the others\'', () => {
    const byPack = new Map([
      [START_ALLOWANCE, new Map([['https://a.invalid', new Set(['A'])]])],
      ['p1', new Map([['https://a.invalid', new Set(['B'])], ['https://b.invalid', new Set(['C'])]])],
      ['p2', new Map([['https://b.invalid', new Set(['D'])]])]
    ]);
    const merged = mergedAllowance(byPack);
    assert.deepStrictEqual([...merged.get('https://a.invalid')].sort(), ['A', 'B']);
    assert.deepStrictEqual([...merged.get('https://b.invalid')].sort(), ['C', 'D']);
    byPack.delete('p1');
    assert.deepStrictEqual([...mergedAllowance(byPack).get('https://b.invalid')], ['D']);
    assert.deepStrictEqual([...mergedAllowance(byPack).get('https://a.invalid')], ['A']);
  });

  it('inside --packsRoot is by real path: a link out of the root is outside; a sibling sharing its prefix is outside', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-17-'));
    try {
      const root = path.join(base, 'packs');
      fs.mkdirSync(path.join(root, 'p', 'node_modules', 'm'), {recursive: true});
      fs.mkdirSync(path.join(base, 'packs-evil', 'm'), {recursive: true});
      fs.mkdirSync(path.join(base, 'away'), {recursive: true});
      fs.symlinkSync(path.join(base, 'away'), path.join(root, 'p', 'node_modules', 'link'), 'dir');
      const rs = [fs.realpathSync(root)];
      assert.strictEqual(insideRoots(path.join(root, 'p', 'node_modules', 'm'), rs), true);
      assert.strictEqual(insideRoots(path.join(root, 'p', 'node_modules', 'link'), rs), false);
      assert.strictEqual(insideRoots(path.join(base, 'packs-evil', 'm'), rs), false);
      assert.strictEqual(insideRoots(path.join(root, 'missing'), rs), false);
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });

  it('a module\'s links are found by walking it: a file link out is named; a link inside the root is not', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-17-'));
    try {
      const root = path.join(base, 'packs');
      const m = path.join(root, 'p', 'node_modules', 'm');
      fs.mkdirSync(path.join(m, 'handlers', 's'), {recursive: true});
      fs.writeFileSync(path.join(root, 'p', 'inside.js'), '');
      fs.symlinkSync(path.join(root, 'p', 'inside.js'), path.join(m, 'handlers', 's', 'ok.js'));
      const rs = [fs.realpathSync(root)];
      assert.strictEqual(linkOut(fs.realpathSync(m), rs), null);
      fs.writeFileSync(path.join(base, 'away.js'), '');
      fs.symlinkSync(path.join(base, 'away.js'), path.join(m, 'handlers', 's', 'out.js'));
      assert.strictEqual(linkOut(fs.realpathSync(m), rs), path.join(fs.realpathSync(m), 'handlers', 's', 'out.js'));
      fs.rmSync(path.join(m, 'handlers', 's', 'out.js'));
      fs.symlinkSync(path.join(base, 'missing.js'), path.join(m, 'handlers', 's', 'dangling.js'));
      assert.ok(linkOut(fs.realpathSync(m), rs) != null, 'a dangling link');
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });
});
