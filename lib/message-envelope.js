'use strict';
// Every message a module's worker sends the main thread crosses as bytes
// (#170): the worker serializes it, measures it against the cap and posts
// {b} with b's ArrayBuffer transferred; the main thread reads b's length
// before it decodes anything, so a worker cannot make the main thread copy
// and parse an arbitrary size. Node deserializes a posted message on receipt,
// before any listener, so the bound holds only because module code cannot
// post on the main thread's port itself: worker_threads is refused by the
// lockdown, the port is private to lib/worker-message.js, and the lockdown
// pins the port (pinPort, below) so a patched MessagePort.prototype method
// is never handed it. A message that is not an envelope,
// or whose bytes are over the cap, is a tampered worker's: the main thread
// ends it (lib/worker-message.js). The fs-broker's ports carry the same
// envelope (lib/fs-broker/client.js, server.js).
//
// A reply already carrying a hop's result or error as bytes (lean worker step
// 2, lib/serialized-result.js: dataBuffer or errorBuffer) keeps them as
// they are: the envelope transfers that ArrayBuffer beside b (t), never
// serializes it twice; the main thread caps it by its length, as before.
const {toArrayBuffer} = require('./serialized-result');
// Taken when this file loads, before a module's worker locks down.
const {Serializer, Deserializer} = require('v8');

// A typed array or DataView crosses as its own bytes: V8's serializer (and
// structured clone) would write a view's whole backing buffer, so ten bytes
// sliced from a 20 MB buffer would weigh 20 MB against the cap. On the main
// thread it is read back as the same kind of view over a fresh buffer; a
// Buffer arrives as a Uint8Array, as it did through postMessage.
const VIEWS = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView'].concat(typeof(globalThis.Float16Array) === 'function' ? ['Float16Array'] : []);
const CTORS = VIEWS.map((n) => globalThis[n]);
const tagOf = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get);
const kindOf = (v) => { const tag = tagOf(v); return VIEWS.indexOf(tag != null ? tag : 'DataView'); };   // no tag: a DataView

class EnvelopeSerializer extends Serializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }
  _writeHostObject(v) {
    if (!ArrayBuffer.isView(v)) return super._writeHostObject(v);
    this.writeUint32(kindOf(v));
    this.writeUint32(v.byteLength);
    this.writeRawBytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
}

class EnvelopeDeserializer extends Deserializer {
  _readHostObject() {
    const kind = this.readUint32();
    const length = this.readUint32();
    if (kind >= CTORS.length) throw new Error('not a view');
    const Ctor = CTORS[kind];
    // the bytes first: a length past the end throws before anything is allocated
    const bytes = this.readRawBytes(length);
    const ab = new ArrayBuffer(length);
    new Uint8Array(ab).set(bytes);
    if (Ctor === DataView) return new DataView(ab);
    if (length % Ctor.BYTES_PER_ELEMENT !== 0) throw new Error('a view of a partial element');
    return new Ctor(ab);
  }
}

// value -> bytes; each ArrayBuffer in `transfer` is written as a reference
// to its place in the list, its bytes never copied in.
function serialize(value, transfer) {
  const s = new EnvelopeSerializer();
  transfer.forEach((ab, i) => s.transferArrayBuffer(i, ab));
  s.writeHeader();
  s.writeValue(value);
  return s.releaseBuffer();
}

// What fits besides the largest output (--maxOutputBytes): a message's own
// fields around it.
const HEADROOM = 64 * 1024;
// A reply's own buffers, carried beside b without being named in a transfer list.
const INNER = ['dataBuffer', 'errorBuffer'];
// The most buffers one message carries beside b.
const MAX_TRANSFER = 4;

// The file bridge's cap: its largest call, one 16 MiB chunk of a write
// (lib/fs-broker/patch.js MAX_IO), and the call's own arguments.
const BRIDGE_CAP = 16 * 1024 * 1024 + HEADROOM;

const capFor = (maxOutputBytes) => (Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : 16777216) + HEADROOM;

// message -> {envelope, transfer}; throws MESSAGE_TOO_LARGE over cap, and
// what structured clone would throw for a value it cannot carry. The
// ArrayBuffers in `transfer` (a hop's input, lib/hop-input.js), and a
// reply's dataBuffer or errorBuffer, wherever they sit in the message, are
// transferred beside b ({b, t}) and never serialized into it: b is capped,
// and each of them is capped by its length where it is used, as before.
function wrap(message, cap, transfer) {
  const t = [];
  for (const ab of (Array.isArray(transfer) ? transfer : [])) if (ab instanceof ArrayBuffer && !t.includes(ab)) t.push(ab);
  for (const k of INNER) if (message != null && message[k] instanceof ArrayBuffer && !t.includes(message[k])) t.push(message[k]);
  // more than unwrap accepts is the runtime's own mistake: said here, loudly,
  // not by the main thread ending the worker
  if (t.length > MAX_TRANSFER) throw new Error(`message-envelope: ${t.length} buffers to carry, over ${MAX_TRANSFER}`);
  const bytes = serialize(message, t);
  if (bytes.byteLength > cap) {
    const {CountinghouseError} = require('./countinghouse-error');
    throw new CountinghouseError('MESSAGE_TOO_LARGE', `${bytes.byteLength} bytes, over ${cap}`);
  }
  const b = toArrayBuffer(bytes);
  return t.length > 0 ? {envelope: {b, t}, transfer: [b, ...t]} : {envelope: {b}, transfer: [b]};
}

// what arrived -> {message} or {violation: why}; nothing over the cap, or not
// an envelope, is decoded.
function unwrap(raw, cap) {
  if (raw == null || typeof(raw) !== 'object' || !(raw.b instanceof ArrayBuffer)) return {violation: 'a message that is not an envelope'};
  // exactly {b}, or {b, t} with t a short list of ArrayBuffers
  const keys = Object.keys(raw).sort().join(',');
  const carried = keys === 'b,t';
  if (!(keys === 'b' || (carried && Array.isArray(raw.t) && raw.t.length >= 1 && raw.t.length <= MAX_TRANSFER &&
    raw.t.every((ab) => ab instanceof ArrayBuffer)))) return {violation: 'a malformed envelope'};
  if (raw.b.byteLength > cap) return {violation: `a message of ${raw.b.byteLength} bytes, over ${cap}`};
  let message;
  try {
    const d = new EnvelopeDeserializer(new Uint8Array(raw.b));
    if (carried) raw.t.forEach((ab, i) => d.transferArrayBuffer(i, ab));
    d.readHeader();
    message = d.readValue();
  } catch (e) {
    return {violation: 'a message that could not be read'};
  }
  return {message};
}

// A port the runtime sends on, made deaf to a patched prototype: every method
// and accessor along its prototype chain (MessagePort, NodeEventTarget,
// EventTarget; string and symbol keys) becomes an own, fixed property of the
// port, as the prototype has it now. A module that later replaces
// MessagePort.prototype.postMessage (or on, addEventListener, an internal
// dispatch symbol...) changes it for its own ports, and is never handed this
// one as `this`. The prototypes themselves are left as they are: freezing
// them breaks util.inspect of any port and a strict-mode EventTarget
// subclass that assigns its own dispatchEvent. Node's own data writes to the
// port (its symbols) are unaffected; only properties the prototypes hold are
// pinned. Called by the lockdown (parentPort) and the file bridge's client.
function pinPort(port) {
  if (port == null) return port;
  for (let p = Object.getPrototypeOf(port); p != null && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const key of Reflect.ownKeys(p)) {
      if (key === 'constructor' || Object.prototype.hasOwnProperty.call(port, key)) continue;
      const d = Object.getOwnPropertyDescriptor(p, key);
      if (typeof(d.value) === 'function') Object.defineProperty(port, key, {value: d.value, writable: false, configurable: false, enumerable: false});
      else if (d.get != null || d.set != null) Object.defineProperty(port, key, {get: d.get, set: d.set, configurable: false, enumerable: false});
    }
  }
  return port;
}

module.exports = {wrap, unwrap, capFor, pinPort, HEADROOM, BRIDGE_CAP};
