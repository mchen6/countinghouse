'use strict';
const options       = require('../cli-options');
const Session       = require('../session');
const express       = require('express');
const getAuthProvider = require('../auth').getAuthProvider;
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {scopeOf, specAsListed} = require('../listing-scope');
const {deviceIDOf} = require('../hidden-text-verdict');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  // [[deviceID, spec]] -> Promise of the specs a caller may see: the listed
  // ones, each as specAsListed answers it, the scope checked again once all
  // are ready (one hidden meanwhile is left out)
  const shownOf = (entries) => {
    const listed = entries.filter(([id]) => scopeOf(cdifInterface, id) === 'listed');
    return Promise.all(listed.map(([id, spec]) => specAsListed(cdifInterface, id, spec)))
      .then((specs) => specs.filter((s, i) => scopeOf(cdifInterface, listed[i][0]) === 'listed'));
  };

  router.route('/').get((req, res) => {
    // in debug mode return the list of all managed devices
    // in non-debug mode return user's device list, via the configured
    // AuthProvider's listDevices (lib/auth/) rather than a raw CouchDB
    // view -- see docs/design-decisions.md's AuthProvider
    // section.
    // Either way, only the modules a caller's tools/list could show, each as
    // it may see it (lib/listing-scope.js: no unlisted part, no non-scenario
    // module under the single-identity profile, none going on or off; the
    // declared text cleaned, no unusable action, no prompt prompts/list
    // leaves out: the high review of #447, 1), so this list never shows
    // what get-spec refuses.
    if (options.debug === true) {
      const session = new Session(req, res, 'unknown', 'device-list', 0, null, null, null);
      // (its own shape: each device's description, an empty serviceList)
      const answer = session.callbackWithoutTimer.bind(session);
      session.callbackWithoutTimer = (err, list, ...rest) => {
        if (err != null || !Array.isArray(list)) return answer(err, list, ...rest);
        return shownOf(list.map((d) => [deviceIDOf(d), d])).then((shown) => answer(null, shown, ...rest), (e) => answer(e, null, ...rest));
      };
      return cdifInterface.getDiscoveredDeviceList(session);
    }

    const appkey = req.get('X-CH-Key') || req.get('X-App-Key') || req.get('Authorization');

    if (appkey == null) {
      // was: a hardcoded Chinese message with HTTP 500, on a route README
      // documents as public API -- untranslatable via --locale (it never
      // went through CountinghouseError) and the wrong status code for "you didn't
      // authenticate". Now uses the standard error catalogue and 403, like
      // every other identity failure.
      const err = new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER');
      return res.status(403).json({code: err.code, message: err.message});
    }

    getAuthProvider().listDevices(appkey, (err, result) => {
      if (err) return res.status(500).json({code: err.code, message: err.message});

      const authorizedDeviceIDs = (result != null && Array.isArray(result.devices)) ? result.devices : [];
      const wildcard  = authorizedDeviceIDs.indexOf('*') !== -1;
      const allSpecs  = cdifInterface.deviceManager.getAllDeviceSpecs();
      const deviceList = [];

      for (const deviceID in allSpecs) {
        if (wildcard || authorizedDeviceIDs.indexOf(deviceID) !== -1) deviceList.push([deviceID, allSpecs[deviceID]]);
      }
      shownOf(deviceList).then((shown) => res.status(200).json(shown), (e) => {
        const failed = new CountinghouseError('SYSTEM_ERROR');
        require('../logger').E(e);
        res.status(500).json({code: failed.code, message: failed.message});
      });
    });
  });
  return router;
}
