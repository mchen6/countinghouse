const options       = require('../cli-options');
const Session       = require('../session');
const express       = require('express');
const getAuthProvider = require('../auth').getAuthProvider;
const CHError         = require('../countinghouse-error').CHError;

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').get((req, res) => {
    // in debug mode return the list of all managed devices
    // in non-debug mode return user's device list, via the configured
    // AuthProvider's listDevices (lib/auth/) rather than a raw CouchDB
    // view -- see docs/design-decisions.md's AuthProvider
    // section.
    if (options.debug === true) {
      const session = new Session(req, res, 'unknown', 'device-list', 0, null, null, null);
      return cdifInterface.getDiscoveredDeviceList(session);
    }

    const appkey = req.get('X-CH-Key') || req.get('X-App-Key') || req.get('Authorization');

    if (appkey == null) {
      // was: a hardcoded Chinese message with HTTP 500, on a route README
      // documents as public API -- untranslatable via --locale (it never
      // went through CHError) and the wrong status code for "you didn't
      // authenticate". Now uses the standard error catalogue and 403, like
      // every other identity failure.
      const err = new CHError('SYSTEM_ERROR_UNKNOWN_USER');
      return res.status(403).json({topic: err.topic, code: err.code, message: err.message});
    }

    getAuthProvider().listDevices(appkey, (err, result) => {
      if (err) return res.status(500).json({topic: 'countinghouse error', code: err.code, message: err.message});

      const authorizedDeviceIDs = (result != null && Array.isArray(result.devices)) ? result.devices : [];
      const wildcard  = authorizedDeviceIDs.indexOf('*') !== -1;
      const allSpecs  = cdifInterface.deviceManager.getAllDeviceSpecs();
      const deviceList = [];

      for (const deviceID in allSpecs) {
        if (wildcard || authorizedDeviceIDs.indexOf(deviceID) !== -1) {
          deviceList.push(allSpecs[deviceID]);
        }
      }
      res.status(200).json(deviceList);
    });
  });
  return router;
}
