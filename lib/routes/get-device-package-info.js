const express   = require('express');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session   = req.session;
    const deviceID  = req.params.deviceID;

    cdifInterface.getDevicePackageInfo(deviceID, (err, packageInfo) => {
      if (err) return session.callbackWithoutTimer(err);
      if (packageInfo == null) return session.callbackWithoutTimer(new Error('null package info'));

      return session.callbackWithoutTimer(null, {name: packageInfo.name, version: packageInfo.version});
    });

  });
  return router;
}

