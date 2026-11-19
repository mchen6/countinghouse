// Packs in place (part 2, plan Task A3; #205's review), server-free: the
// pack name the control channel takes, a shared module's merged remote
// allowance, and confinement to --packsRoot by real path.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {realPath} = require('../helpers/real-path');
const {PACK_NAME, insideRoots, linkOut, chLocalPackOf, ceilingRefusal} = require('../../lib/modules-in-place');
const settingsTool = require('../../lib/settings-tool');
const {mergedAllowance, START_ALLOWANCE} = require('../../lib/module-manager');

describe('stdio 18: packs in place, server-free', () => {
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

  // #205's review, item 7: the operator's ceiling binds a load in place. Its
  // packs allowlist names ch-local's packs; the pack is the scenario's first
  // directory below --packsRoot, by real path.
  describe('the ceiling\'s packs allowlist', () => {
    let base = null;
    let rs = null;
    const scenarioOf = (pack) => {
      const dir = path.join(base, 'packs', pack, 'k1', 'node_modules', '@countinghouse', `ch-pack-${pack}`);
      fs.mkdirSync(dir, {recursive: true});
      return dir;
    };
    const req = (pack, name) => ({name: name || `@countinghouse/ch-pack-${pack}`, scenario: scenarioOf(pack), roots: rs});
    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-18-'));
      fs.mkdirSync(path.join(base, 'packs'));
      rs = [realPath(path.join(base, 'packs'))];
    });
    afterEach(() => {
      settingsTool.ceilingForControl(() => ({state: 'none'}));
      settingsTool.resetForTests();
      fs.rmSync(base, {recursive: true, force: true});
    });
    const trusted = (ceiling) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({packs: null}, ceiling)});

    it('the pack is the scenario\'s first directory below the root, by real path', () => {
      assert.strictEqual(chLocalPackOf(scenarioOf('ci-failure-triage'), rs), 'ci-failure-triage');
      fs.symlinkSync(scenarioOf('other'), path.join(base, 'packs', 'alias'), 'dir');
      assert.strictEqual(chLocalPackOf(path.join(base, 'packs', 'alias'), rs), 'other', 'a link inside the root is its target\'s');
      assert.strictEqual(chLocalPackOf(base, rs), null);
    });

    it('no ceiling, or one with no packs list: allowed', () => {
      settingsTool.ceilingForControl(() => ({state: 'none'}));
      assert.strictEqual(ceilingRefusal(req('x')), null);
      settingsTool.ceilingForControl(() => trusted({}));
      assert.strictEqual(ceilingRefusal(req('x')), null);
    });

    it('a trusted list: a pack it names loads; one it leaves out is SETTING_FORBIDDEN_BY_CEILING, named as pack.<name>', () => {
      settingsTool.ceilingForControl(() => trusted({packs: ['ci-failure-triage']}));
      assert.strictEqual(ceilingRefusal(req('ci-failure-triage')), null);
      const refused = ceilingRefusal(req('other'));
      assert.strictEqual(refused.code, 'SETTING_FORBIDDEN_BY_CEILING');
      assert.match(refused.message, /pack\.other/);
      // the request's name cannot choose the pack: the path does
      assert.strictEqual(ceilingRefusal(req('other', '@countinghouse/ch-pack-ci-failure-triage')).code, 'SETTING_FORBIDDEN_BY_CEILING');
      settingsTool.ceilingForControl(() => trusted({packs: []}));
      assert.strictEqual(ceilingRefusal(req('ci-failure-triage')).code, 'SETTING_FORBIDDEN_BY_CEILING', 'an empty list allows no pack');
    });

    it('a ceiling that cannot be trusted refuses every load: SETTING_CEILING_UNTRUSTED', () => {
      settingsTool.ceilingForControl(() => ({state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is writable by group or others'}));
      const refused = ceilingRefusal(req('ci-failure-triage'));
      assert.strictEqual(refused.code, 'SETTING_CEILING_UNTRUSTED');
      assert.match(refused.message, /writable by group or others/);
    });
  });
});
