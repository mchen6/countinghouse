var express   = require('express');
var Session   = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').get(function(req, res) {
    var session = new Session(req, res, 'unknown', 'load_profile', 0, null, null, null);

    var interval = 60 * 1000;
    if (req.body && req.body.interval) {
      interval = req.body.interval;
    }

    cdifInterface.getServerLoadLevel(interval, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
