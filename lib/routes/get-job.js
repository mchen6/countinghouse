var express    = require('express');
var JobControl = require('../job-control');

module.exports = function() {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = req.session;
    var deviceID = req.params.deviceID;
    var jobID   = req.body.id;

    // Ownership (not just device access) is enforced inside
    // JobControl.getJob via this authCtx -- lib/routes/user.js has already
    // proven who the caller is and whether they can reach this deviceID,
    // but neither of those says the *job* is theirs. See lib/job-control.js.
    var authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.getJob(authCtx, jobID, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}
