'use strict';
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

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
// No limit is not a failure: with no --apiKeyRateLimit configured or no
// metering provider, the limiter answers "not limited", and the request goes
// on. A limiter that can't answer is a failure, and it fails CLOSED
// (CLAUDE.md's invariants): the request is refused RUNTIME_BUSY, the
// runtime's own 503, never let through as "not limited" -- as
// invokeDeviceAction's limiters (the limiter PR's medium, 4). A check Redis
// can't answer is decided by the same limit in memory first
// (lib/redis-resilient.js rateLimiter), so an error here is the limiter's
// own.
//
// `appKey` must be the *resolved* identity -- session.appKey after userAuth,
// authCtx.appKey after resolveCallerIdentity, or a tools/call's key once the
// gate's tool-registry grantsForCall has resolved it (the same identity:
// userAuth answers for the key it was given; countinghouse_overview keys on
// it so) -- never a raw request header no resolution has vouched for.
// Keying on such a header would let a caller spend a victim's budget just by
// sending the victim's key, which is the same mistake lib/routes/balance.js
// already fixed for the balance read itself.
// A local usage ledger that can't be used answers as itself through every
// per-key gate (R-store-aside-locked): RUNTIME_BUSY's "retry shortly" would
// be untrue of a corrupt one -> the error, or null for any other.
const LEDGER_CODES = new Set(['LEDGER_CORRUPT', 'LEDGER_UNREADABLE', 'LEDGER_UNREACHABLE', 'LEDGER_UNWRITABLE', 'LEDGER_RECORD_INVALID']);
function ledgerRefusal(err) {
  return (err instanceof CountinghouseError && LEDGER_CODES.has(err.code)) ? err : null;
}

function rateLimitGate(cdifInterface, appKey, callback) {
  if (cdifInterface == null || appKey == null) return callback(false);

  return guarded((refusal) => callback(refusal != null, refusal), (decide) => cdifInterface.rateLimit(appKey, (err, result) => decide(() => {
    if (err != null) return ledgerRefusal(err) || new CountinghouseError('RUNTIME_BUSY');
    // (the refusal, with the limiter's own retry hint: one shape at every
    // call site, #482's high, round 2, 7)
    return (result != null && result.limited === true) ? rateLimitError(result.timeLeft, result.windowMs) : null;
  })));
}

// A gate's limiter asked, its answer decided, and the gate answered once --
// fail closed: one uniform refusal, never a hang. ask(decide) asks the
// limiter, which calls decide(rule, onPass) with its answer: rule() -> the
// refusal or null, decided in a try (a throw there, or the limiter's own
// throw when asked, is RUNTIME_BUSY, logged). The answer -- cb(refusal), or
// onPass() when there is none -- is given outside that try, so the caller's
// own continuation is never caught and answered twice: a throw from inside
// it goes on up as the caller's; a throw the limiter makes after it has
// answered is logged and dropped. (One copy, for every gate: keyGate and
// callGate in lib/countinghouse-interface.js, rateLimitGate here.)
function guarded(cb, ask) {
  let answered = false;
  let callers = null;   // (a throw from inside the caller's own continuation)
  const answer = (refusal, onPass) => {
    if (answered) return undefined;
    answered = true;
    try {
      return (refusal == null && onPass != null) ? onPass() : cb(refusal);
    } catch (e) {
      callers = e;
      throw e;
    }
  };
  const busy = (e) => {
    try { require('./logger').E(e); } catch (x) { /* no logger */ }
    return new CountinghouseError('RUNTIME_BUSY');
  };
  const decide = (rule, onPass) => {
    let refusal;
    try { refusal = rule(); } catch (e) { refusal = busy(e); }
    return answer(refusal, onPass);
  };
  try {
    return ask(decide);
  } catch (e) {
    if (e === callers) throw e;
    if (answered) {
      try { require('./logger').E(e); } catch (x) { /* no logger */ }
      return undefined;
    }
    return answer(busy(e));
  }
}

// The denial every call site reports: RATE_LIMIT_EXCEEDED, the same code
// invokeDeviceAction's per-key limiter raises (#482's high, 1; the
// server-wide limiter's is RUNTIME_BUSY, the runtime's own).
function rateLimitError(timeLeft, windowMs) {
  return require('./countinghouse-error').setRetryAfter(new CountinghouseError('RATE_LIMIT_EXCEEDED'), timeLeft, windowMs);
}

// HTTP 429, as the catalogue's row says (every REST answer takes its status
// from there since post-rel caller 400).
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
  rateLimitGate(cdifInterface, (session != null ? session.appKey : null), (limited, refusal) => {
    if (limited !== true) return next();

    // (status from the catalogue's row, 429, with Retry-After)
    return require('./countinghouse-error').answerError(res, refusal);
  });
}

module.exports = {
  check: rateLimitGate,
  ledgerRefusal,
  guarded,
  guard: guardRequest,
  STATUS: RATE_LIMIT_STATUS
};
