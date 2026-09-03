const CHError = require('./countinghouse-error').CHError;

// One rate-limit check for one inbound request, shared by every entry path
// that isn't already covered by CdifInterface.prototype.invokeDeviceAction's
// own limiters (HTTP invoke-action and both MCP tools/call shapes reach
// those by going through invokeDeviceAction; nothing else does).
//
// Why the check lives at the entry path rather than deeper down, next to the
// per-job ownership check in lib/job-control.js that these same paths share:
// ownership is a property of the *job*, so it belongs with the job, and
// gating only the MCP gateway would have left the HTTP job routes as a
// bypass (audit S1/S5). A rate limit is a property of one inbound *request*,
// and the two do not decompose the same way. lib/mcp/gateway.js's
// handleTasksCancel calls JobControl.getJob and then JobControl.removeJob,
// so a limiter sitting in job-control would spend two of a caller's tokens
// on one tasks/cancel; and neither GET /balance nor the check-balance tool
// touches job-control at all, so a gate there could not cover them. The
// anti-bypass property comes instead from every entry path calling this one
// helper -- which is why POST /devices/:deviceID/add-job is one of its call
// sites even though it is a write: MCP task creation was already limited
// (lib/mcp/gateway.js), and add-job creates the very same jobs, so leaving
// it open made that limit optional.
//
// Fails OPEN, deliberately and on every failure mode: no --apiKeyRateLimit
// configured, no metering provider, an unresolved key, or Redis being down.
// This matches what every pre-existing rate-limit call site in this codebase
// already does (see invokeDeviceAction's "redis failed, allow action"
// branches) and the rule stated in docs/cross-cutting-matrix.md: this
// codebase does not deny access as a side effect of its own infrastructure
// being unavailable.
//
// `appKey` must be the *resolved* identity -- session.appKey after userAuth,
// or authCtx.appKey after resolveCallerIdentity -- never a raw request
// header. Keying on the header would let a caller spend a victim's budget
// just by sending the victim's key, which is the same mistake
// lib/routes/balance.js already fixed for the balance read itself.
function rateLimitGate(cdifInterface, appKey, callback) {
  if (cdifInterface == null || appKey == null) return callback(false);

  cdifInterface.rateLimit(appKey, (err, result) => {
    if (err != null) return callback(false);
    return callback(result != null && result.limited === true);
  });
}

// The denial every call site reports. Deliberately NOT the
// DENY_DEVICE_ACCESS that invokeDeviceAction's limiters raise: no device is
// involved in GET /balance or countinghouse_check_balance, and a caller
// being over its own request budget is a different condition from being
// refused access to a device.
function rateLimitError() {
  return new CHError('RATE_LIMIT_EXCEEDED');
}

// HTTP 429. The pre-existing limiters answer 500 (lib/session.js shapes
// every error that way), which is the wrong status for this condition; the
// paths gated here are all new to rate limiting, so they get the right one
// rather than inheriting the wrong one. invoke-action's existing 500 is left
// alone -- changing it is a separate, caller-visible behavior change.
const RATE_LIMIT_STATUS = 429;

// What every HTTP call site does with the two above, so the denial is shaped
// in one place rather than five. `session` is req.session -- i.e. the route
// stack has already run lib/routes/user.js (or, for /balance, doUserAuth),
// so session.appKey is a resolved identity.
//
// Answers on `res` directly instead of going through
// Session.prototype.callbackWithoutTimer, which every other error on these
// routes uses: that path hardcodes HTTP 500 (lib/session.js), and 500 is the
// wrong status for "you are over your own request budget". Routing it
// through there would mean either mislabelling this or teaching session.js a
// per-error status map, which is a much larger change than this item.
function guardRequest(cdifInterface, session, res, next) {
  rateLimitGate(cdifInterface, (session != null ? session.appKey : null), (limited) => {
    if (limited !== true) return next();

    const err = rateLimitError();
    return res.status(RATE_LIMIT_STATUS).json({topic: err.topic, code: err.code, message: err.message});
  });
}

module.exports = {
  check: rateLimitGate,
  error: rateLimitError,
  guard: guardRequest,
  STATUS: RATE_LIMIT_STATUS
};
