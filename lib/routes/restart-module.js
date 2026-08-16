const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const path    = req.body.path;
    const name    = req.body.name;
    const version = req.body.version;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js
    mm.restartModule(path, name, version, (err) => {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {restarted: true, name: name, version: version});
    });
  });
  return router;
}
