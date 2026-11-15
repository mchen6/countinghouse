'use strict';
// C1 part 2's run directory, under the review of #248 (e2f2e67), server
// free: the parent's checks, the identity re-check after listen, a temporary
// secret never left behind, and the start lock (lib/session-transport/
// run-dir.js). POSIX only: the named pipe is C2's.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const runDir = require('../../lib/session-transport/run-dir');

describe('session-transport 04: the run directory (#248 review)', function() {
  this.timeout(10000);
  if (process.platform === 'win32') return;
  let home;
  let run;
  let daemon;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rd-'));
    run = path.join(home, 'run');
    daemon = path.join(run, 'daemon');
    fs.mkdirSync(daemon, {recursive: true, mode: 0o700});
    fs.chmodSync(run, 0o700);
    fs.chmodSync(daemon, 0o700);
  });
  afterEach(() => { fs.rmSync(home, {recursive: true, force: true}); });

  it('refuses a parent that is group- or world-writable', () => {
    assert.strictEqual(runDir.runDirProblem(daemon), null);
    fs.chmodSync(run, 0o770);
    assert.match(String(runDir.runDirProblem(daemon)), /writable/);
    fs.chmodSync(run, 0o707);
    assert.match(String(runDir.runDirProblem(daemon)), /writable/);
  });

  it('identity: a directory swapped after the check is caught', () => {
    const before = runDir.identityOf(daemon);
    assert.strictEqual(runDir.sameIdentity(daemon, before), true);
    fs.renameSync(daemon, `${daemon}.old`);
    fs.mkdirSync(daemon, {mode: 0o700});
    assert.strictEqual(runDir.sameIdentity(daemon, before), false);
  });

  it('a secret that cannot be written leaves no temporary file behind', () => {
    fs.mkdirSync(path.join(daemon, 'secret'));   // the rename over it fails
    assert.throws(() => runDir.writeSecret(daemon));
    assert.deepStrictEqual(fs.readdirSync(daemon).filter((n) => /\.tmp$/.test(n)), []);
  });

  it('the start lock: a second take is refused while its holder lives; a dead holder\'s is taken over', () => {
    const lock = runDir.takeStartLock(daemon);
    assert.ok(lock.ok, JSON.stringify(lock));
    const second = runDir.takeStartLock(daemon);
    assert.strictEqual(second.ok, false);
    assert.match(second.why, /another runtime/);
    lock.release();
    fs.writeFileSync(path.join(daemon, 'runtime.lock'), JSON.stringify({pid: 2147483646, at: new Date().toISOString()}), {mode: 0o600});
    const taken = runDir.takeStartLock(daemon);
    assert.strictEqual(taken.ok, true, JSON.stringify(taken));
    taken.release();
    assert.ok(!fs.existsSync(path.join(daemon, 'runtime.lock')));
  });

  it('two starts finding one dead holder: only one takes the lock', () => {
    const lockFile = path.join(daemon, 'runtime.lock');
    fs.writeFileSync(lockFile, JSON.stringify({pid: 2147483646, at: new Date().toISOString()}), {mode: 0o600});
    // the race: the second start has read the dead holder; before it takes
    // the lock over, the first start takes it over and holds a new one
    let first = null;
    const second = runDir.takeStartLock(daemon, {beforeTakeover: () => {
      if (first == null) first = runDir.takeStartLock(daemon);
    }});
    assert.ok(first != null && first.ok, JSON.stringify(first));
    assert.strictEqual(second.ok, false, 'the second start must not take the first one\'s live lock');
    const held = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.strictEqual(held.pid, process.pid, 'the first start\'s lock is still in place');
    assert.deepStrictEqual(fs.readdirSync(daemon).filter((n) => /stale/.test(n)), [], 'nothing left aside');
    first.release();
  });

  it('a lock that is a symlink is not followed', () => {
    const target = path.join(home, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({pid: process.pid}));
    fs.symlinkSync(target, path.join(daemon, 'runtime.lock'));
    const r = runDir.takeStartLock(daemon);
    assert.strictEqual(r.ok, false, 'a symlinked lock is never taken as ours or over');
    assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).pid, process.pid, 'its target is untouched');
  });

  it('a stale socket nothing answers on is removed; a live one is in use', async() => {
    const p = path.join(daemon, 's');
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(p, r));
    assert.match(String(await runDir.clearStale(p)), /in use/);
    await new Promise((r) => srv.close(r));
    // a socket file left by a runtime that died: nothing listens on it
    const dead = net.createServer(() => {});
    await new Promise((r) => dead.listen(p, r));
    const copy = path.join(daemon, 's2');
    fs.linkSync(p, copy);
    await new Promise((r) => dead.close(r));
    assert.strictEqual(await runDir.clearStale(copy), null);
    assert.ok(!fs.existsSync(copy));
  });

  it('a probe that gets no answer in time counts as in use', async() => {
    const p = path.join(daemon, 's');
    fs.writeFileSync(p, '');   // stands in: clearStale is given a probe that never answers
    fs.rmSync(p);
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(p, r));
    const never = () => ({once: () => {}, destroy: () => {}});
    assert.match(String(await runDir.clearStale(p, {probeMs: 100, connect: never})), /in use/);
    await new Promise((r) => srv.close(r));
  });

  it('listens under umask 077', () => {
    let seen = null;
    runDir.withPrivateUmask(() => { seen = process.umask(); });
    assert.strictEqual(seen, 0o077);
  });

  // C2: the long-home fallback, $TMPDIR/ch-<uid>/, whose parent on Linux is
  // /tmp: world-writable, but sticky, so no one else can rename or remove
  // the user's directory in it
  it('a socket directory\'s parent may be sticky (the long-home fallback); world-writable without the sticky bit is refused', () => {
    const tmp = path.join(home, 'tmp');
    const sock = path.join(tmp, 'ch-1000');
    fs.mkdirSync(sock, {recursive: true, mode: 0o700});
    fs.chmodSync(sock, 0o700);
    fs.chmodSync(tmp, 0o1777);
    assert.strictEqual(runDir.runDirProblem(sock, {stickyParent: true}), null);
    assert.match(String(runDir.runDirProblem(sock)), /writable/, 'only the socket\'s own directory takes a sticky parent');
    fs.chmodSync(tmp, 0o777);
    assert.match(String(runDir.runDirProblem(sock, {stickyParent: true})), /writable/);
    fs.chmodSync(tmp, 0o700);
  });
});

// C2: Windows, server free: the named pipe's form, and the run directory's
// and the secret's DACLs by lib/win-acl.js privateProblem. The ACL reader and
// the private create are injected, so these run on every platform.
describe('session-transport 04: the run directory on Windows (C2)', function() {
  this.timeout(10000);
  const USER = 'S-1-5-21-1000000000-1000000000-1000000000-1001';
  const FULL = 2032127;
  const ace = (sid, rights = FULL, extra = {}) => Object.assign({sid, rights, type: 'Allow', inheritOnly: false}, extra);
  const priv = () => ({user: USER, owner: USER, otherAces: false, rules: [ace(USER), ace('S-1-5-18')]});
  const PIPE = '\\\\.\\pipe\\countinghouse-0123456789abcdef0123456789abcdef';
  let home;
  let daemon;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rdw-'));
    daemon = path.join(home, 'run', 'daemon');
    fs.mkdirSync(daemon, {recursive: true});
  });
  afterEach(() => { fs.rmSync(home, {recursive: true, force: true}); });

  it('the session socket is a named pipe of the random form, and only that; on POSIX a pipe name is refused', () => {
    assert.strictEqual(runDir.isPipeName(PIPE), true);
    assert.strictEqual(runDir.socketPathProblem(PIPE, {platform: 'win32'}), null);
    for (const bad of ['\\\\.\\pipe\\countinghouse-0123', '\\\\.\\pipe\\countinghouse-0123456789ABCDEF0123456789ABCDEF',
      '\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef', 'C:\\Users\\u\\.countinghouse\\run\\daemon\\sessions.sock', `${PIPE}x`]) {
      assert.match(String(runDir.socketPathProblem(bad, {platform: 'win32'})), /named pipe/, bad);
    }
    assert.match(String(runDir.socketPathProblem(PIPE, {platform: 'linux'})), /named pipe/);
    assert.strictEqual(runDir.socketPathProblem('/home/u/.countinghouse/run/daemon/sessions.sock', {platform: 'linux'}), null);
  });

  it('the directory and its parent must be private by privateProblem, both read in one call', () => {
    const asked = [];
    const acls = (want) => (files) => { asked.push(files); return files.map((f, i) => want[i]); };
    assert.strictEqual(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([priv(), priv()])}), null);
    assert.deepStrictEqual(asked, [[daemon, path.dirname(daemon)]], 'one call, the directory then its parent');
    const open = priv();
    open.rules.push(ace('S-1-1-0', 1179817));   // Everyone: read and execute
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([open, priv()])})), /S-1-1-0/);
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([priv(), open])})), /parent.*S-1-1-0/);
    const other = Object.assign(priv(), {owner: 'S-1-5-21-1-2-3-1002'});
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([other, priv()])})), /owned by/);
    const harmless = priv();
    harmless.rules.push(ace('S-1-1-0', 0x100000 | 0x20000 | 0x80));
    assert.strictEqual(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([harmless, priv()])}), null);
  });

  it('a parent that is a link (a junction reads as one) is refused, as on POSIX (#275 review)', function() {
    if (process.platform === 'win32') return this.skip();   // a junction needs no privilege, a symlink does: POSIX makes the link
    const real = path.join(home, 'elsewhere');
    fs.mkdirSync(path.join(real, 'daemon'), {recursive: true});
    const linked = path.join(home, 'linked');
    fs.symlinkSync(real, linked);
    assert.match(String(runDir.runDirProblem(path.join(linked, 'daemon'), {platform: 'win32', acls: () => [priv(), priv()]})), /parent .* is not a directory/);
  });

  it('a directory\'s inherit-only allow rule for anyone else is refused: it would flow into the files made there (#275 review)', () => {
    const acls = (want) => (files) => files.map((f, i) => want[i]);
    const flows = priv();
    flows.rules.push(ace('S-1-1-0', FULL, {inheritOnly: true}));
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([flows, priv()])})), /inherit.*S-1-1-0/);
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([priv(), flows])})), /parent.*inherit.*S-1-1-0/);
    // this user's and SYSTEM's own inherit-only rules are theirs
    const own = priv();
    own.rules.push(ace(USER, FULL, {inheritOnly: true}));
    assert.strictEqual(runDir.runDirProblem(daemon, {platform: 'win32', acls: acls([own, priv()])}), null);
    // a file's inherit-only rules flow nowhere: skipped, as before
    const {privateProblem} = require('../../lib/win-acl');
    assert.strictEqual(privateProblem('the secret', flows), null);
    assert.match(String(privateProblem('a directory', flows, {directory: true})), /inherit.*S-1-1-0/);
  });

  it('ACLs that cannot be read, or a directory that is not one, fail closed', () => {
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: () => { throw new Error('powershell timed out'); }})), /could not be read/);
    assert.match(String(runDir.runDirProblem(daemon, {platform: 'win32', acls: () => [priv()]})), /could not be read/);
    assert.match(String(runDir.runDirProblem(path.join(home, 'nothing'), {platform: 'win32', acls: () => [priv(), priv()]})), /could not be read/);
    fs.writeFileSync(path.join(home, 'file'), '');
    assert.match(String(runDir.runDirProblem(path.join(home, 'file'), {platform: 'win32', acls: () => [priv(), priv()]})), /not a directory/);
  });

  it('the secret is created private, then renamed into place; one that cannot be leaves no temporary file', () => {
    const made = [];
    const createPrivate = (file, data) => { made.push(path.basename(file)); fs.writeFileSync(file, data, {flag: 'wx'}); };
    const secret = runDir.writeSecret(daemon, undefined, {platform: 'win32', createPrivate});
    assert.strictEqual(made.length, 1);
    assert.match(made[0], /^\.secret\..*\.tmp$/);
    assert.strictEqual(fs.readFileSync(path.join(daemon, 'secret'), 'utf8'), require('../../lib/session-transport/handshake').formatSecret(secret));
    assert.deepStrictEqual(fs.readdirSync(daemon).sort(), ['secret']);
    // a second start writes a new one over it
    runDir.writeSecret(daemon, undefined, {platform: 'win32', createPrivate});
    assert.deepStrictEqual(fs.readdirSync(daemon).sort(), ['secret']);
    assert.throws(() => runDir.writeSecret(daemon, undefined, {platform: 'win32', createPrivate: (file) => { fs.writeFileSync(file, 'x'); throw new Error('denied'); }}), /denied/);
    assert.deepStrictEqual(fs.readdirSync(daemon).filter((n) => /\.tmp$/.test(n)), []);
  });

  it('nothing is cleared before a pipe binds: a held name fails the bind itself', async() => {
    assert.strictEqual(await runDir.clearStale(PIPE, {platform: 'win32', connect: () => { throw new Error('never probed'); }}), null);
  });
});
