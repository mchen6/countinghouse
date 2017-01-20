var express   = require('express');
var CdifError = require('../cdif-error').CdifError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').get(function(req, res) {
    var session   = req.session;
    var deviceID  = req.params.deviceID;
    var serviceID = req.body.serviceID;
    var token     = req.body.device_access_token;

    cdifInterface.getDeviceState(deviceID, serviceID, token, session);
  });
  return router;
}

