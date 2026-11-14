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

describe('sandbox 47: lib/hop-input.js, server-free', () => {
  it('encode replaces the input with its bytes, keeps the rest, and lists the bytes to transfer', () => {
    const {args, transfer} = hopInput.encode({input: {s: 'abc', n: [1, 2]}, token: 't', usageCall: 3});
    assert.ok(args.inputBytes instanceof ArrayBuffer);
    assert.deepStrictEqual(transfer, [args.inputBytes]);
    assert.ok(!Object.prototype.hasOwnProperty.call(args, 'input'), 'no value beside the bytes');
    assert.deepStrictEqual([args.token, args.usageCall], ['t', 3]);
    assert.deepStrictEqual(hopInput.decodeArgs(args), {token: 't', usageCall: 3, input: {s: 'abc', n: [1, 2]}});
  });

  it('an input structured clone cannot carry throws in the calling worker, as postMessage would', () => {
    assert.throws(() => hopInput.encode({input: {f: () => 1}}), /could not be cloned/);
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

  it('bytes that cannot be read are DEVICE_INVOKE_EXCEPTION, never a crash', () => {
    assert.throws(() => hopInput.decodeArgs({inputBytes: new Uint8Array([1, 2, 3]).buffer}), {code: 'DEVICE_INVOKE_EXCEPTION'});
  });
});

const PORT   = 9749;
const KEY    = 'hop-input-key';
const AUTH   = path.join(__dirname, '47-auth.json');
const CALLEE = path.join(ROOT, 'test', 'fixtures', 'hop-input-callee');
const CALLER = path.join(ROOT, 'test', 'fixtures', 'hop-input-caller');
const CAP    = 4 * 1024 * 1024;

const callerDo = (actionName, input) => post(PORT, KEY, `/devices/${deviceIDForName('hop-input-caller')}/invoke-action`,
  {serviceID: 'urn:countinghouse-test:serviceID:sendService', actionName: actionName, input: input});
const runs = async () => (await callerDo('runs', {})).body.output.output.runs;
const expected = (n) => ({output: {length: n, sha256: crypto.createHash('sha256').update('x'.repeat(n)).digest('hex')}});

describe('sandbox 47: a routed hop\'s input crosses as a transferred buffer', function() {
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

  it('one just under the cap passes', async () => {
    const n = CAP - 64;
    assert.deepStrictEqual((await callerDo('send', {n: n})).body.output.result, expected(n));
  });
});
