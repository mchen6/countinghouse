// Gates the module-lifecycle routes (load/unload/restart/verify/reload
// -module, get-module-device-list, shutdown) on the caller's apiKey
// having admin rights -- see lib/auth/provider.js's isAdmin doc and
// docs/design-decisions.md. Structurally mirrors routes/user.js (same
// header extraction, same doUserAuth call, same error-response shape),
// deliberately reusing doUserAuth rather than a separate auth path: it
// already has the --debug/--debugKey handling this needs (--debug
// bypasses this the same way it bypasses device-level userAuth), and
// already knows how to construct a Session with isAdmin set correctly.
// deviceID/serviceID/actionName are all null -- admin is a
// device-independent capability, same "device-level-only check"
// convention doUserAuth's own header comment already documents for
// lib/peer-channel-broker.js's D3 grant-time check.
const doUserAuth = require('../user-auth');
const CHError    = require('../countinghouse-error').CHError;

const adminOnly = function(req, res, next) {
  let appKey = null;

  const countinghouseKey = req.get('X-CH-Key');
  const xAppKey           = req.get('X-App-Key');
  const authorization     = req.get('Authorization');

  if (countinghouseKey != null) {
    appKey = countinghouseKey;
  } else if (xAppKey != null) {
    appKey = xAppKey;
  } else if (authorization != null) {
    appKey = authorization;
  }

  doUserAuth(req, res, null, appKey, null, null, null, (err, session) => {
    if (err != null) return res.status(403).json({topic: err.topic, code: err.code, message: err.message});

    if (session.isAdmin !== true) {
      const adminErr = new CHError('ADMIN_REQUIRED');
      return res.status(403).json({topic: adminErr.topic, code: adminErr.code, message: adminErr.message});
    }

    req.session = session;
    return next();
  });
};

module.exports = adminOnly;
