const options   = require('../cli-options');
const express   = require('express');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;
const BSON      = require('bson');
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

    //by default we handle application/json
    //and in case of application/bson we deserialize it first to a json object
    let data = req.body;

    if (req.headers['content-type'] === 'application/bson') {
      try {
        data = BSON.deserialize(req.body, {promoteBuffers: true}); //deserialize BSON so we can identify serviceID and actionName in it
      } catch (e) {
        return session.callbackWithoutTimer(new CountinghouseError('INVALID_BSON_REQUEST', e.message));
      }
    }

    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');
    const args       = data;

    if (serviceID == null)  return session.callbackWithoutTimer(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // A module that is loaded but not listed (a scenario's part) is reached
    // only through its scenario (local-mode spec §3).
    if (require('../mcp/tool-registry').listingOf(cdifInterface, deviceID).listed === false) {
      return session.callbackWithoutTimer(new CountinghouseError('MODULE_NOT_LISTED', deviceID));
    }

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
