const express = require('express');
const Session = require('../session');
const CHError = require('../countinghouse-error').CHError;
const identity = require('../identity');

// POST /identity-lookup {id} (admin only, mounted behind admin-only.js): the
// user behind an opaque id this server issued -- {id, userName, isAdmin},
// never the key -- or IDENTITY_NOT_FOUND (lib/identity.js).
module.exports = function() {
  const router = express.Router();

  router.route('/').post((req, res) => {
    const session = new Session(req, res, 'debug', 'debug', 0, null, null, null);
    const id = (req.body != null) ? req.body.id : null;
    if (typeof(id) !== 'string' || id === '') return session.callbackWithoutTimer(new CHError('IDENTITY_NOT_FOUND', 'id must be a non-empty string'));
    const provider = (require('../cli-options').debug === true) ? null : require('../auth').getAuthProvider();
    identity.resolve(id, provider, (err, found) => {
      if (err != null) return session.callbackWithoutTimer(new CHError('SYSTEM_ERROR_USERDB_NA', err.message));
      if (found == null) return session.callbackWithoutTimer(new CHError('IDENTITY_NOT_FOUND'));
      return session.callbackWithoutTimer(null, {id: id, userName: found.userName, isAdmin: found.isAdmin});
    });
  });
  return router;
};
