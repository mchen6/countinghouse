const express   = require('express');
const CHError = require('../countinghouse-error').CHError;

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/*').get((req, res) => {
    const session  = req.session;
    const deviceID = req.params.deviceID;
    const path     = req.path;

    cdifInterface.getDeviceSchema(deviceID, path, session);
  });
  return router;
}

