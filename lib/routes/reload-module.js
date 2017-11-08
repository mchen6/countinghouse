var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var path  = req.body.path;        // base path of the module being reloaded
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    mm.reloadModule(path, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
