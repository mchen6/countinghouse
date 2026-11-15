// countinghouse's code roots (lib/fs-broker/identity.js codeRootsFor): its
// own entries plus its dependency closure, computed once per process (the
// install does not change while it runs; plan 5 benchmark: ~80 ms per spawn
// uncached), with each call's module roots still subtracted.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const identity = require('../../lib/fs-broker/identity');
const {mkdtemp} = require('../helpers/test-tmp');

describe('fs-broker 17: code roots', () => {
  const installDir = fs.realpathSync(path.join(__dirname, '..', '..'));

  it('computes the closure once per process; exclusions apply on every call', () => {
    let calls = 0;
    const counting = (p) => { calls++; return fs.realpathSync(p); };
    const first = identity.codeRootsFor(installDir, counting, []);
    const afterFirst = calls;
    const second = identity.codeRootsFor(installDir, counting, []);
    assert.deepStrictEqual(second, first);
    assert.strictEqual(calls - afterFirst, 0, 'the second call resolves nothing again');
    const ajv = first.find((r) => r.endsWith(`${path.sep}node_modules${path.sep}ajv`));
    assert.ok(ajv, 'ajv is one of countinghouse\'s dependencies');
    const excluded = identity.codeRootsFor(installDir, counting, [ajv]);
    assert.ok(!excluded.includes(ajv), 'a module root is subtracted even from the cached closure');
    assert.strictEqual(excluded.length, first.length - 1);
  });

  // An install run by a spelling that isn't its real path (#272: on Windows,
  // one under an 8.3 short name, C:\\Users\\RUNNER~1\\..., from os.tmpdir();
  // here a symlinked spelling): its own entries are roots under the spelling
  // its files run by and under their real paths, so its lazily required files
  // stay inside them; a module root inside it still takes both out.
  it('lists countinghouse\'s own entries under the spelling it runs from and their real paths (#272)', () => {
    const base = mkdtemp('code-roots-spelled-');
    try {
      const real = path.join(base, 'real-install');
      fs.mkdirSync(path.join(real, 'lib'), {recursive: true});
      fs.writeFileSync(path.join(real, 'package.json'), '{}');
      fs.writeFileSync(path.join(real, 'lib', 'thread-info.js'), '');
      const spelled = path.join(base, 'spelled');
      fs.symlinkSync(real, spelled, 'junction');
      const roots = identity.codeRootsFor(spelled, fs.realpathSync.native, []);
      for (const p of [path.join(spelled, 'lib'), path.join(real, 'lib'), path.join(spelled, 'package.json'), path.join(real, 'package.json')]) {
        assert.ok(roots.includes(p), `${p}: ${JSON.stringify(roots)}`);
      }
      const excluded = identity.codeRootsFor(spelled, fs.realpathSync.native, [path.join(real, 'lib')]);
      assert.ok(!excluded.includes(path.join(spelled, 'lib')) && !excluded.includes(path.join(real, 'lib')), JSON.stringify(excluded));
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });

  // pnpm and linked node_modules: a dependency reached through a symlink is
  // a root under the name Node looks up and under its real path; a module
  // root subtracts both (review, plan 5).
  it('lists a linked dependency under both spellings, and excludes both with its module root', () => {
    const base = mkdtemp('code-roots-');
    try {
      const install = path.join(base, 'install');
      fs.mkdirSync(path.join(install, 'node_modules', 'a'), {recursive: true});
      fs.writeFileSync(path.join(install, 'package.json'), '{"dependencies": {"a": "1", "b": "1"}}');
      fs.writeFileSync(path.join(install, 'node_modules', 'a', 'package.json'), '{"name": "a"}');
      const real = path.join(base, 'elsewhere', 'b');
      fs.mkdirSync(real, {recursive: true});
      fs.writeFileSync(path.join(real, 'package.json'), '{"name": "b"}');
      const linked = path.join(install, 'node_modules', 'b');
      fs.symlinkSync(real, linked);
      const roots = identity.codeRootsFor(install, fs.realpathSync, []);
      assert.ok(roots.includes(linked) && roots.includes(real), JSON.stringify(roots));
      const excluded = identity.codeRootsFor(install, fs.realpathSync, [real]);
      assert.ok(!excluded.includes(linked) && !excluded.includes(real), JSON.stringify(excluded));
      assert.ok(excluded.includes(path.join(install, 'node_modules', 'a')));
    } finally {
      fs.rmSync(base, {recursive: true, force: true});
    }
  });
});
