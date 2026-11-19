'use strict';
// What the HTTP routes that show a module may answer for a caller (the
// reviewer's rulings, 2026-11-19, on #400's follow-up, and #447's high
// review): the module scope the caller's tools/list has, on every route
// that shows one (get-spec, schema, package-info, /device-list). The key's
// grants are the routes' own userAuth (lib/routes/user.js:
// USER_HAS_NO_DEVICE; /device-list filters by the same provider's
// listDevices). Beyond that a module is shown only when it is listed and
// not hidden:
// - listed: tool-registry listingOf (not an unlisted part, not a
//   non-scenario module under the single-identity profile);
// - not hidden while it goes on or off (module-visibility, one global set
//   since M5a: no session has a view of its own).
// A device no module serves is "missing": the route goes on to its own
// answer (DEVICE_NOT_FOUND), whatever the profile (high review, 4). Within a
// listed module, what is shown is specAsListed: the load's verdict on its
// actions (#400), every usable action, tool or not; no prompt prompts/list
// leaves out; the declared text cleaned as the MCP lists show it.
// (One predicate and one field table shared with tools/list is M6's: the
// high review of #447, 6.)
const toolRegistry = require('./mcp/tool-registry');
const visibility = require('./module-visibility');
const {withoutUnusable} = require('./hidden-text-verdict');
const {cleanedSpecText} = require('./spec-text');

// -> 'missing' | 'unlisted' | 'listed'
function scopeOf(cdifInterface, deviceID) {
  const dm = cdifInterface.deviceManager;
  const served = dm != null && dm.deviceMap != null && dm.deviceMap[deviceID] != null;
  // (a module restarting keeps its device's owner: still not missing, so a
  // part that is down is never shown: tool-registry listingOf)
  const owned = dm != null && typeof(dm.moduleOfDevice) === 'function' && typeof(dm.moduleOfDevice(deviceID)) === 'string';
  if (!served && !owned) return 'missing';
  return toolRegistry.listingOf(cdifInterface, deviceID).listed !== false && visibility.listsDevice(deviceID) ? 'listed' : 'unlisted';
}

// -> Promise of the spec as a caller may see it (a copy; the served spec
// itself when nothing is to be left out or cleaned)
async function specAsListed(cdifInterface, deviceID, spec) {
  const leaveOut = await require('./mcp/prompts').hiddenPromptsOf(cdifInterface, deviceID, spec);
  return cleanedSpecText(withoutUnusable(spec, deviceID), {leaveOut});
}

module.exports = {scopeOf, specAsListed};
