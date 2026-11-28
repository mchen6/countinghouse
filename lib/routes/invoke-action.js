'use strict';
const options   = require('../cli-options');
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const encodeLegacyTool = require('../metering/provider').encodeLegacyTool;
const rateLimitGate = require('../rate-limit-gate');

// The headers that carry a caller's key, as the auth gate reads them: never
// handed to a module.
const AUTH_HEADERS = new Set(['x-ch-key', 'x-app-key', 'authorization']);

function findKeyInsensitive(obj, key) {
  if (obj == null) return null;

  const objKeys = Object.keys(obj);

  const found = objKeys.find((item) => {
    return item.toLowerCase() === key.toLowerCase();
  });

  if (found != null) return obj[found];
  return null;
}

// What the route answers for an error the call ends with. One gone since the check answers the one answer too; a listed device still
// loading keeps DEVICE_NOT_FOUND; never one that left a handler, the module's answer. A call held for its module's verdict and
// released without running (purged at its verdict, its device ended, its grant revoked: the main thread's own mark, goneAtVerdict,
// which no module's error carries) is the one answer for a device the caller can't use, whatever the device's scope: it tells nothing
// a call to a device never hosted would not.
function oneAnswerFor(cdifInterface, deviceID) {
  const {scopeOf, notAvailable, oneActionAnswer} = require('../listing-scope');
  const {fromHandler} = require('../countinghouse-error');
  return (err) => {
    if (err == null || err.origin === 'module' || fromHandler(err)) return err;
    if (err.goneAtVerdict === true) return notAvailable();
    if (err.code === 'DEVICE_NOT_FOUND' && scopeOf(cdifInterface, deviceID) !== 'listed') return notAvailable();
    return oneActionAnswer(err);
  };
}

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = req.session;
    const deviceID   = req.params.deviceID;
    // A refusal before the dispatch spends the key's per-key unit, as a
    // dispatched call does in invokeDeviceAction (once either way): a valid
    // key asking for what it can't use is limited too, and over its limit
    // gets the limiter's answer whatever it asked (the limiter PR's medium,
    // 3; #482: one answer per level). session.appKey is userAuth's,
    // resolved.
    const refuse = (err) => rateLimitGate.check(cdifInterface, session.appKey,
      (limited, refusal) => session.callbackWithoutTimer(limited === true ? refusal : err));

    // a JSON body (one declared as BSON is refused 415 before any route: lib/route-manager.js)
    const data = req.body;

    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');
    const args       = data;

    if (serviceID == null)  return refuse(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return refuse(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // (names are strings: what a check judges is what is dispatched)
    if (typeof(serviceID) !== 'string') return refuse(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (typeof(actionName) !== 'string') return refuse(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // Only a module the caller's tools/list could show (lib/listing-scope.js:
    // listed, not hidden while it goes on or off; userAuth has checked the
    // key's grants). A part is reached only through its scenario (local-mode
    // spec §3). One missing, not listed or hidden is one answer
    // (notAvailable), as is one gone by the time it answers (post-rel caller
    // 400: no probing which modules exist).
    const {scopeOf, notAvailable, restReaches} = require('../listing-scope');
    if (scopeOf(cdifInterface, deviceID) !== 'listed' || !restReaches(cdifInterface, deviceID)) return refuse(notAvailable());
    // An action its declared text leaves unusable (F3-1: the load's one
    // decision, as tools/list and tools/call take it, #400) answers as one
    // that isn't there: ACTION_NOT_FOUND, its catalogue text alone. A
    // missing action's answer is re-issued the same way below, whichever
    // path raised it (a worker's crosses as its code alone, one in this
    // thread with the name).
    const {noAction} = require('../listing-scope');
    if (require('../hidden-text-verdict').unusableAt(deviceID, serviceID, actionName)) {
      return refuse(noAction());
    }
    const oneAnswer = oneAnswerFor(cdifInterface, deviceID);
    const timed = session.callback;
    const untimed = session.callbackWithoutTimer;
    session.callback = function(err, ...rest) { return timed.call(this, oneAnswer(err), ...rest); };
    session.callbackWithoutTimer = function(err, ...rest) { return untimed.call(this, oneAnswer(err), ...rest); };

    // build argument object
    const argumentList = {};

    // 'input' is uniformly how an input argument is identified. The
    // --allowSimpleType alternative (copy every top-level body key in as its
    // own argument) is gone: it existed so an action could take bare scalars
    // instead of one object, which no module ever used and which the spec
    // format no longer expresses.
    argumentList.input       = args.input;
    argumentList.ctx         = session;
    // The request's headers minus the ones the auth gate reads (R2-1 Task 5,
    // spec section 2): no key reaches the module through them.
    argumentList.httpHeaders = Object.fromEntries(Object.entries(req.headers || {})
      .filter(([name]) => !AUTH_HEADERS.has(String(name).toLowerCase())));

    // Opt this session in to per-call metering (S3). Session.prototype.response
    // fires it on success, using the same recordCall/mcpToolCallCost the MCP
    // tools/call path uses. encodeLegacyTool is the same `tool` encoding the
    // two cross-worker call paths already record with
    // (lib/device-manager.js, lib/peer-channel-broker.js), so an action
    // invoked over HTTP and the same action invoked over MCP land on the
    // same metering identity rather than two parallel ones.
    session.meteredTool = encodeLegacyTool(deviceID, serviceID, actionName);
    // (billed: its gate asks first whether the charge can be recorded)
    session.billed = true;

    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, session);
  });
  return router;
}
// (for tests: the route's one-answer mapping)
module.exports.oneAnswerFor = oneAnswerFor;
