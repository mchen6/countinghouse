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
// them be). It wraps child_process.spawn before the helper takes it, and
// prints each server's pid and port as it is spawned: that is how this file
// knows which processes to look for (no ps: the test image has none), and
// that the pending start really spawned. Every server named is stopped by
// this file, on every path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {testPort} = require('../helpers/test-env');

const ROOT = path.resolve(__dirname, '../..');
const HELPER = path.join(ROOT, 'test/helpers/sandbox-server.js');
const PENDING_PORT = testPort(9837);
const HELD_PORT = testPort(9838);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const killAll = (pids) => { for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) { /* gone */ } } } };
// (each `SPAWNED <pid> <port>` line the fixture printed)
const spawnedIn = (out) => [...out.matchAll(/^SPAWNED (\d+) (\d+)$/gm)].map((m) => ({pid: Number(m[1]), port: Number(m[2])}));

const FIXTURE = `
const childProcess = require('child_process');
const realSpawn = childProcess.spawn;
const spawned = new Set();
childProcess.spawn = function(cmd, args, ...rest) {
  const child = realSpawn.call(this, cmd, args, ...rest);
  const at = (args || []).indexOf('--port');
  if (at >= 0 && child.pid != null) {
    process.stdout.write('SPAWNED ' + child.pid + ' ' + args[at + 1] + '\\n');
    spawned.add(Number(args[at + 1]));
  }
  return child;
};
const {startServer} = require(${JSON.stringify(HELPER)});
describe('a start still pending when its hook fails', function() {
  this.timeout(30000);
  before(async () => {
    startServer(${PENDING_PORT}, ['--no-workerThread', '--debug', '--debugKey', 'k']).catch(() => {});
    const until = Date.now() + 20000;
    while (!spawned.has(${PENDING_PORT}) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    throw new Error('the hook fails while the start is pending');
  });
  it('never runs', () => {});
});
describe('a server left running', function() {
  this.timeout(60000);
  it('starts and is never stopped', async () => { await startServer(${HELD_PORT}, ['--no-workerThread', '--debug', '--debugKey', 'k']); });
});
describe('a start on the port it holds', function() {
  this.timeout(60000);
  it('takes the port back', async () => {
    await startServer(${HELD_PORT}, ['--no-workerThread', '--debug', '--debugKey', 'k']);
    process.stdout.write('TOOK-BACK\\n');
  });
});
`;

describe('validation 38: no server a test starts outlives its file', function() {
  if (process.platform === 'win32') return;   // (process groups: POSIX)
  this.timeout(300000);
  const trees = require('../helpers/test-tmp').forFile(['ch-validation-38-']);
  const named = [];
  after(() => killAll(named));

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
      const env = Object.assign({}, process.env, {NO_COLOR: '1'});
      delete env.CH_TEST_PORT_BASE;
      delete env.FORCE_COLOR;
      delete env.MOCHA_COLORS;
      const mocha = spawn(process.execPath, [path.join(ROOT, 'node_modules/mocha/bin/mocha.js'), '--no-color', ...run.args, file],
        {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      let out = '';
      mocha.stdout.on('data', (c) => { out += c; });
      mocha.stderr.on('data', (c) => { out += c; });
      let timer = null;
      const ended = await new Promise((resolve) => {
        timer = setTimeout(() => { killAll([mocha.pid]); resolve(false); }, 150000);
        mocha.on('close', () => resolve(true));
      }).finally(() => clearTimeout(timer));
      const servers = spawnedIn(out);
      named.push(...servers.map((x) => x.pid));
      // (a stopped server is gone once its kill lands: waited for, at most 5 s)
      const until = Date.now() + 5000;
      let left = servers.filter((x) => alive(x.pid));
      while (left.length > 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 100));
        left = servers.filter((x) => alive(x.pid));
      }
      killAll(left.map((x) => x.pid));
      assert.ok(ended, `the fixture did not end within 150 s: ${out.slice(-2000)}`);
      assert.deepStrictEqual(servers.map((x) => x.port), [PENDING_PORT, HELD_PORT, HELD_PORT], `the three servers spawned: ${out.slice(-2000)}`);
      assert.deepStrictEqual(left, [], out.slice(-2000));
      assert.ok(/^TOOK-BACK$/m.test(out), `the start on the held port failed: ${out.slice(-2000)}`);
      assert.ok(new RegExp(`a server from an earlier start \\(pid ${servers[1].pid}\\) still held port ${HELD_PORT}: stopped\\n`).test(out), out.slice(-2000));
    });
  }

  it('stopOn and stopAll are there for a file\'s after()', () => {
    const helper = require('../helpers/sandbox-server');
    assert.ok(typeof helper.stopOn === 'function' && typeof helper.stopAll === 'function');
  });

  trees.hooks();
});
