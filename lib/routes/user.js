var userAuth      = require('../user-auth');

var validateUser = function(req, res, next) {
  var appKey = req.get('X-Apemesh-Key');

  userAuth(req, res, req.params.deviceID, appKey, req.body.serviceID, req.body.actionName, null, function(err, session) {
    if (err != null) return res.status(500).json({topic: 'cdif error', message: err.message});
    req.session = session;
    return next();
  });   // = function(req, res, deviceID, appKey, serviceID, actionName, localCB, callback) {
}

module.exports = validateUser;
