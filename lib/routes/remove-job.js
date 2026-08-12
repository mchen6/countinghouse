var express    = require('express');
var JobControl = require('../job-control');

module.exports = function() {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session  = req.session;
    var name     = req.body.name;
    var jobID    = req.body.id;
    var isRepeat = req.body.isRepeat;
    var deviceID = req.params.deviceID;

    // Closes the hole this route's own long-standing TODO described
    // ("arbitrary user can remove someone else's jobs"): JobControl.removeJob
    // now refuses a job whose recorded owner isn't this apiKey. See
    // lib/job-control.js for the ownership model, including why removing a
    // *repeatable* scheduler (isRepeat: true) requires admin.
    var authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.removeJob(authCtx, name, jobID, isRepeat, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}
