'use strict';
// test/sandbox/63: a direct peer channel's port reaches a worker after its
// module code has loaded, and Node sets it up then. Every method that could
// be handed it is replaced (where the lockdown lets it be) by one that
// counts a port it is handed, as `this` or as an argument; then the worker's
// first peer call runs, so the channel is brokered with the replacements in
// place. No replacement may ever see a port.
const EventEmitter = require('events');

const ObjectDefineProperty = Object.defineProperty;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ReflectApply = Reflect.apply;
const PortProto = MessagePort.prototype;
const isPort = Function.prototype.call.bind(Object.prototype.isPrototypeOf, PortProto);

let portsSeen = 0;
const seen = [];
const counting = (name, orig) => function(...a) {
  let port = (this != null && typeof(this) === 'object' && isPort(this));
  for (let i = 0; i < a.length; i++) if (a[i] != null && typeof(a[i]) === 'object' && isPort(a[i])) port = true;
  if (port) { portsSeen++; seen[seen.length] = name; }
  // (a token handed over too: counted once input.watch has the counter set)
  if (watchTokens && (holdsToken(this) || anyHoldsToken(a))) { tokensSeen++; seen[seen.length] = `token: ${name}`; }
  return ReflectApply(orig, this, a);
};
let watchTokens = false;

const NodeEventTargetProto = ObjectGetPrototypeOf(PortProto);
const TARGETS = [
  ['EventEmitter.prototype.on', EventEmitter.prototype, 'on'],
  ['EventEmitter.prototype.addListener', EventEmitter.prototype, 'addListener'],
  ['EventEmitter.prototype.once', EventEmitter.prototype, 'once'],
  ['EventEmitter.prototype.emit', EventEmitter.prototype, 'emit'],
  ['NodeEventTarget.prototype.on', NodeEventTargetProto, 'on'],
  ['NodeEventTarget.prototype.addListener', NodeEventTargetProto, 'addListener'],
  ['EventTarget.prototype.addEventListener', EventTarget.prototype, 'addEventListener'],
  ['EventTarget.prototype.dispatchEvent', EventTarget.prototype, 'dispatchEvent'],
  ['MessagePort.prototype.postMessage', PortProto, 'postMessage'],
  ['MessagePort.prototype.start', PortProto, 'start'],
  ['MessagePort.prototype.close', PortProto, 'close']
];

// What a call's token passes through on the peer path (its queue, the
// channel's pending calls, the metering reply, the envelope's bytes), and the
// keys Node assigns on a port it sets up: with input.watch each is watched
// too, and a token (32 hex characters, lib/call-tokens.js) or a port handed
// to any of them is counted.
let tokensSeen = 0;
const RegExpExec = Function.prototype.call.bind(RegExp.prototype.exec);
const TOKEN = /^[0-9a-f]{32}$/;
const isToken = (v) => typeof(v) === 'string' && v.length === 32 && RegExpExec(TOKEN, v) !== null;
const ownValue = (o, key) => { const d = ObjectGetOwnPropertyDescriptor(o, key); return d != null ? d.value : undefined; };
const holdsToken = (o, depth = 0) => {
  if (isToken(o)) return true;
  if (o == null || typeof(o) !== 'object' || depth > 2) return false;
  try {
    return holdsToken(ownValue(o, 'token'), depth + 1) || holdsToken(ownValue(o, 'args'), depth + 1) || holdsToken(ownValue(o, 'data'), depth + 1);
  } catch (e) {
    return false;
  }
};
const anyHoldsToken = (list) => { for (let i = 0; i < list.length; i++) if (holdsToken(list[i])) return true; return false; };
const ArrayIsArray = Array.isArray;
const Uint8ArrayCtor = Uint8Array;
const isHex = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
const bytesHoldToken = (ab) => {
  if (!(ab instanceof ArrayBuffer)) return false;
  const u8 = new Uint8ArrayCtor(ab);
  const n = u8.length < 1048576 ? u8.length : 1048576;
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (isHex(u8[i])) { run++; continue; }
    if (run === 32) return true;
    run = 0;
  }
  return run === 32;
};
const watching = (fn) => function(...a) {
  if (anyHoldsToken(a)) tokensSeen++;
  return ReflectApply(fn, this, a);
};
const define = (obj, key, desc, undo) => {
  const before = ObjectGetOwnPropertyDescriptor(obj, key);
  try {
    ObjectDefineProperty(obj, key, desc);
  } catch (e) {
    return;
  }
  undo[undo.length] = () => (before !== undefined ? ObjectDefineProperty(obj, key, before) : delete obj[key]);
};
const watchMethods = (obj, keys, undo) => {
  for (const key of keys) {
    const orig = obj[key];
    define(obj, key, {value: function(...a) {
      if (this != null && typeof(this) === 'object' && isPort(this)) { portsSeen++; seen[seen.length] = `${key} (this)`; }
      for (let i = 0; i < a.length; i++) if (a[i] != null && typeof(a[i]) === 'object' && isPort(a[i])) { portsSeen++; seen[seen.length] = key; }
      if (holdsToken(this) || anyHoldsToken(a) || (ArrayIsArray(this) && anyHoldsToken(this))) { tokensSeen++; seen[seen.length] = `token: ${key}`; }
      return ReflectApply(orig, this, a);
    }, writable: true, configurable: true, enumerable: false}, undo);
  }
};
// A port Node's own native code writes into the array of ports a message
// transferred (index by index, with a plain set): a setter on an index is
// handed it. Counted apart (nativeIndexPorts), not as portsSeen: no
// JavaScript runs before Node makes that array.
let nativeIndexPorts = 0;
const INDEX_KEY = /^[0-9]+$/;
const setterOn = (obj, key, undo) => define(obj, key, {configurable: true, enumerable: false,
  get() { return undefined; },
  set(v) {
    const indexOfPortList = typeof(key) === 'string' && RegExpExec(INDEX_KEY, key) !== null && ArrayIsArray(this) && v != null && typeof(v) === 'object' && isPort(v);
    if (indexOfPortList) { nativeIndexPorts++; seen[seen.length] = `native index ${String(key)}`; } else if ((v != null && typeof(v) === 'object' && isPort(v)) || isPort(this)) { portsSeen++; seen[seen.length] = `setter ${String(key)}`; }
    if (holdsToken(this) || holdsToken(v)) { tokensSeen++; seen[seen.length] = `token: setter ${String(key)}`; }
    ObjectDefineProperty(this, key, {value: (typeof(v) === 'function') ? watching(v) : v, writable: true, enumerable: true, configurable: true});
  }}, undo);
function watch(undo) {
  watchMethods(Map.prototype, ['set', 'get', 'has', 'delete'], undo);
  watchMethods(Array.prototype, ['push', 'shift', 'unshift', 'splice', 'forEach'], undo);
  watchMethods(Object, ['assign'], undo);
  const TA = ObjectGetPrototypeOf(Uint8Array.prototype);
  const bufferOf = ObjectGetOwnPropertyDescriptor(TA, 'buffer').get;
  let inside = false;
  for (const key of ['buffer', 'byteOffset', 'byteLength']) {
    const get = ObjectGetOwnPropertyDescriptor(TA, key).get;
    define(TA, key, {configurable: true, enumerable: false, get() {
      if (!inside) {
        inside = true;
        try { if (bytesHoldToken(ReflectApply(bufferOf, this, []))) { tokensSeen++; seen[seen.length] = `token: bytes (${key})`; } } catch (e) { /* not a typed array */ } finally { inside = false; }
      }
      return ReflectApply(get, this, []);
    }}, undo);
  }
  for (let k = 0; k < 8; k++) setterOn(Object.prototype, String(k), undo);
  const keys = Object.getOwnPropertySymbols(new EventTarget());
  keys[keys.length] = Symbol.for('nodejs.internal.kCurrentlyReceivingPorts');
  for (const key of keys) setterOn(Object.prototype, key, undo);
  for (const key of ['token', 'args', 'data', 'callback', 'billingKey']) setterOn(Object.prototype, key, undo);
}

// input.forge: the residual Node leaves (it writes the ports a message
// transferred into an array by index, natively), used as module code would.
// A setter on Array.prototype's index 0 takes the peer channel's port as the
// worker's first peer call brokers it. With it, module code reads what
// arrives on the port, and posts a replayed invoke (the first call's id)
// and a guessed one, while a legitimate hop runs. Then the callee says how
// many invokes it served.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function forge(ctx) {
  let port = null;
  const undo = [];
  define(Array.prototype, '0', {configurable: true, enumerable: false,
    get() { return undefined; },
    set(v) {
      if (port == null && v != null && typeof(v) === 'object' && isPort(v)) port = v;
      ObjectDefineProperty(this, '0', {value: v, writable: true, enumerable: true, configurable: true});
    }}, undo);
  const sink = (s) => ctx.call('hop-input-callee/sinkService.sink', {s}).then((r) => r.output, (e) => ({refused: String(e && e.code)}));
  let first;
  try {
    first = await sink('ch-sandbox-63-first');
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
  }
  const read = [];
  if (port != null) {
    port.on('message', (m) => {
      if (holdsToken(m)) tokensSeen++;
      read[read.length] = (m != null && typeof(m) === 'object')
        ? {id: m.id, command: m.command, category: m.category, errCode: m.errCode, data: m.data === undefined ? 'absent' : m.data} : {value: String(m)};
    });
    port.postMessage({id: 0, command: 'peer-invoke'});
    port.postMessage({id: 424242, command: 'peer-invoke'});
  }
  const legit = await sink('ch-sandbox-63-legit');
  for (let n = 0; n < 40 && read.length < 2; n++) await sleep(50);
  const after = await ctx.call('hop-input-callee/sinkService.count', {}).then((r) => r.output.runs, (e) => String(e && e.code));
  return {captured: port != null, first, legit, read, runs: after, tokensSeen};
}

module.exports = async (input, ctx) => {
  if (input != null && input.forge === true) {
    tokensSeen = 0;
    return {output: await forge(ctx)};
  }
  const changed = {};
  const undo = [];
  tokensSeen = 0;
  portsSeen = 0;
  nativeIndexPorts = 0;
  seen.length = 0;
  for (let i = 0; i < TARGETS.length; i++) {
    const [name, obj, key] = TARGETS[i];
    const before = ObjectGetOwnPropertyDescriptor(obj, key);
    changed[name] = false;
    if (before == null || typeof(before.value) !== 'function') continue;
    try {
      ObjectDefineProperty(obj, key, {value: counting(name, before.value), writable: true, configurable: true, enumerable: before.enumerable});
      changed[name] = true;
      undo[undo.length] = () => ObjectDefineProperty(obj, key, before);
    } catch (e) {
      // fixed by the lockdown
    }
  }
  watchTokens = (input != null && input.watch === true);
  if (watchTokens) watch(undo);
  const calls = [];
  try {
    for (let n = 0; n < 2; n++) {
      try {
        const r = await ctx.call('hop-input-callee/sinkService.count', {});
        calls[calls.length] = (r != null && r.output != null && typeof(r.output.runs) === 'number') ? 'answered' : JSON.stringify(r);
      } catch (e) {
        calls[calls.length] = String(e && e.code);
      }
    }
  } finally {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]();
    watchTokens = false;
  }
  return {output: {changed, calls, portsSeen, tokensSeen, nativeIndexPorts, seen}};
};
