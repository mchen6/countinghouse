// --hardened checks its grants before relaunching: Node's permission model
// refuses a sync realpath of a granted directory when another grant extends
// its name (nodejs/node#66812; synchronous calls too from Node 24.22), which
// countinghouse makes on its install and dependency directories. The probe
// runs those calls under the real flags and refuses to start with a clear
// message instead of failing later (user decision, 2026-11-04).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hardened = require('../../lib/hardened-launch');
const {mkdtemp} = require('../helpers/test-tmp');

describe('sandbox 18: --hardened grant probe', function() {
  this.timeout(30000);
  let base = null;
  afterEach(() => { if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  it('finds grants whose name another grant extends, from the flags alone', () => {
    const flags = ['--permission', '--allow-fs-read=/x/ch', '--allow-fs-read=/x/ch_data', '--allow-fs-write=/x/ch_data',
      '--allow-fs-read=/x/ch/lib', '--allow-fs-read=/x/a', '--allow-fs-read=/x/b', '--allow-fs-read=/y/redis', '--allow-fs-read=/y/redis-commands'];
    assert.deepStrictEqual(hardened.grantOverlaps(flags), [['/x/ch', '/x/ch_data'], ['/y/redis', '/y/redis-commands']]);
  });

  it('allows grants with distinct names, on every Node', () => {
    base = mkdtemp('probe-');
    ['install', 'store'].forEach((d) => fs.mkdirSync(path.join(base, d)));
    const flags = ['--permission', `--allow-fs-read=${path.join(base, 'install')}`, `--allow-fs-read=${path.join(base, 'store')}`,
      `--allow-fs-write=${path.join(base, 'store')}`];
    assert.deepStrictEqual(hardened.probeGrants(flags), {ok: true, refused: []});
  });

  it('agrees with this Node about an overlapping pair', () => {
    base = mkdtemp('probe-');
    const ch = path.join(base, 'ch');
    ['ch', 'ch_data'].forEach((d) => fs.mkdirSync(path.join(base, d)));
    const flags = ['--permission', `--allow-fs-read=${ch}`, `--allow-fs-read=${ch}_data`];
    // What this Node does, asked directly; the probe must say the same.
    const direct = require('child_process').spawnSync(process.execPath, flags.concat(['-e',
      `try { require('fs').realpathSync.native(${JSON.stringify(ch)}); } catch (e) { process.exit(9); }`]), {stdio: 'ignore'});
    const probe = hardened.probeGrants(flags);
    assert.strictEqual(probe.ok, direct.status === 0, JSON.stringify(probe));
    if (!probe.ok) assert.ok(probe.refused.some((r) => r.path === ch && r.op === 'realpathSync'), JSON.stringify(probe));
  });

  it('a refusal names the issue, the Node version, each overlapping pair and what to do', () => {
    const flags = ['--permission', '--allow-fs-read=/srv/countinghouse', '--allow-fs-read=/srv/countinghouse_data'];
    const stub = () => ({status: 0, stdout: JSON.stringify({refused: [{path: '/srv/countinghouse', op: 'realpathSync', code: 'ERR_ACCESS_DENIED'}]})});
    const probe = hardened.probeGrants(flags, {spawnSync: stub, existsDir: () => true});
    assert.strictEqual(probe.ok, false);
    const text = hardened.refusalMessage(probe, hardened.grantOverlaps(flags), 'v24.22.2');
    ['nodejs/node#66812', 'v24.22.2', '/srv/countinghouse and /srv/countinghouse_data', '--moduleDataPath', 'without --hardened']
      .forEach((s) => assert.ok(text.includes(s), `${s} missing from:\n${text}`));
  });

  it('a probe that cannot run refuses, saying so', () => {
    const stub = () => ({status: 1, stdout: '', stderr: 'boom', error: null});
    const probe = hardened.probeGrants(['--permission', '--allow-fs-read=/srv/x'], {spawnSync: stub, existsDir: () => true});
    assert.strictEqual(probe.ok, false);
    assert.ok(/boom/.test(probe.error), JSON.stringify(probe));
  });
});
