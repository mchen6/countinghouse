// AuthProvider: the interface every authentication/authorization backend
// implements. Deliberately narrow -- lib/user-auth.js's original doUserAuth
// (pre-refactor) also computed balance/apiRemainCount/priceRecord from the
// same CouchDB record this replaces, but that's MeteringProvider's domain
// now (see docs/cdif-audit-and-refactoring-plan.md's AuthProvider section
// for why: two parallel pricing systems existed, only one was ever
// actually exercised, and prepaid per-tool quotas are recorded there as a
// MeteringProvider roadmap item, not something AuthProvider owns). This
// interface only ever answers "is this apiKey allowed to do X."
function AuthProvider() {}

// Checks whether `apiKey` is allowed to call `deviceID` (and, if given,
// specifically `serviceID`/`actionName` -- both may be null, same
// null-tolerance the original doUserAuth had; no built-in provider
// currently makes a *finer* decision than device-level ownership with
// them, but they're part of the signature for a future service/action-level
// ACL to use without a breaking interface change).
//
// callback(err, result): `err` is a transport-level failure (backend
// unreachable, corrupt config, etc.) -- callers should treat this the same
// way they'd treat any other backend-unavailable condition, not as "access
// denied". On success, `result` is {ok: boolean, userName: string|null,
// err: CHError|null} -- when `ok` is false, `result.err` carries the
// specific reason (SYSTEM_ERROR_UNKNOWN_USER, USER_HAS_NO_DEVICE, ...),
// reusing the existing CHError/error-info.*.json code taxonomy rather than
// inventing a parallel one.
AuthProvider.prototype.authenticate = function(apiKey, deviceID, serviceID, actionName, callback) {
  throw new Error('AuthProvider.authenticate must be implemented by a subclass');
};

// Lists the deviceIDs `apiKey` is authorized for. callback(err, result):
// result is {devices: [deviceID, ...]}, where the array may contain the
// literal string '*' to mean "every currently loaded device" -- providers
// return it as-is rather than expanding it themselves (they don't
// necessarily know the live device set; lib/mcp/tool-registry.js's
// tools/list filtering is what expands it against
// DeviceManager.prototype.getAllDeviceSpecs()).
AuthProvider.prototype.listDevices = function(apiKey, callback) {
  throw new Error('AuthProvider.listDevices must be implemented by a subclass');
};

module.exports = AuthProvider;
