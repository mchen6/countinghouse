// Lean worker step 4: a call over a direct peer channel is checked by the
// main thread, as a routed hop is.
// - The caller announces the invoke's target and its input, as bytes, to the
//   main thread, which holds them (the review of #202): the port carries the
//   invoke's id alone, so the callee can restate neither. The main thread
//   caps the bytes (--maxOutputBytes, INPUT_TOO_LARGE) and checks them
//   against the callee's input schema in a validator before any handler
//   runs, and hands the callee the target and the checked bytes.
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

  it('announces the target and the input as bytes to the main thread; the port carries the invoke\'s id alone', async () => {
    const announced = [];
    const {channel, other} = caller({announce: (id, token, target, bytes) => announced.push({id, token, target, bytes})});
    const sent = nextMessage(other);
    channel.invoke('d', 's', 'a', {v: 1}, 5000, () => {}, 'tok');
    const m = await sent;
    assert.deepStrictEqual(m, {id: 0, command: 'peer-invoke'});
    assert.strictEqual(announced.length, 1);
    assert.deepStrictEqual([announced[0].id, announced[0].token, announced[0].target], [0, 'tok', {deviceID: 'd', serviceID: 's', actionName: 'a', epoch: channel.epoch}]);
    assert.deepStrictEqual(require('../../lib/serialized-result').decode(announced[0].bytes), {input: {v: 1}});
  });

  it('a queued invoke is announced when it is sent, not while it waits, with the time its timer has left', async () => {
    const announced = [];
    const {channel} = caller({maxConcurrentInvokes: 1, announce: (id, token, target, bytes, left) => announced.push({id, left})});
    channel.invoke('d', 's', 'a', {}, 5000, () => {});
    channel.invoke('d', 's', 'a', {}, 300, () => {});
    assert.deepStrictEqual(announced.map((a) => a.id), [0], 'the queued one was announced');
    await new Promise((r) => setTimeout(r, 100));
    channel.deliver(0, null, {output: 1});
    assert.deepStrictEqual(announced.map((a) => a.id), [0, 1]);
    assert.ok(announced[1].left <= 210 && announced[1].left > 0, `left ${announced[1].left}`);
  });

  it('each grant of a channel has its own epoch, and a result or refusal for another epoch is not taken', async () => {
    const {channel} = caller({});
    const second = new MessageChannel();
    const again = new PeerChannel(second.port1, {workerId: 2});
    assert.notStrictEqual(channel.epoch, again.epoch);
    second.port1.close();
    second.port2.close();
    const methods = require('../../lib/peer-worker').methods;
    const self = {peerChannels: {2: channel}};
    const answers = [];
    channel.invoke('d', 's', 'a', {}, 5000, (err, data) => answers.push(err != null ? err.code : data));
    const {serialize, toArrayBuffer} = require('../../lib/serialized-result');
    methods.onPeerResult.call(self, {channel: '1:2', invokeId: 0, epoch: 'earlier', dataBuffer: toArrayBuffer(serialize({output: 'stale'}))});
    methods.onPeerAnnounceRefused.call(self, {channel: '1:2', invokeId: 0, epoch: 'earlier', errMsg: 'x', errCode: 'RATE_LIMITED'});
    assert.deepStrictEqual(answers, []);
    methods.onPeerResult.call(self, {channel: '1:2', invokeId: 0, epoch: channel.epoch, dataBuffer: toArrayBuffer(serialize({output: 'this'}))});
    assert.deepStrictEqual(answers, [{output: 'this'}]);
  });

  it('a callee\'s error made unreadable becomes DEVICE_INVOKE_EXCEPTION; it does not throw in the caller', () => {
    const {channel} = caller({});
    const methods = require('../../lib/peer-worker').methods;
    const answers = [];
    channel.invoke('d', 's', 'a', {}, 5000, (err) => answers.push(err.code));
    const {serialize, toArrayBuffer} = require('../../lib/serialized-result');
    const hostile = toArrayBuffer(serialize({fields: {errMsg: {toString: null}, errCode: 7, errData: 1n}}));
    assert.doesNotThrow(() => methods.onPeerResult.call({peerChannels: {2: channel}}, {channel: '1:2', invokeId: 0, epoch: channel.epoch, errorBuffer: hostile}));
    assert.strictEqual(answers.length, 1);
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

  it('forged answers are reported once per channel, and a refusal\'s fields on the port are bounded', async () => {
    const forged = [];
    const {channel, other} = caller({onForgedReply: (id) => forged.push(id)});
    const answers = [];
    channel.invoke('d', 's', 'a', {}, 5000, () => {});
    channel.invoke('d', 's', 'a', {}, 5000, (err) => answers.push(err));
    for (let i = 0; i < 50; i++) other.postMessage({id: 0, category: 'peer-reply', errMsg: null, data: {output: 'forged'}});
    other.postMessage({id: 1, category: 'peer-reply', data: null, errMsg: 'y'.repeat(100000), errCode: 'not a code\n'});
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(forged, [0]);
    assert.strictEqual(answers.length, 1);
    assert.ok(String(answers[0].message).length <= 1100, `${String(answers[0].message).length} characters`);
    assert.strictEqual(answers[0].code, 'DEVICE_INVOKE_EXCEPTION');
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

  // The review of #202 (4): a slot is freed at the invoke's timeout, so an
  // answer that never comes (a bill the main thread could not match) does
  // not hold it; the late answer then frees nothing twice.
  it('an invoke\'s slot is freed at its timeout, so the next queued invoke goes; its late answer frees nothing twice', async () => {
    const {channel, other} = caller({maxConcurrentInvokes: 1});
    const seen = [];
    other.on('message', (m) => seen.push(m.id));
    const answers = [];
    channel.invoke('d', 's', 'a', {}, 30, (err) => answers.push(err.code));
    channel.invoke('d', 's', 'a', {}, 5000, (err, data) => answers.push(data));
    channel.invoke('d', 's', 'a', {}, 5000, (err, data) => answers.push(data));
    await new Promise((r) => setTimeout(r, 80));
    assert.deepStrictEqual(answers, ['PEER_CHANNEL_TIMEOUT']);
    assert.deepStrictEqual(seen, [0, 1], 'the second waited on a slot no answer would free');
    channel.deliver(0, null, {output: 'late'});   // the first's answer, after its timeout
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(seen, [0, 1], 'the late answer freed a slot a second time');
    channel.deliver(1, null, {output: 'second'});
    await new Promise((r) => setTimeout(r, 30));
    assert.deepStrictEqual(seen, [0, 1, 2]);
    assert.deepStrictEqual(answers, ['PEER_CHANNEL_TIMEOUT', {output: 'second'}]);
  });

  it('an invoke failed at once (its announcement refused) frees its slot', async () => {
    const {channel, other} = caller({maxConcurrentInvokes: 1});
    const seen = [];
    other.on('message', (m) => seen.push(m.id));
    channel.invoke('d', 's', 'a', {}, 5000, () => {});
    channel.invoke('d', 's', 'a', {}, 5000, () => {});
    await new Promise((r) => setTimeout(r, 20));
    channel.fail(0, new CountinghouseError('RATE_LIMITED'));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(seen, [0, 1]);
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
