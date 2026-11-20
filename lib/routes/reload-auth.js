'use strict';
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
    // (the grant sets and the id index follow it: lib/auth reloadAuth)
    require('../auth').reloadAuth((err, result) => (err != null
      ? session.callbackWithoutTimer(new CountinghouseError('AUTH_RELOAD_INVALID', err.message))
      : session.callbackWithoutTimer(null, result)));
  });
  return router;
};
