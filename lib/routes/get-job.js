const express    = require('express');
const JobControl = require('../job-control');

module.exports = function() {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = req.session;
    const deviceID = req.params.deviceID;
    const jobID   = req.body.id;

    // Ownership (not just device access) is enforced inside
    // JobControl.getJob via this authCtx -- lib/routes/user.js has already
    // proven who the caller is and whether they can reach this deviceID,
    // but neither of those says the *job* is theirs. See lib/job-control.js.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.getJob(authCtx, jobID, (err, data) => {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}
