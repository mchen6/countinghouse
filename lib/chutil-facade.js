// The CHUtil a lean worker's module sees (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 2; lean worker step 3, Task 5). Its implementation,
// lib/countinghouse-util.js and what it requires, is loaded with this file,
// at a worker's boot, before any module code: a later require would return
// whatever module code had put in require.cache by then. The facade's
// methods are plain functions over the implementation, never bound to it;
// it has no dm or ci, and a service client it hands out holds no reference
// to the runtime (the high review of #177).
//
// createFacade(wire): the lean worker's, once, at boot. wire() -> {dm, ci,
// redis}: what the implementation is attached to, there and then, the only
// time it can be (a second attach is refused): module code that reaches the
// implementation through require.cache finds it attached to the runtime's
// state, never able to attach its own. The implementation's own requests
// (CHUtil.invokeAction's among them) then go through this facade's request
// as the lockdown wrapped it, so every outbound path of the implementation
// takes its host check; the facade's request itself calls postman-request,
// loaded on its first use (lib/lazy-require.js). Tidying, not a boundary
// (spec section 3's residual): module code shares the worker's realm and
// reaches what require.cache holds; the lockdown and the main thread's
// checks are the boundary.
'use strict';


let facade = null;
let wireFn = null;
let attached = false;

// The implementation, attached to the lean worker's state on its first load.
// Every worker-side runtime path loads it here (handler-ctx, the peer side,
// this facade). Outside a lean worker (no facade), as it always was.
const impl = require('./countinghouse-util');
const {lazy, orCallback} = require('./lazy-require');
function attach() {
  if (attached || wireFn == null) return;
  attached = true;
  const state = wireFn();
  impl.__attach({dm: state.dm, ci: state.ci, redis: state.redis,
    outbound: (opts, callback) => facade.request(opts, callback)});
}
function runtime() {
  return impl;
}

// The helpers a module may call (lib/countinghouse-util.js's exports, minus
// its internals).
const METHODS = ['getHostIp', 'getHostProtocol', 'inherits', 'loadFile', 'request', 'invokeAction', 'createServiceClient',
  'queryDeviceSpec', 'recordUsage', 'deviceLog', 'jobProgress', 'jobInfo'];

// A service client a module may hold: invoke and the address, nothing that
// reaches the runtime (a ServiceClient carries the worker's interface).
function moduleClient(client) {
  return Object.freeze({
    invoke: (opts, callback) => client.invoke(opts, callback),
    subscribe: (callback) => client.subscribe(callback),
    deviceID: client.deviceID,
    serviceID: client.serviceID
  });
}

function createFacade(wire) {
  if (facade != null) throw new Error('chutil-facade: a worker has one CHUtil');
  wireFn = (typeof(wire) === 'function') ? wire : null;
  const f = {};
  for (const name of METHODS) {
    // as a method of the implementation, which reads its own state
    f[name] = function(...args) { return runtime()[name](...args); };
  }
  // postman-request, loaded on its first use (lib/lazy-require.js): the
  // lockdown wraps this method at set-options, and every request of the
  // implementation comes here
  f.request = function(opts, callback) {
    const lib = orCallback(lazy('postman-request'), callback);
    if (lib != null) return lib(opts, callback);
    return undefined;
  };
  f.createServiceClient = function(opts, callback) {
    return runtime().createServiceClient(opts, (err, client) => callback(err, (client == null) ? client : moduleClient(client)));
  };
  Object.defineProperty(f, 'redis', {enumerable: true, get: () => runtime().redis});
  facade = f;
  attach();
  return f;
}

module.exports = {createFacade, runtime, METHODS};
