const express = require('express');
const Session = require('../session');

module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const name    = req.body.name;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    // minimal response -- see lib/routes/load-module.js for why these routes
    // no longer echo back whatever internal object the callback carried
    mm.unloadModuleExternal(name, (err) => {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, {unloaded: true, name: name});
    });
  });
  return router;
}
