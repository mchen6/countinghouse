const express    = require('express');
const JobControl = require('../job-control');

module.exports = function() {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session  = req.session;
    const deviceID = req.params.deviceID;
    const name     = req.body.name;

    // Job names are caller-chosen and therefore not an ownership boundary
    // (this route's own TODO noted the same gap from the deviceID angle) --
    // JobControl.getJobHistory filters the returned records to the ones this
    // apiKey actually owns. See lib/job-control.js.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.getJobHistory(authCtx, name, (err, data) => {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}
