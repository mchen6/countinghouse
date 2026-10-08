const express   = require('express');
const rateLimitGate = require('../rate-limit-gate');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session   = req.session;
    const deviceID  = req.params.deviceID;

    // Rate limited (7.1.2). The 7.0.0 read-path work gated /balance, tasks/*
    // and the job routes and left this one out. Same shared per-apiKey
    // budget, same 429. See lib/rate-limit-gate.js.
    rateLimitGate.guard(cdifInterface, session, res, () => {
      cdifInterface.getDevicePackageInfo(deviceID, (err, packageInfo) => {
        if (err) return session.callbackWithoutTimer(err);
        if (packageInfo == null) return session.callbackWithoutTimer(new Error('null package info'));

        return session.callbackWithoutTimer(null, {name: packageInfo.name, version: packageInfo.version});
      });
    });

  });
  return router;
}
