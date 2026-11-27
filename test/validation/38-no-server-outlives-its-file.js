'use strict';
// A server a test starts through test/helpers/sandbox-server.js never
// outlives its file (R-redis-drop-spin, 11-27): auth 42's before() failed
// with Redis unreachable while its start was still pending, so the file never
// had the server object, its after() stopped nothing, and the server (its own
// process group) ran on, holding the file's port for every later file. The
// helper records each server it spawns and stops what is left when the
// process exits; a start on a port a recorded server still holds stops that
// one first; stopAll() is there for a file's after().
//
// A fixture file runs under mocha in a child process; the servers are found
// afterwards by their ports. Every one found is stopped by this file, on
// every path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const {testPort} = require('../helpers/test-env');
const tmp = require('../helpers/test-tmp');

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'test/helpers/sandbox-server.js');
const PENDING_PORT = testPort(9837);
const HELD_PORT = testPort(9838);

// (the fixture's ports from its own testPort(), asked in the same order as
// here: the same two, which its port guard then lets it use)
const FIXTURE = `
const {startServer} = require(${JSON.stringify(HELPER)});
const {testPort} = require(${JSON.stringify(path.join(ROOT, 'test/helpers/test-env.js'))});
const PENDING_PORT = testPort(9837);
const HELD_PORT = testPort(9838);
if (PENDING_PORT !== ${PENDING_PORT} || HELD_PORT !== ${HELD_PORT}) throw new Error('the fixture got other ports: ' + PENDING_PORT + ', ' + HELD_PORT);
const FLAGS = ['--no-workerThread', '--debug', '--debugKey', 'k'];
describe('a start still pending when its hook fails', function() {
  this.timeout(30000);
  before(async () => {
    startServer(PENDING_PORT, FLAGS).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    throw new Error('the hook fails while the start is pending');
  });
  it('never runs', () => {});
});
describe('a server left running', function() {
  this.timeout(60000);
  it('starts and is never stopped', async () => { await startServer(HELD_PORT, FLAGS); });
});
describe('a start on the port it holds', function() {
  this.timeout(60000);
  it('takes the port back', async () => { await startServer(HELD_PORT, FLAGS); });
});
`;

// the pids of servers spawned from this checkout on `port`
function serversOn(port) {
  const out = execFileSync('ps', ['-eo', 'pid=,args=']).toString();
  return out.split('\n').filter((l) => l.includes(path.join(ROOT, 'framework.js')) && new RegExp(`--port ${port}(\\s|$)`).test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}
const killAll = (pids) => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* gone */ } } } };

describe('validation 38: no server a test starts outlives its file', function() {
  if (process.platform === 'win32') return;   // (ps and process groups: POSIX)
  this.timeout(120000);
  let dir = null;
  after(() => {
    killAll([...serversOn(PENDING_PORT), ...serversOn(HELD_PORT)]);
    if (dir != null) tmp.remove(dir);
  });

  // (CI's largest run is mocha without --exit: the root hook,
  // test/helpers/stop-servers.js, stops them after the last test; run-local
  // passes --exit: the helper's exit-time stop does)
  for (const exitFlag of [[], ['--exit']]) {
    it(`a hook that fails mid-start, a server left running, and a start on its port: none is left once the file ends (mocha ${exitFlag.join(' ') || 'without --exit'})`, async () => {
      if (dir == null) dir = tmp.mkdtemp('ch-validation-38-');
      const file = path.join(dir, 'fixture.js');
      fs.writeFileSync(file, FIXTURE);
      const mocha = spawn(process.execPath, [path.join(ROOT, 'node_modules/mocha/bin/mocha.js'), ...exitFlag, file],
        {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      let out = '';
      mocha.stdout.on('data', (c) => { out += c; });
      mocha.stderr.on('data', (c) => { out += c; });
      let timer = null;
      const ended = await new Promise((resolve) => {
        timer = setTimeout(() => { killAll([mocha.pid]); resolve(false); }, 45000);
        mocha.on('close', () => resolve(true));
      }).finally(() => clearTimeout(timer));
      assert.ok(ended, `the fixture did not end (a server it started still holds it open): ${out.slice(-2000)}`);
      // (the stop is a SIGKILL: gone at once; a moment for ps)
      await new Promise((r) => setTimeout(r, 500));
      const left = {pending: serversOn(PENDING_PORT), held: serversOn(HELD_PORT)};
      killAll([...left.pending, ...left.held]);
      assert.deepStrictEqual(left, {pending: [], held: []}, out.slice(-2000));
      assert.ok(/[✔✓] takes the port back/.test(out), `the start on the held port failed: ${out.slice(-2000)}`);
      assert.ok(new RegExp(`a server from an earlier start \\(pid \\d+\\) still held port ${HELD_PORT}: stopped`).test(out), out.slice(-2000));
    });
  }

  it('stopAll is there for a file\'s after()', () => {
    assert.strictEqual(typeof require('../helpers/sandbox-server').stopAll, 'function');
  });
});
