var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var name    = req.body.name;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js for why these routes
    // no longer echo back whatever internal object the callback carried
    mm.unloadModuleExternal(name, function(err) {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {unloaded: true, name: name});
    });
  });
  return router;
}
