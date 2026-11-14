// A module's input and output are checked in a validator worker, in code the
// module cannot reach, off the main thread (lean worker, step 1(b):
// docs/superpowers/specs/2026-11-13-lean-worker-design.md section 4, as
// revised on #152). A value its validation takes seconds over is refused
// at the deadline (--validationTimeoutMs 300 here) while the server answers. The fixture
// (test/fixtures/main-checked) turns off its own worker's validation on
// request: under the default module sandbox (audit) and with none, the
// runtime's Service and validator are in its worker's require.cache, and its
// tamper action replaces both with ones that accept anything. Even so:
// - a bad input never reaches the worker (take counts its runs);
// - a bad output is refused;
// - over a hop routed through the main thread too (main-checked-caller);
// - each answer is the one single-thread mode gives, where the module's own
//   validation is not touched: the same status, code, text and fault (but
//   for worker mode's own rule, unchanged: an error that crossed back from a
//   worker is answered with its code's catalogue text, so a name in the
//   message, such as the unknown action's, is not repeated);
// - the order of the checks is kept: an unknown service or action is
//   answered as such, whatever the input.
// A direct peer channel still validates in the called worker (until step 4
// moves that check out of the module's reach too), shown before the tamper.
const assert = require('assert');
const path   = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');

const PORT    = 9749;
const KEY     = 'main-checked-key';
const OTHER_KEY = 'main-checked-other-key';
const AUTH    = path.join(__dirname, '41-auth.json');
const CALLEE  = path.join(ROOT, 'test', 'fixtures', 'main-checked');
const CALLER  = path.join(ROOT, 'test', 'fixtures', 'main-checked-caller');
const SERVICE = 'urn:countinghouse-test:serviceID:checkService';

const invoke = (actionName, input, serviceID) => post(PORT, KEY, `/devices/${deviceIDForName('main-checked')}/invoke-action`,
  {serviceID: serviceID || SERVICE, actionName: actionName, input: input});
const hop = (action, args) => post(PORT, KEY, `/devices/${deviceIDForName('main-checked-caller')}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:callerService', actionName: 'hop', input: {action: action, args: args}});
const count = async () => (await invoke('count', {})).body.output;
const tamper = async () => (await invoke('tamper', {})).body.output;

// The calls whose answers are compared with single-thread mode's.
const REFUSALS = {
  badInput:       () => invoke('take', {n: 'not an integer'}),
  extraInputKey:  () => invoke('take', {n: 1, more: true}),
  badOutputType:  () => invoke('give', {kind: 'badType'}),
  extraOutputKey: () => invoke('give', {kind: 'extraKey'}),
  noOutput:       () => invoke('give', {kind: 'noOutput'}),
  unknownAction:  () => invoke('nowhere', {n: 'not an integer'}),
  unknownService: () => invoke('take', {n: 'not an integer'}, 'urn:countinghouse-test:serviceID:nowhere')
};
const CODES = {
  badInput: 'INPUT_DATA_VALIDATION_FAIL', extraInputKey: 'INPUT_DATA_VALIDATION_FAIL',
  badOutputType: 'OUTPUT_DATA_VALIDATION_FAIL', extraOutputKey: 'OUTPUT_DATA_VALIDATION_FAIL',
  noOutput: 'OUTPUT_DATA_VALIDATION_FAIL', unknownAction: 'ACTION_NOT_FOUND', unknownService: 'SERVICE_NOT_FOUND'
};

// Single-thread mode's answer as worker mode gives it: an error that crosses
// back from a worker is remade from its code (CountinghouseError.fromReply),
// so its message is the catalogue's text, without the name that single-thread
// mode adds. A refusal the main thread makes goes through the same decoding.
function asWorkerMode(answer) {
  const {CountinghouseError} = require('../../lib/countinghouse-error');
  return {status: answer.status, body: Object.assign({}, answer.body, {message: new CountinghouseError(answer.body.code).message})};
}

const SERVER_ARGS = ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER];
// The default sandbox, and none.
const MAIN_ROUTED = [{label: 'the default sandbox', args: []}, {label: 'no module sandbox', args: ['--moduleSandbox', 'off']}];

describe('sandbox 41: a module\'s input and output are checked on the main thread', function() {
  this.timeout(120000);
  const singleThread = {};

  describe('single-thread mode (the answers to compare with)', () => {
    let server = null;
    before(async () => { server = await startServer(PORT, SERVER_ARGS.concat(['--no-workerThread'])); });
    after(() => stopServer(server));

    it('refuses each call, with its code', async () => {
      for (const name of Object.keys(REFUSALS)) {
        const r = await REFUSALS[name]();
        assert.strictEqual(r.body.code, CODES[name], `${name}: ${JSON.stringify(r.body)}`);
        singleThread[name] = r;
      }
      assert.deepStrictEqual(await count(), {takes: 0, tampered: false});
      assert.deepStrictEqual(await tamper(), {tampered: false}, 'single-thread mode: the fixture leaves the main thread alone');
    });
  });

  MAIN_ROUTED.forEach((mode) => describe(`worker mode, ${mode.label}, hops through the main thread`, () => {
    let server = null;
    before(async () => {
      server = await startServer(PORT, SERVER_ARGS.concat(['--workerThread', '--no-directPeerChannels', '--validationTimeoutMs', '300', '--maxOutputBytes', '100000'], mode.args));
    });
    after(() => stopServer(server));

    it('the module turns off its worker\'s own validation', async () => {
      assert.deepStrictEqual(await tamper(), {tampered: true});
      assert.deepStrictEqual(await count(), {takes: 0, tampered: true});
    });

    it('a bad input is refused, and never reaches the worker', async () => {
      const r = await REFUSALS.badInput();
      assert.strictEqual(r.body.code, 'INPUT_DATA_VALIDATION_FAIL', JSON.stringify(r.body));
      assert.deepStrictEqual(await count(), {takes: 0, tampered: true});
    });

    it('every refusal is single-thread mode\'s answer: status, code, text and fault', async () => {
      for (const name of Object.keys(REFUSALS)) {
        const r = await REFUSALS[name]();
        assert.deepStrictEqual({status: r.status, body: r.body}, asWorkerMode(singleThread[name]), name);
      }
      assert.deepStrictEqual(await count(), {takes: 0, tampered: true});
    });

    it('a service or action named like an Object.prototype member is not found, and nothing runs', async () => {
      for (const name of ['constructor', '__proto__', 'toString']) {
        const action = await invoke(name, {n: 'not an integer'});
        assert.deepStrictEqual([action.status, action.body.code], [500, 'ACTION_NOT_FOUND'], `action ${name}: ${JSON.stringify(action.body)}`);
        const service = await invoke('take', {n: 'not an integer'}, name);
        assert.deepStrictEqual([service.status, service.body.code], [500, 'SERVICE_NOT_FOUND'], `service ${name}: ${JSON.stringify(service.body)}`);
      }
      assert.deepStrictEqual(await count(), {takes: 0, tampered: true});
    });

    // another caller: one caller has one validation in flight across the pool
    // (the review of #165), so a flood's own key would wait behind it
    const ping = () => post(PORT, OTHER_KEY, `/devices/${deviceIDForName('main-checked-caller')}/invoke-action`,
      {serviceID: 'urn:countinghouse-test:serviceID:callerService', actionName: 'ping', input: {}});

    it('a value its validation takes seconds over is refused at the deadline, and another module answers meanwhile', async () => {
      const slow = invoke('slow', {s: `${'a'.repeat(40)}!`});
      await new Promise((r) => setTimeout(r, 50));
      const started = Date.now();
      const other = await ping();
      assert.strictEqual(other.status, 200, JSON.stringify(other.body));
      assert.ok(Date.now() - started < 250, `another module's call answered in ${Date.now() - started} ms`);
      const r = await slow;
      assert.ok(['VALIDATION_TIMEOUT', 'INPUT_DATA_VALIDATION_FAIL'].includes(r.body.code), JSON.stringify(r.body));
      // a validator still working on the slow input holds the caller's one
      // validation in flight (the review of #165) until it is replaced
      await new Promise((resolve) => setTimeout(resolve, 700));
      // an input's stall cools nothing down: the module is served at once
      assert.strictEqual((await invoke('slow', {s: 'abc'})).status, 200, 'a plain value is validated');
    });

    // (That a call timed out in the queue is never validated nor sent on is
    // shown server-free, by the pool's count of what it sent: module-loading 24.)
    it('during a flood of one module\'s slow inputs, another module answers at once, and the flood is refused at the deadline', async () => {
      const stalling = Array.from({length: 20000}, (_, i) => ({i}));
      const flood = Array.from({length: 4}, () => invoke('stall', {items: stalling}));
      await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const r = await ping();
        assert.strictEqual(r.status, 200, `${JSON.stringify(r.body)}\n${server.output.slice(-3000)}`);
        assert.ok(Date.now() - started < 250, `${Date.now() - started} ms`);
      }
      for (const r of await Promise.all(flood)) assert.strictEqual(r.body.code, 'VALIDATION_TIMEOUT', JSON.stringify(r.body));
      // the flood's last validators finish or are replaced before this key's
      // next calls (one validation in flight per caller)
      await new Promise((resolve) => setTimeout(resolve, 1500));
    });

    it('an output over --maxOutputBytes is refused in the module\'s worker, naming the module and the action', async () => {
      const r = await invoke('big', {n: 200000});
      assert.strictEqual(r.body.code, 'OUTPUT_TOO_LARGE', `${JSON.stringify(r.body)}\n${server.output.slice(-3000)}`);
      assert.match(r.body.message, /^main-checked\/big: its output is \d+ bytes, over the 100000-byte limit \(--maxOutputBytes\)/);
      assert.strictEqual((await invoke('big', {n: 1000})).status, 200);
    });

    it('a valid call runs, once', async () => {
      const r = await invoke('take', {n: 7});
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(await count(), {takes: 1, tampered: true});
      assert.strictEqual((await invoke('give', {kind: 'good'})).status, 200);
    });

    it('over a hop: a bad input never reaches the called worker, and a bad output is refused', async () => {
      const before = (await count()).takes;
      const bad = await hop('take', {n: 'not an integer'});
      assert.deepStrictEqual(bad.body, {output: {code: 'INPUT_DATA_VALIDATION_FAIL'}}, JSON.stringify(bad.body));
      assert.strictEqual((await count()).takes, before);
      for (const kind of ['badType', 'extraKey', 'noOutput']) {
        const r = await hop('give', {kind: kind});
        assert.deepStrictEqual(r.body, {output: {code: 'OUTPUT_DATA_VALIDATION_FAIL'}}, `${kind}: ${JSON.stringify(r.body)}`);
      }
      const good = await hop('take', {n: 3});
      assert.strictEqual(good.status, 200, JSON.stringify(good.body));
      assert.strictEqual((await count()).takes, before + 1);
    });

    // The review of #165: a hop's input stalls count against the CALLING
    // module, whatever end user's key it hops for, so a module cannot spread
    // them over its users' ids. Last in this server: it leaves
    // main-checked-caller throttled on main-checked for a minute.
    it('stalling hops under four end users\' keys throttle the calling module; another key\'s own calls keep passing', async () => {
      const slowHop = (n) => post(PORT, `main-checked-rotating-${n}`, `/devices/${deviceIDForName('main-checked-caller')}/invoke-action`,
        {serviceID: 'urn:countinghouse-test:serviceID:callerService', actionName: 'hop', input: {action: 'slow', args: {s: `${'a'.repeat(40)}!`}}});
      const codes = [];
      for (let n = 1; n <= 4; n++) {
        codes.push((await slowHop(n)).body.output.code);
        // the stalled validator is replaced before the next hop
        await new Promise((resolve) => setTimeout(resolve, 700));
        const quiet = await ping();
        assert.strictEqual(quiet.status, 200, `another key's call during the hops: ${JSON.stringify(quiet.body)}`);
      }
      assert.deepStrictEqual(codes.slice(0, 3).map((c) => ['VALIDATION_TIMEOUT', 'INPUT_DATA_VALIDATION_FAIL'].includes(c)), [true, true, true], JSON.stringify(codes));
      assert.strictEqual(codes[3], 'VALIDATION_CALLER_THROTTLED', `a fourth key, the same calling module: ${JSON.stringify(codes)}`);
    });
  }));

  describe('worker mode, the default sandbox and direct peer channels', () => {
    let server = null;
    before(async () => { server = await startServer(PORT, SERVER_ARGS.concat(['--workerThread'])); });
    after(() => stopServer(server));

    it('before any tamper, every client call is worker mode\'s answer (as it was when the worker checked it)', async () => {
      for (const name of Object.keys(REFUSALS)) {
        const r = await REFUSALS[name]();
        assert.deepStrictEqual({status: r.status, body: r.body}, asWorkerMode(singleThread[name]), name);
      }
      assert.deepStrictEqual(await count(), {takes: 0, tampered: false});
    });

    it('a peer channel checks in the called worker, which validates as before', async () => {
      const bad = await hop('take', {n: 'not an integer'});
      assert.deepStrictEqual(bad.body, {output: {code: 'INPUT_DATA_VALIDATION_FAIL'}}, JSON.stringify(bad.body));
      const out = await hop('give', {kind: 'badType'});
      assert.deepStrictEqual(out.body, {output: {code: 'OUTPUT_DATA_VALIDATION_FAIL'}}, JSON.stringify(out.body));
      assert.deepStrictEqual(await count(), {takes: 0, tampered: false});
    });

    it('once the module turns off its worker\'s validation, every client call is still single-thread mode\'s answer', async () => {
      assert.deepStrictEqual(await tamper(), {tampered: true});
      for (const name of Object.keys(REFUSALS)) {
        const r = await REFUSALS[name]();
        assert.deepStrictEqual({status: r.status, body: r.body}, asWorkerMode(singleThread[name]), name);
      }
      assert.deepStrictEqual(await count(), {takes: 0, tampered: true});
    });
  });
});
