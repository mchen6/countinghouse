var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var path     = req.body.path;
    var name     = req.body.name;
    var version  = req.body.version;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    mm.loadModuleFromPath(path, name, version, session.callbackWithoutTimer.bind(session));
  });
  return router;
}

// data.loadModule.path, data.loadModule.name, data.loadModule.version