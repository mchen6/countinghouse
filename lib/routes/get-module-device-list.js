const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const name = req.body.name;   // module's name
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // mm.verifyModule(registryUrl, packageName, path, apiDesignID, session.callbackWithoutTimer.bind(session));
    mm.getModuleDeviceListByName(name, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
