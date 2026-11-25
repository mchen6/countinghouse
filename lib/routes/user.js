'use strict';
const {answerError} = require('../countinghouse-error');
const userAuth      = require('../user-auth');
const rateLimitGate = require('../rate-limit-gate');

// (cdifInterface: the per-key limiter's, for a key refused here -- below)
module.exports = (cdifInterface) => function validateUser(req, res, next) {
  let appKey = null;

  const countinghouseKey    = req.get('X-CH-Key');
  const xAppKey     = req.get('X-App-Key');
  const authorization = req.get('Authorization');

  if (countinghouseKey != null) {
    appKey = countinghouseKey;
  } else if (xAppKey != null) {
    appKey = xAppKey;
  } else if (authorization != null) {
    appKey = authorization;
  }

  let serviceID = null, actionName = null;

  if (req.body != null) {
    serviceID  = req.body.serviceID;
    actionName = req.body.actionName;
  }

  if (serviceID == null || actionName == null) {
    serviceID  = req.get('serviceID');
    actionName = req.get('actionName');
  }

  userAuth(req, res, req.params.deviceID, appKey, serviceID, actionName, null, (err, session) => {
    //TODO: log error to redis errorChannel for this error callback path
    // err.code (CountinghouseError) carries the same stable
    // classification Session.prototype.response already exposes for a
    // later-stage failure -- this middleware runs *before* that, so it
    // needs to include it too, or a userAuth failure (e.g.
    // USER_HAS_NO_DEVICE, SYSTEM_ERROR_UNKNOWN_USER) is indistinguishable
    // from any other 500 by anything but its message text.
    // Found via test/auth/01-file-provider-tools-list-filtering.js -- no
    // prior test ever exercised this failure branch (every existing test
    // runs --debug, where userAuth never errors this way).
    // (a device the key isn't granted answers as one that isn't there or
    // isn't listed: one answer, no probing which modules exist; post-rel
    // caller 400)
    // A key that resolved (USER_HAS_NO_DEVICE says it did) spends its
    // per-key unit here, as a dispatched call does in invokeDeviceAction, so
    // asking for devices it can't use is limited too; over its limit, the
    // limiter's answer, the same whatever the device (the limiter PR's
    // medium, 3; #482: one answer per level)
    if (err != null && err.code === 'USER_HAS_NO_DEVICE' && typeof(req.params.deviceID) === 'string') {
      const one = require('../listing-scope').notAvailable();
      return rateLimitGate.check(cdifInterface, appKey, (limited, refusal) => answerError(res, limited === true ? refusal : one));
    }
    // (the limit on keys that don't resolve too: its row's 429, with its
    // hint's Retry-After: #482, merging #483)
    if (err != null) return answerError(res, err);
    req.session = session;
    return next();
  });
}

