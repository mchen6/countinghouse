'use strict';
// #400 (F3-1): an action whose declared text (its input schema, or its
// output schema as advertised) holds a hidden character where nothing can be
// left out is unusable: not listed, and not callable. Decided once, at the
// load, by the declarations check (lib/declarations.js, in a validator at a
// worker's spawn, lib/schema-safety.js schemaVerdict; on the main thread in
// single-thread mode, schemaChecked), and held here on the spec's own action
// objects, so every route takes the same answer: tools/list and tools/call
// (lib/mcp/tool-registry.js buildToolTargets marks the target unlisted), a
// task's run and re-run and add-job's (lib/device-manager.js invokeJobsNow,
// after any reload), tasks/result, and the HTTP invoke-action and add-job
// routes. A reload gives a new spec, its actions new objects, and its own
// decision; nothing is fetched or decided on a call. The main thread's only.
const unusable = new WeakSet();

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);

// spec: a module's parsed api.json, as the main thread holds it; pairs: the
// load's list, [serviceID (the serviceList key), action name]
function mark(spec, pairs) {
  if (!isObject(spec) || !Array.isArray(pairs) || pairs.length === 0) return;
  const list = isObject(spec.device) && isObject(spec.device.serviceList) ? spec.device.serviceList : {};
  for (const pair of pairs) {
    if (!Array.isArray(pair) || typeof(pair[0]) !== 'string' || typeof(pair[1]) !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(list, pair[0])) continue;
    const service = list[pair[0]];
    const actions = isObject(service) && Array.isArray(service.actionList) ? service.actionList : [];
    for (const action of actions) if (isObject(action) && action.name === pair[1]) unusable.add(action);
  }
}

function isUnusable(action) {
  return isObject(action) && unusable.has(action);
}
// tools/list's own walk of a schema as resolved found it unusable where the
// load did not (a spec read again, or replaced since): recorded on the action
// too, so the two answers meet at the stricter, and every route refuses it
// from then on, as tools/list leaves it out
// (no new tool generation: tools/call asks isUnusable of the target's own
// action beside its kept unlisted flag, as every other route asks
// unusableAt, so the kept tables, a client's page cursor and the per-
// generation caches stay as they are)
function markAction(action) {
  if (isObject(action)) unusable.add(action);
}
// A spec replaced in place (CHDevice updateDeviceSpec, single-thread mode):
// an action marked in the old spec stays marked in the new one, by its
// service key and name, failing closed (nothing decides again here)
function carry(oldSpec, newSpec) {
  const pairs = [];
  const list = isObject(oldSpec) && isObject(oldSpec.device) && isObject(oldSpec.device.serviceList) ? oldSpec.device.serviceList : {};
  for (const serviceID of Object.keys(list)) {
    const actions = isObject(list[serviceID]) && Array.isArray(list[serviceID].actionList) ? list[serviceID].actionList : [];
    for (const action of actions) if (isUnusable(action) && typeof(action.name) === 'string') pairs.push([serviceID, action.name]);
  }
  mark(newSpec, pairs);
}

// the spec a loaded device is served with: a worker's (its WorkerMessage, or
// a session's record, keeps them in deviceList) or single-thread mode's
// (the device's own spec), as lib/device-manager.js getAllDeviceSpecs reads it
function specOf(dm, deviceID) {
  if (dm == null || dm.deviceMap == null || typeof(deviceID) !== 'string') return null;
  const entry = Object.prototype.hasOwnProperty.call(dm.deviceMap, deviceID) ? dm.deviceMap[deviceID] : null;
  if (entry != null && typeof(entry) === 'object') {
    if (isObject(entry.deviceList) && Object.prototype.hasOwnProperty.call(entry.deviceList, deviceID)) return entry.deviceList[deviceID];
    if (isObject(entry.spec)) return entry.spec;
  }
  // a module restarting or suspended keeps its spec listed (getAllDeviceSpecs)
  // though its device is out of deviceMap: its decision is that spec's
  if (typeof(dm.getAllDeviceSpecs) === 'function') {
    try {
      const all = dm.getAllDeviceSpecs();
      if (all != null && Object.prototype.hasOwnProperty.call(all, deviceID) && isObject(all[deviceID])) return all[deviceID];
    } catch (e) {
      return null;
    }
  }
  return null;
}

// by address (strings only: anything else names no action)
function unusableAt(deviceManager, deviceID, serviceID, actionName) {
  if (typeof(serviceID) !== 'string' || typeof(actionName) !== 'string') return false;
  const spec = specOf(deviceManager, deviceID);
  const list = (isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList)) ? spec.device.serviceList : null;
  const service = (list != null && Object.prototype.hasOwnProperty.call(list, serviceID)) ? list[serviceID] : null;
  const actions = isObject(service) && Array.isArray(service.actionList) ? service.actionList : [];
  for (const action of actions) if (isObject(action) && action.name === actionName) return isUnusable(action);
  return false;
}

module.exports = {mark, markAction, carry, isUnusable, unusableAt};
