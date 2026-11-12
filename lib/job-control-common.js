// What both job runners share (lib/job-control.js over BullMQ, and
// lib/job-control-local.js for --store local, LM1): the bounds on what one
// add-job may ask for, the job-ownership checks, and the scheduler ids.
// Pure functions and constants, no queue.
const CountinghouseError = require('./countinghouse-error').CountinghouseError;

// The longest delay setTimeout honours.
const MAX_TIMER_MS = 2147483647;

// Job failures bullmq must not retry (see the processor's reject path): the
// module is gone until an operator acts.
const NOT_RETRIED = new Set(['MODULE_UNLOADED', 'MODULE_SUSPENDED']);

// What one add-job may ask for. A job's runs are not rate limited -- only
// creating it is (lib/routes/add-job.js, lib/mcp/gateway.js) -- so these keep
// one rate-limited request from becoming unbounded work: a repeating job at
// most once a second, and at most 10 attempts. A cron pattern's finest step
// is a second, so it needs no check of its own.
const MIN_REPEAT_EVERY_MS = 1000;
const MAX_ATTEMPTS        = 10;

function isWhole(n) {
  return typeof(n) === 'number' && Number.isInteger(n);
}

function jobOptsError(jobOpts) {
  if (jobOpts.attempts != null && !(isWhole(jobOpts.attempts) && jobOpts.attempts >= 1 && jobOpts.attempts <= MAX_ATTEMPTS)) {
    return `attempts must be a whole number from 1 to ${MAX_ATTEMPTS}`;
  }
  const repeat = jobOpts.repeat;
  if (repeat == null) return null;
  if (typeof(repeat) !== 'object') return 'repeat must be an object with every or cron';
  if (repeat.cron != null) {
    if (typeof(repeat.cron) !== 'string') return 'repeat.cron must be a cron pattern string';
  } else if (!(isWhole(repeat.every) && repeat.every >= MIN_REPEAT_EVERY_MS)) {
    return `repeat.every must be a whole number of milliseconds, at least ${MIN_REPEAT_EVERY_MS}`;
  }
  if (repeat.limit != null && !(isWhole(repeat.limit) && repeat.limit >= 1)) return 'repeat.limit must be a whole number, at least 1';
  return null;
}

// --- job ownership (S1/S5) ---
//
// Every job records the apiKey that created it (jobData.apiKey, set from the
// *authenticated* identity by addJob below -- never from anything the
// requester supplied, see addJob's own comment). Every read/mutate entry
// point then takes an `authCtx` as its FIRST argument and refuses to touch a
// job the caller doesn't own.
//
// The check lives here rather than in lib/mcp/gateway.js because there are
// two independent front doors onto the same jobs -- the MCP tasks/* methods
// and the HTTP /devices/:deviceID/{get,remove}-job(-history) routes. Gating
// only the gateway would leave the HTTP routes as a bypass (exactly the
// shape of the gap docs/cross-cutting-matrix.md exists to prevent), so the
// gate is put at the single point both funnel through.
//
// authCtx is one of:
//   {appKey: <string>, isAdmin: <bool>}  a tenant-originated request
//   JobControl.INTERNAL                   platform-internal call (see below)
//
// Anything else -- null, undefined, a missing appKey -- is denied. Fail
// closed: an unauthenticated caller has no owner identity to match against,
// so it can never match one.
const INTERNAL = {internal: true};

// A repeatable job's scheduler id: the caller's name, scoped to its owner.
// The id was the raw name in one shared queue, and bullmq upserts schedulers
// with override, so another tenant posting the same name replaced the first
// tenant's scheduler, its later runs then owned and billed to the second
// (review R3-2). A hash, so the id never carries the key itself.
function schedulerId(authCtx, name) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return name;
  const identity = require('./identity');
  const owner = identity.ready() ? identity.idForKey(authCtx.appKey) : legacyOwner(authCtx);
  return `${owner}:${name}`;
}

// The owner tag schedulers were stored under before the opaque id (an
// unsalted sha256 prefix of the key): still looked up on removal, so a
// scheduler set up before the upgrade is found by its owner.
function legacyOwner(authCtx) {
  return require('crypto').createHash('sha256').update(String(authCtx.appKey)).digest('hex').slice(0, 16);
}
function legacySchedulerId(authCtx, name) {
  if (authCtx === INTERNAL || authCtx == null || authCtx.appKey == null) return null;
  return `${legacyOwner(authCtx)}:${name}`;
}

// A job with no recorded apiKey (created before ownership existed, or by an
// internal path) is owned by nobody, so only an admin can reach it. This is
// deliberate: treating "no owner" as "everyone's" is how the original gap
// behaved, and it is exactly what must not survive this fix.
function ownsJob(authCtx, jobData) {
  if (authCtx === INTERNAL) return true;
  if (authCtx == null || authCtx.appKey == null) return false;
  if (authCtx.isAdmin === true) return true;
  return jobData != null && jobData.apiKey === authCtx.appKey;
}

function denied(authCtx) {
  // Distinguish "you didn't authenticate" from "you authenticated but this
  // isn't yours" -- same distinction lib/user-auth.js already draws between
  // SYSTEM_ERROR_UNKNOWN_USER and USER_HAS_NO_DEVICE.
  if (authCtx == null || authCtx.appKey == null) return new CountinghouseError('SYSTEM_ERROR_UNKNOWN_USER');
  return new CountinghouseError('JOB_ACCESS_DENIED');
}

module.exports = {MAX_TIMER_MS, NOT_RETRIED, MIN_REPEAT_EVERY_MS, MAX_ATTEMPTS, isWhole, jobOptsError,
  INTERNAL, schedulerId, legacyOwner, legacySchedulerId, ownsJob, denied};
