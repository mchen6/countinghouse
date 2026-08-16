const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const registryUrl = req.body.registry;   // usually this points to configured local kappa address
    const packageName = req.body.name;      // local name with absolute path prefix of the zipped package
    const path        = req.body.path;      // absolute path prefix of the installed package temp folder, can be different than zipped package folder
    const apiDesignID = req.body.apiDesignID;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // mm.verifyModule(registryUrl, packageName, path, apiDesignID, session.callbackWithoutTimer.bind(session));
    mm.verifyModule(req.body, session.callbackWithoutTimer.bind(session));
  });
  return router;
}
