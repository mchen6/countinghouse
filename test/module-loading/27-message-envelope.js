// #170: a module's worker sends the main thread bytes, never a value the main
// thread must deserialize first. lib/message-envelope.js wraps a message
// (serialized, measured against the cap, b transferred; a hop's dataBuffer
// or errorBuffer transferred beside it) and unwraps it on the main thread,
// reading b's length before decoding. WorkerMessage's main side ends a worker
// whose message is not an envelope, is malformed, or is over the cap.
// Server-free.
const assert = require('assert');
const EventEmitter = require('events');
const {wrap, unwrap, capFor, pinPort, HEADROOM} = require('../../lib/message-envelope');
const {MessageChannel, MessagePort} = require('worker_threads');
const util = require('util');
const options = require('../../lib/cli-options');
const CountinghouseError = require('../../lib/countinghouse-error').CountinghouseError;
const WorkerMessage = require('../../lib/worker-message');

const CAP = capFor(1024 * 1024);

describe('module-loading 27: messages to the main thread cross as bounded bytes (#170)', () => {
  it('a message round-trips; the cap is --maxOutputBytes plus the headroom', () => {
    const m = {id: 3, category: 'child', command: 'devicelog', errMsg: null, data: {text: 'hi', n: [1, 2]}};
    const {envelope, transfer} = wrap(m, CAP);
    assert.deepStrictEqual(Object.keys(envelope), ['b']);
    assert.deepStrictEqual(transfer, [envelope.b]);
    assert.deepStrictEqual(unwrap(envelope, CAP).message, m);
    assert.strictEqual(capFor(1024 * 1024), 1024 * 1024 + HEADROOM);
    assert.strictEqual(capFor(undefined), 8388608 + HEADROOM);
  });

  it('over the cap, the worker refuses it MESSAGE_TOO_LARGE before anything is posted', () => {
    assert.throws(() => wrap({data: 'x'.repeat(CAP + 1)}, CAP), (e) => e.code === 'MESSAGE_TOO_LARGE');
  });

  it('a view crosses as its own bytes, not its whole buffer, and comes back the same kind of view', () => {
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
    const m = {a: big.subarray(5, 15), f: new Float64Array([1.5, 2]), d: new DataView(new ArrayBuffer(4)), n: {i: Int16Array.of(-3)}};
    const {envelope} = wrap(m, CAP);
    assert.ok(envelope.b.byteLength < 200, `${envelope.b.byteLength}`);
    const back = unwrap(envelope, CAP).message;
    assert.deepStrictEqual(back.a, new Uint8Array(10).fill(7));   // a Buffer arrives as a Uint8Array, as through postMessage
    assert.deepStrictEqual(back.f, new Float64Array([1.5, 2]));
    assert.ok(back.d instanceof DataView && back.d.byteLength === 4);
    assert.deepStrictEqual(back.n.i, Int16Array.of(-3));
  });

  it('a pinned port is deaf to a patched prototype, and still inspects', async () => {
    const {port1, port2} = new MessageChannel();
    pinPort(port1);
    const proto = MessagePort.prototype;
    const et = Object.getPrototypeOf(Object.getPrototypeOf(proto));
    const saved = {post: proto.postMessage, add: et.addEventListener};
    const seen = [];
    try {
      proto.postMessage = function(...a) { seen.push('post'); return saved.post.apply(this, a); };
      et.addEventListener = function(...a) { if (this === port1) seen.push('add'); return saved.add.apply(this, a); };
      port1.on('message', () => {});
      const got = new Promise((resolve) => port2.once('message', resolve));
      port1.postMessage('hi');
      assert.strictEqual(await got, 'hi');
      assert.deepStrictEqual(seen, []);
      assert.doesNotThrow(() => util.inspect(port1));
    } finally {
      proto.postMessage = saved.post;
      et.addEventListener = saved.add;
      port1.close();
    }
  });

  it('a reply over the cap is answered MESSAGE_TOO_LARGE, not as a crash', () => {
    const posted = [];
    CountinghouseError.postReply((m) => {
      if (posted.length === 0) { posted.push(null); throw new CountinghouseError('MESSAGE_TOO_LARGE', 'n bytes'); }
      posted.push(m);
    }, {id: 1, category: 'reply', data: 'big'});
    assert.strictEqual(posted[1].errCode, 'MESSAGE_TOO_LARGE');
    assert.strictEqual(posted[1].data, null);
  });

  it('child side: a request over the cap goes to its callback, nothing queued; any other failure still throws', async () => {
    const saved = options.maxOutputBytes;
    options.maxOutputBytes = 1000;
    try {
      const wm = new WorkerMessage(null);
      const err = await new Promise((resolve) => wm.sendActiveMessageToParent({command: 'rediscommand', data: 'x'.repeat(70000)}, resolve));
      assert.strictEqual(err.code, 'MESSAGE_TOO_LARGE');
      assert.deepStrictEqual(Object.keys(wm.msgQueue), []);
      // not a worker: no port to post on, which is not a size refusal
      assert.throws(() => wm.sendActiveMessageToParent({command: 'rediscommand', data: 'x'}, () => {}), (e) => e.code !== 'MESSAGE_TOO_LARGE');
    } finally {
      options.maxOutputBytes = saved;
    }
  });

  it('a hop\'s bytes (dataBuffer, errorBuffer) are transferred beside b, never serialized again', () => {
    for (const field of ['dataBuffer', 'errorBuffer']) {
      const inner = new ArrayBuffer(4 * 1024 * 1024);   // larger than the cap: only b is capped here
      const {envelope, transfer} = wrap({id: 1, category: 'reply', [field]: inner}, CAP);
      assert.strictEqual(envelope.x, inner);
      assert.strictEqual(envelope.f, field);
      assert.ok(envelope.b.byteLength < 1024, `${envelope.b.byteLength}`);
      assert.deepStrictEqual(transfer, [envelope.b, inner]);
      assert.strictEqual(unwrap(envelope, CAP).message[field], inner);
    }
  });

  it('the main thread decodes nothing that is not an envelope, malformed, or over the cap', () => {
    const big = wrap({data: 'x'.repeat(2000)}, 10000).envelope;
    for (const [raw, why] of [
      [{id: 1, category: 'child', command: 'devicelog', data: 'plain'}, /not an envelope/],
      [null, /not an envelope/],
      [{b: new ArrayBuffer(8), extra: 1}, /malformed/],
      [{b: new ArrayBuffer(8), x: 'nope', f: 'dataBuffer'}, /malformed/],
      [{b: new ArrayBuffer(8), x: new ArrayBuffer(8), f: 'data'}, /malformed/],
      [{b: new ArrayBuffer(8), f: 'dataBuffer'}, /malformed/],
      [big, /over 1000/],
      [{b: new Uint8Array([1, 2, 3]).buffer}, /could not be read/]
    ]) {
      const r = unwrap(raw, raw === big ? 1000 : CAP);
      assert.ok(r.message === undefined, JSON.stringify(raw && Object.keys(raw)));
      assert.match(r.violation, why);
    }
  });

  describe('WorkerMessage, main side', () => {
    function fakeWorker() {
      const w = new EventEmitter();
      w.terminated = 0;
      w.terminate = () => { w.terminated += 1; return Promise.resolve(); };
      w.postMessage = () => {};
      return w;
    }

    it('an envelope is decoded and handled as before', () => {
      const w = fakeWorker();
      const wm = new WorkerMessage(w);
      const seen = [];
      wm.on('devicelog', (m) => seen.push(m.data));
      w.emit('message', wrap({id: 7, category: 'child', command: 'devicelog', errMsg: null, data: {deviceID: 'd', data: 'hello'}}, CAP).envelope);
      assert.deepStrictEqual(seen, [{deviceID: 'd', data: 'hello'}]);
      assert.strictEqual(w.terminated, 0);
    });

    it('anything else ends the worker, and is handled no further', () => {
      for (const raw of [{id: 7, category: 'child', command: 'devicelog', errMsg: null, data: 'plain'}, wrap({id: 7, category: 'child', command: 'devicelog', data: 'x'.repeat(9000)}, 1e6).envelope]) {
        const w = fakeWorker();
        const wm = new WorkerMessage(w);
        wm.messageCap = 8192;
        const seen = [];
        wm.on('devicelog', (m) => seen.push(m));
        w.emit('message', raw);
        assert.deepStrictEqual(seen, []);
        assert.strictEqual(w.terminated, 1);
        assert.match(String(wm.killReason), /message/);
      }
    });
  });
});
