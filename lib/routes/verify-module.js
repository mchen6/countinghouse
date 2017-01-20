var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var packageName = req.body.name;      // local name with absolute path prefix of the zipped package
    var session = new Session(req, res, 'debug', 'debug', 0, null, null);

    mm.verifyModule(packageName, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
