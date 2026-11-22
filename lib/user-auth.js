'use strict';
const options       = require('./cli-options');
const Session       = require('./session');
const LOG           = require('./logger');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {getAuthProvider, identitySource} = require('./auth');
const identity      = require('./identity');
const safeEqual     = require('./auth/safe-equal').safeEqual;
// a key that doesn't resolve is counted against the request's address, one
// that does remembered, and an address over budget is not looked up for
// (lib/unauth-limit.js): this is the one place a key is resolved
const unauthLimit   = require('./unauth-limit');
// How long a request waits for its key to be read into the identity index
// (the door, below): short, and below every caller's own deadline
const DOOR_WAIT_MS = 1500;
const unknownUser = (appKey) => { unauthLimit.keyRefused(appKey); return new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER'); };

// req & res can be null is this is from a local service client call
// serviceID and actionName can be null for a device-level-only check (e.g.
// lib/peer-channel-broker.js's D3 grant-time check, lib/mcp/tool-registry.js's
// fetchSchema, or lib/routes/admin-only.js's admin check, which also passes
// deviceID: null since admin is a device-independent capability)
//
// Every successful call sets session.isAdmin (true unconditionally under
// --debug, otherwise AuthProvider.authenticate()'s result.isAdmin) even
// when the caller only cares about device access -- cheap to always set,
// and means admin-only.js can reuse this function as-is rather than
// needing its own auth path.
const doUserAuth = function(req, res, deviceID, appKey, serviceID, actionName, localCB, callback) {
  if (options.debug === true) {
    // --debug bypasses AuthProvider entirely, including the isAdmin gate
    // (lib/routes/admin-only.js) -- consistent with every other capability
    // this mode already bypasses, not a separate carve-out.
    // quick path in case we are running in container
    if (options.debugKey == null) {
      const session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
      session.serviceID  = serviceID;
      session.actionName = actionName;
      session.isAdmin    = true;
      return callback(null, session);
    }

    const debugKey = options.debugKey;
    if (!safeEqual(appKey, debugKey)) {
      return callback(unknownUser(appKey));
    }
    unauthLimit.keyResolved(appKey);
    const session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
    session.serviceID  = serviceID;
    session.actionName = actionName;
    session.isAdmin    = true;
    return callback(null, session);
  }

  if (appKey == null) {
    return callback(unknownUser(null));
  }

  // Authorization decision (identity + device ownership) is delegated
  // entirely to the configured AuthProvider (lib/auth/, default
  // FileAuthProvider -- see docs/design-decisions.md's
  // AuthProvider section for why this replaced the previous inline
  // Redis-cache-then-CouchDB logic). balance/apiRemainCount are no longer
  // this function's concern -- that's MeteringProvider's domain now (see
  // lib/countinghouse-interface.js's recordCall/checkBalance/rateLimit) --
  // so the constructed Session always gets 0/0 placeholders for those two
  // fields; nothing reads them as real values anymore (the one thing that
  // used to, the realPrice/NOT_ENOUGH_USER_BALANCE gate, was retired
  // alongside this refactor).
  const lookup = unauthLimit.beforeLookup(appKey);
  // (with the limiter's own hint, as every limiter's refusal: #482, merging #483)
  if (lookup == null) return callback(unauthLimit.refusal());
  getAuthProvider().authenticate(appKey, deviceID, serviceID, actionName, (err, result) => {
    // (refused(answered): a provider that failed drops no key from those that resolved)
    if (unauthLimit.keyResolvedBy(err, result)) lookup.resolved(); else lookup.refused(err == null);
    const ok = err == null && result != null && result.ok === true;
    // (the provider's failure, as lib/auth's guard answers it: the
    // catalogue's own text, the provider's in the log only)
    if (err) return callback(err);
    if (!ok) return callback(result != null && result.err != null ? result.err : new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER'));

    const session = new Session(req, res, result.userName, appKey, 0, deviceID, 0, localCB);
    session.serviceID  = serviceID;
    session.actionName = actionName;
    session.isAdmin    = result.isAdmin === true;
    // A key the provider accepts but the identity index doesn't hold (one
    // rotated under a stable id on a provider with no change signal, or new
    // since the last read) is read in, under its user's stable id, before
    // anyone reads its id: never one derived from the key, which splits the
    // user's jobs, stored results and usage (the final pass's gateway part,
    // A2). Only a provider that lists its entries is asked, and nothing is
    // remembered here: a key its listing doesn't show (yet) is not given a
    // derived id that a later refill would orphan, and request traffic never
    // pushes a job's owner out of the remembered ones (#518). The refill is
    // the add's (throttled, bounded); this request waits for it at most
    // DOOR_WAIT_MS, and past that, or on a refill that fails, goes on as it
    // did before, the refill still landing for the next one (the medium on
    // this PR, 1-3).
    const provider = identity.isIndexed(appKey) ? null : identitySource(options);
    if (provider != null && typeof(provider.entries) === 'function') {
      let done = false;
      const go = () => { if (done) return; done = true; clearTimeout(t); process.nextTick(callback, null, session); };
      const t = setTimeout(go, DOOR_WAIT_MS);
      return identity.know(appKey, provider).then(go, go);
    }
    return callback(null, session);
  });
}

module.exports = doUserAuth;
