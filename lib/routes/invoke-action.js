var options   = require('../cli-options');
var express   = require('express');
var CdifError = require('../cdif-error').CdifError;

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = req.session;
    var deviceID   = req.params.deviceID;
    var serviceID  = req.body.serviceID;
    var actionName = req.body.actionName;
    var args       = req.body;
    var token      = req.body.device_access_token;

    if (serviceID == null)  return session.callbackWithoutTimer(new CdifError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CdifError('ACTIONNAME_NOT_AVAILABLE'));

    // build argument object
    var argumentList = {};

    if (options.allowSimpleType !== true) {
      // in this case we uniformly use 'input' to identify input argument
      argumentList.input       = args.input;  //input can be either object or array type
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
