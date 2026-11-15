'use strict';
// #234: a server test that fails leaves no server behind, and the port guard
// refuses a countinghouse server spawned with no --port under
// CH_TEST_PORT_BASE (one listens on its default port, outside the run's
// block, where the test's own client never looks: the direct-peer-channels
// files did both, so each failing local run left a server taking jobs).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

describe('validation 16: no server left behind (#234)', function() {
  this.timeout(180000);

  it('the port guard: a countinghouse server with no --port is refused; one with a port, --stdio or --sessionSocket, is not', () => {
    const {serverWithoutPort} = require('../helpers/port-guard');
    const node = process.execPath;
    assert.strictEqual(serverWithoutPort(node, [path.join(ROOT, 'framework.js'), '--workerThread']), true);
    assert.strictEqual(serverWithoutPort('"./bin/countinghouse" --workerThread --debug --directPeerChannels', null), true);
    assert.strictEqual(serverWithoutPort(node, ['--expose-gc', path.join(ROOT, 'framework.js'), '--port', '1234']), false);
    assert.strictEqual(serverWithoutPort('"./bin/countinghouse" --port 1234 --debug', null), false);
    assert.strictEqual(serverWithoutPort(node, [path.join(ROOT, 'framework.js'), '--stdio']), false);
    // a shared runtime on its session socket binds no port either
    assert.strictEqual(serverWithoutPort(node, [path.join(ROOT, 'framework.js'), '--store', 'local', '--sessionSocket', '/tmp/x/s']), false);
    assert.strictEqual(serverWithoutPort(node, ['-e', '1']), false, 'not a server');
  });

  it('a server that never answers /shutdown is stopped all the same, within the wait', async () => {
    const {shutdownThenStop} = require('../helpers/sandbox-server');
    const {spawn} = require('child_process');
    // a stand-in that takes the request and never answers it
    const hung = spawn(process.execPath, ['-e', `require('http').createServer(() => {}).listen(0, '127.0.0.1', function() { console.log(this.address().port); })`],
      {detached: true, stdio: ['ignore', 'pipe', 'ignore']});
    const port = await new Promise((resolve) => hung.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    const exited = new Promise((resolve) => hung.once('exit', resolve));
    const started = Date.now();
    await shutdownThenStop(hung, port, null, {waitMs: 300});
    await exited;
    assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  });

  it('a failing case\'s server is stopped: its process is gone once mocha exits', () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-v16-')), 'pid');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'mocha', 'bin', 'mocha.js'), '--exit',
      path.join(ROOT, 'test', 'fixtures', 'server-left-behind', 'failing.js')],
    {cwd: ROOT, env: Object.assign({}, process.env, {LEFT_BEHIND_PID_FILE: pidFile}), encoding: 'utf8', timeout: 150000});
    assert.notStrictEqual(r.status, 0, 'the fixture\'s case fails');
    assert.match(r.stdout + r.stderr, /a failing case, on purpose/);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(pid, 0); } catch (e) { alive = false; }
      if (alive) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
    }
    assert.strictEqual(alive, false, `the server ${pid} is still running`);
  });
});
