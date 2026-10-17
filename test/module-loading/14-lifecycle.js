const assert = require('assert');
const {ModuleLifecycle} = require('../../lib/module-lifecycle');

describe('module-loading 14: the per-name lifecycle lock', () => {
  it('runs one critical section per name at a time, others in parallel', async () => {
    const l = new ModuleLifecycle();
    const order = [];
    const slow = (tag, ms) => () => new Promise((r) => setTimeout(() => { order.push(tag); r(); }, ms));
    await Promise.all([l.run('a', slow('a1', 50)), l.run('a', slow('a2', 1)), l.run('b', slow('b1', 1))]);
    assert.deepStrictEqual(order, ['b1', 'a1', 'a2']);
  });

  it('a worker is live until it exits, and settled(name) waits beyond that for its broker (review I5)', async () => {
    const l = new ModuleLifecycle();
    let exit;
    let done;
    l.track('a', {exited: new Promise((r) => { exit = r; }), settled: new Promise((r) => { done = r; }), terminate: async () => {}});
    assert.notStrictEqual(l.live('a'), null);
    let passed = false;
    const waiting = l.settled('a').then(() => { passed = true; });
    exit();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(l.live('a'), null, 'exited: no longer live');
    assert.strictEqual(passed, false, 'but not settled yet');
    done();
    await waiting;
    assert.strictEqual(passed, true);
  });

  it('the broker delay hook is ignored without the test-only variable (review M1)', () => {
    const {testDelayMs} = require('../../lib/fs-broker/broker');
    assert.strictEqual(testDelayMs({COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500'}), 0);
    assert.strictEqual(testDelayMs({COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500', COUNTINGHOUSE_TEST_REQUIRE_THREAD_FLAG: '1'}), 1500);
  });
});

// Wired (port 9634): the broker's writes are held by the test-only delay hook
// (lib/fs-broker/broker.js testDelayMs), so the old worker's write is still
// running when the next spawn wants to empty /tmp.
describe('module-loading 14: the lock in a running server', function() {
  this.timeout(120000);
  const fs = require('fs');
  const path = require('path');
  const {ROOT, startServer, stopServer, mcpCall, post, waitFor} = require('../helpers/sandbox-server');
  const {mkdtemp} = require('../helpers/test-tmp');
  const tool = (a) => `fs_probe_probeservice_${a}`;
  let server = null;
  let base = null;
  afterEach(() => { stopServer(server); server = null; if (base) fs.rmSync(base, {recursive: true, force: true}); base = null; });

  const start = () => {
    base = mkdtemp('lifecycle-');
    return startServer(9634, ['--workerThread', '--debug', '--debugKey', 'k', '--moduleSandbox', 'audit',
      '--moduleDataPath', path.join(base, 'store'), '--loadModule', path.join(ROOT, 'test', 'fixtures', 'fs-probe')],
    {env: {COUNTINGHOUSE_TEST_BROKER_DELAY_MS: '1500'}});
  };
  // The second spawn walk comes after the first worker's broker settled.
  const walkWaitedForSettle = (out) => {
    const walks = [];
    for (let i = out.indexOf('file broker: fs-probe spawn walk'); i >= 0; i = out.indexOf('file broker: fs-probe spawn walk', i + 1)) walks.push(i);
    const settledAt = out.indexOf('file broker: fs-probe settled');
    return walks.length >= 2 && settledAt >= 0 && settledAt < walks[1];
  };

  it('a restart waits for the old worker\'s write to settle before emptying /tmp', async () => {
    server = await start();
    await mcpCall(9634, 'k', tool('slowWrite'), {});
    const r = await post(9634, 'k', '/restart-module', {name: 'fs-probe'});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    await waitFor(async () => walkWaitedForSettle(server.output), 20000, 'second walk after settle');
    await waitFor(async () => {
      const read = await mcpCall(9634, 'k', tool('read'), {path: '/tmp/slow'});
      return read.structuredContent != null && read.structuredContent.output.code === 'ENOENT';
    }, 20000, '/tmp emptied by the new spawn');
  });

  it('a crash while the broker is busy still restarts after backoff (review I5)', async () => {
    server = await start();
    await mcpCall(9634, 'k', tool('slowWrite'), {});
    await mcpCall(9634, 'k', tool('exit'), {});
    await waitFor(async () => walkWaitedForSettle(server.output), 30000, 'supervised restart after settle');
    await waitFor(async () => {
      const w = await mcpCall(9634, 'k', tool('write'), {path: '/data/after', content: 'x'});
      return w.structuredContent != null && w.structuredContent.output.ok === true;
    }, 30000, 'module back');
    assert.ok(!server.output.includes('superseded'), 'nobody superseded the restart');
  });
});
