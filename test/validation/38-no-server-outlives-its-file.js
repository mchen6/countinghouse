'use strict';
// A server a test starts through test/helpers/sandbox-server.js never
// outlives its file (R-redis-drop-spin, 11-27): auth 42's before() failed
// with Redis unreachable while its start was still pending, so the file never
// had the server object, its after() stopped nothing, and the server (its own
// process group) ran on, holding the file's port for every later file. The
// helper records each server it spawns; a start on a port a recorded server
// still holds stops that one first; what is left is stopped after the last
// test (the root hook, test/helpers/stop-servers.js) and at the process's
// exit (mocha --exit); stopOn() and stopAll() are there for a file's after().
//
// A fixture file runs under mocha in a child process, on this file's two
// ports (its own environment has no port base, so its port guard leaves
// them be); the servers are found afterwards by their ports. Every one found
// is stopped by this file, on every path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const {testPort} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'test/helpers/sandbox-server.js');
const PENDING_PORT = testPort(9837);
const HELD_PORT = testPort(9838);

// the pids of servers spawned from this checkout on `port`
function serversOn(port) {
  const out = execFileSync('ps', ['-eo', 'pid=,args=']).toString();
  return out.split('\n').filter((l) => l.includes(path.join(ROOT, 'framework.js')) && new RegExp(`--port ${port}(\\s|$)`).test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}
const killAll = (pids) => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* gone */ } } } };

// (the pending start's hook fails once its server has been spawned, seen by
// its port, within 20 s)
const FIXTURE = `
const {execFileSync} = require('child_process');
const {startServer} = require(${JSON.stringify(HELPER)});
const FLAGS = ['--no-workerThread', '--debug', '--debugKey', 'k'];
const spawnedOn = (port) => execFileSync('ps', ['-eo', 'args=']).toString().split('\\n')
  .some((l) => l.includes(${JSON.stringify(path.join(ROOT, 'framework.js'))}) && new RegExp('--port ' + port + '(\\\\s|$)').test(l));
describe('a start still pending when its hook fails', function() {
  this.timeout(30000);
  before(async () => {
    startServer(${PENDING_PORT}, FLAGS).catch(() => {});
    const until = Date.now() + 20000;
    while (!spawnedOn(${PENDING_PORT}) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    throw new Error('the hook fails while the start is pending');
  });
  it('never runs', () => {});
});
describe('a server left running', function() {
  this.timeout(60000);
  it('starts and is never stopped', async () => { await startServer(${HELD_PORT}, FLAGS); });
});
describe('a start on the port it holds', function() {
  this.timeout(60000);
  it('takes the port back', async () => { await startServer(${HELD_PORT}, FLAGS); });
});
`;

describe('validation 38: no server a test starts outlives its file', function() {
  if (process.platform === 'win32') return;   // (ps and process groups: POSIX)
  this.timeout(120000);
  const trees = require('../helpers/test-tmp').forFile(['ch-validation-38-']);
  after(() => killAll([...serversOn(PENDING_PORT), ...serversOn(HELD_PORT)]));

  // Without --exit (CI's largest run), with the repo's mocha config: the root
  // hook stops what is left. With --exit (run-local) and without the root
  // hook (no config; the two other required helpers only): the helper's
  // exit-time stop alone.
  const RUNS = [
    {name: 'mocha without --exit, the root hook', args: []},
    {name: 'mocha --exit, the exit-time stop alone', args: ['--no-config', '--require', 'test/helpers/require-thread-flag.js', '--require', 'test/helpers/port-guard.js', '--exit']}
  ];
  for (const run of RUNS) {
    it(`a hook that fails mid-start, a server left running, and a start on its port: none is left once the file ends (${run.name})`, async () => {
      const dir = trees.mkdtemp('ch-validation-38-');
      const file = path.join(dir, 'fixture.js');
      fs.writeFileSync(file, FIXTURE);
      const env = Object.assign({}, process.env);
      delete env.CH_TEST_PORT_BASE;
      const mocha = spawn(process.execPath, [path.join(ROOT, 'node_modules/mocha/bin/mocha.js'), ...run.args, file],
        {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      let out = '';
      mocha.stdout.on('data', (c) => { out += c; });
      mocha.stderr.on('data', (c) => { out += c; });
      let timer = null;
      const ended = await new Promise((resolve) => {
        timer = setTimeout(() => { killAll([mocha.pid]); resolve(false); }, 60000);
        mocha.on('close', () => resolve(true));
      }).finally(() => clearTimeout(timer));
      // (a stopped server is gone once its kill lands: waited for, at most 5 s)
      const until = Date.now() + 5000;
      let left = {pending: serversOn(PENDING_PORT), held: serversOn(HELD_PORT)};
      while ((left.pending.length > 0 || left.held.length > 0) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
        left = {pending: serversOn(PENDING_PORT), held: serversOn(HELD_PORT)};
      }
      killAll([...left.pending, ...left.held]);
      assert.ok(ended, `the fixture did not end (a server it started still holds it open): ${out.slice(-2000)}`);
      assert.deepStrictEqual(left, {pending: [], held: []}, out.slice(-2000));
      assert.ok(/[✔✓] takes the port back/.test(out), `the start on the held port failed: ${out.slice(-2000)}`);
      assert.ok(new RegExp(`a server from an earlier start \\(pid \\d+\\) still held port ${HELD_PORT}: stopped\\n`).test(out), out.slice(-2000));
    });
  }

  it('stopOn and stopAll are there for a file\'s after()', () => {
    const helper = require('../helpers/sandbox-server');
    assert.ok(typeof helper.stopOn === 'function' && typeof helper.stopAll === 'function');
  });

  trees.hooks();
});
