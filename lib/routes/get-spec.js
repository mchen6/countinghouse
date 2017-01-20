var express   = require('express');
var CdifError = require('../cdif-error').CdifError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').get(function(req, res) {
    var session = req.session;
    var deviceID = req.params.deviceID;
    var token    = req.body.device_access_token;

    cdifInterface.getDeviceSpec(deviceID, token, session);
  });
  return router;
}

