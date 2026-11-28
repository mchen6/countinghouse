'use strict';
// A run billed to its owner runs only while that charge can be recorded (the
// owner's decision, 11-27): asked after the owner check, before anything
// runs. A ledger that can't record it (here: chargeable() answers
// LEDGER_UNWRITABLE) fails the run with that refusal, its handler never
// invoked and nothing billed; once it can, the next run goes on and is billed.
// In a child process, as jobs-local 06: user-auth stubbed, the index set up
// there.
const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {identityLines} = require('../helpers/identity-scope');

const LIB = path.join(__dirname, '..', '..', 'lib');

describe('jobs-local 11: a billed run waits for a charge that can be recorded', function() {
  this.timeout(60000);

  it('refused while the ledger can\'t record its charge: failed with the ledger\'s code, nothing run or billed; once it can, run and billed', () => {
    const script = `
      const options = require(${JSON.stringify(path.join(LIB, 'cli-options'))});
      options.workerThread = true;
      options.mcpToolCallCost = 1;
      const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
      require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
        exports: (a, b, deviceID, appKey, serviceID, actionName, localCB, cb) => setImmediate(() => cb(null, {}))};
      ${identityLines(LIB, ['owner-key-11'])}
      const {CountinghouseError} = require(${JSON.stringify(path.join(LIB, 'countinghouse-error'))});
      const {createRunner} = require(${JSON.stringify(path.join(LIB, 'job-control-local'))});
      const {INTERNAL} = require(${JSON.stringify(path.join(LIB, 'job-control-common'))});
      const runner = createRunner({jobTimeoutMs: 0});
      const billed = [];
      const ran = [];
      let recordable = false;
      runner.initJobProcess({
        chargeable: (key, cb) => setImmediate(cb, recordable ? null : new CountinghouseError('LEDGER_UNWRITABLE')),
        recordCall: (k, t, c, cb) => { billed.push(k); if (cb) cb(null); },
        invokeJobs: (deviceID, serviceID, actionName, input, jobID, callback) => { ran.push(jobID); setImmediate(callback, null, {ok: 1}); }});
      const settled = (id, cb) => {
        const t0 = Date.now();
        const poll = () => runner.getJob(INTERNAL, id, (e, rec) => {
          const st = rec != null ? rec.state : null;
          if (st === 'completed' || st === 'failed' || Date.now() - t0 > 5000) return cb(rec || {});
          setTimeout(poll, 20);
        });
        poll();
      };
      runner.addJob({appKey: 'owner-key-11'}, {name: 'n'}, 'dev', 'svc', 'act', {}, (err, r) => {
        if (err) { process.stdout.write('OUT ' + JSON.stringify({addErr: err.code || err.message}) + '\\n'); process.exit(0); }
        settled(r.id, (first) => {
          const refused = {state: first.state, said: /LEDGER_UNWRITABLE: /.test(JSON.stringify(first)), ran: ran.length, billed: billed.length};
          recordable = true;
          runner.addJob({appKey: 'owner-key-11'}, {name: 'm'}, 'dev', 'svc', 'act', {}, (err2, r2) => {
            if (err2) { process.stdout.write('OUT ' + JSON.stringify({addErr2: err2.code || err2.message}) + '\\n'); process.exit(0); }
            settled(r2.id, (second) => {
              process.stdout.write('OUT ' + JSON.stringify({refused, then: {state: second.state, ran: ran.length, billed}}) + '\\n');
              process.exit(0);
            });
          });
        });
      });`;
    const r = spawnSync(process.execPath, ['-e', script], {cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', timeout: 30000});
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('OUT '));
    assert.ok(line != null, `no output: ${r.stdout} ${r.stderr}`);
    const out = JSON.parse(line.slice(4));
    assert.strictEqual(out.refused.state, 'failed', line);
    assert.strictEqual(out.refused.said, true, line);
    assert.deepStrictEqual([out.refused.ran, out.refused.billed], [0, 0], line);
    assert.deepStrictEqual(out.then, {state: 'completed', ran: 1, billed: ['owner-key-11']}, line);
  });
});
