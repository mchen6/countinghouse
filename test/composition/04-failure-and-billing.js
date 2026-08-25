// Task 6: what actually happens when a composed ctx.call chain fails, and
// what the caller is billed for it -- an investigation, not a transcription.
// See .superpowers/sdd/2026-08-24-module-composition-api/task-6-brief.md
// and its two CONTROLLER AMENDMENTs for the reasoning this file follows.
//
// Reuses test/fixtures/compose-caller (viaCall, viaBoom) and
// test/fixtures/compose-callee (double, boom) from Task 4.
//
// One fixture was touched for observability, not behavior:
// test/fixtures/compose-caller/handlers/callerService/viaBoom.js now
// catches ctx.call's rejection, prints its `.fault`/`.code`/constructor
// name to stdout with a greppable prefix, and rethrows the *same* error
// unchanged (see that file's own comment for the two things that were
// tried and did NOT work: console.log outside --debug is silently
// dropped by lib/countinghouse-util.js's loadFile, "drop console under
// release mode"; smuggling the observation through a rethrown error's own
// `.message` does not survive either, because lib/device-manager.js's own
// cross-worker reply relays rebuild `new DeviceError(err.code)` whenever
// a `.code` is present, discarding any extra message detail). Because of
// the first of those, the servers in this file run with --debug --
// otherwise this handler's console.log would never reach `server.stdout`.
//
// --debug replaces AuthProvider's normal two-identity split (an outer
// caller's own key vs. a composing module's own internal identity, bound
// via fixtures-auth.json's "runsModules") with a single shared debugKey
// that every appKey in the whole call chain must equal exactly
// (lib/user-auth.js's doUserAuth quick path). That still exercises real
// production code end to end (Service/doActionCall, ctx.call,
// device-manager.js's two cross-worker paths, MeteringProvider) -- --debug
// only changes which collaborator answers "is this appKey allowed", not
// how a call is dispatched, routed, or billed. fixtures-auth.json's
// "compose-caller-internal" -> runsModules: ["compose-caller"] binding
// still resolves ctx.call's identity the normal way (identityForModule
// reads --authConfigPath regardless of --debug), so debugKey is set to
// that same string and used as the one key throughout: as the MCP
// caller's X-CH-Key, and so implicitly as ctx.caller.apiKey, which is who
// every hop and the outer call are billed to
// (lib/handler-ctx.js's ctx.serviceClient).
const assert  = require('assert');
const path    = require('path');
const request = require('supertest');
const spawn   = require('child_process').spawn;

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const ROOT     = path.join(__dirname, '..', '..');

// Port for this task per the dispatch: 9558 only, plus a second port this
// file picks for the second (--directPeerChannels) server -- 9559, checked
// against every port literal under test/ at the time this file was written
// (grep turned up 9527, 9530-9531, 9541-9546, 9550-9557, 9574-9575, 9584,
// 9586, 9590-9591, 9593, 9595; 9559 is in none of those, nor in the task's
// own "taken elsewhere" list).
const PORT_FLAG_OFF = 9558;
const PORT_FLAG_ON  = 9559;

// Under --debug, every appKey in the call chain must equal this exactly
// (see header comment) -- also the identity fixtures-auth.json's
// "runsModules" binds to compose-caller, so it doubles as both the outer
// MCP caller's X-CH-Key and (via ctx.caller.apiKey) the billing identity.
const CALLER_KEY = 'compose-caller-internal';

// Constants from test/direct-peer-channels/06-no-double-billing.js, reused
// rather than invented (CONTROLLER AMENDMENT 2).
const SETTLE_POLL_MS    = 200;
const SETTLE_STABLE     = 3;
const SETTLE_TIMEOUT_MS = 15000;

function getBalance(base, cb) {
  request(base).get('/balance')
    .set('X-CH-Key', CALLER_KEY)
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body.balance);
    });
}

// Copied from test/direct-peer-channels/06-no-double-billing.js's
// settledBalance -- used ONLY for assertion 3 below (a real charge is
// expected). See CONTROLLER AMENDMENT 1 in the task brief for why this
// must not be reused for a "nothing was billed" assertion: it only returns
// once the balance has moved off `mustDifferFrom` and then gone quiet, so
// a call that is never going to move the balance either hangs to this
// function's own timeout (mustDifferFrom = the pre-call balance) or
// returns almost immediately, often before a late fire-and-forget charge
// would have landed (mustDifferFrom = null) -- a false pass for exactly
// the bug this task exists to catch.
function settledBalance(base, mustDifferFrom, cb) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last    = null;
  let stable  = 0;
  let changed = (mustDifferFrom === null);

  (function poll() {
    getBalance(base, (err, balance) => {
      if (err) return cb(err);
      if (typeof balance !== 'number') {
        return cb(new Error(`settledBalance: /balance did not return a numeric balance, got ${JSON.stringify(balance)}`));
      }

      if (balance !== mustDifferFrom) changed = true;
      stable = (last !== null && balance === last) ? stable + 1 : 1;
      last   = balance;

      if (changed && stable >= SETTLE_STABLE) return cb(null, balance);
      if (Date.now() >= deadline) {
        return cb(new Error(`settledBalance: balance did not ${
                            changed ? 'settle' : `move from ${mustDifferFrom}`
                            } within ${SETTLE_TIMEOUT_MS}ms (last read ${balance})`));
      }
      setTimeout(poll, SETTLE_POLL_MS);
    });
  })();
}

// For the two "not billed" assertions (CONTROLLER AMENDMENT 1): read the
// balance, wait a FIXED window (not poll-until-stable, not
// poll-until-expected) at least as long as SETTLE_TIMEOUT_MS above -- the
// same order of magnitude this suite already trusts to be enough for a
// fire-and-forget charge to land -- then read again and hand both numbers
// to the caller to compare. A surplus charge landing at any point in that
// window is caught; stopping early the moment three reads agree (what
// settledBalance does) would not catch one that lands just after.
function balanceBefore(base, cb) { getBalance(base, cb); }

function balanceAfterFixedWait(base, cb) {
  setTimeout(() => getBalance(base, cb), SETTLE_TIMEOUT_MS);
}

function callTool(base, name, args, cb) {
  request(base)
    .post('/mcp')
    .set('X-CH-Key', CALLER_KEY)
    .set('Accept', 'application/json, text/event-stream')
    .send({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: name, arguments: args}})
    .end((err, res) => {
      if (err) return cb(err);
      return cb(null, res.body);
    });
}

// Scrapes every 'CTX_CALL_FAULT {...}' line the compose-caller worker has
// printed so far (see viaBoom.js's own comment) out of an accumulated
// stdout buffer and returns the LAST one parsed -- the most recent call's,
// since the buffer is shared across the whole describe block's lifetime
// rather than reset per test.
function lastCtxCallFault(stdoutBuf) {
  const lines = stdoutBuf.split('\n').filter((l) => l.indexOf('CTX_CALL_FAULT ') !== -1);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const jsonStart = last.indexOf('CTX_CALL_FAULT ') + 'CTX_CALL_FAULT '.length;
  try {
    return JSON.parse(last.slice(jsonStart));
  } catch (e) {
    return null;
  }
}

function startServer(port, extraArgs, onLine, done) {
  const args = [
    path.join(ROOT, 'framework.js'),
    '--workerThread', '--bindAddr', '127.0.0.1', '--port', String(port),
    '--mcpToolCallCost', '1',
    '--debug', '--debugKey', CALLER_KEY, // see header comment: needed so viaBoom.js's console.log survives loadFile's console-stripping
    '--authConfigPath', path.join(__dirname, 'fixtures-auth.json'),
    '--loadModule', path.join(FIXTURES, 'compose-callee'),
    '--loadModule', path.join(FIXTURES, 'compose-caller')
  ].concat(extraArgs);

  const server = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']});

  let out = '';
  let startupSeen = false;
  const onData = (buf) => {
    const chunk = buf.toString();
    out += chunk;
    if (onLine != null) onLine(chunk);
    if (!startupSeen && /all module discovered/i.test(out)) {
      startupSeen = true;
      setTimeout(done, 2500); // same margin 02-ctx-call.js gives verifyComposition's post-discovery work
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);

  return server;
}

// Run the same battery of assertions against a running server -- called
// once per flag state below. `base` is the server's URL.
function runFailureAndBillingAssertions(getBase, getStdoutBuf) {
  it('viaBoom returns an MCP error to the caller, not a hang (bounded 20s)', function(done) {
    this.timeout(20000); // a hang must fail loudly here, not pass slowly at mocha's default
    callTool(getBase(), 'compose_caller_callerservice_viaboom', {}, (err, body) => {
      assert.ifError(err);
      assert.strictEqual(body.result.isError, true, `expected an MCP error, got ${JSON.stringify(body)}`);
      console.log(`    [observed] viaBoom structuredContent: ${JSON.stringify(body.result.structuredContent)}, text: ${JSON.stringify(body.result.content)}`);
      assert.strictEqual(body.result.structuredContent && body.result.structuredContent.code, 'DEVICE_INVOKE_EXCEPTION',
        `expected structuredContent.code, got ${JSON.stringify(body)}`);

      // Give the worker's console.log a moment to cross the thread
      // boundary and land in the piped stdout buffer before reading it.
      setTimeout(() => {
        const observed = lastCtxCallFault(getStdoutBuf());
        console.log(`    [observed] viaBoom's ctx.call .fault on this flag state: ${JSON.stringify(observed)}`);

        // Assertion written AFTER observing (see report). ctx.call must
        // not invent fault content (lib/handler-ctx.js's own comment) --
        // assert null if that's what was observed, otherwise assert the
        // real value.
        assert.ok(observed != null, 'expected a CTX_CALL_FAULT log line from viaBoom.js');
        if (observed.fault == null) {
          assert.strictEqual(observed.fault, null);
        } else {
          assert.strictEqual(observed.fault.message, 'boom from the callee',
            `expected the callee's own error message in .fault, got ${JSON.stringify(observed.fault)}`);
        }
        done();
      }, 500);
    });
  });

  it('the failed hop and the failed outer call are both billed nothing (fixed-window check, not settle-until-stable)', function(done) {
    this.timeout(SETTLE_TIMEOUT_MS + 10000);
    balanceBefore(getBase(), (err, before) => {
      assert.ifError(err);
      callTool(getBase(), 'compose_caller_callerservice_viaboom', {}, (err, body) => {
        assert.ifError(err);
        assert.strictEqual(body.result.isError, true, `expected an MCP error, got ${JSON.stringify(body)}`);
        balanceAfterFixedWait(getBase(), (err, after) => {
          assert.ifError(err);
          console.log(`    [observed] balance before=${before} after=${after} (waited ${SETTLE_TIMEOUT_MS}ms)`);
          assert.strictEqual(after, before,
            `expected no charge for a failed hop or a failed outer call, but balance moved from ${before} to ${after}`);
          done();
        });
      });
    });
  });

  it('a successful viaCall bills exactly 2 (1 outer MCP call + 1 inner hop, both at --mcpToolCallCost 1)', function(done) {
    this.timeout(SETTLE_TIMEOUT_MS + 10000);
    settledBalance(getBase(), null, (err, before) => {
      assert.ifError(err);
      callTool(getBase(), 'compose_caller_callerservice_viacall', {n: 21}, (err, body) => {
        assert.ifError(err);
        assert.strictEqual(body.result.isError, false, `expected success, got ${JSON.stringify(body)}`);
        assert.strictEqual(body.result.structuredContent.output.n, 42, JSON.stringify(body));
        settledBalance(getBase(), before, (err, after) => {
          assert.ifError(err);
          const delta = before - after;
          console.log(`    [observed] viaCall billing delta: before=${before} after=${after} delta=${delta}`);
          // Observed and cross-checked against docs/composite-tools.md's
          // "billing authority" principle: the outer MCP tools/call is
          // billed once (lib/mcp/gateway.js, on success only) and the one
          // inner hop is billed once more (lib/device-manager.js's
          // sendInvokeActionMessageToWorker / lib/peer-channel-broker.js's
          // handleMeteringRequest, depending on flag state) -- both at
          // options.mcpToolCallCost (1), both charged to ctx.caller.apiKey.
          assert.strictEqual(delta, 2, `expected 1 outer + 1 hop = 2, got ${delta}`);
          done();
        });
      });
    });
  });
}

describe('composition 04: failure and billing (--directPeerChannels off)', function() {
  this.timeout(40000);
  let server = null;
  let stdoutBuf = '';
  const base = `http://127.0.0.1:${PORT_FLAG_OFF}`;

  before((done) => {
    server = startServer(PORT_FLAG_OFF, [], (chunk) => { stdoutBuf += chunk; }, done);
  });
  after(() => { if (server != null) server.kill('SIGKILL'); });

  runFailureAndBillingAssertions(() => base, () => stdoutBuf);
});

describe('composition 04b: failure and billing (--directPeerChannels on)', function() {
  this.timeout(40000);
  let server = null;
  let stdoutBuf = '';
  const base = `http://127.0.0.1:${PORT_FLAG_ON}`;

  before((done) => {
    server = startServer(PORT_FLAG_ON, ['--directPeerChannels'], (chunk) => { stdoutBuf += chunk; }, done);
  });
  after(() => { if (server != null) server.kill('SIGKILL'); });

  runFailureAndBillingAssertions(() => base, () => stdoutBuf);
});
