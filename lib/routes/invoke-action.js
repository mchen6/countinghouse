var options   = require('../cli-options');
var express   = require('express');
var CHError = require('../countinghouse-error').CHError;
var BSON      = require('bson');
var encodeLegacyTool = require('../metering/redis-provider').encodeLegacyTool;

function findKeyInsensitive(obj, key) {
  if (obj == null) return null;

  var objKeys = Object.keys(obj);

  var found = objKeys.find(function(item) {
    return item.toLowerCase() === key.toLowerCase();
  });

  if (found != null) return obj[found];
  return null;
}

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = req.session;
    var deviceID   = req.params.deviceID;

    //by default we handle application/json
    //and in case of application/bson we deserialize it first to a json object
    var data = req.body;

    if (req.headers['content-type'] === 'application/bson') {
      try {
        data = BSON.deserialize(req.body, {promoteBuffers: true}); //deserialize BSON so we can identify serviceID and actionName in it
      } catch (e) {
        return session.callbackWithoutTimer(new CHError('INVALID_BSON_REQUEST', e.message));
      }
    }

    var serviceID  = findKeyInsensitive(data, 'serviceID');
    var actionName = findKeyInsensitive(data, 'actionName');
    var args       = data;
    var token      = data.device_access_token;

    if (serviceID == null)  return session.callbackWithoutTimer(new CHError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CHError('ACTIONNAME_NOT_AVAILABLE'));

    // build argument object
    var argumentList = {};

    if (options.allowSimpleType !== true) {
      // in this case we uniformly use 'input' to identify input argument
      argumentList.input       = args.input;
      argumentList.ctx         = session;
      argumentList.httpHeaders = req.headers;
    } else {
      for (var i in args) {
        argumentList[i] = args[i];
      }
      delete argumentList.serviceID; delete argumentList.actionName;
    }

    // Opt this session in to per-call metering (S3). Session.prototype.response
    // fires it on success, using the same recordCall/mcpToolCallCost the MCP
    // tools/call path uses. encodeLegacyTool is the same `tool` encoding the
    // two cross-worker call paths already record with
    // (lib/device-manager.js, lib/peer-channel-broker.js), so an action
    // invoked over HTTP and the same action invoked over MCP land on the
    // same metering identity rather than two parallel ones.
    session.meteredTool = encodeLegacyTool(deviceID, serviceID, actionName);

    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, token, session);
  });
  return router;
}
