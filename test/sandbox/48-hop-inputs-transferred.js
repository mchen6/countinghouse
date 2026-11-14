// A routed hop's input crosses the main thread as bytes (the reviewer's
// ruling, 2026-11-14, after the lean step 4 profile): the calling worker
// serialises {input} once and transfers it; the main thread caps it by the
// bytes' length (--maxOutputBytes, the one cap, INPUT_TOO_LARGE), has it
// checked in a validator and transfers the checked bytes to the called
// worker, which decodes them. The main thread never deserialises or clones a
// hop's input. lib/hop-input.js; the routed path end to end below.
//
// Port 9749 is sandbox 41's and 42's, bound only after theirs have stopped
// (one mocha process runs the folder's files one after another).
const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');
const hopInput = require('../../lib/hop-input');

describe('sandbox 48: lib/hop-input.js, server-free', () => {
  it('encode replaces the input with its bytes, keeps the rest, and lists the bytes to transfer', () => {
    const {args, transfer} = hopInput.encode({input: {s: 'abc', n: [1, 2]}, token: 't', usageCall: 3});
    assert.ok(args.inputBytes instanceof ArrayBuffer);
    assert.deepStrictEqual(transfer, [args.inputBytes]);
    assert.ok(!Object.prototype.hasOwnProperty.call(args, 'input'), 'no value beside the bytes');
    assert.deepStrictEqual([args.token, args.usageCall], ['t', 3]);
    assert.deepStrictEqual(hopInput.decodeArgs(args), {token: 't', usageCall: 3, input: {s: 'abc', n: [1, 2]}});
  });

  it('an input structured clone cannot carry throws in the calling worker, as postMessage would; so does shared memory', () => {
    assert.throws(() => hopInput.encode({input: {f: () => 1}}), /could not be cloned/);
    assert.throws(() => hopInput.encode({input: {buf: new SharedArrayBuffer(16)}}));
  });

  it('args with no input, or a value input (an older or tampered worker), are left as they are', () => {
    assert.deepStrictEqual(hopInput.encode({token: 't'}), {args: {token: 't'}, transfer: []});
    assert.strictEqual(hopInput.bytesOf({input: {s: 'x'}}), null);
    assert.deepStrictEqual(hopInput.decodeArgs({input: {s: 'x'}}), {input: {s: 'x'}});
  });

  it('the cap is the bytes\' own length: INPUT_TOO_LARGE over it, naming the called action; nothing at it', () => {
    const {args} = hopInput.encode({input: {s: 'x'.repeat(1000)}});
    const n = args.inputBytes.byteLength;
    assert.strictEqual(hopInput.sizeRefusal(args.inputBytes, {module: 'm', action: 'a', max: n}), null);
    const err = hopInput.sizeRefusal(args.inputBytes, {module: 'm', action: 'a', max: n - 1});
    assert.strictEqual(err.code, 'INPUT_TOO_LARGE');
    assert.strictEqual(err.message, `m/a: its input is ${n} bytes, over the ${n - 1}-byte limit (--maxOutputBytes), so the call was refused`);
  });

  it('a post to the callee that throws leaves no reply waiting, so the worker\'s end never answers the hop again', () => {
    const WorkerMessage = require('../../lib/worker-message');
    const fake = {postMessage: () => { throw new Error('DataCloneError'); }, on: () => {}, once: () => {}, threadId: 99};
    const wm = new WorkerMessage(fake);
    const {args} = hopInput.encode({input: {s: 'x'}});
    assert.throws(() => wm.sendInvokeActionMessage({deviceID: 'd', serviceID: 's', actionName: 'a', args: args, serializedReply: true}, () => assert.fail('never answered')), /DataCloneError/);
    assert.deepStrictEqual(Object.keys(wm.msgQueue), []);
    assert.strictEqual(wm.bytesExpected.size, 0);
  });

  it('bytes that cannot be read are DEVICE_INVOKE_EXCEPTION naming the input, never a crash', () => {
    assert.throws(() => hopInput.decodeArgs({inputBytes: new Uint8Array([1, 2, 3]).buffer}), (e) => e.code === 'DEVICE_INVOKE_EXCEPTION' && /a hop's input could not be read/.test(e.message));
  });
});

describe('sandbox 48: a validator\'s answer to input bytes it cannot read, server-free', function() {
  this.timeout(60000);
  const SERVICE = 'urn:countinghouse-test:serviceID:s';
  let pool = null;
  let wasWorkerThread;
  before(async () => {
    const options = require('../../lib/cli-options');
    wasWorkerThread = options.workerThread;
    options.setOptions({workerThread: true});
    const {ValidatorPool} = require('../../lib/validator-pool');
    pool = new ValidatorPool({size: 1, timeoutMs: 5000, compileMs: 5000, workerOptions: options.getOptionsForWorker()});
    const api = {device: {friendlyName: 'bytes-module', serviceList: {[SERVICE]: {actionList: [{name: 'a', input: {schema: '/s/a/input'}, output: {schema: '/s/a/output'}}]}}}};
    pool.register('bytes-module#1', 'bytes-module', JSON.stringify(api), JSON.stringify({$id: '#/', s: {a: {input: {type: 'object'}, output: {type: 'object'}}}}));
    for (let w = 0; !pool.slots.every((x) => x.ready) && w < 30000; w += 20) await new Promise((r) => setTimeout(r, 20));
  });
  after(() => {
    if (pool != null) pool.close();
    require('../../lib/cli-options').setOptions({workerThread: wasWorkerThread});
  });

  it('an input says the input (the review of #185); an output keeps the result\'s wording', async () => {
    const garbage = () => new Uint8Array([1, 2, 3]).buffer;
    const input = await pool.checkSerialized('bytes-module#1', SERVICE, 'a', 'input', garbage());
    assert.strictEqual(input.refused[0].code, 'DEVICE_INVOKE_EXCEPTION');
    assert.match(input.refused[0].message, /a hop's input could not be read/);
    const output = await pool.checkSerialized('bytes-module#1', SERVICE, 'a', 'output', garbage());
    assert.strictEqual(output.refused[0].code, 'DEVICE_INVOKE_EXCEPTION');
    assert.doesNotMatch(output.refused[0].message, /input/);
  });
});

const PORT   = 9749;
const KEY    = 'hop-input-key';
const AUTH   = path.join(__dirname, '48-auth.json');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'hop-input-caller');
const CAP    = 4 * 1024 * 1024;

const callerDo = (actionName, input) => post(PORT, KEY, `/devices/${deviceIDForName('hop-input-caller')}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:sendService', actionName: actionName, input: input});
const runs = async () => (await callerDo('runs', {})).body.output.output.runs;
const expected = (n) => ({output: {length: n, sha256: crypto.createHash('sha256').update('x'.repeat(n)).digest('hex')}});

describe('sandbox 48: a routed hop\'s input crosses as a transferred buffer', function() {
  this.timeout(180000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--no-directPeerChannels', '--moduleSandbox', 'audit', '--maxOutputBytes', String(CAP), '--requestTimeout', '60']);
  });
  after(() => stopServer(server));

  it('a 3 MB input reaches the called module intact', async () => {
    const r = await callerDo('send', {n: 3 * 1024 * 1024});
    assert.deepStrictEqual(r.body.output.result, expected(3 * 1024 * 1024), `${JSON.stringify(r.body).slice(0, 500)}\n${server.output.slice(-2000)}`);
  });

  it('a wrong input is still refused by the called action\'s input schema, and its handler does not run', async () => {
    const before = await runs();
    const r = await callerDo('send', {n: 5, wrong: true});
    assert.strictEqual(r.body.output.code, 'INPUT_DATA_VALIDATION_FAIL', JSON.stringify(r.body).slice(0, 500));
    assert.strictEqual(await runs(), before);
  });

  it('an input over --maxOutputBytes is refused INPUT_TOO_LARGE, naming the called action, before any check or handler', async () => {
    const before = await runs();
    const r = await callerDo('send', {n: CAP + 1});
    assert.strictEqual(r.body.output.code, 'INPUT_TOO_LARGE', JSON.stringify(r.body).slice(0, 500));
    assert.match(r.body.output.message, /^hop-input-callee\/sink: its input is \d+ bytes, over the 4194304-byte limit/);
    assert.strictEqual(await runs(), before);
  });

  it('a hop whose module swaps its input bytes for a value is refused on the main thread, and the callee does not run', async () => {
    const before = await runs();
    const r = await callerDo('sendAsValue', {});
    assert.strictEqual(r.body.output.code, 'DEVICE_INVOKE_EXCEPTION', JSON.stringify(r.body).slice(0, 500));
    assert.match(r.body.output.message, /a hop's input must cross as bytes/);
    assert.strictEqual(await runs(), before);
  });

  it('one just under the cap passes', async () => {
    const n = CAP - 64;
    assert.deepStrictEqual((await callerDo('send', {n: n})).body.output.result, expected(n));
  });
});
