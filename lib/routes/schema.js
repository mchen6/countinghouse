const express   = require('express');
const CHError = require('../countinghouse-error').CHError;

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/*').get((req, res) => {
    const session  = req.session;
    const deviceID = req.params.deviceID;
    const token    = req.body.device_access_token;
    const path     = req.path;

    cdifInterface.getDeviceSchema(deviceID, path, token, session);
  });
  return router;
}

