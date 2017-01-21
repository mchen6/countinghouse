var express   = require('express');
var Session   = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/*').get(function(req, res) {
    var session = new Session(req, res, 'unknown', 'url_callback', 0, null, null);

    var deviceID   = req.params.deviceID;
    var path       = req.path;
    var data       = {query: req.query, body: req.body};
    var token      = req.body.device_access_token;

    cdifInterface.invokeDeviceCallbacks(deviceID, path, data, token, session);
  });

  router.route('/*').post(function(req, res) {
    var session = new Session(req, res, 'unknown', 'url_callback', 0, null, null);

    var deviceID   = req.params.deviceID;
    var path       = req.path;
    var data       = {query: req.query, body: req.body};
    var token      = req.body.device_access_token;
    console.log(req.headers);
    console.log(req.body);
    cdifInterface.invokeDeviceCallbacks(deviceID, path, data, token, session);
  });
  return router;
}
