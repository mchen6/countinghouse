var options   = require('../cli-options');
var express   = require('express');
var CdifError = require('../cdif-error').CdifError;
var BSON      = require('bson');

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
        data = BSON.deserialize(req.body); //deserialize BSON so we can identify serviceID and actionName in it
      } catch (e) {
        return session.callbackWithoutTimer(new CdifError('INVALID_BSON_REQUEST', e.message));
      }
    }

    var serviceID  = findKeyInsensitive(data, 'serviceID');
    var actionName = findKeyInsensitive(data, 'actionName');
    var args       = data;
    var token      = data.device_access_token;

    if (serviceID == null)  return session.callbackWithoutTimer(new CdifError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CdifError('ACTIONNAME_NOT_AVAILABLE'));

    // build argument object
    var argumentList = {};

    if (options.allowSimpleType !== true) {
      // in this case we uniformly use 'input' to identify input argument

        //input can be either object or array type, we serialize it to BSON buffer and pass it to worker
        //then in worker we deserialize and promote the (possible) binary fields to Buffer instance, see app-sandbox.js code for more
        if (args.input != null && (typeof(args.input) === 'object' || Array.isArray(args.input))) {
          argumentList.input = BSON.serialize(args.input);
        } else {
          // in this case input can be either null or undefined, send it alone with args to worker for validation
          argumentList.input = args.input;
        }

      argumentList.ctx         = session;
      argumentList.httpHeaders = req.headers;
    } else {
      for (var i in args) {
        argumentList[i] = args[i];
      }
      delete argumentList.serviceID; delete argumentList.actionName;
    }

    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, token, session);
  });
  return router;
}
