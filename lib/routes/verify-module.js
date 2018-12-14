var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var registryUrl = req.body.registry;   // usually this points to configured local kappa address
    var packageName = req.body.name;      // local name with absolute path prefix of the zipped package
    var path        = req.body.path;      // absolute path prefix of the installed package temp folder, can be different than zipped package folder
    var apiDesignID = req.body.apiDesignID;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // mm.verifyModule(registryUrl, packageName, path, apiDesignID, session.callbackWithoutTimer.bind(session));
    mm.verifyModule(req.body, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
