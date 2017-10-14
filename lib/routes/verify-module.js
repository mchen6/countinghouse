var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var packageName = req.body.name;      // local name with absolute path prefix of the zipped package
    var path        = req.body.path;      // absolute path prefix of the installed package temp folder, can be different than zipped package folder
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    mm.verifyModule(packageName, path, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
