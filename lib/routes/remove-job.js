const express    = require('express');
const JobControl = require('../job-control');
const rateLimitGate = require('../rate-limit-gate');

module.exports = function(cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session  = req.session;
    const name     = req.body.name;
    const jobID    = req.body.id;
    const isRepeat = req.body.isRepeat;
    const deviceID = req.params.deviceID;

    // Closes the hole this route's own long-standing TODO described
    // ("arbitrary user can remove someone else's jobs"): JobControl.removeJob
    // now refuses a job whose recorded owner isn't this apiKey. See
    // lib/job-control.js for the ownership model, including why removing a
    // *repeatable* scheduler (isRepeat: true) requires admin.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    // Rate limited (7.0.0), same correction as /get-job. See lib/rate-limit-gate.js.
    rateLimitGate.guard(cdifInterface, session, res, () => {
      JobControl.removeJob(authCtx, name, jobID, isRepeat, (err, data) => {
        if (err) return session.callbackWithoutTimer(err);

        return session.callbackWithoutTimer(null, data);
      });
    });
  });
  return router;
}
