var express    = require('express');
var JobControl = require('../job-control');
var LOG        = require('../logger');
var CHError    = require('../countinghouse-error').CHError;

// Scheduling options this route accepts from the request body, and nothing
// else. `opts` used to be forwarded to JobControl.addJob wholesale, which is
// how a caller-supplied `apiKey` inside it became the job's billing subject
// and (later) its owner -- a valid key could bill and impersonate an
// arbitrary other key by sending {"opts":{"apiKey":"victim"}}.
//
// addJob now takes the identity out-of-band (authCtx) and ignores anything
// named apiKey in jobOpts, so this whitelist is defense in depth rather than
// the only thing standing between a request body and an identity. It is kept
// deliberately explicit so that adding a future privileged field to jobOpts
// can't quietly become reachable from the wire: a new field is not accepted
// here until someone adds it to this list on purpose.
var ALLOWED_JOB_OPTS = ['name', 'attempts', 'delay', 'timeout', 'repeat'];

function pickJobOpts(raw) {
  if (raw == null || typeof(raw) !== 'object') return raw;

  var clean = {};
  ALLOWED_JOB_OPTS.forEach(function(key) {
    if (raw[key] !== undefined) clean[key] = raw[key];
  });
  return clean;
}

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

    if (serviceID == null)  return session.callbackWithoutTimer(new CHError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CHError('ACTIONNAME_NOT_AVAILABLE'));

    var opts         = pickJobOpts(req.body.opts);
    var input        = req.body.input;

    // The job's owner (and billing subject) is the authenticated caller,
    // supplied out-of-band as authCtx -- never anything inside `opts`, which
    // is request-body data. See lib/job-control.js's addJob.
    var authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    JobControl.addJob(authCtx, opts, deviceID, serviceID, actionName, input, function(err, ret) {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, ret);
    });
  });
  return router;
}
