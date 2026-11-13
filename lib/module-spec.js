// A module's spec and validators on the main thread (lean worker, step 1:
// docs/superpowers/specs/2026-11-13-lean-worker-design.md section 4).
//
// Built once per worker start, before the worker starts, from the module's
// own api.json and schema.json, read here on the main thread. It is the same
// Service objects a worker builds (lib/service.js, through
// lib/countinghouse-device.js's schema resolution), compiled with the main
// thread's ajv, so its answers are the same function's output as a worker's.
//
// Every call the main thread sends to a module's worker (a client's call, a
// job's run, a hop routed through the main thread: lib/device-manager.js's
// sendCounted) is checked with it: the input before the invoke is sent, the
// output on the reply. A module's code runs only in its worker, so it cannot
// reach these checks. The worker is told the call was checked (mainChecked)
// and skips its own validation; a direct peer channel's call does not pass
// here, and is still validated in the called worker.
//
// The device the gateway lists is this spec: a worker's announcement is
// registered only if it matches it (matches), and then as this copy.
const fs          = require('fs');
const path        = require('path');
const Service     = require('./service');
const CHDevice    = require('./countinghouse-device');
const callAddress = require('./call-address');
const {CountinghouseError} = require('./countinghouse-error');

// A worker keeps its services and actions in plain objects, where a name
// such as toString finds the prototype's, and answers it its own way.
const OBJECT_NAMES = {};
const hasOwn = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);

// The services of one spec, once each action's schemas are resolved and
// compiled: resolves {deviceID, spec, specText, services}. Never rejects: a
// spec it cannot build resolves {error}, and the module's device is then
// never registered (its worker fails the same files with its own error).
function fromParts(spec, schemaDoc) {
  return new Promise((resolve) => {
    let pending = 0;
    let built = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let result = null;
    const maybeDone = () => {
      if (built && pending === 0) finish(result);
    };
    try {
      const deviceID = callAddress.deviceIDForName(spec.device.friendlyName);
      // As CHDevice's constructor does, so the copy registered is the spec a
      // worker announces.
      spec.device.deviceID = deviceID;
      const specText = JSON.stringify(spec);
      // What Service needs of a device: the root schema and its resolution,
      // CHDevice's own (one JSON-pointer resolution, no external refs).
      const device = {
        spec: spec,
        schemaDoc: schemaDoc,
        resolveSchemaFromPath: function(pointer, self, callback) {
          pending++;
          let answered = false;
          CHDevice.prototype.resolveSchemaFromPath.call(this, pointer, self, (...answer) => {
            if (answered) return;
            answered = true;
            try {
              callback(...answer);
            } finally {
              pending--;
              maybeDone();
            }
          });
        }
      };
      const services = Object.create(null);
      const serviceList = spec.device.serviceList;
      for (const serviceID in serviceList) {
        if (!hasOwn(serviceList, serviceID)) continue;
        services[serviceID] = new Service(device, serviceID, serviceList[serviceID]);
      }
      result = {deviceID: deviceID, spec: spec, specText: specText, services: services};
    } catch (e) {
      return finish({error: e.message});
    }
    built = true;
    maybeDone();
  });
}

// A module directory's spec, read from its api.json and schema.json (absent
// is legal, as in a worker: lib/handler-map-module.js's readRootSchema).
function build(modulePath) {
  let spec = null;
  let schemaDoc = null;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(modulePath, 'api.json')).toString());
    const schemaPath = path.join(modulePath, 'schema.json');
    if (fs.existsSync(schemaPath)) schemaDoc = JSON.parse(fs.readFileSync(schemaPath).toString());
  } catch (e) {
    return Promise.resolve({error: e.message});
  }
  return fromParts(spec, schemaDoc);
}

// Whether a worker's announced device is this spec's: the same device ID and
// the same spec, as text. A worker reads the same files, so a difference
// means the files changed between the two reads, or module code changed what
// its worker announces.
function matches(own, deviceID, announced) {
  if (own == null || own.error != null || own.deviceID !== deviceID) return false;
  try {
    return JSON.stringify(announced) === own.specText;
  } catch (e) {
    return false;
  }
}

// The answer to a call that fails its checks, as a worker's reply carries it
// (CountinghouseError.replyFields, then fromReplyFields): so a refusal made
// here and one made in a worker reach every caller the same.
function asReply(refused) {
  return [CountinghouseError.fromReplyFields(CountinghouseError.replyFields(refused[0])), refused[1]];
}

// Before a call is sent to a worker, in the order a worker checks it: the
// service, the action, an input at all, then the input against its schema.
// (A handler for the action is not checked: a loaded module has one for
// every action it declares, lib/handler-map.js.) Answers:
//   {refused: [error, data]}  the call's answer, as a reply carries it;
//   {action}                  checked: send it, then check the output;
//   null                      not checked here: send it as before, and the
//                             worker checks it (no spec for this device, or a
//                             name only an object's prototype has, which a
//                             worker answers its own way).
function checkInput(own, deviceID, serviceID, actionName, args) {
  if (own == null || own.error != null || own.deviceID !== deviceID) return null;
  if (!hasOwn(own.services, serviceID)) {
    if (OBJECT_NAMES[serviceID] != null) return null;
    return {refused: asReply([new CountinghouseError('SERVICE_NOT_FOUND', serviceID), null])};
  }
  const service = own.services[serviceID];
  if (!hasOwn(service.actions, actionName) && service.actions[actionName] != null) return null;
  const refused = service.refuseCall(actionName, args, false, true);
  if (refused != null) return {refused: asReply(refused)};
  return {service: service, action: service.actions[actionName]};
}

// On the reply: null when the output passes, else the call's answer.
function checkOutput(checked, output) {
  const refused = checked.service.refuseData(checked.action, output, false);
  return (refused == null) ? null : asReply(refused);
}

module.exports = {build, fromParts, matches, checkInput, checkOutput};
