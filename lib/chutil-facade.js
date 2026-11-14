// The CHUtil a lean worker's module sees (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 2; lean worker step 3, Task 5). Each documented helper loads its
// implementation, lib/countinghouse-util.js and what it requires, on its
// first call, so a module that uses none never loads them. The facade's
// methods are plain functions over the implementation, never bound to it,
// and it has no dm or ci: module code cannot reach the worker's runtime
// objects through it (as R2-1 5b's moduleFacade).
//
// setWiring(fn): the lean worker's hook, run once on the implementation when
// it is first loaded, by whatever path (this facade, handler-ctx, the peer
// channel side), so it is never seen without the worker's state. Outside a
// lean worker none is set, and countinghouse-util is as it always was.
'use strict';

let wiring = null;
let wired = false;
function setWiring(fn) { wiring = fn; }
// Called by countinghouse-util at the end of its own load.
function wireLoaded(impl) {
  if (wired || typeof(wiring) !== 'function') return;
  wired = true;
  wiring(impl);
}

// The helpers a module may call (lib/countinghouse-util.js's exports, minus
// dm, ci and the runtime's own __deviceLogWithID).
const METHODS = ['getHostIp', 'getHostProtocol', 'inherits', 'loadFile', 'request', 'invokeAction', 'createServiceClient',
  'queryDeviceSpec', 'recordUsage', 'deviceLog', 'jobProgress', 'jobInfo'];

function createFacade() {
  const impl = () => require('./countinghouse-util');
  const facade = {};
  for (const name of METHODS) {
    // as a method of the implementation, which reads its own state
    facade[name] = function(...args) { return impl()[name](...args); };
  }
  Object.defineProperty(facade, 'redis', {enumerable: true, get: () => impl().redis});
  return facade;
}

module.exports = {createFacade, setWiring, wireLoaded, METHODS};
