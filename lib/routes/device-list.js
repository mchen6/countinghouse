var options       = require('../cli-options');
var Session       = require('../session');
var express       = require('express');
var getAuthProvider = require('../auth').getAuthProvider;
var CHError         = require('../countinghouse-error').CHError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').get(function(req, res) {
    // in debug mode return the list of all managed devices
    // in non-debug mode return user's device list, via the configured
    // AuthProvider's listDevices (lib/auth/) rather than a raw CouchDB
    // view -- see docs/design-decisions.md's AuthProvider
    // section.
    if (options.debug === true) {
      var session = new Session(req, res, 'unknown', 'device-list', 0, null, null, null);
      return cdifInterface.getDiscoveredDeviceList(session);
    }

    var appkey = req.get('X-CH-Key') || req.get('X-App-Key') || req.get('Authorization');

    if (appkey == null) {
      // was: a hardcoded Chinese message with HTTP 500, on a route README
      // documents as public API -- untranslatable via --locale (it never
      // went through CHError) and the wrong status code for "you didn't
      // authenticate". Now uses the standard error catalogue and 403, like
      // every other identity failure.
      var err = new CHError('SYSTEM_ERROR_UNKNOWN_USER');
      return res.status(403).json({topic: err.topic, code: err.code, message: err.message});
    }

    getAuthProvider().listDevices(appkey, function(err, result) {
      if (err) return res.status(500).json({topic: 'countinghouse error', code: err.code, message: err.message});

      var authorizedDeviceIDs = (result != null && Array.isArray(result.devices)) ? result.devices : [];
      var wildcard  = authorizedDeviceIDs.indexOf('*') !== -1;
      var allSpecs  = cdifInterface.deviceManager.getAllDeviceSpecs();
      var deviceList = [];

      for (var deviceID in allSpecs) {
        if (wildcard || authorizedDeviceIDs.indexOf(deviceID) !== -1) {
          deviceList.push(allSpecs[deviceID]);
        }
      }
      res.status(200).json(deviceList);
    });
  });
  return router;
}
