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

// port.postMessage(message) and port.close(), with the methods taken above
function postOnPort(port, message) {
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

module.exports = {scoped, onPortMessage, onPortEvent, postOnPort, closePort, withFields, ownField};
