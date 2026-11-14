// Packs in place (part 2, plan Task A2; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 1): a
// control channel between ch-local start and the runtime it spawned, over an
// IPC fd, never over stdin or stdout (the client's MCP channel). Only in the
// single-identity profile, and never reachable by module code.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {startStdio, INITIALIZE} = require('../helpers/stdio-client');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'bin', 'countinghouse-stdio.js');

describe('stdio 11: the control channel', function() {
  this.timeout(60000);
  let home = null;
  let io = null;
  const base = () => ['--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data')];
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-stdio-11-')); });
  afterEach(async () => {
    if (io != null && io.child.exitCode == null) { io.child.kill(); await new Promise((r) => io.child.once('exit', r)); }
    io = null;
  });
  after(() => fs.rmSync(home, {recursive: true, force: true}));

  it('answers each request by its id; an unknown type is CONTROL_UNKNOWN, and the MCP channel is untouched', async () => {
    io = startStdio([...base(), '--controlChannel', 'ipc'], {ipc: true});
    const init = await io.request(INITIALIZE, 30000);
    assert.ok(init.result != null, JSON.stringify(init));
    const r = await io.control({type: 'nonsense'});
    assert.deepStrictEqual({ok: r.ok, code: r.code}, {ok: false, code: 'CONTROL_UNKNOWN'});
    const ready = await io.control({type: 'load', name: 'x'});
    assert.strictEqual(ready.ok, false);
    assert.ok(['CONTROL_NOT_READY', 'CONTROL_BAD_REQUEST'].includes(ready.code), JSON.stringify(ready));
    assert.ok(!io.lines.some((l) => /CONTROL_/.test(l)), 'nothing of the channel on stdout');
  });

  it('is refused outside the single-identity profile, and without an IPC fd, naming the flag', () => {
    for (const [extra, opts] of [[['--authConfigPath', path.join(home, 'auth.json')], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']}],
      [[], {stdio: ['pipe', 'pipe', 'pipe']}]]) {
      fs.writeFileSync(path.join(home, 'auth.json'), '{}');
      const r = spawnSync(process.execPath, [ENTRY, ...base(), '--controlChannel', 'ipc', ...extra], {...opts, encoding: 'utf8', timeout: 30000, input: ''});
      assert.strictEqual(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /--controlChannel/);
    }
  });

  it('a value other than ipc is refused', () => {
    const r = spawnSync(process.execPath, [ENTRY, ...base(), '--controlChannel', 'tcp'], {encoding: 'utf8', timeout: 30000, input: ''});
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /--controlChannel/);
  });
});
