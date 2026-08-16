// Turns a handler map (see lib/handler-map.js) into the thing the rest of the
// runtime already knows how to consume: an EventEmitter that answers
// 'discover' by emitting 'deviceonline' with a CHDevice.
//
// That indirection is the point. Discovery is a real capability for modules
// that decide at runtime how many devices to expose, so it stays -- but a
// static module should not have to pay its ceremony. The framework writes the
// index.js that every static module used to write by hand, and device
// assembly, schema loading and URN resolution all move here off the author's
// desk. See docs/design-decisions.md.
const events   = require('events');
const util     = require('util');
const fs       = require('fs');
const path     = require('path');

const CHDevice = require('./countinghouse-device');
const CHError  = require('./countinghouse-error').CHError;
const handlerMapLib = require('./handler-map');
const handlerCtx    = require('./handler-ctx');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file).toString());
}

// schema.json is read by the framework now; a module no longer implements
// _getDeviceRootSchema. Absent is legal -- not every module has a schema doc --
// but present-and-malformed is not, and says so with the path.
function readRootSchema(modulePath, moduleName) {
  const schemaPath = path.join(modulePath, 'schema.json');
  if (!fs.existsSync(schemaPath)) return null;
  try {
    return readJSON(schemaPath);
  } catch (e) {
    throw new CHError('MODULE_ASSEMBLY_FAIL', moduleName,
      `stage=readRootSchema -- ${schemaPath} is not valid JSON: ${e.message}`);
  }
}

// Adapts a 6.0.0 handler -- (input, ctx) or (input, ctx, callback) -- to the
// shape Service.prototype.doActionCall already invokes: invoke(args) for an
// async action, invoke(args, callback) otherwise.
//
// The wrapper must preserve async-ness, because doActionCall selects its
// branch on `action.invoke.constructor.name === 'AsyncFunction'`. Wrapping an
// async handler in a plain function would silently move it onto the callback
// branch and hang the call. (setAction's own .bind() is safe here: bind
// preserves AsyncFunction, checked rather than assumed.)
function makeInvoker(device, handler, serviceID, actionName) {
  const opts = {serviceID: serviceID, actionName: actionName};

  if (handler.constructor.name === 'AsyncFunction') {
    return async function(args) {
      return handler(args.input, handlerCtx.buildCtx(device, args, opts));
    };
  }

  return function(args, callback) {
    return handler(args.input, handlerCtx.buildCtx(device, args, opts), callback);
  };
}

// Builds the CHDevice subclass for one handler-map module. The class is made
// per module rather than once, because _getDeviceRootSchema and the handler
// wiring both close over this module's path and map.
function buildDeviceClass(modulePath, spec, handlerMap, moduleName) {
  const serviceIndex = handlerMapLib.buildServiceIndex(spec);
  const rootSchema   = readRootSchema(modulePath, moduleName);

  function HandlerMapDevice() {
    CHDevice.call(this, spec);

    // validateHandlerMap has already proved every short name resolves to
    // exactly one URN and every pair lines up, so this loop can be total.
    for (const short of Object.keys(handlerMap)) {
      const urn = serviceIndex.get(short)[0];
      const actions = handlerMap[short];
      for (const actionName of Object.keys(actions)) {
        this.setAction(urn, actionName, makeInvoker(this, actions[actionName], urn, actionName));
      }
    }
  }

  util.inherits(HandlerMapDevice, CHDevice);

  // CHDevice's constructor calls getDeviceRootSchema() -> _getDeviceRootSchema(),
  // so this has to be on the prototype before the first instantiation.
  HandlerMapDevice.prototype._getDeviceRootSchema = function() {
    return rootSchema;
  };

  return HandlerMapDevice;
}

// The synthesized equivalent of every static module's index.js.
function HandlerMapModule(DeviceClass) {
  this.on('discover',     () => { this.emit('deviceonline', new DeviceClass(), this); });
  this.on('stopdiscover', () => {});
}

util.inherits(HandlerMapModule, events.EventEmitter);

// Resolve a module directory to a handler map, from either shape:
//   - device.js (or whatever package.json "main" points at) exporting the map
//   - handlers/<serviceShortName>/<actionName>.js, when there is no map export
// `exported` is what the module's main entry evaluated to, or null when the
// caller could not load one. requireFile loads a single handler file.
//
// Returns {handlerMap, source} or null when this is not a handler-map module
// at all (in which case the caller keeps the legacy discovery path).
function resolveHandlerMap(modulePath, exported, requireFile) {
  if (handlerMapLib.isHandlerMap(exported)) {
    return {handlerMap: exported, source: 'module export'};
  }

  const convention = handlerMapLib.loadConventionHandlers(modulePath, requireFile);
  if (convention != null) {
    return {handlerMap: convention, source: 'handlers/ directory'};
  }
  return null;
}

// Assemble, or throw a CHError naming every mismatch at once. Throwing rather
// than logging-and-continuing is deliberate: design section 3.4, and the
// already-fixed defect class where a module with an illegal spec simply never
// appeared.
function assemble(modulePath, moduleName, handlerMap, source) {
  const apiPath = path.join(modulePath, 'api.json');
  let spec;
  try {
    spec = readJSON(apiPath);
  } catch (e) {
    throw new CHError('MODULE_ASSEMBLY_FAIL', moduleName,
      `stage=readApiJson -- ${apiPath} could not be read: ${e.message}`);
  }

  const problems = handlerMapLib.validateHandlerMap(spec, handlerMap, moduleName);
  if (problems.length > 0) {
    throw new CHError('MODULE_HANDLER_MISMATCH', moduleName,
      `handler map (from ${source}) does not match api.json -- ` +
      `${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`);
  }

  const DeviceClass = buildDeviceClass(modulePath, spec, handlerMap, moduleName);
  return new HandlerMapModule(DeviceClass);
}

module.exports = {
  resolveHandlerMap: resolveHandlerMap,
  assemble:          assemble,
  HandlerMapModule:  HandlerMapModule
};
