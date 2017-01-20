var express = require('express');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = req.session;

    var deviceID = req.params.deviceID;
    var token    = req.body.device_access_token;

    cdifInterface.disconnectDevice(deviceID, token, session);
  });
  return router;
}
