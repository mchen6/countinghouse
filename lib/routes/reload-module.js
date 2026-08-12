var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var path    = req.body.path;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js
    mm.reloadModule(path, function(err) {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {reloaded: true, path: path});
    });
  });
  return router;
}
