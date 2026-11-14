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
// Taken when this file loads, before any module code runs.
const {AsyncResource} = require('async_hooks');

// fn, each call in a resource of its own, made when it is called: the
// context it runs in (an AsyncLocalStorage store) is the one the port's
// event runs in, as before, not one fixed when the listener was added.
function scoped(fn) {
  return function(...args) {
    return new AsyncResource('countinghouse-port').runInAsyncScope(fn, this, ...args);
  };
}

// port.on('message', handler), the handler in its own scope.
function onPortMessage(port, handler) {
  return port.on('message', scoped(handler));
}

// port.on(event, handler) for any other event a port's listener dispatches
// module callbacks from ('close': a peer channel fails its calls in flight).
function onPortEvent(port, event, handler) {
  return port.on(event, scoped(handler));
}

module.exports = {scoped, onPortMessage, onPortEvent};
