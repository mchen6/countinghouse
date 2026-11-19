'use strict';
// What the HTTP spec and schema routes may answer for a caller (the
// reviewer's rulings, 2026-11-19, on #400's follow-up): the module scope the
// caller's tools/list has. The key's grants are the routes' own userAuth
// (lib/routes/user.js), which refuses a device outside them
// (USER_HAS_NO_DEVICE) before the route runs, from the same provider
// tools/list filters by. Beyond that a module is answered only when it is
// listed and not hidden:
// - listed: tool-registry listingOf (not an unlisted part, not a
//   non-scenario module under the single-identity profile);
// - not hidden while it goes on or off (module-visibility, one global set
//   since M5a: no session has a view of its own).
// Otherwise a route refuses it whole, MODULE_NOT_LISTED. Within a listed
// module, which actions are answered stays the load's verdict (#400): every
// usable action, tool or not. A route checks again when its answer arrives
// (listedNow), so a module a load or unload hides meanwhile is not answered.
const toolRegistry = require('./mcp/tool-registry');
const visibility = require('./module-visibility');

// -> true | false
function listedNow(cdifInterface, deviceID) {
  return toolRegistry.listingOf(cdifInterface, deviceID).listed !== false && visibility.listsDevice(deviceID);
}

module.exports = {listedNow};
