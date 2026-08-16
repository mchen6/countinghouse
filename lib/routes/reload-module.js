const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const path    = req.body.path;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js
    mm.reloadModule(path, (err) => {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {reloaded: true, path: path});
    });
  });
  return router;
}
