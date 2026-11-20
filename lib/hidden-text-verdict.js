'use strict';
// #400 (F3-1): an action whose declared text (its input schema, or its
// output schema as advertised) holds a hidden character where nothing can be
// left out is unusable: not listed, and not callable. Decided once per load
// of a device's spec, by the declarations check (lib/declarations.js, in a
// validator at a worker's spawn, lib/schema-safety.js schemaVerdict; on the
// main thread in single-thread mode, schemaChecked; again whenever a device
// replaces its spec, CHDevice updateDeviceSpec), and held here by address:
// (deviceID, serviceID, action name), one set per device, replaced on each
// decision, never on the spec's objects (a copy of a spec, a session's
// override, a JSON round trip all keep it; the high review of #400). Every
// route takes the same answer: tools/list and tools/call (lib/mcp/tool-
// registry.js buildToolTargets, gateway handleToolsCall), a task's run and
// re-run and add-job's (lib/device-manager.js invokeJobsNow, after any
// reload), tasks/result, and the HTTP invoke-action, add-job and get-spec
// routes (the schema route judges what it answers by the same walk:
// lib/routes/schema.js). Nothing is fetched or decided on a call. The main thread's
// only.
const callAddress = require('./call-address');
const {isObject, own, copyWith} = require('./safe-copy');

// deviceID -> the decision for the device serving under it: {owner, keys}.
// owner: the entry registered for it (its CHDevice, or in worker
// mode the worker's WorkerMessage), which alone replaces it (a device that
// doesn't serve, a reload's refused on the way or a deviceID another module
// holds, never touches it); keys: "<serviceID>\0<action name>" of each
// action decided unusable. Each decision is a new record, so a tools/list walk
// that began on one marks nothing once another is made (markAt).
const records = new Map();

const keyOf = (serviceID, actionName) => `${serviceID}\0${actionName}`;
// the ID a spec's device is served under (as lib/module-spec.js and CHDevice
// make it, from the friendly name), or the one it already carries
function deviceIDOf(spec) {
  if (!isObject(spec) || !isObject(spec.device)) return null;
  if (typeof(spec.device.deviceID) === 'string' && spec.device.deviceID !== '') return spec.device.deviceID;
  return typeof(spec.device.friendlyName) === 'string' ? callAddress.deviceIDForName(spec.device.friendlyName) : null;
}

// a decision for a device's spec: pairs, the load's list of [serviceID (the
// serviceList key), action name]; replaces whatever was decided before
function set(deviceID, pairs, owner = null) {
  if (typeof(deviceID) !== 'string') return;
  const record = {owner, keys: new Set()};
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof(pair[0]) === 'string' && typeof(pair[1]) === 'string') record.keys.add(keyOf(pair[0], pair[1]));
    }
  }
  records.set(deviceID, record);
}
// A device's own decision made again (CHDevice updateDeviceSpec): replaces
// the record only when that device is its owner, or none is held yet (#400's
// high review: a device that doesn't serve never replaces the one that does)
function setFor(deviceID, pairs, owner) {
  const held = records.get(deviceID);
  if (held != null && held.owner != null && held.owner !== owner) return;
  set(deviceID, pairs, owner);
}
// A load's decision, held with the spec it was made for until that spec
// serves (adopt, at the device's registration): a load refused later (a
// device-spec check, a deviceID another module holds) never touches the
// decision of the version that serves (the medium review of #400's high
// review). An empty decision is held too, so a fixed reload clears it.
const pending = new WeakMap(); // spec -> pairs
function pend(spec, pairs) {
  if (isObject(spec)) pending.set(spec, Array.isArray(pairs) ? pairs : []);
}
function adopt(deviceID, spec, pairs = undefined, owner = null) {
  set(deviceID, pairs !== undefined ? pairs : (isObject(spec) && pending.has(spec) ? pending.get(spec) : []), owner);
}
// The device has gone and isn't coming back (lib/device-manager.js, on its
// purge): its decision goes with it, when it is still that owner's
function forget(deviceID, owner = undefined) {
  const held = records.get(deviceID);
  if (held == null || (owner !== undefined && held.owner !== owner)) return;
  records.delete(deviceID);
}

// The decision a walk begins on (tools/list's, toolsFor), for markAt
const tokenOf = (deviceID) => records.get(deviceID) || null;
// tools/list's own walk of a schema as resolved found it unusable where the
// load did not (a spec read again, or replaced since): recorded too, so the
// two answers meet at the stricter, and every route refuses it from then on.
// Only on the decision the walk began on (token, tokenOf before it): a walk
// that spans a reload or a new decision marks nothing. A device listed with
// no decision held (none is made yet, or a spec its supervisor lists) gets
// one, of no owner, holding the mark.
function markAt(deviceID, serviceID, actionName, token) {
  if (typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string' || typeof(actionName) !== 'string') return;
  let record = records.get(deviceID);
  if (record == null && token == null) { record = {owner: null, keys: new Set()}; records.set(deviceID, record); }
  if (record == null || (token != null && record !== token) || (token == null && record.owner != null)) return;
  const key = keyOf(serviceID, actionName);
  if (record.keys.has(key)) return;
  record.keys.add(key);
}

// by address (strings only: anything else names no action)
function unusableAt(deviceID, serviceID, actionName) {
  if (typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string' || typeof(actionName) !== 'string') return false;
  const record = records.get(deviceID);
  return record != null && record.keys.has(keyOf(serviceID, actionName));
}

// A spec as an HTTP caller is shown it (get-spec): a copy without the
// actions decided unusable, as tools/list leaves them out (the reviewer's
// ruling on #400); the spec served is never changed
function withoutUnusable(spec, deviceID = deviceIDOf(spec)) {
  if (!isObject(spec) || !isObject(spec.device) || !isObject(spec.device.serviceList)) return spec;
  const record = records.get(deviceID);
  const keys = record != null ? record.keys : null;
  if (keys == null || keys.size === 0) return spec;
  // (each key defined, never assigned: a "__proto__" key is a key here too)
  let any = false;
  const serviceList = {};
  for (const serviceID of Object.keys(spec.device.serviceList)) {
    const service = spec.device.serviceList[serviceID];
    if (!isObject(service) || !Array.isArray(service.actionList)) { own(serviceList, serviceID, service); continue; }
    const kept = service.actionList.filter((a) => !(isObject(a) && keys.has(keyOf(serviceID, a.name))));
    if (kept.length !== service.actionList.length) any = true;
    const copy = {};
    for (const k of Object.keys(service)) own(copy, k, service[k]);
    own(copy, 'actionList', kept);
    own(serviceList, serviceID, copy);
  }
  if (!any) return spec;
  // (the spec and its device copied as the services are: each key defined,
  // never assigned, so a "__proto__" key stays a key, never a prototype;
  // lib/safe-copy.js)
  return copyWith(spec, {device: copyWith(spec.device, {serviceList})});
}

// whether a decision record (tokenOf's) holds an action
const recordHas = (record, serviceID, actionName) => record != null && record.keys != null && record.keys.has(keyOf(serviceID, actionName));

module.exports = {recordHas, set, setFor, pend, adopt, forget, tokenOf, markAt, unusableAt, withoutUnusable, deviceIDOf};
