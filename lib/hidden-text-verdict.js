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

const byDevice = new Map(); // deviceID -> Set of "<serviceID>\0<action name>"

// deviceID -> Set of the unusable actions' own schema pointers (input,
// output), for the schema route (pointerUnusable); a Set, so a mark made
// again adds nothing
const pointersOf = new Map();
const addPointers = (deviceID, action) => {
  if (!pointersOf.has(deviceID)) pointersOf.set(deviceID, new Set());
  for (const which of ['input', 'output']) {
    if (isObject(action) && isObject(action[which]) && typeof(action[which].schema) === 'string' && action[which].schema !== '') pointersOf.get(deviceID).add(action[which].schema);
  }
};

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
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
function set(deviceID, pairs, spec = null) {
  if (typeof(deviceID) !== 'string') return;
  const keys = new Set();
  if (Array.isArray(pairs)) {
    for (const pair of pairs) {
      if (Array.isArray(pair) && typeof(pair[0]) === 'string' && typeof(pair[1]) === 'string') keys.add(keyOf(pair[0], pair[1]));
    }
  }
  byDevice.set(deviceID, keys);
  pointersOf.set(deviceID, new Set());
  const list = isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList) ? spec.device.serviceList : {};
  for (const serviceID of Object.keys(list)) {
    const actions = isObject(list[serviceID]) && Array.isArray(list[serviceID].actionList) ? list[serviceID].actionList : [];
    for (const a of actions) if (isObject(a) && keys.has(keyOf(serviceID, a.name))) addPointers(deviceID, a);
  }
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
function adopt(deviceID, spec, pairs = undefined) {
  set(deviceID, pairs !== undefined ? pairs : (isObject(spec) && pending.has(spec) ? pending.get(spec) : []), spec);
}

// tools/list's own walk of a schema as resolved found it unusable where the
// load did not (a spec read again, or replaced since): recorded too, so the
// two answers meet at the stricter, and every route refuses it from then on
// (current: whether the action walked is still the one the serving spec
// holds; a walk of a version since replaced, by a tools/list that spans a
// reload, marks nothing)
function markAt(deviceID, serviceID, actionName, action = null, current = () => true) {
  if (typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string' || typeof(actionName) !== 'string') return;
  if (current() !== true) return;
  if (!byDevice.has(deviceID)) byDevice.set(deviceID, new Set());
  byDevice.get(deviceID).add(keyOf(serviceID, actionName));
  addPointers(deviceID, action);
}

// by address (strings only: anything else names no action)
function unusableAt(deviceID, serviceID, actionName) {
  if (typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string' || typeof(actionName) !== 'string') return false;
  const keys = byDevice.get(deviceID);
  return keys != null && keys.has(keyOf(serviceID, actionName));
}

// A spec as an HTTP caller is shown it (get-spec): a copy without the
// actions decided unusable, as tools/list leaves them out (the reviewer's
// ruling on #400); the spec served is never changed
function withoutUnusable(spec, deviceID = deviceIDOf(spec)) {
  if (!isObject(spec) || !isObject(spec.device) || !isObject(spec.device.serviceList)) return spec;
  const keys = byDevice.get(deviceID);
  if (keys == null || keys.size === 0) return spec;
  // (each key defined, never assigned: a "__proto__" key is a key here too)
  const own = (o, k, v) => Object.defineProperty(o, k, {value: v, writable: true, enumerable: true, configurable: true});
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
  return Object.assign({}, spec, {device: Object.assign({}, spec.device, {serviceList})});
}

// whether a path (the schema route's) is an unusable action's own schema
// pointer or under one, by decoded segments (one that can't be decoded is
// refused)
function pointerUnusable(deviceID, pointer) {
  const pointers = pointersOf.get(deviceID);
  if (pointers == null || pointers.size === 0 || typeof(pointer) !== 'string') return false;
  // (each segment as a JSON pointer's: ~1 and ~0 unescaped, then decoded,
  // so another spelling of the same node is the same)
  const segments = (p) => p.split('/').filter((seg) => seg !== '').map((seg) => decodeURIComponent(seg.replace(/~1/g, '/').replace(/~0/g, '~')));
  let at;
  try { at = segments(pointer); } catch (e) { return true; }
  for (const p of pointers) {
    let q;
    try { q = segments(p); } catch (e) { continue; }
    if (at.length >= q.length && q.every((seg, i) => seg === at[i])) return true;
  }
  return false;
}

module.exports = {set, pend, adopt, markAt, unusableAt, withoutUnusable, pointerUnusable, deviceIDOf};
