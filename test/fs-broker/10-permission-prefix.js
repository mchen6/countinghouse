// Node 24's permission model refuses async operations on a granted directory
// itself when another grant extends its name (/x/countinghouse and
// /x/countinghouse_module_data, the default layout under $HOME); paths inside
// it are unaffected. createForWorker therefore resolves a directory's real
// path through a file inside it (found in plan 2b, Task 5).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = fs.realpathSync(path.join(__dirname, '..', '..'));

describe('fs-broker 10: permission grants that share a prefix', function() {
  this.timeout(30000);
  let base = null;
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); });

  function underPermission(dir, code) {
    return execFileSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${dir}_data`, '-e', code],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  }

  it('reproduces the refusal on the directory itself (the assumption this works around)', () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    const out = underPermission(dir, `require('fs/promises').realpath(${JSON.stringify(dir)}).then(() => console.log('ok'), (e) => console.log(e.code))`);
    assert.strictEqual(out, 'ERR_ACCESS_DENIED');
  });

  it('realDirVia resolves it through a file inside', () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const out = underPermission(dir, `require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))}).realDirVia(${JSON.stringify(dir)}, 'package.json').then((r) => console.log(r), (e) => console.log(e.code))`);
    assert.strictEqual(out, dir);
  });
});
