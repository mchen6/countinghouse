// Every command in bin/ is one a package install puts on the PATH: listed in
// package.json "bin", with a shebang and the executable bit, and answering
// --help. The docs name them as commands (docs/upgrading-to-8.md's
// `countinghouse-auth-sqlite bind-module`, docs/authentication.md); before
// 8.0.0, countinghouse-auth-sqlite and countinghouse-meter were missing from
// "bin".
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const listed = new Set(Object.values(pkg.bin).map((p) => path.normalize(p)));
const files = fs.readdirSync(path.join(ROOT, 'bin')).map((f) => path.normalize(`bin/${f}`));

describe('validation 15: every bin/ command is installed', () => {
  it('each file in bin/ is listed in package.json "bin", and each listed one exists', () => {
    assert.deepStrictEqual(files.filter((f) => !listed.has(f)), []);
    assert.deepStrictEqual([...listed].filter((f) => !fs.existsSync(path.join(ROOT, f))), []);
  });

  it('each has a shebang and, off Windows, the executable bit', () => {
    for (const f of files) {
      assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')[0], /^#!\//, f);
      if (process.platform !== 'win32') assert.ok((fs.statSync(path.join(ROOT, f)).mode & 0o111) !== 0, `${f} is not executable`);
    }
  });

  // Neither command has a --help of its own: each prints its usage for it as
  // for any command it does not know, and exits non-zero (auth-sqlite 1,
  // meter 2). Run in a throwaway directory: auth-sqlite opens its default
  // database, ./auth.sqlite3, before it reads the command.
  it('the two added in 8.0.0 print their usage when given --help, and leave nothing behind', () => {
    const cwd = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ch-bins-'));
    try {
      for (const [f, usage, status] of [['bin/countinghouse-auth-sqlite.js', /bind-module/, 1], ['bin/countinghouse-meter.js', /countinghouse-meter set/, 2]]) {
        const r = spawnSync(process.execPath, [path.join(ROOT, f), '--help'], {cwd, encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, {COUNTINGHOUSE_SEED_KEY: ''})});
        assert.match(`${r.stdout}${r.stderr}`, usage, f);
        assert.strictEqual(r.status, status, f);
      }
      assert.ok(!fs.existsSync(path.join(ROOT, 'auth.sqlite3')), 'nothing written in the repository');
    } finally {
      fs.rmSync(cwd, {recursive: true, force: true});
    }
  });
});
