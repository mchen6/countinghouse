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

    //TODO: check if the calling user has the permission to remove a specific job by its deviceID, by looking to couchdb
    // or arbitrary user can remove someone else's jobs
    JobControl.removeJob(name, jobID, isRepeat, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}

