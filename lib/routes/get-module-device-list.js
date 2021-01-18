var express = require('express');
var Session = require('../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router();

  router.route('/').post(function(req, res) {
    var name = req.body.name;   // module's name
    var session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // mm.verifyModule(registryUrl, packageName, path, apiDesignID, session.callbackWithoutTimer.bind(session));
    mm.getModuleDeviceListByName(name, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
