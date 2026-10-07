// A grant revoked while the server runs must close the direct peer channel
// that was opened under it.
//
// On the direct path (the default) a module's right to call another
// module's device is checked once, when the channel between their workers is
// brokered, and the channel is then reused. Nothing used to re-check it, so
// with an AuthProvider that can change at run time -- sqlite here, through
// its own CLI, exactly as an operator would -- a revoked module identity kept
// reaching the device until its worker happened to restart. The broker now
// re-runs the same check for every open grant on a timer
// (--peerChannelAuthRecheckSeconds, 1 here, 5 by default) and closes the
// channel on a denial.
//
// echo-device-client-module calls echo-device-module as the identity
// "aabbcc" (its baked-in appKey), so that is the grant this revokes. The
// outer caller keeps its own grant throughout: what must start failing is
// the inner hop, not the outer call's own authorization.
const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const { exec, execFileSync } = require('child_process');

const waitForReady = require('../helpers/wait-for-ready');

const ROOT    = path.join(__dirname, '..', '..');
const PORT    = 9601;
const url     = `http://127.0.0.1:${PORT}`;
const DB_PATH = `/tmp/countinghouse-test-auth-19-${process.pid}.sqlite3`;

const CALLER          = `caller-key-19-${process.pid}`;
const MODULE_IDENTITY = 'aabbcc';

const RECHECK_SECONDS = 1;

function authCli(args) {
  execFileSync(process.execPath,
    [path.join(ROOT, 'bin', 'countinghouse-auth-sqlite.js'), '--dbPath', DB_PATH].concat(args),
    {cwd: ROOT, stdio: 'pipe'});
}

function callThroughTheHop(cb) {
  request(url).post('/mcp').set('Content-Type', 'application/json').set('X-CH-Key', CALLER)
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
           params: {name: 'echo_device_client_x_api', arguments: {}}})
    .end((err, res) => {
      if (err) return cb(err);
      const result = res.body.result;
      return cb(null, {ok: (result != null && result.isError !== true), body: res.body});
    });
}

// Calls until the hop's outcome is `wantOk`, or fails with the last body seen.
function untilHopIs(wantOk, deadlineMs, cb) {
  const deadline = Date.now() + deadlineMs;
  (function attempt() {
    callThroughTheHop((err, outcome) => {
      if (err) return cb(err);
      if (outcome.ok === wantOk) return cb(null, outcome);
      if (Date.now() > deadline) {
        return cb(new Error(`the hop was still ${outcome.ok ? 'succeeding' : 'failing'} after ${deadlineMs} ms: ${
          JSON.stringify(outcome.body)}`));
      }
      return setTimeout(attempt, 300);
    });
  })();
}

describe('auth 19: revoking a module identity closes its open peer channel', function() {
  this.timeout(0);

  before((done) => {
    authCli(['add-user', CALLER, 'caller']);
    authCli(['grant', CALLER, '*']);
    authCli(['add-user', MODULE_IDENTITY, 'echo-device-client-module']);
    authCli(['grant', MODULE_IDENTITY, '*']);

    waitForReady(exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
         } --authProvider sqlite --authConfigPath ${DB_PATH
         } --peerChannelAuthRecheckSeconds ${RECHECK_SECONDS
         } --loadModule ./pre-installed-packages/echo-device-module` +
         ' --loadModule ./pre-installed-packages/echo-device-client-module',
         {cwd: ROOT}, () => {}), done);
  });

  after((done) => {
    exec(`pkill -f "[f]ramework.js.*${DB_PATH}"`, () => {
      try { fs.unlinkSync(DB_PATH); } catch (e) { /* already gone */ }
      done();
    });
  });

  it('the hop works while the module identity is granted (this opens the channel)', (done) => {
    callThroughTheHop((err, outcome) => {
      assert.ifError(err);
      assert.strictEqual(outcome.ok, true, `expected the hop to succeed: ${JSON.stringify(outcome.body)}`);
      done();
    });
  });

  it('is refused within a few re-check intervals of the grant being revoked', (done) => {
    authCli(['revoke', MODULE_IDENTITY, '*']);
    untilHopIs(false, 8000, (err) => { done(err); });
  });

  it('stays refused: the channel is not quietly re-opened', (done) => {
    setTimeout(() => {
      callThroughTheHop((err, outcome) => {
        assert.ifError(err);
        assert.strictEqual(outcome.ok, false, `expected the hop to stay refused: ${JSON.stringify(outcome.body)}`);
        done();
      });
    }, RECHECK_SECONDS * 2000);
  });

  it('works again once the grant is restored', (done) => {
    authCli(['grant', MODULE_IDENTITY, '*']);
    untilHopIs(true, 8000, (err) => { done(err); });
  });
});

describe('auth 19b: --peerChannelAuthRecheckSeconds', () => {
  const options = require('../../lib/cli-options');

  // every other file in this mocha process expects the bare defaults
  after(() => { options.setOptions({}); });

  function parsed(argv) {
    options.setOptions(argv);
    return options.peerChannelAuthRecheckSeconds;
  }

  it('defaults to 5', () => { assert.strictEqual(parsed({}), 5); });
  it('takes a number of seconds', () => { assert.strictEqual(parsed({peerChannelAuthRecheckSeconds: 30}), 30); });
  it('0 turns the re-check off', () => { assert.strictEqual(parsed({peerChannelAuthRecheckSeconds: 0}), 0); });
  it('falls back to 5 on a negative or non-numeric value', () => {
    assert.strictEqual(parsed({peerChannelAuthRecheckSeconds: -1}), 5);
    assert.strictEqual(parsed({peerChannelAuthRecheckSeconds: 'soon'}), 5);
  });
  it('reaches a worker unchanged', () => {
    options.setOptions({peerChannelAuthRecheckSeconds: 0});
    assert.strictEqual(options.getOptions().peerChannelAuthRecheckSeconds, 0);
  });
});
