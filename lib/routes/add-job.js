'use strict';
const express    = require('express');
const JobControl = require('../store').jobs;
const rateLimitGate = require('../rate-limit-gate');
const LOG        = require('../logger');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

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

  // Rate limited first, before any refusal (the limiter PR's medium): every
  // request spends the key's one unit, whatever it asked, so over its limit
  // every device answers RATE_LIMIT_EXCEEDED alike and none is probed
  // unlimited (#482: one answer per level), as package-info does. (One
  // unit per add: the job's run spends none of the key's: invokeJobs.)
  // This route was a real bypass before 7.0.0: MCP task creation is limited
  // at creation (lib/mcp/gateway.js createTaskForToolCall, against unbounded
  // queue growth), and this route makes the very same jobs, unlimited. One
  // per-key budget with every other gated path (lib/rate-limit-gate.js).
  router.route('/').post((req, res) => rateLimitGate.guard(cdifInterface, req.session, res, () => {
    const session = req.session;
    const deviceID   = req.params.deviceID;

    // A job is a JSON description of the task.
    const data       = req.body;
    const serviceID  = findKeyInsensitive(data, 'serviceID');
    const actionName = findKeyInsensitive(data, 'actionName');

    if (serviceID == null)  return session.callbackWithoutTimer(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (actionName == null) return session.callbackWithoutTimer(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));
    // (names are strings: what a check judges is what is run)
    if (typeof(serviceID) !== 'string') return session.callbackWithoutTimer(new CountinghouseError('SERVICEID_NOT_AVAILABLE'));
    if (typeof(actionName) !== 'string') return session.callbackWithoutTimer(new CountinghouseError('ACTIONNAME_NOT_AVAILABLE'));

    const opts         = pickJobOpts(req.body.opts);
    const input        = req.body.input;

    // The job's owner (and billing subject) is the authenticated caller,
    // supplied out-of-band as authCtx -- never anything inside `opts`, which
    // is request-body data. See lib/job-control.js's addJob.
    const authCtx = {appKey: session.appKey, isAdmin: session.isAdmin === true};

    // Only a module the caller's tools/list could show: one missing, not
    // listed (a scenario's part, reached only through its scenario) or
    // hidden makes no job, one answer (notAvailable). Before this an
    // unlisted part's action was queued and RUN (post-rel caller 400: an
    // access gap, not only an oracle).
    const {scopeOf, notAvailable, restReaches} = require('../listing-scope');
    if (scopeOf(cdifInterface, deviceID) !== 'listed' || !restReaches(cdifInterface, deviceID)) return session.callbackWithoutTimer(notAvailable());
    // Actions are judged at the run, not here: a missing action and one its
    // declared text leaves unusable both make a job whose run fails
    // ACTION_NOT_FOUND (lib/device-manager.js invokeJobsNow), so neither the
    // add's answer nor the run's tells them apart (post-rel caller 400).
    JobControl.addJob(authCtx, opts, deviceID, serviceID, actionName, input, (err, ret) => {
      if (err) return session.callbackWithoutTimer(err);

      return session.callbackWithoutTimer(null, ret);
    });
  }));
  return router;
}
