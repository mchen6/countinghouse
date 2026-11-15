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
});
