var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var path    = req.body.path;
    var name    = req.body.name;
    var version = req.body.version;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js
    mm.restartModule(path, name, version, function(err) {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {restarted: true, name: name, version: version});
    });
  });
  return router;
}
