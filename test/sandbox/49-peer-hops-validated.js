// Lean worker step 4: a call over a direct peer channel is checked by the
// main thread, as a routed hop is.
// - The caller sends its input as bytes over the port. The callee hands them
//   to the main thread with its match request, and the main thread caps
//   them (--maxOutputBytes, INPUT_TOO_LARGE) and checks them against the
//   callee's input schema in a validator before any handler runs.
// - The callee sends its result, or its error, as bytes with its bill
//   request. The main thread caps it (OUTPUT_TOO_LARGE) and checks it
//   against the callee's output schema.
// - Only then does the main thread deliver it to the caller (peer-result).
//   The caller never takes a result from the port, so a callee cannot answer
//   around the check.
//
// Port 9749 is sandbox 41's, 42's and 48's, bound only after theirs have
// stopped (one mocha process runs the folder's files one after another).
const assert = require('assert');
const crypto = require('crypto');
const path   = require('path');
const {MessageChannel} = require('worker_threads');
const {ROOT, startServer, stopServer, post} = require('../helpers/sandbox-server');
const {deviceIDForName} = require('../../lib/call-address');
const PeerChannel = require('../../lib/peer-channel');
const {CountinghouseError} = require('../../lib/countinghouse-error');

describe('sandbox 49: a peer channel\'s caller, server-free', () => {
  let ports = null;
  afterEach(() => { if (ports != null) { ports.port1.close(); ports.port2.close(); } ports = null; });
  const caller = (opts) => {
    ports = new MessageChannel();
    return {channel: new PeerChannel(ports.port1, Object.assign({workerId: 2}, opts)), other: ports.port2};
  };
  const nextMessage = (port) => new Promise((resolve) => port.once('message', resolve));

  it('sends the input as bytes, never as a value', async () => {
    const {channel, other} = caller({});
    const sent = nextMessage(other);
    channel.invoke('d', 's', 'a', {v: 1}, 5000, () => {});
    const m = await sent;
    assert.ok(m.inputBytes instanceof ArrayBuffer);
    assert.ok(!('input' in m));
    assert.deepStrictEqual(require('../../lib/serialized-result').decode(m.inputBytes), {input: {v: 1}});
  });

  it('a value structured clone cannot carry, or shared memory, throws in the caller before anything is sent', () => {
    const {channel} = caller({});
    assert.throws(() => channel.invoke('d', 's', 'a', {buf: new SharedArrayBuffer(8)}, 5000, () => {}));
    assert.deepStrictEqual(Object.keys(channel.pending), []);
  });

  it('a result posted on the port is dropped and reported; the main thread\'s delivery answers the call', async () => {
    const forged = [];
    const {channel, other} = caller({onForgedReply: (id) => forged.push(id)});
    const answers = [];
    const sent = nextMessage(other);
    channel.invoke('d', 's', 'a', {}, 5000, (err, data) => answers.push([err, data]));
    const m = await sent;
    other.postMessage({id: m.id, category: 'peer-reply', errMsg: null, data: {output: 'forged'}});
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(answers, [], 'not taken');
    assert.deepStrictEqual(forged, [m.id]);
    channel.deliver(m.id, null, {output: 'checked'});
    assert.deepStrictEqual(answers, [[null, {output: 'checked'}]]);
  });

  it('the callee\'s refusal on the port ends the call at once', async () => {
    const {channel, other} = caller({});
    const answers = [];
    const sent = nextMessage(other);
    channel.invoke('d', 's', 'a', {}, 5000, (err) => answers.push(err.code));
    const m = await sent;
    other.postMessage(Object.assign({id: m.id, category: 'peer-reply', data: null}, CountinghouseError.replyFields(new CountinghouseError('CTX_CALL_UNDECLARED', 's/a'))));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(answers, ['CTX_CALL_UNDECLARED']);
  });

  it('an invoke\'s slot is freed by its final answer even after its caller timed out, so the next queued invoke goes', async () => {
    const {channel, other} = caller({maxConcurrentInvokes: 1});
    const seen = [];
    other.on('message', (m) => seen.push(m.id));
    const answers = [];
    channel.invoke('d', 's', 'a', {}, 30, (err) => answers.push(err.code));
    channel.invoke('d', 's', 'a', {}, 5000, (err, data) => answers.push(data));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(answers, ['PEER_CHANNEL_TIMEOUT']);
    assert.deepStrictEqual(seen, [0], 'the second waits for a slot');
    channel.deliver(0, null, {output: 'late'});   // the first's answer, after its timeout
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(seen, [0, 1], 'its slot freed');
    channel.deliver(1, null, {output: 'second'});
    assert.deepStrictEqual(answers, ['PEER_CHANNEL_TIMEOUT', {output: 'second'}]);
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
const sinkOf = (n) => ({output: {length: n, sha256: crypto.createHash('sha256').update('x'.repeat(n)).digest('hex')}});
const bigOf = (n) => { const text = JSON.stringify({output: {s: 'x'.repeat(n)}}); return {length: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex')}; };

describe('sandbox 49: a direct peer channel\'s hop is checked by the main thread', function() {
  this.timeout(180000);
  let server = null;
  before(async () => {
    server = await startServer(PORT, ['--authConfigPath', AUTH, '--loadModule', CALLEE, '--loadModule', CALLER, '--workerThread',
      '--directPeerChannels', '--moduleSandbox', 'audit', '--maxOutputBytes', String(CAP), '--requestTimeout', '60']);
  });
  after(() => stopServer(server));

  it('a 3 MB input and its answer cross intact', async () => {
    const r = await callerDo('send', {n: 3 * 1024 * 1024});
    assert.deepStrictEqual(r.body.output.result, sinkOf(3 * 1024 * 1024), `${JSON.stringify(r.body).slice(0, 500)}\n${server.output.slice(-2000)}`);
  });

  it('a wrong input is refused by the callee\'s input schema, and its handler does not run', async () => {
    const before = await runs();
    const r = await callerDo('send', {n: 5, wrong: true});
    assert.strictEqual(r.body.output.code, 'INPUT_DATA_VALIDATION_FAIL', JSON.stringify(r.body).slice(0, 500));
    assert.strictEqual(await runs(), before);
  });

  it('an input over --maxOutputBytes is refused INPUT_TOO_LARGE, naming the callee, before any check or handler', async () => {
    const before = await runs();
    const r = await callerDo('send', {n: CAP + 1});
    assert.strictEqual(r.body.output.code, 'INPUT_TOO_LARGE', JSON.stringify(r.body).slice(0, 500));
    assert.match(r.body.output.message, /^hop-input-callee\/sink: its input is \d+ bytes, over the 4194304-byte limit/);
    assert.strictEqual(await runs(), before);
  });

  it('an output its own schema refuses never reaches the caller: OUTPUT_DATA_VALIDATION_FAIL', async () => {
    const r = await callerDo('call', {action: 'bad', args: {}});
    assert.strictEqual(r.body.output.code, 'OUTPUT_DATA_VALIDATION_FAIL', JSON.stringify(r.body).slice(0, 500));
  });

  it('an output over --maxOutputBytes is refused OUTPUT_TOO_LARGE, naming the callee (it used to cross unmeasured)', async () => {
    const r = await callerDo('call', {action: 'big', args: {n: CAP + 1}});
    assert.strictEqual(r.body.output.code, 'OUTPUT_TOO_LARGE', JSON.stringify(r.body).slice(0, 500));
    assert.match(r.body.output.message, /^hop-input-callee\/big: its output is \d+ bytes, over the 4194304-byte limit/);
  });

  it('one just under the cap crosses intact', async () => {
    const n = CAP - 1024;
    assert.deepStrictEqual((await callerDo('call', {action: 'big', args: {n: n}})).body.output, bigOf(n));
  });
});
