'use strict';
// C2: the shared runtime on Windows (the shared-runtime design section 1,
// "Where it listens", and section 7), spawned as ch-local daemon spawns it:
// --sessionSocket a named pipe, \\.\pipe\countinghouse-<32 hex>, random per
// start, and --sessionDir the directory of its secret, owner-only by DACL.
// - it serves a session over the pipe, its secret owner-only too;
// - a name another process holds fails the bind, and the runtime exits 2
//   (it never serves under a name it doesn't hold);
// - a socket that is no pipe name, or a pipe without --sessionDir, is refused.
// Windows only: it is in this folder because CI's stdio job runs it on the
// Windows leg. The POSIX side is test/session-runtime/01-spawned.js, and the
// Windows checks' logic, server free, test/session-transport/04-run-dir.js.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const winAcl = require('../../lib/win-acl');
const runDir = require('../../lib/session-transport/run-dir');
const handshake = require('../../lib/session-transport/handshake');
const shim = require('../session-transport/helpers/shim');

const FRAMEWORK = path.join(__dirname, '..', '..', 'framework.js');
const pipeName = () => `\\\\.\\pipe\\countinghouse-${crypto.randomBytes(16).toString('hex')}`;
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}};

// <home>\run and <home>\run\daemon, each with a protected DACL: this user and
// SYSTEM, full control, nothing inherited (as ch-local daemon makes them)
function privateRunDir(home, user) {
  const icacls = path.win32.join(winAcl.windowsDir(), 'System32', 'icacls.exe');
  const run = path.join(home, 'run');
  const daemon = path.join(run, 'daemon');
  fs.mkdirSync(daemon, {recursive: true});
  for (const d of [run, daemon]) {
    execFileSync(icacls, [d, '/inheritance:r', '/grant:r', `*${user}:(OI)(CI)F`, `*${winAcl.SYSTEM}:(OI)(CI)F`], {stdio: 'ignore', windowsHide: true});
  }
  return daemon;
}

function runtime(home, socket, extra = []) {
  const child = spawn(process.execPath, [FRAMEWORK, '--workerThread', '--store', 'local', '--storePath', path.join(home, 'store'),
    '--modulePath', path.join(home, 'modules'), '--moduleDataPath', path.join(home, 'module_data'), '--controlChannel', 'ipc',
    '--sessionSocket', socket, ...extra], {stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    env: Object.assign({}, process.env, {COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''})});
  const r = {child, err: '', told: []};
  child.on('message', (m) => {
    if (m != null && m.type === 'ready') child.send({id: 'restore-1', type: 'restore', sessions: [], declines: [], reset: []});
    if (m != null && m.id === undefined && m.type !== 'ready') r.told.push(m);
  });
  child.stderr.on('data', (d) => { r.err += d; });
  child.stdout.on('data', () => {});
  child.on('error', () => {});
  r.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return r;
}
const until = async(test, ms) => {
  for (const end = Date.now() + ms; !test() && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  return test();
};

describe('stdio 25: the shared runtime on a Windows named pipe (C2)', function() {
  this.timeout(180000);
  let user;
  const homes = [];
  const children = [];
  const home = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-pipe-')); homes.push(h); return h; };
  before(function() {
    if (process.platform !== 'win32') return this.skip();
    user = winAcl.fileAcl(os.tmpdir()).user;
    return undefined;
  });
  afterEach(async() => {
    for (const r of children.splice(0)) {
      if (r.child.exitCode == null) { r.child.kill(); await r.exited; }
    }
    for (const h of homes.splice(0)) fs.rmSync(h, {recursive: true, force: true});
  });

  it('serves a session over the pipe, its secret owner-only by DACL, and tells the daemon the pipe it listens on', async() => {
    const h = home();
    const dir = privateRunDir(h, user);
    assert.strictEqual(runDir.runDirProblem(dir), null, 'the directories as the daemon makes them pass the runtime\'s check');
    const pipe = pipeName();
    const r = runtime(h, pipe, ['--sessionDir', dir]);
    children.push(r);
    const up = await until(() => r.told.some((m) => m.type === 'listening'), 120000);
    assert.ok(up, `never listened: ${r.err.slice(-3000)}`);
    assert.deepStrictEqual(r.told.find((m) => m.type === 'listening'), {type: 'listening', socket: pipe});
    const secretFile = path.join(dir, 'secret');
    assert.strictEqual(winAcl.privateProblem('the secret', winAcl.fileAcl(secretFile)), null);
    const secret = handshake.parseSecret(fs.readFileSync(secretFile, 'utf8'));
    const a = await shim.session(pipe, secret);
    assert.ok(a.welcome != null, JSON.stringify(a.refused));
    assert.strictEqual(a.proveOk, true, 'the runtime proved the secret');
    shim.message(a.c, {seq: 1}, JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {_meta: META}}));
    let answer = null;
    for (let m; answer == null && (m = await shim.readM(a.c, 60000)) != null;) {
      if (m.header != null && m.header.seq === 1) answer = JSON.parse(m.line.toString('utf8'));
    }
    assert.ok(answer != null && answer.result != null && Array.isArray(answer.result.tools), JSON.stringify(answer));
    a.c.end();
  });

  it('a pipe name another process holds fails the bind: the runtime exits 2, never serving', async() => {
    const pipe = pipeName();
    const squatter = net.createServer(() => {});
    await new Promise((resolve, reject) => { squatter.once('error', reject); squatter.listen(pipe, resolve); });
    try {
      const h = home();
      const dir = privateRunDir(h, user);
      const r = runtime(h, pipe, ['--sessionDir', dir]);
      children.push(r);
      assert.strictEqual(await r.exited, 2, r.err.slice(-3000));
      assert.match(r.err, /its name is taken by another process \(EADDRINUSE\)/);
      assert.ok(!r.told.some((m) => m.type === 'listening'), 'it never told it listens');
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it('a socket that is no pipe name, a pipe without --sessionDir, or a --sessionDir that is no drive path, is refused (exit 2)', async() => {
    const h = home();
    const dir = privateRunDir(h, user);
    const path1 = runtime(h, path.join(dir, 'sessions.sock'), ['--sessionDir', dir]);
    children.push(path1);
    assert.strictEqual(await path1.exited, 2, path1.err.slice(-3000));
    assert.match(path1.err, /must be a named pipe/);
    const noDir = runtime(h, pipeName());
    children.push(noDir);
    assert.strictEqual(await noDir.exited, 2, noDir.err.slice(-3000));
    assert.match(noDir.err, /needs --sessionDir/);
    // a UNC or device path for --sessionDir is refused (#275 review): a drive path only
    for (const far of ['\\\\server\\share\\run\\daemon', '\\\\?\\C:\\run\\daemon']) {
      const unc = runtime(h, pipeName(), ['--sessionDir', far]);
      children.push(unc);
      assert.strictEqual(await unc.exited, 2, unc.err.slice(-3000));
      assert.match(unc.err, /--sessionDir on Windows must be a drive path/);
    }
  });
});
