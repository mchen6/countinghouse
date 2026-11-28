'use strict';
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
// What reads and writes a message's bytes, taken at load (a worker's boot,
// before module code): the bytes carry a call's token on the way out, so no
// getter, method or constructor module code replaced is ever handed them.
const uncurry = (fn) => Function.prototype.call.bind(fn);
const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
const getterOf = (proto, key) => uncurry(Object.getOwnPropertyDescriptor(proto, key).get);
const ViewBuffer = getterOf(TypedArrayProto, 'buffer');
const ViewByteOffset = getterOf(TypedArrayProto, 'byteOffset');
const ViewByteLength = getterOf(TypedArrayProto, 'byteLength');
const ArrayBufferByteLength = getterOf(ArrayBuffer.prototype, 'byteLength');
const ArrayBufferSlice = uncurry(ArrayBuffer.prototype.slice);
const IsPrototypeOf = uncurry(Object.prototype.isPrototypeOf);
const ArrayBufferProto = ArrayBuffer.prototype;
const IsArrayBuffer = (v) => v != null && typeof(v) === 'object' && IsPrototypeOf(ArrayBufferProto, v);
const ArrayBufferIsView = ArrayBuffer.isView;
const Uint8ArrayCtor = Uint8Array;
const SerializerWriteHeader = uncurry(Serializer.prototype.writeHeader);
const SerializerWriteValue = uncurry(Serializer.prototype.writeValue);
const SerializerReleaseBuffer = uncurry(Serializer.prototype.releaseBuffer);
const SerializerTreatViews = uncurry(Serializer.prototype._setTreatArrayBufferViewsAsHostObjects);
const SerializerWriteHostObject = uncurry(Serializer.prototype._writeHostObject);
const DeserializerReadHeader = uncurry(Deserializer.prototype.readHeader);
const DeserializerReadValue = uncurry(Deserializer.prototype.readValue);

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
  const ab = ViewBuffer(buf);
  const offset = ViewByteOffset(buf);
  const length = ViewByteLength(buf);
  if (offset === 0 && IsArrayBuffer(ab) && ArrayBufferByteLength(ab) === length) return ab;
  return ArrayBufferSlice(ab, offset, offset + length);
}

// A value as bytes: what structured clone carries, and throws where it
// would (a function, a symbol, a host object).
function serialize(value) {
  const s = new Serializer();
  SerializerWriteHeader(s);
  SerializerWriteValue(s, value);
  return SerializerReleaseBuffer(s);
}

// A module's output is JSON (MCP completeness, spec section 1): a Buffer, a
// typed array or a DataView in it is refused OUTPUT_NOT_JSON. V8 calls
// _writeHostObject for every ArrayBuffer view it meets once views are host
// objects, and for nothing else, so the check is free for a clean output,
// whose bytes are serialize()'s exactly. A bare ArrayBuffer is written as
// before: it is left to the validator's type check (the reviewer's ruling).
class NotJson extends Error {
  constructor(view) {
    super('an ArrayBuffer view in a module output');
    this.view = view;
  }
}
class OutputSerializer extends Serializer {
  constructor() {
    super();
    SerializerTreatViews(this, true);
  }
  _writeHostObject(obj) {
    // a view is not JSON; any other host object is what it always was (a
    // clone error, answered as DEVICE_INVOKE_EXCEPTION)
    if (ArrayBufferIsView(obj)) throw new NotJson(obj);
    return SerializerWriteHostObject(this, obj);
  }
}
function serializeOutput(value) {
  const s = new OutputSerializer();
  SerializerWriteHeader(s);
  SerializerWriteValue(s, value);
  return SerializerReleaseBuffer(s);
}

const escapePointer = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');

// The RFC 6901 pointer to `target` in `root`, found by identity, or null.
// Only on the refusal path: a walk of what serializeOutput already met. A
// module's getter or proxy that throws on this second read leaves the field
// unnamed; the call is still answered.
function pointerTo(root, target) {
  try {
    return pointerWalk(root, target);
  } catch (e) {
    return null;
  }
}
function pointerWalk(root, target) {
  const seen = new Set();
  const walk = (v, at) => {
    if (v === target) return at;
    if (v == null || typeof(v) !== 'object' || ArrayBuffer.isView(v) || seen.has(v)) return null;
    seen.add(v);
    const entries = (v instanceof Map) ? [...v.entries()] : (v instanceof Set) ? [...v].map((x, i) => [i, x]) : Object.entries(v);
    for (const [k, x] of entries) {
      const found = walk(x, `${at}/${escapePointer(k)}`);
      if (found != null) return found;
    }
    return null;
  };
  return walk(root, '');
}

// serializeOutput's refusal as the call's error: OUTPUT_NOT_JSON naming the
// field, as a pointer into the output (a reply is {output}).
function notJsonError(e, reply, module, action) {
  const at = pointerTo(reply, e.view);
  const field = (at == null) ? '(a nested value)' : (at.startsWith('/output/') ? at.slice('/output'.length) : (at === '/output' ? '(the whole output)' : at));
  return CountinghouseError.withFields('OUTPUT_NOT_JSON', {module: String(module), action: String(action), field: field});
}

// The value the bytes hold, read as serialize wrote them: the validator and
// the calling worker read them alike. Bytes that cannot be read are
// DEVICE_INVOKE_EXCEPTION, never a crash.
function decode(buffer) {
  try {
    if (!IsArrayBuffer(buffer)) throw new TypeError('not an ArrayBuffer');
    const d = new Deserializer(new Uint8ArrayCtor(buffer));
    DeserializerReadHeader(d);
    return DeserializerReadValue(d);
  } catch (e) {
    throw CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'a module\'s result could not be read');
  }
}

module.exports = {SerializedResult, toArrayBuffer, serialize, serializeOutput, NotJson, notJsonError, escapePointer, decode};
