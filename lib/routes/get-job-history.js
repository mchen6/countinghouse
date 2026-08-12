var express    = require('express');
var JobControl = require('../job-control');

module.exports = function() {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session  = req.session;
    var deviceID = req.params.deviceID;
    var name     = req.body.name;

    // Job names are caller-chosen and therefore not an ownership boundary
    // (this route's own TODO noted the same gap from the deviceID angle) --
    // JobControl.getJobHistory filters the returned records to the ones this
    // apiKey actually owns. See lib/job-control.js.
    var authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.getJobHistory(authCtx, name, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}
