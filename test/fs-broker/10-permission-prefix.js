// Node's permission model refuses operations on a granted directory itself
// when another grant extends its name (/x/countinghouse and
// /x/countinghouse_module_data); paths inside it are unaffected
// (nodejs/node#66812). Up to Node 24.21 a sync realpath was spared, which
// realDir relied on (plan 2b, Task 5); from 24.22 it is refused too, so under
// --hardened the unrestricted parent resolves these directories and the
// child's realDir answers from that (lib/hardened-realpaths.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync, spawn} = require('child_process');

const ROOT = fs.realpathSync(path.join(__dirname, '..', '..'));

describe('fs-broker 10: permission grants that share a prefix', function() {
  this.timeout(30000);
  let base = null;
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); });

  function underPermission(dir, code) {
    return execFileSync(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${dir}_data`, '-e', code],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  }

  // The quirk is Node's, and not every supported version has it: 24.0.0
  // allows the directory itself (the floor-shim PR's 24.0.0 CI leg), while
  // 22.23 and 24.14 refuse it. Where it is absent the case is skipped and
  // says so; the workaround stays, and the realDir case below holds either
  // way.
  it('reproduces the refusal on the directory itself (the assumption this works around)', function() {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    const out = underPermission(dir, `require('fs/promises').realpath(${JSON.stringify(dir)}).then(() => console.log('ok'), (e) => console.log(e.code))`);
    if (out === 'ok') {
      this.test.title += ` -- skipped: Node ${process.version} allows the directory itself`;
      this.skip();
    }
    assert.strictEqual(out, 'ERR_ACCESS_DENIED');
  });

  it('realDir resolves the directory itself under the same grants, given the parent\'s real paths', async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const dir = path.join(base, 'ch');
    fs.mkdirSync(dir);
    fs.mkdirSync(`${dir}_data`);
    const realpaths = require('../../lib/hardened-realpaths');
    const code = `require(${JSON.stringify(path.join(ROOT, 'lib', 'hardened-realpaths'))}).receive();
      try { console.log(require(${JSON.stringify(path.join(ROOT, 'lib', 'fs-broker'))}).realDir(${JSON.stringify(dir)})); } catch (e) { console.log(e.code); }`;
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${ROOT}`, `--allow-fs-read=${dir}`, `--allow-fs-read=${dir}_data`, '-e', code],
        {env: Object.assign({}, process.env, realpaths.childEnv()), stdio: ['ignore', 'pipe', 'ignore', 'pipe']});
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      child.on('exit', () => resolve(text.trim()));
      realpaths.send(child, {[dir]: dir});
    });
    assert.strictEqual(out, dir);
  });

  // A module must not choose its own /app: a package.json that is a symlink
  // into another directory leaves the module's own directory as its root.
  it('a module whose package.json is a symlink keeps its own directory as /app', async () => {
    const {createForWorker} = require('../../lib/fs-broker');
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.ch-perm-')));
    const mod = path.join(base, 'mod');
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(mod);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'package.json'), '{"name": "m"}');
    fs.symlinkSync(path.join(elsewhere, 'package.json'), path.join(mod, 'package.json'));
    const fsb = await createForWorker({name: 'm', mode: 'audit', modulePath: mod, declared: [],
      options: {moduleDataPath: path.join(base, 'store'), modulePath: base}, report: () => {}});
    try {
      assert.strictEqual(fsb.namespace.roots.find((r) => r.name === 'app').host, mod);
      assert.strictEqual(fsb.moduleRoot, mod);
    } finally {
      await fsb.bridge.close();
    }
  });
});
