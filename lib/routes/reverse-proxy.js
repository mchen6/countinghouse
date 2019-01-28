var express   = require('express');
var requestProxy = require("express-request-proxy");

module.exports = function(app, mm, cdifInterface) {
  var router = express.Router({mergeParams: true});
  // app.all('/devices/*', function(req, res) {
  //   apiProxy.web(req, res, {target: 'http://10.0.0.122:9527'});
  // });
  router.route('/api-proxy').all(function(req, res) {
    var session = req.session;
    var deviceID = req.params.deviceID;

    //TODO: dispatch request to different registered devices with deviceID
    // apiProxy.web(req, res, {target: 'http://10.0.0.122:9527/devices/3a509370-6db9-5fd0-9e98-4a912810d805/invoke-action'});

    requestProxy({
      url: "http://10.0.0.122:9527/devices/3a509370-6db9-5fd0-9e98-4a912810d805/invoke-action",
    });

  });
  return router;
}