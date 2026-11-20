'use strict';
const options   = require('../cli-options');
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const encodeLegacyTool = require('../metering/provider').encodeLegacyTool;

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

module.exports = function(mm, cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {
    const session = req.session;
    const deviceID   = req.params.deviceID;

    // a JSON body (one declared as BSON is refused 415 before any route: lib/route-manager.js)
    const data = req.body;

    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');
    const args       = data;

    if (serviceID == null)  return session.callbackWithoutTimer(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // (names are strings: what a check judges is what is dispatched)
    if (typeof(serviceID) !== 'string') return session.callbackWithoutTimer(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (typeof(actionName) !== 'string') return session.callbackWithoutTimer(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // Only a module the caller's tools/list could show (lib/listing-scope.js:
    // listed, not hidden while it goes on or off; userAuth has checked the
    // key's grants). A part is reached only through its scenario (local-mode
    // spec §3). One missing, not listed or hidden is one answer
    // (notAvailable), as is one gone by the time it answers (post-rel caller
    // 400: no probing which modules exist).
    const {scopeOf, notAvailable} = require('../listing-scope');
    if (scopeOf(cdifInterface, deviceID) !== 'listed') return session.callbackWithoutTimer(notAvailable());
    // An action its declared text leaves unusable (F3-1: the load's one
    // decision, as tools/list and tools/call take it, #400) answers as one
    // that isn't there: ACTION_NOT_FOUND, its catalogue text alone. A
    // missing action's answer is re-issued the same way below, whichever
    // path raised it (a worker's crosses as its code alone, one in this
    // thread with the name).
    const {noAction, oneActionAnswer} = require('../listing-scope');
    if (require('../hidden-text-verdict').unusableAt(deviceID, serviceID, actionName)) {
      return session.callbackWithoutTimer(noAction());
    }
    // (one gone since the check answers the one answer too; a per-session
    // device in shared mode answers it at its source, workerFor, #482's
    // high, 3; a listed device still loading keeps DEVICE_NOT_FOUND; never a
    // hop's refusal, the composer's)
    const {hopped} = require('../countinghouse-error');
    const oneAnswer = (err) => {
      if (err == null || err.origin === 'module' || hopped(err)) return err;
      if (err.code === 'DEVICE_NOT_FOUND' && scopeOf(cdifInterface, deviceID) !== 'listed') return notAvailable();
      return oneActionAnswer(err);
    };
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

    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, session);
  });
  return router;
}
