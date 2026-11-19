'use strict';
// What the HTTP spec and schema routes may answer for a caller (the
// reviewer's rulings, 2026-11-19, on #400's follow-up): the module scope the
// caller's tools/list has. A module is answered only when that list could
// show it:
// - the key is granted its device (tool-registry grantedDevices, as
//   tools/list filters by it: null is every device);
// - the module is listed (tool-registry listingOf: not an unlisted part, not
//   a non-scenario module under the single-identity profile);
// - it is not hidden while it goes on or off (module-visibility, one global
//   set since M5a: no session has a view of its own).
// Otherwise a route refuses it whole, MODULE_NOT_LISTED. Within a listed
// module, which actions are answered stays the load's verdict (#400): every
// usable action, tool or not.
const toolRegistry = require('./mcp/tool-registry');
const visibility = require('./module-visibility');

// callback(err, true | false). A grants lookup that fails is passed on,
// never taken as granted.
function listedFor(cdifInterface, appKey, deviceID, callback, {grantedDevices = toolRegistry.grantedDevices} = {}) {
  grantedDevices(appKey, (err, granted) => {
    if (err) return callback(err);
    if (granted != null && !granted.has(deviceID)) return callback(null, false);
    if (toolRegistry.listingOf(cdifInterface, deviceID).listed === false) return callback(null, false);
    if (!visibility.listsDevice(deviceID)) return callback(null, false);
    return callback(null, true);
  });
}

module.exports = {listedFor};
