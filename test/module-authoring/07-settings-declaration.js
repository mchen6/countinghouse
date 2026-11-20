'use strict';
// Module settings in countinghouse-validate (the module-level configuration
// design, section 4.1): a bad declaration is a problem by position and
// field; a secret-looking name or title, and a part's `required` setting,
// are warnings; and each declared setting's confirmation rule is printed, so
// an author sees what a user will be asked. The load refuses the same
// declarations (module-loading 40). Server-free (the CLI is a child).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFile} = require('child_process');
const {validateModule} = require('../../lib/module-validator');

const ROOT = path.join(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'countinghouse-validate.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'handler-map-convention');

describe('module-authoring 07: module settings in countinghouse-validate', function() {
  this.timeout(30000);
  const dirs = [];
  after(() => { for (const d of dirs) fs.rmSync(d, {recursive: true, force: true}); });

  // the clean fixture with `settings` (and `role`) in its package.json
  function moduleWith(settings, extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ma07-'));
    dirs.push(dir);
    fs.cpSync(FIXTURE, dir, {recursive: true});
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.name = 'weather-tool';
    pkg.countinghouse = Object.assign({}, pkg.countinghouse, {settings}, extra);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    return dir;
  }
  const validated = (dir) => new Promise((resolve, reject) => validateModule(dir, (err, r) => (err != null ? reject(err) : resolve(r))));
  const cli = (dir) => new Promise((resolve) => execFile(process.execPath, [BIN, dir], {cwd: ROOT}, (err, stdout, stderr) => resolve({code: err == null ? 0 : err.code, out: stdout + stderr})));

  it('the fixture as it is: no settings, no settings lines', async () => {
    const r = await validated(FIXTURE);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.settings || [], []);
    assert.ok(!/setting /.test((await cli(FIXTURE)).out));
  });

  it('a good declaration: ok, and each setting\'s confirmation rule printed', async () => {
    const dir = moduleWith({
      units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units'},
      defaultRepo: {type: 'string', format: 'repo'},
      shareStats: {type: 'boolean', default: false, confirm: true},
    });
    const r = await validated(dir);
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    assert.deepStrictEqual(r.settings, [
      {name: 'units', type: 'enum', rule: 'on request'},
      {name: 'defaultRepo', type: 'string', rule: 'confirm'},
      {name: 'shareStats', type: 'boolean', rule: 'confirm'},
    ]);
    const {code, out} = await cli(dir);
    assert.strictEqual(code, 0, out);
    assert.match(out, /setting units \(enum\): changed in conversation on request/);
    assert.match(out, /setting defaultRepo \(string\): changed in conversation only with the user's own confirmation/);
    assert.match(out, /setting shareStats \(boolean\): changed in conversation only with the user's own confirmation/);
  });

  it('a bad declaration: a problem by position and field, with a fix; exit 1', async () => {
    const dir = moduleWith({units: {type: 'enum', values: []}, 'bad.name': {type: 'boolean'}});
    const r = await validated(dir);
    assert.strictEqual(r.ok, false);
    const ours = r.problems.filter((p) => p.stage === 'countinghouse.settings');
    assert.ok(ours.some((p) => /countinghouse\.settings\.units\.values/.test(p.message)), JSON.stringify(ours));
    assert.ok(ours.some((p) => /countinghouse\.settings\["bad\.name"\]/.test(p.message)), JSON.stringify(ours));
    assert.ok(ours.every((p) => p.code === 'SETTINGS_DECLARATION_INVALID' && typeof p.fix === 'string'), JSON.stringify(ours));
    const {code, out} = await cli(dir);
    assert.strictEqual(code, 1);
    assert.match(out, /\[countinghouse\.settings\] countinghouse\.settings\.units\.values/);
  });

  it('a secret-looking name, and a part\'s required setting: warnings, still ok', async () => {
    const dir = moduleWith({apiKey: {type: 'string'}, region: {type: 'string', required: true}}, {role: 'part'});
    const r = await validated(dir);
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems));
    const ours = r.warnings.filter((w) => w.stage === 'countinghouse.settings').map((w) => w.message);
    assert.ok(ours.some((m) => /apiKey/.test(m) && /secret/.test(m)), JSON.stringify(ours));
    assert.ok(ours.some((m) => /region/.test(m) && /part/.test(m)), JSON.stringify(ours));
    assert.match((await cli(dir)).out, /warning \[countinghouse\.settings\] setting apiKey looks like a secret/);
    assert.deepStrictEqual(r.settings.map((x) => x.rule), ['terminal only', 'terminal only'], 'a part\'s settings are set at a terminal');
    assert.match((await cli(dir)).out, /setting region \(string\): changed at a terminal only/);
  });

  it('a module with problems still has its settings printed', async () => {
    const dir = moduleWith({units: {type: 'enum', values: ['metric']}});
    fs.rmSync(path.join(dir, 'api.json'));
    const {code, out} = await cli(dir);
    assert.strictEqual(code, 1);
    assert.match(out, /setting units \(enum\): changed in conversation on request/);
  });
});
