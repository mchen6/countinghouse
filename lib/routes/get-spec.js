'use strict';
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {scopeOf, specAsListed} = require('../listing-scope');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;
    const notListed = () => new CountinghouseError('MODULE_NOT_LISTED', deviceID);

    // only a module the caller's tools/list could show (lib/listing-scope.js;
    // userAuth has checked the key's grants), checked before the spec is
    // read and again when it is answered; one no module serves goes on to
    // its own answer (DEVICE_NOT_FOUND)
    if (scopeOf(cdifInterface, deviceID) === 'unlisted') return session.callbackWithoutTimer(notListed());
    // the spec as the caller may see it (lib/listing-scope.js specAsListed:
    // no unusable action, no prompt prompts/list leaves out, the declared
    // text cleaned); a copy, the served spec never changed
    // (the spec is answered through session.callback, worker and
    // single-thread mode alike; an error passes as it is)
    const answer = session.callback;
    session.callback = function(err, data, ...rest) {
      if (err != null) return answer.call(this, err, data, ...rest);
      const self = this;
      specAsListed(cdifInterface, deviceID, data).then((shown) => {
        if (scopeOf(cdifInterface, deviceID) !== 'listed') return answer.call(self, notListed(), null, ...rest);
        return answer.call(self, null, shown, ...rest);
      }, (e) => answer.call(self, e, null, ...rest));
    };
    cdifInterface.getDeviceSpec(deviceID, session);
  });
  return router;
}
