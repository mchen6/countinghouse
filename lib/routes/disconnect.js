const express = require('express');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = req.session;

    const deviceID = req.params.deviceID;
    const token    = req.body.device_access_token;

    cdifInterface.disconnectDevice(deviceID, token, session);
  });
  return router;
}
