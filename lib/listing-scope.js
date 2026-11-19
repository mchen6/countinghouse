'use strict';
// What the HTTP routes that show a module may answer for a caller (the
// reviewer's rulings, 2026-11-19, on #400's follow-up, and #447's high
// review): the module scope the caller's tools/list has, on every route
// that shows one (get-spec, schema, package-info, /device-list), decided by
// the one predicate tools/list, prompts/list and resources/list list by
// (tool-registry listedFor: listed, within the key's grants, not hidden
// while it goes on or off; #447's high review, 6). The key's grants are the
// routes' own userAuth on get-spec, schema and package-info
// (lib/routes/user.js: USER_HAS_NO_DEVICE); /device-list keeps to the
// provider's before it asks (tool-registry grantedDevices). So the routes
// ask with none.
// A device no module serves is "missing": the route goes on to its own
// answer (DEVICE_NOT_FOUND), whatever the profile (high review, 4). Within a
// listed module, what is shown is specAsListed: the load's verdict on its
// actions (#400), every usable action, tool or not; no prompt prompts/list
// leaves out; the declared text cleaned as the MCP lists show it.
const toolRegistry = require('./mcp/tool-registry');
const {withoutUnusable, deviceIDOf} = require('./hidden-text-verdict');
const {cleanedSpecText} = require('./spec-text');
const {isObject, copyWith} = require('./safe-copy');

// -> 'missing' | 'unlisted' | 'listed'
function scopeOf(cdifInterface, deviceID) {
  const dm = cdifInterface.deviceManager;
  if (dm == null || typeof(deviceID) !== 'string') return 'missing';
  // (an own entry: "constructor" is no device)
  const served = dm.deviceMap != null && Object.hasOwn(dm.deviceMap, deviceID) && dm.deviceMap[deviceID] != null;
  if (!served && !owned(dm, deviceID)) return 'missing';
  return toolRegistry.listedFor(cdifInterface, deviceID, null) ? 'listed' : 'unlisted';
}

// A device out of the map that a module still holds: one restarting,
// ended, supervised or spawning keeps its owner, so a part that is down is
// never shown (tool-registry listingOf); an owner the device manager only
// remembers (its module uninstalled) holds nothing, and the device is
// missing (the medium review of #447's high round, 4).
function owned(dm, deviceID) {
  const name = typeof(dm.moduleOfDevice) === 'function' ? dm.moduleOfDevice(deviceID) : null;
  if (typeof(name) !== 'string') return false;
  const mm = dm.moduleManager;
  if (mm == null) return false;
  if (mm.modules != null && Object.hasOwn(mm.modules, name) && mm.modules[name] != null) return true;
  if (typeof(mm.endedStateForDevice) === 'function' && mm.endedStateForDevice(deviceID) != null) return true;
  if (mm.supervisor != null && typeof(mm.supervisor.errorForDevice) === 'function' && mm.supervisor.errorForDevice(deviceID) != null) return true;
  return mm.pinnedDevicePackages instanceof Map && mm.pinnedDevicePackages.get(deviceID) === name;
}

// the device spec with no unusable action and no prompt prompts/list leaves
// out, its embedded devices' too (each by its own deviceID)
async function withoutHidden(cdifInterface, deviceID, spec) {
  let out = withoutUnusable(spec, deviceID);
  const leaveOut = await require('./mcp/prompts').hiddenPromptsOf(cdifInterface, deviceID, out);
  if (leaveOut.size > 0 && isObject(out) && isObject(out.device) && Array.isArray(out.device.promptList)) {
    out = copyWith(out, {device: copyWith(out.device, {promptList: out.device.promptList.filter((p) => !(isObject(p) && leaveOut.has(p.name)))})});
  }
  if (isObject(out) && isObject(out.device) && Array.isArray(out.device.deviceList)) {
    const inner = await Promise.all(out.device.deviceList.map((d) => (isObject(d) && isObject(d.device) ? withoutHidden(cdifInterface, deviceIDOf(d), d) : d)));
    if (inner.some((d, i) => d !== out.device.deviceList[i])) out = copyWith(out, {device: copyWith(out.device, {deviceList: inner})});
  }
  return out;
}

// -> Promise of the spec as a caller may see it (a copy; the served spec
// itself when nothing is to be left out or cleaned)
async function specAsListed(cdifInterface, deviceID, spec) {
  return cleanedSpecText(await withoutHidden(cdifInterface, deviceID, spec));
}

module.exports = {scopeOf, specAsListed};
