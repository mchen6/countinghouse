var express    = require('express');
var JobControl = require('../job-control');

module.exports = function() {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var session = req.session;
    var jobID   = req.body.id;

    JobControl.getJob(jobID, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}

