var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var name     = req.body.name;
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    mm.unloadModuleExternal(name);
  });
  return router;
}

