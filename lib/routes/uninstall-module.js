const express = require('express');
const Session = require('../session');

// POST /uninstall-module {name, keepData}: deletes a module's data and its
// registry entry, never its code (lib/module-manager.js uninstallModule).
module.exports = function(mm) {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const name    = req.body.name;
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);

    mm.uninstallModule(name, req.body.keepData === true, (err, result) => {
      if (err != null) return session.callbackWithoutTimer(err);
      return session.callbackWithoutTimer(null, Object.assign({uninstalled: true}, result));
    });
  });
  return router;
};
