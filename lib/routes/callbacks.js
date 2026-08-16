const express   = require('express');
const Session   = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/*').get((req, res) => {
    const session = new Session(req, res, 'unknown', 'url_callback', 0, null, null, null);

    const deviceID   = req.params.deviceID;
    const path       = req.path;
    const data       = {query: req.query, body: req.body};
    const token      = req.body.device_access_token;

    cdifInterface.invokeDeviceCallbacks(deviceID, path, data, token, session);
  });

  router.route('/*').post((req, res) => {
    const session = new Session(req, res, 'unknown', 'url_callback', 0, null, null, null);

    const deviceID   = req.params.deviceID;
    const path       = req.path;
    const data       = {query: req.query, body: req.body};
    const token      = req.body.device_access_token;
    cdifInterface.invokeDeviceCallbacks(deviceID, path, data, token, session);
  });
  return router;
}
