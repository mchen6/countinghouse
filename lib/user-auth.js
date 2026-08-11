var options       = require('./cli-options');
var Session       = require('./session');
var LOG           = require('./logger');
var CHError     = require('./countinghouse-error').CHError;
var getAuthProvider = require('./auth').getAuthProvider;

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
var doUserAuth = function(req, res, deviceID, appKey, serviceID, actionName, localCB, callback) {
  if (options.debug === true) {
    // --debug bypasses AuthProvider entirely, including the isAdmin gate
    // (lib/routes/admin-only.js) -- consistent with every other capability
    // this mode already bypasses, not a separate carve-out.
    // quick path in case we are running in container
    if (options.debugKey == null) {
      var session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
      session.serviceID  = serviceID;
      session.actionName = actionName;
      session.isAdmin    = true;
      return callback(null, session);
    }

    var debugKey = options.debugKey;
    if (appKey == null || appKey !== debugKey) {
      return callback(new CHError('SYSTEM_ERROR_UNKNOWN_USER'));
    }
    var session = new Session(req, res, 'debug', appKey, 0, deviceID, 0, localCB);
    session.serviceID  = serviceID;
    session.actionName = actionName;
    session.isAdmin    = true;
    return callback(null, session);
  }

  if (appKey == null) {
    return callback(new CHError('SYSTEM_ERROR_UNKNOWN_USER'));
  }

  // Authorization decision (identity + device ownership) is delegated
  // entirely to the configured AuthProvider (lib/auth/, default
  // FileAuthProvider -- see docs/cdif-audit-and-refactoring-plan.md's
  // AuthProvider section for why this replaced the previous inline
  // Redis-cache-then-CouchDB logic). balance/apiRemainCount are no longer
  // this function's concern -- that's MeteringProvider's domain now (see
  // lib/countinghouse-interface.js's recordCall/checkBalance/rateLimit) --
  // so the constructed Session always gets 0/0 placeholders for those two
  // fields; nothing reads them as real values anymore (the one thing that
  // used to, the realPrice/NOT_ENOUGH_USER_BALANCE gate, was retired
  // alongside this refactor).
  getAuthProvider().authenticate(appKey, deviceID, serviceID, actionName, function(err, result) {
    if (err) return callback(new CHError('SYSTEM_ERROR_USERDB_NA', err.message));
    if (result.ok !== true) return callback(result.err != null ? result.err : new CHError('SYSTEM_ERROR_UNKNOWN_USER', appKey));

    var session = new Session(req, res, result.userName, appKey, 0, deviceID, 0, localCB);
    session.serviceID  = serviceID;
    session.actionName = actionName;
    session.isAdmin    = result.isAdmin === true;
    return callback(null, session);
  });
}

module.exports = doUserAuth;
