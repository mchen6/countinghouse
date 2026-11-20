'use strict';
const express   = require('express');
const {scopeOf, specAsListed, notAvailable} = require('../listing-scope');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;
    // only a module the caller's tools/list could show (lib/listing-scope.js;
    // userAuth has checked the key's grants), checked before the spec is
    // read and again when it is answered: one missing, not listed or hidden
    // is one answer (notAvailable; post-rel caller 400)
    if (scopeOf(cdifInterface, deviceID) !== 'listed') return session.callbackWithoutTimer(notAvailable());
    // the spec as the caller may see it (lib/listing-scope.js specAsListed:
    // no unusable action, no prompt prompts/list leaves out, the declared
    // text cleaned); a copy, the served spec never changed
    // (the spec is answered through session.callback, worker and
    // single-thread mode alike; an error passes as it is)
    const answer = session.callback;
    session.callback = function(err, data, ...rest) {
      // (one gone meanwhile: the same one answer)
      // (or one REST can't reach: a per-session device in shared mode,
      // #482's high, 3)
      if (err != null) return answer.call(this, scopeOf(cdifInterface, deviceID) !== 'listed' || err.code === 'DEVICE_NOT_FOUND' ? notAvailable() : err, data, ...rest);
      const self = this;
      specAsListed(cdifInterface, deviceID, data).then((shown) => {
        const scope = scopeOf(cdifInterface, deviceID);
        if (scope !== 'listed') return answer.call(self, notAvailable(), null, ...rest);
        return answer.call(self, null, shown, ...rest);
      }, (e) => answer.call(self, e, null, ...rest));
    };
    // The device manager's own refusals come through callbackWithoutTimer
    // (ensureListedDevice): a device gone, hidden or one REST can't reach (a
    // per-session device in shared mode) is the same one answer there too
    // (#482's high, 3); never a hop's (it has none here)
    const untimed = session.callbackWithoutTimer;
    session.callbackWithoutTimer = function(err, ...rest) {
      const one = err != null && (scopeOf(cdifInterface, deviceID) !== 'listed' || err.code === 'DEVICE_NOT_FOUND');
      return untimed.call(this, one ? notAvailable() : err, ...rest);
    };
    cdifInterface.getDeviceSpec(deviceID, session);
  });
  return router;
}
