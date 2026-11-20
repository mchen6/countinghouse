'use strict';
const options       = require('../cli-options');
const Session       = require('../session');
const express       = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {scopeOf, specAsListed} = require('../listing-scope');
const {deviceIDOf} = require('../hidden-text-verdict');
const userAuth      = require('../user-auth');
const unauthLimit   = require('../unauth-limit');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  // [[deviceID, spec]] (within the caller's grants already) -> Promise of
  // the specs a caller may see: the listed ones (listing-scope scopeOf, the
  // one predicate tools/list lists by), each as specAsListed answers it, the
  // scope checked again once all are ready (one hidden meanwhile is left out)
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

    // the key resolved first (lib/user-auth.js, where a key that doesn't is
    // counted against the address: lib/unauth-limit.js), then its grants as
    // a call reads them (tool-registry grantsForCall: kept a few seconds, the
    // provider's listDevices, '*' every device). A key that doesn't resolve
    // sees no device, as before.
    const identify = (key, cb) => userAuth(null, null, null, key, null, null, () => {}, (err, s) => (err != null ? cb(err) : cb(null, {isAdmin: s.isAdmin === true})));
    require('../mcp/tool-registry').grantsForCall(appkey, identify, (authErr, granted, unread) => {
      if (authErr != null && authErr.code === 'UNAUTH_RATE_LIMITED') return unauthLimit.answerLimited(res, authErr);
      if (authErr != null && authErr.code === 'SYSTEM_ERROR_UNKNOWN_USER') return res.status(200).json([]);
      // (lib/auth's guard: SYSTEM_ERROR_USERDB_NA in the catalogue's words)
      const err = authErr != null ? authErr : unread;
      if (err) return res.status(500).json({code: err.code, message: err.message});

      const allSpecs  = cdifInterface.deviceManager.getAllDeviceSpecs();
      // the grants first, once per device (the cheap part: the high review of
      // #457, 6), then the listing
      const callerSees = require('../mcp/tool-registry').callerSees;
      const mine = Object.keys(allSpecs).filter((id) => callerSees(granted, id));
      shownOf(mine.map((id) => [id, allSpecs[id]])).then((shown) => res.status(200).json(shown), (e) => {
        const failed = new CountinghouseError('SYSTEM_ERROR');
        require('../logger').E(e);
        res.status(500).json({code: failed.code, message: failed.message});
      });
    });
  });
  return router;
}
