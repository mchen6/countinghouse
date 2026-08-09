var userAuth      = require('../user-auth');

var validateUser = function(req, res, next) {
  var appKey = null;

  var countinghouseKey    = req.get('X-CH-Key');
  var xAppKey     = req.get('X-App-Key');
  var authorization = req.get('Authorization');

  if (countinghouseKey != null) {
    appKey = countinghouseKey;
  } else if (xAppKey != null) {
    appKey = xAppKey;
  } else if (authorization != null) {
    appKey = authorization;
  }

  var serviceID = null, actionName = null;

  if (req.body != null) {
    serviceID  = req.body.serviceID;
    actionName = req.body.actionName;
  }

  if (serviceID == null || actionName == null) {
    serviceID  = req.get('serviceID');
    actionName = req.get('actionName');
  }

  userAuth(req, res, req.params.deviceID, appKey, serviceID, actionName, null, function(err, session) {
    //TODO: log error to redis errorChannel for this error callback path
    // err.code (CHError/DeviceError) carries the same locale-independent
    // classification Session.prototype.response already exposes for a
    // later-stage failure -- this middleware runs *before* that, so it
    // needs to include it too, or a userAuth failure (e.g.
    // USER_HAS_NO_DEVICE, SYSTEM_ERROR_UNKNOWN_USER) is indistinguishable
    // from any other 500 by anything but locale-dependent message text.
    // Found via test/auth/01-file-provider-tools-list-filtering.js -- no
    // prior test ever exercised this failure branch (every existing test
    // runs --debug, where userAuth never errors this way).
    if (err != null) return res.status(500).json({topic: err.topic, code: err.code, message: err.message});
    req.session = session;
    return next();
  });
}

module.exports = validateUser;
