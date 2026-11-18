'use strict';
const express   = require('express');
const {withoutUnusable} = require('../hidden-text-verdict');

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').get((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;

    // an action its declared text leaves unusable is not in the spec shown
    // (F3-1, the load's one decision, as tools/list leaves it out; #400)
    // (the spec is answered through session.callback, worker and
    // single-thread mode alike; an error passes as it is)
    const answer = session.callback;
    session.callback = function(err, data, ...rest) {
      return answer.call(this, err, err == null ? withoutUnusable(data, deviceID) : data, ...rest);
    };
    cdifInterface.getDeviceSpec(deviceID, session);
  });
  return router;
}

