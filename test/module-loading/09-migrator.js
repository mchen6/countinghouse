// bin/countinghouse-migrate-module.js, the tool README.md and MIGRATION.md
// both tell people to run on their existing modules.
//
// It shipped once with no test and a bug that made it useless for its actual
// audience: its `CHUtil.loadFile(...)` pattern only matched the template
// literal form, so it worked on this repo's own modules -- which had been
// modernised to ES6 before being migrated -- and refused every real 5.x module
// in the wild, which is ES5 and writes `__dirname + '/x.js'`. Caught by
// installing the packed tarball and running it against a module checked out
// from v5.0.1.
//
// So the fixture here is deliberately ES5, and the assertions are about the
// two things that actually broke: that it converts at all, and that the
// converted handler runs.
const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const migrator = require('../../bin/countinghouse-migrate-module.js');

const SRC = path.join(__dirname, '..', 'fixtures', 'legacy-5x-module');

// migrate a throwaway copy -- the fixture has to stay 5.x-shaped for the next run
function copyToTemp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'countinghouse-migrate-'));
  for (const f of fs.readdirSync(SRC)) {
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  }
  return dir;
}

function rmrf(dir) {
  try { fs.rmSync(dir, {recursive: true, force: true}); } catch (e) { /* best effort */ }
}

describe('module-loading 09: the 5.x -> 6.0.0 migrator', () => {
  it('converts an ES5 module -- the spelling every real 5.x module uses', () => {
    const dir = copyToTemp();
    try {
      const r = migrator.migrate(dir, false);
      assert.strictEqual(r.status, 'migrated');

      assert.ok(fs.existsSync(path.join(dir, 'handlers', 'legacyService', 'shout.js')),
        'handler must land at handlers/<serviceShortName>/<actionName>.js');
      assert.ok(!fs.existsSync(path.join(dir, 'index.js')),   'index.js must be removed');
      assert.ok(!fs.existsSync(path.join(dir, 'device.js')),  'device.js must be removed');
      assert.ok(!fs.existsSync(path.join(dir, 'com-countinghouse-legacyService-shout.js')),
        'the old handler file must be moved, not left behind');

      // main pointed at index.js, which no longer exists
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).main, undefined);
    } finally { rmrf(dir); }
  });

  it('the converted handler has the 6.0.0 signature and actually runs', () => {
    const dir = copyToTemp();
    try {
      migrator.migrate(dir, false);
      const out = fs.readFileSync(path.join(dir, 'handlers', 'legacyService', 'shout.js'), 'utf8');

      assert.ok(/module\.exports = \(input, ctx, callback\) =>/.test(out), out);

      // `var input = args.input;` must be dropped, not rewritten -- rewriting
      // it in place produces `var input = input;`, which throws at call time
      assert.ok(!/input\s*=\s*input/.test(out), `self-referential declaration: ${out}`);
      assert.ok(!/\bargs\b/.test(out), `no args reference should survive: ${out}`);

      // run it, with DeviceError stubbed the way lib/sandbox.js provides it
      global.DeviceError = global.DeviceError || function (code) { this.code = code; };
      const handler = require(path.join(dir, 'handlers', 'legacyService', 'shout.js'));

      let result = null;
      handler({text: 'hi'}, {}, (err, data) => { result = {err: err, data: data}; });
      assert.strictEqual(result.err, null);
      assert.deepStrictEqual(result.data, {output: {text: 'HI'}});
    } finally { rmrf(dir); }
  });

  it('refuses a module whose constructor builds a ServiceClient, and changes nothing', () => {
    const dir = copyToTemp();
    try {
      const device = path.join(dir, 'device.js');
      fs.writeFileSync(device, `${fs.readFileSync(device, 'utf8')}\nCHUtil.createServiceClient({}, function() {});\n`);

      assert.throws(() => migrator.migrate(dir, false), (e) => {
        assert.strictEqual(e.migrationRefusal, true);
        assert.ok(/ServiceClient/.test(e.message), e.message);
        assert.ok(/ctx\.serviceClient/.test(e.message), 'must name the replacement');
        return true;
      });

      assert.ok(fs.existsSync(device), 'a refusal must leave the module untouched');
      assert.ok(!fs.existsSync(path.join(dir, 'handlers')), 'no partial output');
    } finally { rmrf(dir); }
  });

  it('is idempotent -- a module already in the 6.0.0 shape is left alone', () => {
    const dir = copyToTemp();
    try {
      migrator.migrate(dir, false);
      const again = migrator.migrate(dir, false);
      assert.strictEqual(again.status, 'already-migrated');
      assert.deepStrictEqual(again.writes, []);
    } finally { rmrf(dir); }
  });
});
