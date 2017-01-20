var express   = require('express');
var CdifError = require('../cdif-error').CdifError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').get(function(req, res) {
    var session  = req.session;
    var deviceID = null;
    var params   = req.query;

    // console.log(params);
    if (params.state != null) {
      deviceID = params.state;    // oauth 2.0 bring back device ID in state param
    } else {
      deviceID = params.deviceID;
    }
    cdifInterface.setDeviceOAuthAccessToken(deviceID, params, session);
  });
  return router;
}

