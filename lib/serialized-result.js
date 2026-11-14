// A hop's result as v8.serialize bytes (lean worker step 2, the reviewer's
// ruling (a) of 2026-11-13). The callee's worker serializes its output once,
// measures it against --maxOutputBytes and posts the bytes with their
// ArrayBuffer transferred. The main thread holds them as a SerializedResult
// (main thread only, never posted as such): it reads their length, has them
// checked in a validator (lib/validator-pool.js checkSerialized) and
// transfers them on to the calling worker, which decodes them. The main
// thread never deserialises them.
const {CountinghouseError} = require('./countinghouse-error');
// V8's own serializer, not Node's default one: a Buffer arrives as a
// Uint8Array, as structured clone (the cloned path, a peer channel) gives it.
// Taken when this file loads, before a module's worker locks down.
const {Serializer, Deserializer} = require('v8');

// isError: the bytes are a failed call's {fields, data} (its error, as
// CountinghouseError.replyFields gives it, and its payload).
class SerializedResult {
  constructor(buffer, {error = false} = {}) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('a SerializedResult holds an ArrayBuffer');
    this._buffer = buffer;
    this._error = error === true;
  }
  get buffer() { return this._buffer; }
  get bytes() { return this._buffer.byteLength; }
  get isError() { return this._error; }
}

// A Node Buffer's bytes as an ArrayBuffer that can be transferred: its own
// when it covers exactly its bytes, else a copy of just them (a pooled
// Buffer is a slice of a larger one, which must never be transferred).
function toArrayBuffer(buf) {
  if (buf.byteOffset === 0 && buf.buffer.byteLength === buf.byteLength && buf.buffer instanceof ArrayBuffer) return buf.buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// A value as bytes: what structured clone carries, and throws where it
// would (a function, a symbol, a host object).
function serialize(value) {
  const s = new Serializer();
  s.writeHeader();
  s.writeValue(value);
  return s.releaseBuffer();
}

// The value the bytes hold, read as serialize wrote them: the validator and
// the calling worker read them alike. Bytes that cannot be read are
// DEVICE_INVOKE_EXCEPTION, never a crash.
function decode(buffer) {
  try {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('not an ArrayBuffer');
    const d = new Deserializer(Buffer.from(buffer));
    d.readHeader();
    return d.readValue();
  } catch (e) {
    throw new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s result could not be read');
  }
}

module.exports = {SerializedResult, toArrayBuffer, serialize, decode};
