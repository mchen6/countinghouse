'use strict';
// The runtime's port callbacks run in a scope of their own (the review of
// #186, HIGH 1). Node's executionAsyncResource() inside a port's 'message'
// callback is the port itself, and so is it for any code that callback calls
// synchronously: a module's handler, a ctx.redis or ctx.call reply's
// callback, a handler file required at load. Holding the port would post
// past the envelope (lib/message-envelope.js). A callback bound here runs in
// an AsyncResource of its own, so executionAsyncResource() there is that
// resource, never the port. A promise continuation or timer it starts runs
// in its own resource as before.
//
// The routes that still hand out resources (process._getActiveHandles and
// _getActiveRequests, async_hooks.executionAsyncResource and createHook's
// init) leave ports out for module code: lib/module-lockdown.js install(),
// section 2b, in every worker that locks down.
//
// Taken when this file loads, before any module code runs: the class and
// its runInAsyncScope, called through Reflect.apply, so module code that
// replaces AsyncResource.prototype's methods is never run with a port (the
// review of #177). No callback is given the port as `this` either: the
// emitter's this is dropped (no handler uses it).
const {AsyncResource} = require('async_hooks');
const runInAsyncScope = AsyncResource.prototype.runInAsyncScope;
const ReflectApply = Reflect.apply;
// A port's own methods as they are now, before any module code (this file
// loads at the worker's boot): every port the runtime holds is listened on,
// posted to and closed with these, so module code that replaces
// MessagePort.prototype's (or NodeEventTarget's) methods is never handed a
// port. Peer channels' ports, which arrive after module code has loaded,
// use them too (lib/peer-channel.js).
const PortProto = MessagePort.prototype;
const PortOn = PortProto.on;
const PortPostMessage = PortProto.postMessage;
const PortClose = PortProto.close;
const ObjectKeys = Object.keys;
const ObjectDefineProperty = Object.defineProperty;

// fn, each call in a resource of its own, made when it is called: the
// context it runs in (an AsyncLocalStorage store) is the one the port's
// event runs in, as before, not one fixed when the listener was added.
function scoped(fn) {
  return function(...args) {
    // (by index: an array's iterator is looked up when a spread runs)
    const call = [fn, undefined];
    for (let i = 0; i < args.length; i++) ObjectDefineProperty(call, i + 2, {__proto__: null, value: args[i], writable: true, enumerable: true, configurable: true});
    return ReflectApply(runInAsyncScope, new AsyncResource('countinghouse-port'), call);
  };
}

// port.on('message', handler), the handler in its own scope.
function onPortMessage(port, handler) {
  return ReflectApply(PortOn, port, ['message', scoped(handler)]);
}

// port.on(event, handler) for any other event a port's listener dispatches
// module callbacks from ('close': a peer channel fails its calls in flight).
function onPortEvent(port, event, handler) {
  return ReflectApply(PortOn, port, [event, scoped(handler)]);
}

// port.postMessage(message) and port.close(), with the methods taken above.
// Under --moduleSandbox off a post looks postMessage up as the port has it
// now, as lib/worker-message.js's own post does: nothing is fixed there, a
// module shares the realm and the runtime's objects anyway, and the test
// fixtures that stand for a module controlling its worker rewrite what is
// posted (test/composition/18: what the main thread must hold against). The
// mode is latched once, at set-options, before any module code
// (lib/lean-worker.js): never read later from anything module code reaches.
let postsLive = false;
let latched = false;
function latchSandboxMode(mode) {
  if (latched) return;
  latched = true;
  postsLive = (mode === 'off');
}
function postOnPort(port, message) {
  if (postsLive) return port.postMessage(message);
  return ReflectApply(PortPostMessage, port, [message]);
}
function closePort(port) {
  return ReflectApply(PortClose, port, []);
}

// base with each of fields' own enumerable values over it, as base's own
// (by index, with what was taken at boot): for a message a file that loads
// after module code builds (lib/peer-channel.js)
function withFields(base, fields) {
  const keys = ObjectKeys(fields);
  for (let i = 0; i < keys.length; i++) ObjectDefineProperty(base, keys[i], {__proto__: null, value: fields[keys[i]], writable: true, enumerable: true, configurable: true});
  return base;
}

// a message's own data field, or undefined (never an Object.prototype
// getter's answer), for a file that loads after module code
const ObjectHasOwn = Object.hasOwn;
const ownField = (o, key) => (o != null && typeof(o) === 'object' && ObjectHasOwn(o, key) ? o[key] : undefined);

// The runtime's containers on a worker's call path, with what was taken at
// boot: a value appended by index (never Array.prototype.push, and never
// through a setter on an index), the first taken off (Array.prototype.shift
// as it was), and a key's value set as an own property (never a setter on
// Object.prototype). A queue holding a call's token is never handed to a
// method module code replaced.
const ArrayShift = Function.prototype.call.bind(Array.prototype.shift);
function put(list, value) {
  ObjectDefineProperty(list, list.length, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});
  return list.length;
}
const takeFirst = (list) => ArrayShift(list);
function setOwn(o, key, value) {
  ObjectDefineProperty(o, key, {__proto__: null, value: value, writable: true, enumerable: true, configurable: true});
  return value;
}

// An object the runtime reads, re-homed: its own enumerable data fields as
// own fields of an object with no prototype, so reading a field it lacks
// answers undefined and never falls through to a getter module code put on
// Object.prototype (with the object, a call's args and their token, as
// `this`). Every message that arrives on a worker's ports is re-homed so
// before anything reads it (rehomeMessage), and so are the runtime's own
// copies of a call's args. A getter is not run; an array is left as it is.
const ArrayIsArrayPS = Array.isArray;
function rehome(o) {
  if (o == null || typeof(o) !== 'object' || ArrayIsArrayPS(o)) return o;
  const out = {__proto__: null};
  const keys = ObjectKeys(o);
  for (let i = 0; i < keys.length; i++) {
    const d = ObjectGetOwnPropertyDescriptor(o, keys[i]);
    if (d != null && ObjectHasOwn(d, 'value')) ObjectDefineProperty(out, keys[i], {__proto__: null, value: d.value, writable: true, enumerable: true, configurable: true});
  }
  return out;
}
// a message as it arrives: itself, and the fields the runtime reads further
// into (a call's args, their caller, its limits, a reply's data)
function rehomeMessage(m) {
  const msg = rehome(m);
  if (msg == null || typeof(msg) !== 'object') return msg;
  for (let i = 0; i < MESSAGE_PARTS.length; i++) {
    const key = MESSAGE_PARTS[i];
    if (ObjectHasOwn(msg, key)) ObjectDefineProperty(msg, key, {__proto__: null, value: rehome(msg[key]), writable: true, enumerable: true, configurable: true});
  }
  if (msg.args != null && typeof(msg.args) === 'object' && ObjectHasOwn(msg.args, 'ctx')) {
    ObjectDefineProperty(msg.args, 'ctx', {__proto__: null, value: rehome(msg.args.ctx), writable: true, enumerable: true, configurable: true});
  }
  return msg;
}
const MESSAGE_PARTS = ['args', 'limits', 'data', 'target', 'caller', 'options', 'sandbox'];

// What the runtime calls through, fixed at a worker's boot (lib/lean-worker.js):
// each own property non-writable and non-configurable, as the lockdown fixes
// path and url, so module code that reaches a runtime file's exports or a
// runtime class's prototype (through require.cache) cannot replace a function
// the runtime later calls there.
const ReflectOwnKeys = Reflect.ownKeys;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
function fixOwn(obj) {
  if (obj == null || (typeof(obj) !== 'object' && typeof(obj) !== 'function')) return obj;
  const keys = ReflectOwnKeys(obj);
  for (let i = 0; i < keys.length; i++) {
    const d = ObjectGetOwnPropertyDescriptor(obj, keys[i]);
    if (d == null) continue;
    // (a function's own prototype is non-configurable but writable: made
    // non-writable, so a class the runtime instantiates later keeps its own)
    if (d.configurable !== true) {
      if (ObjectHasOwn(d, 'value') && d.writable === true) ObjectDefineProperty(obj, keys[i], {__proto__: null, writable: false});
      continue;
    }
    ObjectDefineProperty(obj, keys[i], ObjectHasOwn(d, 'value')
      ? {__proto__: null, value: d.value, writable: false, configurable: false, enumerable: d.enumerable}
      : {__proto__: null, get: d.get, set: d.set, configurable: false, enumerable: d.enumerable});
  }
  return obj;
}

module.exports = {scoped, onPortMessage, onPortEvent, postOnPort, closePort, withFields, ownField, put, takeFirst, setOwn, fixOwn, latchSandboxMode, rehome, rehomeMessage};
