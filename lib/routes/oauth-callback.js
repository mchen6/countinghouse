const express   = require('express');
const CHError = require('../countinghouse-error').CHError;

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').get((req, res) => {
    const session  = req.session;
    let deviceID = null;
    const params   = req.query;

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

