'use strict';
// A routed hop's input as bytes (the reviewer's ruling, 2026-11-14, after
// the lean step 4 profile): the calling worker serialises {input} once and
// transfers the bytes; the main thread checks their length against
// --maxOutputBytes (the one cap), has them checked in a validator and
// transfers them to the called worker, which decodes them. The main thread
// never deserialises or clones a hop's input, as with its result (step 2).
const {CountinghouseError} = require('./countinghouse-error');
const {serialize, toArrayBuffer, decode} = require('./serialized-result');
const callLimits = require('./call-limits');
// Taken at load (a worker's boot, before module code): args carry the call's
// token, so they are copied as own properties, by index, never through
// Object.assign or a setter module code put on Object.prototype.
const ObjectKeys = Object.keys;
const ObjectHasOwn = Object.hasOwn;
const ObjectDefineProperty = Object.defineProperty;
const own = (o, key, value) => ObjectDefineProperty(o, key, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});
// args' own enumerable fields but `drop`, then key set to value, in an
// object with no prototype (a field it lacks is never read through a getter
// module code put on Object.prototype)
function copied(args, drop, key, value) {
  const out = {__proto__: null};
  const keys = ObjectKeys(args);
  for (let i = 0; i < keys.length; i++) if (keys[i] !== drop) own(out, keys[i], args[keys[i]]);
  own(out, key, value);
  return out;
}

// calling worker: args -> {args, transfer}, the input replaced by its bytes.
// A value structured clone cannot carry throws here, as postMessage would;
// so does a SharedArrayBuffer, which postMessage would have shared: memory
// shared between two modules' workers is not something a hop carries.
function encode(args) {
  if (args == null || typeof(args) !== 'object' || !ObjectHasOwn(args, 'input')) return {args: args, transfer: []};
  const bytes = toArrayBuffer(serialize({input: args.input}));
  return {args: copied(args, 'input', 'inputBytes', bytes), transfer: [bytes]};
}

// main thread: the input's bytes, or null for a hop that sent none.
const bytesOf = (args) => ((args != null && args.inputBytes instanceof ArrayBuffer) ? args.inputBytes : null);

// main thread: the refusal for bytes over the cap, else null. Their own
// length is the guarantee: the calling worker's module can post anything.
function sizeRefusal(bytes, {module, action, max}) {
  if (bytes == null || !Number.isInteger(max) || bytes.byteLength <= max) return null;
  return CountinghouseError.withFields('INPUT_TOO_LARGE', {module: module, action: action, bytes: bytes.byteLength, max: max,
    raise: callLimits.raiseHint(bytes.byteLength)});
}

// called worker: args with the input decoded from its bytes. Bytes that
// cannot be read are DEVICE_INVOKE_EXCEPTION, naming the input (a validator
// reads them first wherever the main thread holds the callee's spec).
function decodeArgs(args) {
  const bytes = bytesOf(args);
  if (bytes == null) return args;
  let value;
  try { value = decode(bytes); } catch (e) { throw CountinghouseError.runtimeReason('DEVICE_INVOKE_EXCEPTION', 'a hop\'s input could not be read'); }
  return copied(args, 'inputBytes', 'input', (value != null && typeof(value) === 'object') ? value.input : undefined);
}

module.exports = {encode, bytesOf, sizeRefusal, decodeArgs};
