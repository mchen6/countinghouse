// The CHUtil a lean worker's module sees (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 2; lean worker step 3, Task 5). Each documented helper loads its
// implementation, lib/countinghouse-util.js and what it requires, on its
// first call, so a module that uses none never loads them. The facade's
// methods are plain functions over the implementation, never bound to it;
// it has no dm or ci, and a service client it hands out holds no reference
// to the runtime (the high review of #177).
//
// createFacade(wire): the lean worker's, once, at boot. wire() -> {dm, ci,
// redis}: what the implementation is attached to when it is first loaded
// (runtime()), the only time it can be. The implementation's own requests
// (CHUtil.invokeAction's among them) then go through this facade's request
// as the lockdown wrapped it, so every outbound path takes its host check;
// the facade's request itself calls postman-request through the handle the
// attach returns, which nothing else holds.
'use strict';

let facade = null;
let wireFn = null;
let attached = false;
let rawRequest = null;

// The implementation, attached to the lean worker's state on its first load.
// Every worker-side runtime path loads it here (handler-ctx, the peer side,
// this facade). Outside a lean worker (no facade), as it always was.
function runtime() {
  const impl = require('./countinghouse-util');
  if (!attached && wireFn != null) {
    attached = true;
    const state = wireFn();
    rawRequest = impl.__attach({dm: state.dm, ci: state.ci, redis: state.redis,
      outbound: (opts, callback) => facade.request(opts, callback)});
  }
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
  // postman-request through the attach's handle: the lockdown wraps this
  // method (set-options), and every request of the implementation comes here
  f.request = function(opts, callback) {
    const impl = runtime();
    return (rawRequest != null) ? rawRequest(opts, callback) : impl.request(opts, callback);
  };
  f.createServiceClient = function(opts, callback) {
    return runtime().createServiceClient(opts, (err, client) => callback(err, (client == null) ? client : moduleClient(client)));
  };
  Object.defineProperty(f, 'redis', {enumerable: true, get: () => runtime().redis});
  facade = f;
  return f;
}

module.exports = {createFacade, runtime, METHODS};
