var express = require('express');

// GET /balance -- returns the caller's current metering balance via
// CdifInterface.prototype.checkBalance (lib/countinghouse-interface.js),
// backed by MeteringProvider.checkBalance (lib/metering/redis-provider.js).
// Not device-scoped (no :deviceID in the path), so this is mounted directly
// on the app rather than under deviceControlRouter, and does its own
// lightweight X-CH-Key extraction instead of the full lib/routes/user.js
// validateUser flow (which requires a deviceID for its CouchDB
// device-ownership check that checkBalance doesn't need).
module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').get(function(req, res) {
    var appKey = req.get('X-CH-Key') || req.get('X-App-Key') || req.get('Authorization');

    if (appKey == null) {
      return res.status(500).json({topic: 'countinghouse error', code: 'SYSTEM_ERROR_UNKNOWN_USER', message: 'must supply X-CH-Key'});
    }

    cdifInterface.checkBalance(appKey, function(err, result) {
      if (err != null) {
        return res.status(500).json({topic: err.topic || 'countinghouse error', code: err.code, message: err.message});
      }
      return res.status(200).json(result);
    });
  });

  return router;
};
