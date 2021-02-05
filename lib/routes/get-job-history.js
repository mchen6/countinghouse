var express    = require('express');
var JobControl = require('../job-control');

module.exports = function() {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session  = req.session;
    var deviceID = req.params.deviceID;
    var name     = req.body.name;

    //TODO: check if the input name belongs to this specific deviceID
    JobControl.getJobHistory(name, function(err, data) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, data);
    });
  });
  return router;
}

