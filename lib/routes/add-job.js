const express    = require('express');
const JobControl = require('../job-control');
const rateLimitGate = require('../rate-limit-gate');
const LOG        = require('../logger');
const CHError    = require('../countinghouse-error').CHError;

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
const ALLOWED_JOB_OPTS = ['name', 'attempts', 'delay', 'timeout', 'repeat'];

function pickJobOpts(raw) {
  if (raw == null || typeof(raw) !== 'object') return raw;

  const clean = {};
  ALLOWED_JOB_OPTS.forEach((key) => {
    if (raw[key] !== undefined) clean[key] = raw[key];
  });
  return clean;
}

function findKeyInsensitive(obj, key) {
  if (obj == null) return null;

  const objKeys = Object.keys(obj);

  const found = objKeys.find((item) => {
    return item.toLowerCase() === key.toLowerCase();
  });

  if (found != null) return obj[found];
  return null;
}

module.exports = function(cdifInterface) {
  const router = express.Router({mergeParams: true});

  router.route('/').post((req, res) => {

    const session = req.session;
    const deviceID   = req.params.deviceID;

    //by default we handle application/json
    //and in case of application/bson we deserialize it first to a json object
    const data       = req.body;
    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');

    if (serviceID == null)  return session.callbackWithoutTimer(new CHError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CHError('ACTIONNAME_NOT_AVAILABLE'));

    const opts         = pickJobOpts(req.body.opts);
    const input        = req.body.input;

    // The job's owner (and billing subject) is the authenticated caller,
    // supplied out-of-band as authCtx -- never anything inside `opts`, which
    // is request-body data. See lib/job-control.js's addJob.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    // Rate limited (7.0.0), and this one was a real bypass rather than only a
    // wrong matrix cell: MCP task creation is deliberately limited at
    // creation time (lib/mcp/gateway.js's createTaskForToolCall, guarding
    // against unbounded queue growth), but this route creates the very same
    // jobs and was not limited at all -- so a caller could queue without
    // limit simply by using HTTP instead of MCP. Shares one per-apiKey budget
    // with every other gated path. See lib/rate-limit-gate.js.
    rateLimitGate.guard(cdifInterface, session, res, () => {
      JobControl.addJob(authCtx, opts, deviceID, serviceID, actionName, input, (err, ret) => {
        if (err) return session.callbackWithoutTimer(err);

        return session.callbackWithoutTimer(null, ret);
      });
    });
  });
  return router;
}
