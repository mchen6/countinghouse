const express = require('express');
const Session = require('../session');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

// POST /reload-auth (admin only): re-read the auth configuration without a
// restart -- see AuthProvider.prototype.reload. The answer is counts only,
// never keys; a configuration that fails its checks is refused and the
// working one stays.
module.exports = function() {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);
    const provider = require('../auth').getAuthProvider();
    provider.reload((err, result) => {
      if (err != null) return session.callbackWithoutTimer(new CountinghouseError('AUTH_RELOAD_INVALID', err.message));
      // The id index follows the configuration (lib/identity.js).
      require('../identity').rebuild(provider).then(() => session.callbackWithoutTimer(null, result),
        (e) => session.callbackWithoutTimer(new CountinghouseError('AUTH_RELOAD_INVALID', e.message)));
    });
  });
  return router;
};
