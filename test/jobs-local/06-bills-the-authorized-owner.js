'use strict';
// B-meter-keys (2), the medium on it: a job names its owner by id, and the
// key is found from the identity index before each run. The run is billed
// to the key that was authorized for it, even if the owner leaves the index
// while the run is under way (a reload that removes the key, a rebuild):
// before, the completion looked the key up again, found none, and the run
// went unbilled, silently. In a child process, as jobs-local 04: user-auth
// stubbed, the index set up there.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {identityLines} = require('../helpers/identity-scope');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('jobs-local 06: a run is billed to the owner it was authorized as (B-meter-keys (2))', function() {
  this.timeout(60000);

  it('an owner removed from the index while its run is under way is still billed for it', () => {
    const script = `
      const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
      options.workerThread = true;
      options.mcpToolCallCost = 1;
      const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) => setImmediate(() => cb(null, {}))};
      ${identityLines(LIB, ['owner-key-6'])}
      const identity = require(${JSON.stringify(path.join(LIB, 'identity'))});
      const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
      const {INTERNAL} = require(${JSON.stringify(path.join(LIB, 'job-control-common'))});
      const runner = createRunner({jobTimeoutMs: 0});
      const billed = [];
      runner.initJobProcess({recordCall: (k, t, c, cb) => { billed.push(k); if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => {
          // the owner leaves the index while the run is under way
          identity.stateForTests().forget();
          setImmediate(callback, null, {ok: 1});
        }});
      runner.addJob({appKey: 'owner-key-6'}, {name: 'n'}, 'dev', 'svc', 'act', {}, (err, r) => {
        if (err) { process.stdout.write('OUT ' + JSON.stringify({addErr: err.code || err.message}) + '\\n'); process.exit(0); }
        // (the run's end, then what it billed: never polled for the one expected)
        const t0 = Date.now();
        const poll = () => runner.getJob(INTERNAL, r.id, (e, rec) => {
          const st = rec != null ? rec.state : null;
          if (st === 'completed' || st === 'failed' || Date.now() - t0 > 5000) {
            process.stdout.write('OUT ' + JSON.stringify({state: st, billed}) + '\\n');
            process.exit(0);
          }
          setTimeout(poll, 20);
        });
        poll();
      });`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 30000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    assert.deepStrictEqual(JSON.parse(line.slice(4)), {state: 'completed', billed: ['owner-key-6']});
  });
});
