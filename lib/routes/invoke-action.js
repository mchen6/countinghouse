const options   = require('../cli-options');
const express   = require('express');
const CHError = require('../countinghouse-error').CHError;
const BSON      = require('bson');
const encodeLegacyTool = require('../metering/redis-provider').encodeLegacyTool;

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
        return session.callbackWithoutTimer(new CHError('INVALID_BSON_REQUEST', e.message));
      }
    }

    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');
    const args       = data;

    if (serviceID == null)  return session.callbackWithoutTimer(new CHError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CHError('ACTIONNAME_NOT_AVAILABLE'));

    // build argument object
    const argumentList = {};

    // 'input' is uniformly how an input argument is identified. The
    // --allowSimpleType alternative (copy every top-level body key in as its
    // own argument) is gone: it existed so an action could take bare scalars
    // instead of one object, which no module ever used and which the spec
    // format no longer expresses.
    argumentList.input       = args.input;
    argumentList.ctx         = session;
    argumentList.httpHeaders = req.headers;

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
