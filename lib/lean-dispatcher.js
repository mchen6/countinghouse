// The lean worker's dispatcher (docs/superpowers/specs/2026-11-13-lean-worker-design.md
// section 2; lean worker step 3, Task 2). It requires a module's
// handlers/<service>/<action>.js files (lib/handler-map.js) and runs a
// handler for each invoke, with a ctx from handler-ctx, answering exactly as
// lib/service.js does (lib/handler-answer.js, which both use). No CHDevice,
// no Service, no validator: the main thread validated the call (its input
// before the invoke, its output on the reply) unless the call came over a
// direct peer channel, whose output the caller's checkOutput checks (until
// step 4 moves peer validation).
'use strict';

const path = require('path');
const handlerMap = require('./handler-map');
const identity = require('./fs-broker/identity');
const handlerCtx = require('./handler-ctx');
const callAddress = require('./call-address');
const {answerHandler, readField} = require('./handler-answer');
const {CountinghouseError} = require('./countinghouse-error');

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

// {modulePath, moduleName, spec (api.json, parsed), checkOutput?} ->
// {invoke(serviceID, actionName, args, mainChecked, cb), names, device}.
// checkOutput(serviceID, actionName, output) -> null, or [err, data] to
// answer instead: run only for a call the main thread did not check.
// Handler files are required here, once: a file that throws while it
// loads throws out of createDispatcher, and the load fails with it.
function createDispatcher({modulePath, moduleName, spec, checkOutput}) {
  // A handler file that throws while it is required fails the load, named
  // by its path in the module (lean worker step 3, Review Focus 2).
  // A module's own path is /app/... under the file broker (spec section 2):
  // required by the specifier the broker's loader maps, as CHUtil.loadFile
  // requires it.
  const requireNamed = (file) => {
    try {
      return require(identity.specifierFor(identity.resolveModulePath(file)));
    } catch (e) {
      const where = path.relative(modulePath, file).split(path.sep).join('/');
      throw new CountinghouseError('LOAD_MODULE_FAIL', moduleName, `${where}: ${readField(e, 'message', 'an error with no message')}`);
    }
  };
  const map = handlerMap.loadConventionHandlers(modulePath, requireNamed) || {};
  const services = (spec != null && spec.device != null && spec.device.serviceList != null) ? spec.device.serviceList : {};
  // the device a handler's ctx sees (ctx.device, its composition), not a CHDevice
  const device = {
    deviceID: callAddress.deviceIDForName(spec.device.friendlyName),
    moduleName: moduleName,
    spec: spec,
    _composition: null,
    _compositionSettled: false
  };
  const handlers = new Map();
  const names = new Set();
  // the actions that declare an output schema
  const withOutput = new Set();
  for (const serviceID of Object.keys(services)) {
    const actions = map[handlerMap.shortNameOf(serviceID)];
    for (const actionName of handlerMap.actionNamesOf(services[serviceID])) {
      const fn = own(actions, actionName) ? actions[actionName] : null;
      if (typeof(fn) !== 'function') continue;
      handlers.set(`${serviceID}|${actionName}`, fn);
      names.add(`${serviceID}|${actionName}`);
      const declared = (services[serviceID].actionList || []).find((a) => a != null && a.name === actionName);
      if (declared != null && declared.output != null) withOutput.add(`${serviceID}|${actionName}`);
    }
  }

  function invoke(serviceID, actionName, args, mainChecked, cb) {
    if (!own(services, serviceID)) return cb(new CountinghouseError('SERVICE_NOT_FOUND', String(serviceID)), null);
    const fn = handlers.get(`${serviceID}|${actionName}`);
    if (fn == null) return cb(new CountinghouseError('ACTION_NOT_FOUND', String(actionName)), null);
    const opts = {serviceID: serviceID, actionName: actionName};
    // a callback-style handler gets its callback; an async one ignores it
    const run = (a, callback) => fn(a.input, handlerCtx.buildCtx(device, a, opts), callback);
    const finish = (output) => {
      // A function is not data, checked call or not: refused here as
      // lib/service.js refused it (a validator would never see it, as it
      // cannot be posted), for an action that declares an output.
      if (typeof(output) === 'function' && withOutput.has(`${serviceID}|${actionName}`)) {
        return cb(new CountinghouseError('OUTPUT_DATA_VALIDATION_FAIL'), {reason: 'output argument not found', info: ''});
      }
      const refused = (mainChecked === true || typeof(checkOutput) !== 'function') ? null : checkOutput(serviceID, actionName, output);
      if (refused != null) return cb(refused[0], refused[1]);
      return cb(null, output);
    };
    return answerHandler(run, args, cb, finish);
  }

  return {invoke, names, device};
}

module.exports = {createDispatcher};
