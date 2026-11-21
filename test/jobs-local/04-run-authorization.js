// The local job runner's own owner check before every run (#15) and its
// deadline (#24), unstubbed (the back-sweep, 11-18: every other local-runner
// test stubs authorizeRun). Run in a child process, with lib/user-auth.js
// replaced in its require cache, so nothing of the stub reaches the mocha
// process the folder shares.
//   refused:  the access check answers a refusal -> the run fails with that
//             code, final (no retry), and the action is never invoked
//   deadline: the access check never answers -> past authorizeRunMs the run
//             fails SYSTEM_ERROR_USERDB_NA, retried while attempts remain,
//             and the action is never invoked
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');

const LIB = path.join(__dirname, '..', '..', 'lib');

function run(scenario, attempts) {
  const script = `
    const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
    options.workerThread = true;
    const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
    const asked = [];
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) => {
        asked.push({deviceID, appKey, actionName});
        if (${JSON.stringify(scenario)} === 'refused') return setImmediate(() => cb(Object.assign(new Error('no access'), {code: 'USER_HAS_NO_DEVICE'})));
        // deadline: never answers
      }};
    // (the owner's key known to the identity index, as a server's: a job
    // names its owner by id -- B-meter-keys (2))
    ${require('../helpers/identity-scope').identityLines(LIB, ['owner-key-1'])}
    const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
    const runner = createRunner({jobTimeoutMs: 0});
    runner.authorizeRunMs = 200;
    const invoked = [];
    runner.initJobProcess({recordCall: (k, t, c, cb) => cb && cb(null),
      invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => { invoked.push(actionName); setImmediate(callback, null, {ok: 1}); }});
    const t0 = Date.now();
    runner.addJob({appKey: 'owner-key-1'}, {name: 'n', attempts: ${attempts}}, 'dev', 'svc', 'act', {}, (err, r) => {
      if (err) { process.stdout.write('OUT ' + JSON.stringify({addErr: err.code || err.message}) + '\\n'); process.exit(0); }
      const poll = () => runner.getJob({appKey: 'owner-key-1'}, r.id, (e, rec) => {
        const st = rec != null ? rec.state : null;
        if (st === 'failed' || Date.now() - t0 > 8000) {
          process.stdout.write('OUT ' + JSON.stringify({state: st, reason: rec && rec.job ? rec.job.failedReason : null, attempts: rec && rec.job ? rec.job.attemptsMade : null,
            asked: asked.length, invoked: invoked.length, ms: Date.now() - t0}) + '\\n');
          process.exit(0);
        }
        setTimeout(poll, 20);
      });
      poll();
    });`;
  const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 30000});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
  assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice(4));
}

describe('jobs-local 04: the local runner\'s owner check before each run, and its deadline (#15, #24)', function() {
  this.timeout(60000);

  it('a refused check fails the run with its code, final, and the action is never invoked', () => {
    const o = run('refused', 3);
    assert.strictEqual(o.state, 'failed', JSON.stringify(o));
    assert.match(String(o.reason), /^USER_HAS_NO_DEVICE: /);
    assert.strictEqual(o.attempts, 1, 'final: not retried though attempts remain');
    assert.strictEqual(o.asked, 1);
    assert.strictEqual(o.invoked, 0);
  });

  it('a check that never answers fails the run at authorizeRunMs with SYSTEM_ERROR_USERDB_NA, retried while attempts remain; the action is never invoked', () => {
    const o = run('deadline', 2);
    assert.strictEqual(o.state, 'failed', JSON.stringify(o));
    assert.match(String(o.reason), /^SYSTEM_ERROR_USERDB_NA: /);
    assert.strictEqual(o.attempts, 2, 'retried once (not final)');
    assert.strictEqual(o.asked, 2);
    assert.strictEqual(o.invoked, 0);
    assert.ok(o.ms < 5000, `answered in ${o.ms} ms`);
  });
});
