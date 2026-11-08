const express = require('express');
const Session = require('../session');

// POST /reload-auth (admin only): re-read the auth configuration without a
// restart -- see AuthProvider.prototype.reload. The answer is counts only,
// never keys; a configuration that fails its checks is refused and the
// working one stays.
module.exports = function() {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);
    require('../auth').getAuthProvider().reload((err, result) => {
      if (err != null) return session.callbackWithoutTimer(new CHError('AUTH_RELOAD_INVALID', err.message));
      return session.callbackWithoutTimer(null, result);
    });
  });
  return router;
};
