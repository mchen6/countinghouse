// A hop's result as v8.serialize bytes (lean worker step 2, the reviewer's
// ruling (a) of 2026-11-13). The callee's worker serializes its output once,
// measures it against --maxOutputBytes and posts the bytes with their
// ArrayBuffer transferred. The main thread holds them as a SerializedResult
// (main thread only, never posted as such): it reads their length, has them
// checked in a validator (lib/validator-pool.js checkSerialized) and
// transfers them on to the calling worker, which decodes them. The main
// thread never deserialises them.
const {CountinghouseError} = require('./countinghouse-error');

class SerializedResult {
  constructor(buffer) {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('a SerializedResult holds an ArrayBuffer');
    this._buffer = buffer;
  }
  get buffer() { return this._buffer; }
  get bytes() { return this._buffer.byteLength; }
}

// A Node Buffer's bytes as an ArrayBuffer that can be transferred: its own
// when it covers exactly its bytes, else a copy of just them (a pooled
// Buffer is a slice of a larger one, which must never be transferred).
function toArrayBuffer(buf) {
  if (buf.byteOffset === 0 && buf.buffer.byteLength === buf.byteLength && buf.buffer instanceof ArrayBuffer) return buf.buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// The value the bytes hold. `deserialize` is v8.deserialize, as the caller
// took it (a module's worker takes it before its lockdown). Bytes that
// cannot be read are DEVICE_INVOKE_EXCEPTION, never a crash.
function decode(buffer, deserialize) {
  try {
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('not an ArrayBuffer');
    return deserialize(Buffer.from(buffer));
  } catch (e) {
    throw new CountinghouseError('DEVICE_INVOKE_EXCEPTION', 'a module\'s result could not be read');
  }
}

module.exports = {SerializedResult, toArrayBuffer, decode};
