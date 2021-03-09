var express   = require('express');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').get(function(req, res) {
    var session   = req.session;
    var deviceID  = req.params.deviceID;

    cdifInterface.getDevicePackageInfo(deviceID, function(err, packageInfo) {
      if (err) return session.callbackWithoutTimer(err);
      if (packageInfo == null) return session.callbackWithoutTimer(new Error('null package info'));

      return session.callbackWithoutTimer(null, {name: packageInfo.name, version: packageInfo.version});
    });

  });
  return router;
}

