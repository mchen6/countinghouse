'use strict';
// A call's own cap and timeout (lib/call-limits.js; the shared runtime's
// design, #223 section 3): every read of maxOutputBytes and requestTimeout
// that bounds one call reads the call's own value, from its session, its
// token entry (a hop, a peer invoke) or the invoke message (its worker), and
// today defaults to the options. So a session override only has to set a
// call's values. Each site below is shown holding a call to its own value,
// tighter than the global one.
//
// Port 9792, in B's block (test/ports.md).
const assert = require('assert');
const path = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {testPort} = require('../helpers/test-env');
const {deviceIDForName} = require('../../lib/call-address');

describe('sandbox 54: lib/call-limits.js and its holders, server-free', () => {
  const options = require('../../lib/cli-options');
  const callLimits = require('../../lib/call-limits');
  const callTokens = require('../../lib/call-tokens');
  let saved;
  beforeEach(() => { saved = {maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout}; callLimits.resetForTests(); });
  afterEach(() => Object.assign(options, saved));

  it('a holder with no values takes the options as they are when the call starts; a malformed one is none', () => {
    options.maxOutputBytes = 1234;
    options.requestTimeout = 5678;
    assert.deepStrictEqual(callLimits.of(null), {maxOutputBytes: 1234, requestTimeout: 5678});
    assert.deepStrictEqual(callLimits.of({limits: {maxOutputBytes: 10, requestTimeout: 20}}), {maxOutputBytes: 10, requestTimeout: 20});
    for (const bad of [{maxOutputBytes: 0, requestTimeout: 20}, {maxOutputBytes: 10}, {maxOutputBytes: '10', requestTimeout: 20}, 'x']) {
      assert.strictEqual(callLimits.check(bad), null, JSON.stringify(bad));
    }
    assert.ok(Object.isFrozen(callLimits.of(null)));
  });

  it('a session starts with no override: the global values, read at each check, so a live tightening reaches it; its timer takes its own timeout', () => {
    const Session = require('../../lib/session');
    const s = new Session(null, null, 'u', 'k', 0, 'd', 0, () => {});
    assert.strictEqual(s.limits, null);
    options.maxOutputBytes = 9000;
    assert.strictEqual(callLimits.of(s).maxOutputBytes, 9000);
    options.maxOutputBytes = 4000;   // a tightening while the call runs
    assert.strictEqual(callLimits.of(s).maxOutputBytes, 4000);
    callLimits.override(s, {maxOutputBytes: 1, requestTimeout: 30});
    const started = Date.now();
    return new Promise((resolve) => {
      s.callback = () => { assert.ok(Date.now() - started < 1000, 'expired at its own 30 ms'); resolve(); };
      s.installTimer(() => {});
    });
  });

  it('a token carries its call\'s override; a hop\'s is never looser than its parent\'s, field by field; none is null', () => {
    const parent = callTokens.issue({billingKey: 'k', workerId: 1, limits: {maxOutputBytes: 100, requestTimeout: 200}});
    const child = callTokens.issue({billingKey: 'k', workerId: 2, parent});
    assert.deepStrictEqual(callTokens.resolve(child, {workerId: 2}).limits, {maxOutputBytes: 100, requestTimeout: 200});
    const own = callTokens.issue({billingKey: 'k', workerId: 4, parent, limits: {maxOutputBytes: 500, requestTimeout: 50}});
    assert.deepStrictEqual(callTokens.resolve(own, {workerId: 4}).limits, {maxOutputBytes: 100, requestTimeout: 50}, 'the tighter of each');
    const plain = callTokens.issue({billingKey: 'k', workerId: 3});
    assert.strictEqual(callTokens.resolve(plain, {workerId: 3}).limits, null);
    assert.deepStrictEqual(callLimits.of(callTokens.resolve(plain, {workerId: 3})), callLimits.defaults());
    for (const t of [parent, child, own, plain]) callTokens.drop(t);
  });

  it('a malformed override is refused where it is set; one present on a holder anyway fails closed', () => {
    for (const bad of [{maxOutputBytes: 0, requestTimeout: 20}, {maxOutputBytes: 10}, {maxOutputBytes: '10', requestTimeout: 20}, 'x']) {
      assert.throws(() => callLimits.override({}, bad), /an override is/, JSON.stringify(bad));
    }
    assert.throws(() => callLimits.of({limits: {maxOutputBytes: -1, requestTimeout: 5}}), /malformed/);
  });

  it('the call\'s timer is clamped as setTimeout needs (past 2^31-1 ms it would fire at once)', () => {
    const Timer = require('../../lib/timer');
    const t = new Timer(2 ** 40);
    assert.strictEqual(t.timeout._idleTimeout, 2147483647);
    clearTimeout(t.timeout);
  });

  it('a handler\'s wait for its composition verdict is bounded by its call\'s own timeout (by its token)', () => {
    const {verdictWaitMs} = require('../../lib/handler-ctx');
    callLimits.remember('tk', {maxOutputBytes: 5, requestTimeout: 3000});
    assert.strictEqual(verdictWaitMs('tk'), 1000, 'its 3 s, less the 2 s margin');
    options.requestTimeout = 30000;
    assert.strictEqual(verdictWaitMs('other'), 25000, 'a call with none: the global, at most 25 s');
    callLimits.forget('tk');
  });

  it('a worker holds each call\'s values by its token while it runs, bounded', () => {
    callLimits.remember('t1', {maxOutputBytes: 5, requestTimeout: 6});
    assert.deepStrictEqual(callLimits.forToken('t1'), {maxOutputBytes: 5, requestTimeout: 6});
    callLimits.forget('t1');
    assert.deepStrictEqual(callLimits.forToken('t1'), callLimits.defaults());
    for (let i = 0; i < 10005; i++) callLimits.remember(`t${i}`, {maxOutputBytes: 5, requestTimeout: 6});
    assert.deepStrictEqual(callLimits.forToken('t0'), callLimits.defaults(), 'the oldest dropped past the bound');
    assert.deepStrictEqual(callLimits.forToken('t10004'), {maxOutputBytes: 5, requestTimeout: 6});
  });
});

const PORT = testPort(9792);
const KEY = 'hop-input-key';
const AUTH = require('../helpers/private-auth').privateAuth(path.join(__dirname, '48-auth.json'));
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'hop-input-caller');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'call-limits-preload.js');
const GLOBAL_CAP = 4 * 1024 * 1024;
// the client's own call's values, by its action: tighter than the global ones
const CALL_LIMITS = {
  call: {maxOutputBytes: 3000},           // a hop's output, held to its caller's cap
  send: {maxOutputBytes: 3000},           // a hop's input, the same
  big: {maxOutputBytes: 3000},            // a call's own output
  forge: {maxOutputBytes: 3000},          // a worker that makes its own copy huge
  slow: {requestTimeout: 1500},           // a call's own timer
  runs: {requestTimeout: 1500}            // (unused by the hops below)
};

const invoke = (module, service, actionName, input) => post(PORT, KEY, `/devices/${deviceIDForName(module)}/invoke-action`,
  {serviceID: `urn:countinghouse-test:serviceID:${service}`, actionName, input});
const callerDo = (actionName, input) => invoke('hop-input-caller', 'sendService', actionName, input);

['routed', 'peer'].forEach((path_) => {
  describe(`sandbox 54: a call held to its own cap and timeout, over a ${path_} hop`, function() {
    this.timeout(180000);
    let server = null;
    before(async () => {
      server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
        ...(path_ === 'peer' ? ['--directPeerChannels'] : []), '--moduleSandbox', 'audit', '--maxOutputBytes', String(GLOBAL_CAP), '--requestTimeout', '60'],
      {env: {NODE_OPTIONS: `--require ${PRELOAD}`, CH_TEST_CALL_LIMITS: JSON.stringify(CALL_LIMITS)}});
    });
    after(() => stopServer(server));
    const why = (r) => `${JSON.stringify(r.body).slice(0, 500)}\n${server.output.slice(-1500)}`;

    it('a hop\'s output is held to the CALLER\'s cap (its token entry\'s), not the global one', async () => {
      const r = await callerDo('call', {action: 'big', args: {n: 5000}});
      assert.strictEqual(r.body.output.code, 'OUTPUT_TOO_LARGE', why(r));
      assert.match(r.body.output.message, /over the 3000-byte limit/, why(r));
      // one under it crosses
      assert.strictEqual((await callerDo('call', {action: 'big', args: {n: 1000}})).body.output.code, undefined);
    });

    it('a hop\'s input is held to the caller\'s cap', async () => {
      const r = await callerDo('send', {n: 5000});
      assert.strictEqual(r.body.output.code, 'INPUT_TOO_LARGE', why(r));
      assert.match(r.body.output.message, /over the 3000-byte limit/, why(r));
    });

    it('a client\'s call of its own output is held to its own cap', async () => {
      const r = await invoke('hop-input-callee', 'sinkService', 'big', {n: 5000});
      assert.strictEqual(r.body.code, 'OUTPUT_TOO_LARGE', why(r));
      assert.match(String(r.body.message), /over the 3000-byte limit/, why(r));
    });

    it('a worker that makes its copy of the limits huge is still held to the call\'s cap: the main thread\'s is its own', async () => {
      // the first call forges the worker's copy; the next ones run with it
      for (let i = 0; i < 2; i++) {
        const r = await invoke('hop-input-callee', 'sinkService', 'forge', {n: 5000});
        assert.strictEqual(r.body.code, 'OUTPUT_TOO_LARGE', why(r));
        assert.match(String(r.body.message), /over the 3000-byte limit/, why(r));
      }
      // and over a hop: the caller's cap, from its token entry
      const h = await callerDo('call', {action: 'forge', args: {n: 5000}});
      assert.strictEqual((h.body.output || {}).code, 'OUTPUT_TOO_LARGE', why(h));
    });

    it('a call is held to its own timeout: answered not responding at its 1.5 s, not the global 60 s', async () => {
      const started = Date.now();
      const r = await invoke('hop-input-callee', 'sinkService', 'slow', {ms: 8000});
      const took = Date.now() - started;
      assert.strictEqual(r.body.code, 'DEVICE_NOT_RESPONDING', why(r));
      assert.ok(took < 6000, `${took} ms`);
    });
  });
});
