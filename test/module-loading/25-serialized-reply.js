// Lean worker step 2 (the reviewer's ruling (a) of 2026-11-13): a hop's
// result crosses as v8.serialize bytes, its ArrayBuffer transferred, never
// copied. The callee's worker posts them to the main thread, which wraps
// them in a SerializedResult without reading them, and relays them to the
// calling worker, which decodes them. Server-free: a real worker thread for
// the worker's side, a recording stand-in for the main thread's post.
const assert = require('assert');
const path = require('path');
const v8 = require('v8');
const {Worker} = require('worker_threads');
const WorkerMessage = require('../../lib/worker-message');
const {SerializedResult, toArrayBuffer, decode} = require('../../lib/serialized-result');

const LIB = path.join(__dirname, '..', '..', 'lib');
const bytesOf = (value) => toArrayBuffer(v8.serialize(value));

describe('module-loading 25: a serialized reply crosses with its buffer transferred', function() {
  this.timeout(30000);

  it('a worker\'s serialized reply reaches the main thread as a SerializedResult, its bytes transferred and never read there', async () => {
    // the worker answers the main thread's message with the bytes of {output: {n: 7}},
    // then reports what is left of its buffer
    const worker = new Worker(`
      const {parentPort} = require('worker_threads');
      const v8 = require('v8');
      const WorkerMessage = require(${JSON.stringify(path.join(LIB, 'worker-message'))});
      const {toArrayBuffer} = require(${JSON.stringify(path.join(LIB, 'serialized-result'))});
      const wm = new WorkerMessage(null);
      parentPort.on('message', (m) => {
        if (m.command !== 'probe') return;
        const buffer = toArrayBuffer(v8.serialize({output: {n: 7}}));
        wm.sendSerializedReplyToParent(m.id, buffer);
        parentPort.postMessage({id: 'left', left: buffer.byteLength});
      });`, {eval: true});
    try {
      const left = new Promise((resolve) => worker.on('message', (m) => { if (m != null && m.id === 'left') resolve(m.left); }));
      const main = new WorkerMessage(worker);
      const real = v8.deserialize;
      let reads = 0;
      v8.deserialize = (...a) => { reads += 1; return real(...a); };
      let answer;
      try {
        answer = await new Promise((resolve) => main.sendMessageToWorker({command: 'probe'}, (err, data) => resolve({err, data})));
      } finally {
        v8.deserialize = real;
      }
      assert.strictEqual(answer.err, null);
      assert.ok(answer.data instanceof SerializedResult, String(answer.data));
      assert.strictEqual(reads, 0, 'never deserialised on the main thread');
      assert.strictEqual(answer.data.bytes, answer.data.buffer.byteLength);
      assert.deepStrictEqual(decode(answer.data.buffer, v8.deserialize), {output: {n: 7}});
      assert.strictEqual(await left, 0, 'transferred out of the worker, not copied');
    } finally {
      await worker.terminate();
    }
  });

  it('a SerializedResult relayed to the calling worker is posted as dataBuffer, its buffer transferred', () => {
    const posted = [];
    const caller = new WorkerMessage({on() {}, postMessage: (msg, transfer) => posted.push({msg, transfer})});
    const buffer = bytesOf({output: {n: 7}});
    caller.sendActionInvokeReplyToChild({msgID: 4, errMsg: null, data: new SerializedResult(buffer), platformMetering: null});
    assert.strictEqual(posted.length, 1);
    const {msg, transfer} = posted[0];
    assert.strictEqual(msg.command, 'invoke-action-reply');
    assert.strictEqual(msg.msgID, 4);
    assert.strictEqual(msg.data, null);
    assert.strictEqual(msg.dataBuffer, buffer);
    assert.deepStrictEqual(transfer, [buffer]);
  });

  it('any other reply is posted as before, with no transfer list', () => {
    const posted = [];
    const caller = new WorkerMessage({on() {}, postMessage: (msg, transfer) => posted.push({msg, transfer})});
    caller.sendActionInvokeReplyToChild({msgID: 5, errMsg: null, data: {output: {n: 1}}});
    assert.deepStrictEqual(posted[0].msg.data, {output: {n: 1}});
    assert.strictEqual(posted[0].msg.dataBuffer, undefined);
    assert.strictEqual(posted[0].transfer, undefined);
  });

  it('decode gives what structured clone gave before: Date, Map, Set, typed array, BigInt, nested undefined', () => {
    const value = {output: {d: new Date(5), m: new Map([[1, 'a']]), s: new Set([2]), t: new Uint8Array([1, 2]), b: 10n, u: [undefined], n: {x: null}}};
    assert.deepStrictEqual(decode(bytesOf(value), v8.deserialize), structuredClone(value));
  });

  it('bytes that cannot be read are DEVICE_INVOKE_EXCEPTION, not a crash', () => {
    assert.throws(() => decode(new Uint8Array([0xff, 0x0f, 0x01]).buffer, v8.deserialize), {code: 'DEVICE_INVOKE_EXCEPTION'});
    assert.throws(() => decode(null, v8.deserialize), {code: 'DEVICE_INVOKE_EXCEPTION'});
  });

  it('toArrayBuffer gives a Buffer\'s own ArrayBuffer when it covers exactly its bytes, else a copy of just them', () => {
    const own = Buffer.from(new ArrayBuffer(4));
    assert.strictEqual(toArrayBuffer(own), own.buffer);
    const shared = Buffer.from('hello');   // from the pool: a slice of a larger ArrayBuffer
    const ab = toArrayBuffer(shared);
    assert.notStrictEqual(ab, shared.buffer);
    assert.strictEqual(ab.byteLength, 5);
    assert.strictEqual(Buffer.from(ab).toString(), 'hello');
  });
});
