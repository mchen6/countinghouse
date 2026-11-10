// The run-time authorization of a job (authorizeRun, since every run is
// checked) has a deadline: an auth backend that accepts the lookup and never
// answers fails the run as SYSTEM_ERROR_USERDB_NA, which bullmq retries, and
// the log names the job id. Before, the processor's own timeout was set only
// after authorizeRun resolved, so a hung backend held every job run with no
// bound at all. A unit test with a stub user-auth, in a child process: the
// job control's requires open Redis clients.
const assert = require('assert');
const path   = require('path');
const {spawnSync} = require('child_process');
const {ROOT} = require('../helpers/sandbox-server');

const LIB = path.join(ROOT, 'lib');

function run(behaviour) {
  const script = `
    require(${JSON.stringify(path.join(LIB, 'cli-options'))}).setOptions({workerThread: true});
    const LOG = require(${JSON.stringify(path.join(LIB, 'logger'))});
    LOG.createLogger(false);
    const lines = [];
    LOG.E = (e) => { lines.push(String(e && e.message ? e.message : e)); return e; };
    LOG.I = (l) => { lines.push(String(l)); };
    const authPath = require.resolve(${JSON.stringify(path.join(LIB, 'user-auth'))});
    const behaviour = ${JSON.stringify(behaviour)};
    require.cache[authPath] = {id: authPath, filename: authPath, loaded: true,
      exports: (a, b, deviceID, appKey, c, d, localCB, cb) => {
        if (behaviour === 'ok') return setImmediate(() => cb(null, {}));
        if (behaviour === 'late') return setTimeout(() => cb(null, {}), 900);
      }};
    const JobControl = require(${JSON.stringify(path.join(LIB, 'job-control'))});
    JobControl.authorizeRunMs = 300;
    const started = Date.now();
    JobControl.authorizeRun({id: 'job-35', data: {apiKey: 'some-key', deviceID: 'd', serviceID: 's', actionName: 'a'}})
      .then(() => ({outcome: 'resolved'}), (e) => ({outcome: 'rejected', kind: e.constructor.name, message: e.message}))
      .then((r) => { r.ms = Date.now() - started; return r; })
      // A second more, so a late answer or a second settlement would show.
      .then((r) => setTimeout(() => {
        process.stdout.write('RESULT ' + JSON.stringify(Object.assign(r, {lines: lines})) + '\\n');
        process.exit(0);
      }, 1000));`;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 20000});
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line != null, `no result: ${r.stdout} ${r.stderr}`);
  return JSON.parse(line.slice('RESULT '.length));
}

describe('auth 35: the run-time authorization of a job has a deadline', function() {
  this.timeout(60000);

  it('a backend that never answers fails the run as SYSTEM_ERROR_USERDB_NA, retryable, naming the job', () => {
    const r = run('hang');
    assert.strictEqual(r.outcome, 'rejected', JSON.stringify(r));
    assert.notStrictEqual(r.kind, 'UnrecoverableError');
    assert.match(r.message, /^SYSTEM_ERROR_USERDB_NA: /);
    assert.ok(!r.message.includes('some-key'), `the key is in the failure: ${r.message}`);
    assert.ok(r.ms < 1000, `took ${r.ms} ms`);
    assert.ok(r.lines.some((l) => /job job-35/.test(l) && !/some-key/.test(l)), `no log line names the job: ${JSON.stringify(r.lines)}`);
  });

  it('an answer after the deadline changes nothing', () => {
    const r = run('late');
    assert.strictEqual(r.outcome, 'rejected', JSON.stringify(r));
    assert.match(r.message, /^SYSTEM_ERROR_USERDB_NA: /);
  });

  it('an answer in time authorizes the run', () => {
    const r = run('ok');
    assert.strictEqual(r.outcome, 'resolved', JSON.stringify(r));
  });
});
