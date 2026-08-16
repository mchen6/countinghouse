const express    = require('express');
const doUserAuth = require('../user-auth');

// GET /balance -- returns the *caller's own* current metering balance via
// CdifInterface.prototype.checkBalance (lib/countinghouse-interface.js),
// backed by MeteringProvider.checkBalance (lib/metering/redis-provider.js).
//
// Authenticated (S6). This route used to take the apiKey straight off the
// header and hand it to checkBalance with no AuthProvider involvement at
// all, so any string was accepted -- `X-CH-Key: totally-made-up-key`
// answered HTTP 200 {"balance": 0}. That made it an unauthenticated balance
// oracle for any key value an attacker learned or guessed, and an
// unauthenticated, unmetered Redis round trip per request.
//
// deviceID/serviceID/actionName are null: a balance is a property of the
// apiKey, not of any device, so this is a device-independent identity check
// -- the same use of doUserAuth lib/routes/admin-only.js already makes.
// Balance is deliberately
// read back from the *authenticated* session's appKey rather than from the
// raw header, so there is no path by which one key can ask about another.
module.exports = function(mm, cdifInterface) {
  const router = express.Router();

  router.route('/').get((req, res) => {
    const appKey = req.get('X-CH-Key') || req.get('X-App-Key') || req.get('Authorization');

    doUserAuth(req, res, null, appKey, null, null, null, (err, session) => {
      if (err != null) {
        return res.status(403).json({topic: err.topic, code: err.code, message: err.message});
      }

      cdifInterface.checkBalance(session.appKey, (err, result) => {
        if (err != null) {
          return res.status(500).json({topic: err.topic || 'countinghouse error', code: err.code, message: err.message});
        }
        return res.status(200).json(result);
      });
    });
  });

  return router;
};
