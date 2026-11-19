'use strict';
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const {withoutUnusable} = require('../hidden-text-verdict');
const {listedNow} = require('../listing-scope');
const {cleanedSpecText} = require('../spec-text');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;

    // only a module the caller's tools/list could show (lib/listing-scope.js:
    // listed, not hidden while going on or off; userAuth has checked the
    // key's grants), checked before the spec is read and again when it
    // arrives; any other is refused whole (the reviewer's rulings on #400's
    // follow-up)
    if (!listedNow(cdifInterface, deviceID)) return session.callbackWithoutTimer(new CountinghouseError('MODULE_NOT_LISTED', deviceID));
    // an action its declared text leaves unusable is not in the spec shown
    // (F3-1, the load's one decision, as tools/list leaves it out; #400),
    // and the declared text of the rest is cleaned as the lists show it
    // (lib/spec-text.js): a copy, the served spec never changed
    // (the spec is answered through session.callback, worker and
    // single-thread mode alike; an error passes as it is)
    const answer = session.callback;
    // (a prompt prompts/list leaves out is left out too: HTTP never shows
    // what the listing hides)
    session.callback = function(err, data, ...rest) {
      if (err != null) return answer.call(this, err, data, ...rest);
      if (!listedNow(cdifInterface, deviceID)) return answer.call(this, new CountinghouseError('MODULE_NOT_LISTED', deviceID), null, ...rest);
      const self = this;
      require('../mcp/prompts').hiddenPromptsOf(cdifInterface, deviceID, data).then((leaveOut) => {
        if (!listedNow(cdifInterface, deviceID)) return answer.call(self, new CountinghouseError('MODULE_NOT_LISTED', deviceID), null, ...rest);
        return answer.call(self, null, cleanedSpecText(withoutUnusable(data, deviceID), {leaveOut}), ...rest);
      }, (e) => answer.call(self, e, null, ...rest));
    };
    cdifInterface.getDeviceSpec(deviceID, session);
  });
  return router;
}
