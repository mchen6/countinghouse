'use strict';
// After every device route (lib/route-manager.js): a request under
// /devices/<id>/ that no route answered -- a sub-path none serves, or a
// method a route doesn't take (GET .../invoke-action) -- gets the one answer
// a device the caller can't use gets (MODULE_NOT_LISTED 404, JSON), after
// spending the key's one unit, as every device route does. Before, Express's
// HTML 404 answered it, unlimited: a key granted every device got unlimited
// auth lookups, and the answer (HTML here, userAuth's JSON for a device it
// isn't granted) told a key its own grants (#512's high).
// userAuth (lib/routes/user.js) has run before: req.session is the
// resolved caller's.
const {answerError} = require('../countinghouse-error');
const rateLimitGate = require('../rate-limit-gate');
const {notAvailable} = require('../listing-scope');

module.exports = (cdifInterface) => function deviceFallback(req, res) {
  const appKey = req.session != null ? req.session.appKey : null;
  return rateLimitGate.check(cdifInterface, appKey, (limited, refusal) => answerError(res, limited === true ? refusal : notAvailable()));
};
