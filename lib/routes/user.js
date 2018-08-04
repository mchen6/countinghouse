var userAuth      = require('../user-auth');

var validateUser = function(req, res, next) {
  var appKey = null;

  var apemeshKey    = req.get('X-Apemesh-Key');
  var xAppKey     = req.get('X-App-Key');
  var authorization = req.get('Authorization');

  if (apemeshKey != null) {
    appKey = apemeshKey;
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
    if (err != null) return res.status(500).json({topic: 'cdif error', message: err.message});
    req.session = session;
    return next();
  });
}

module.exports = validateUser;
