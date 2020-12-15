var express    = require('express');
var JobControl = require('../job-control');
var LOG        = require('../logger');

function findKeyInsensitive(obj, key) {
  if (obj == null) return null;

  var objKeys = Object.keys(obj);

  var found = objKeys.find(function(item) {
    return item.toLowerCase() === key.toLowerCase();
  });

  if (found != null) return obj[found];
  return null;
}

module.exports = function() {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {

    var session = req.session;
    var deviceID   = req.params.deviceID;

    //by default we handle application/json
    //and in case of application/bson we deserialize it first to a json object
    var data       = req.body;
    var serviceID  = findKeyInsensitive(data, 'serviceID');
    var actionName = findKeyInsensitive(data, 'actionName');

    if (serviceID == null)  return session.callbackWithoutTimer(new CdifError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CdifError('ACTIONNAME_NOT_AVAILABLE'));

    var opts         = req.body.opts;
    var input        = req.body.input;

    JobControl.addJob(opts, deviceID, serviceID, actionName, input, function(err, ret) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, ret);
    });
  });
  return router;
}
