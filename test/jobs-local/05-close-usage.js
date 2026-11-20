'use strict';
// B-shutdown-usage: the local runner's close() (shutdown, tests) leaves no
// usage call open. A pass still running is ended there, its record a
// cancelled call's (the cancel hook: lib/usage/task.js cancel), as the
// runtime's exit closes every call still open.
const assert = require('assert');
const {createRunner} = require('../../lib/job-control-local');
const {INTERNAL} = require('../../lib/job-control-common');
const {createUsage} = require('../../lib/usage');
const {taskHooks} = require('../../lib/usage/task');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(20); }
  return false;
}

describe('jobs-local 05: close() ends a running pass\'s usage call as cancelled (B-shutdown-usage)', function() {
  this.timeout(20000);
  const options = require('../../lib/cli-options');
  let workerThread;
  before(() => { workerThread = options.workerThread; options.workerThread = true; });
  after(() => { options.workerThread = workerThread; });

  it('a pass whose call never answers: close() records it cancelled, and a later answer records nothing more', async () => {
    const u = createUsage({usageDir: null, pid: 1, startMs: 1});
    const hooks = taskHooks({usage: () => u, targetFor: () => ({name: 'slow', role: 'tool', module: 'm'}), callerOf: () => 'c1',
      buildResult: (err) => ({content: [{type: 'text', text: err != null ? 'failed' : 'ok'}], isError: err != null})});
    let answerLater = null;
    const ci = {recordCall: (k, t, c, cb) => cb && cb(null), invokeJobs: (d, s, a, input, jobID, callback) => { answerLater = callback; }};
    const runner = createRunner({jobTimeoutMs: 0});
    runner.authorizeRun = () => Promise.resolve();
    runner.initJobProcess(ci);
    runner.setStartHook(hooks.start);
    runner.setCompletionHook((data, results, run) => hooks.complete(data, results, run));
    runner.setCancelHook((data, run) => hooks.cancel(data, run));
    await new Promise((resolve) => runner.addJob({appKey: 'test-owner-0123456789', isAdmin: false}, {name: 'n'}, 'dev', 'svc', 'act', {}, () => resolve()));
    assert.ok(await until(() => answerLater != null), 'the pass never started');
    assert.strictEqual(u.inFlight(), 1);
    runner.close();
    assert.strictEqual(u.inFlight(), 0, 'close() left the pass\'s call open');
    const out = u.records().filter((r) => r.bytesOut !== undefined);
    assert.deepStrictEqual(out.map((r) => [r.tool, r.outcome]), [['slow', 'cancelled']]);
    answerLater(null, {late: true});
    await wait(50);
    assert.strictEqual(u.records().filter((r) => r.bytesOut !== undefined).length, 1, 'an answer after close records nothing');
  });
});
