// Step B-3, second half: an inner hop is AUTHORIZED as the composing module
// and BILLED to the real outer caller.
//
// docs/composite-tools.md listed this as a known simplification: every inner
// ServiceClient used a fixed internal identity, so all composite billing
// landed on one key no matter who called. It also warned that wiring the ctx
// path carelessly has a sharp edge, and asked for a decision first. Decided:
// split the two identities, and refuse a hop whose billing identity cannot be
// resolved rather than metering it for free.
//
// Non---debug and multi-tenant on purpose: under --debug every key resolves to
// an admin session, so neither half of the split would be observable.
//
// The decisive assertion is the negative one. It is easy to write a test that
// merely shows the call works; what matters is *whose balance moved*. So the
// internal identity is given a balance too, and asserted not to have paid.
const assert  = require('assert');
const fs      = require('fs');
const exec    = require('child_process').exec;
const request = require('supertest');

const PORT      = 9593;
const url       = `http://127.0.0.1:${PORT}`;
const AUTH_PATH = `/tmp/countinghouse-test-auth-13-${process.pid}.json`;

const CALLER       = `caller-13-${process.pid}`;
const AS_IDENTITY  = 'ctx-compose-internal';   // must match the fixture's `as`
const ECHO_DEVICE  = 'c5284c70-ae5f-591c-b2f1-cf0b4ebd0767';

// The caller is granted the composing device ONLY -- deliberately not echo.
// If authorization used the caller's identity, the inner hop would fail; if it
// uses the module's, it succeeds. That is the encapsulation half of the split.
function writeAuth() {
  const config = {};
  config[CALLER]      = {userName: 'caller', devices: ['*']};
  config[AS_IDENTITY] = {userName: AS_IDENTITY, devices: [ECHO_DEVICE]};
  fs.writeFileSync(AUTH_PATH, JSON.stringify(config));
}

function startServer(done) {
  writeAuth();
  exec(`"./bin/countinghouse" --workerThread --bindAddr 127.0.0.1 --port ${PORT
       } --authProvider file --authConfigPath ${AUTH_PATH} --mcpToolCallCost 1` +
       ` --loadModule ./pre-installed-packages/echo-device-module` +
       ` --loadModule ./test/fixtures/ctx-compose-module`,
       (err) => { console.log(err); });
  setTimeout(done, 14000);
}

function balanceOf(key, cb) {
  request(url).get('/balance').set('X-CH-Key', key).end((err, res) => {
    if (err) return cb(err);
    return cb(null, (res.body != null) ? res.body.balance : null);
  });
}

// Balance debits are asynchronous (see test/direct-peer-channels/
// 06-no-double-billing.js): wait for the value to stop moving, never for a
// specific number, so an extra charge cannot hide behind an early match.
function settledBalance(key, cb) {
  const deadline = Date.now() + 15000;
  let last = null, stable = 0;

  (function poll() {
    balanceOf(key, (err, balance) => {
      if (err) return cb(err);
      stable = (last !== null && balance === last) ? stable + 1 : 1;
      last   = balance;
      if (stable >= 3) return cb(null, balance);
      if (Date.now() >= deadline) return cb(new Error(`balance for ${key} never settled (last ${balance})`));
      setTimeout(poll, 200);
    });
  })();
}

function callCompose(cb) {
  request(url).post('/mcp')
  .set('Content-Type', 'application/json').set('X-CH-Key', CALLER)
  .send({jsonrpc: '2.0', id: 1, method: 'tools/call',
         params: {name: 'ctx_compose_module_composeservice_compose', arguments: {text: 'hi'}}})
  .end((err, res) => {
    if (err) return cb(err);
    return cb(null, res.body != null ? res.body.result : null);
  });
}

describe('auth 13: inner hops are authorized as the module, billed to the caller', function() {
  this.timeout(0);

  before(function(done) {
    this.timeout(0);
    console.log('starting countinghouse without --debug for the ctx billing split...');
    startServer(done);
  });

  after((done) => {
    exec(`pkill -f "[f]ramework.js.*${AUTH_PATH}"`, () => {
      try { fs.unlinkSync(AUTH_PATH); } catch (e) { /* already gone */ }
      setTimeout(done, 2000);
    });
  });

  it('the hop succeeds even though the caller has no grant to the inner device', (done) => {
    callCompose((err, result) => {
      if (err) return done(err);
      assert.ok(result != null, 'no result at all');
      assert.strictEqual(result.isError, false,
        `authorization must use the module identity, not the caller: ${JSON.stringify(result)}`);
      assert.strictEqual(result.structuredContent.output.echoed, 'hi');
      assert.strictEqual(result.structuredContent.output.billedTo, CALLER,
        'ctx.caller must be the real outer caller');
      return done();
    });
  });

  it('the caller pays for the hop, and the module identity does not', (done) => {
    settledBalance(CALLER, (err, callerBefore) => {
      if (err) return done(err);
      settledBalance(AS_IDENTITY, (err2, internalBefore) => {
        if (err2) return done(err2);

        callCompose((err3, result) => {
          if (err3) return done(err3);
          assert.strictEqual(result.isError, false, JSON.stringify(result));

          settledBalance(CALLER, (err4, callerAfter) => {
            if (err4) return done(err4);
            settledBalance(AS_IDENTITY, (err5, internalAfter) => {
              if (err5) return done(err5);

              const callerPaid   = callerBefore - callerAfter;
              const internalPaid = internalBefore - internalAfter;

              // outer invoke charge + one inner hop
              assert.ok(callerPaid >= 2,
                `caller should pay the outer call and the inner hop, paid ${callerPaid}`);

              // the point of the split: the fixed internal identity stops
              // absorbing what other people's calls cost
              assert.strictEqual(internalPaid, 0,
                `the module identity must not be billed, but paid ${internalPaid}`);
              return done();
            });
          });
        });
      });
    });
  });
});
