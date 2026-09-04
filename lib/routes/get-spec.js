const express   = require('express');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;

    cdifInterface.getDeviceSpec(deviceID, session);
  });
  return router;
}

