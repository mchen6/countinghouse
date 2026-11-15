'use strict';
// A job's session (the shared runtime, B1 Task 3, as the reviewer ruled on
// 2026-11-15): which client session created a job, kept on the main thread
// only, in memory. Never in the job's data, its history or the store, so no
// worker, module, job-history reader or client sees it, and a runtime
// restart forgets it. (A usage record carries the id, as the B1 plan says;
// nothing else about a session goes anywhere.) Shared mode requires the
// local store, so a job runs in the process that made it: this map, per
// process, sees every run.
//
// The key is the job's own: its scheduler's id for a repeating job (every
// run of it), its job id otherwise. It is set before the job can first run
// (lib/job-control.js, lib/job-control-local.js) and dropped when a one-off
// job has finished for the last time, a job or scheduler is removed, or a
// scheduler has run its last.
//
// A run takes (forRun, read once the run's owner check has passed):
//   - the session, with no values of its own, while the session is live
//     (lib/sessions.js knows it; the call's values then come from the
//     session, B2);
//   - once it has ended, its last override bounded by the defaults
//     (lib/call-limits.js bound: 'defaults'): each check takes the tighter of
//     it and the option as it is then, so a loosening never outlives its
//     session, a tightening does, and a later tightening of the defaults
//     still reaches the run. An ended session with no override: none;
//   - none, and so the defaults, for a job with no entry (a job from no
//     session, or one that outlived a restart).
const callLimits = require('./call-limits');

const byKey = new Map();      // job key -> session id
const counts = new Map();     // session id -> how many keys it has
const ended = new Map();      // session id -> its last override (an ended session with keys)

const isId = (v) => typeof(v) === 'string' && v.length > 0 && v.length <= 200;
const isLive = (session) => require('./sessions').get(session) != null;

function remember(key, session) {
  if (!isId(key) || !isId(session)) return;
  forget(key);
  byKey.set(key, session);
  counts.set(session, (counts.get(session) || 0) + 1);
}

function forget(key) {
  if (!isId(key) || !byKey.has(key)) return;
  const session = byKey.get(key);
  byKey.delete(key);
  const left = (counts.get(session) || 1) - 1;
  if (left > 0) { counts.set(session, left); return; }
  counts.delete(session);
  ended.delete(session);
}

// A session has ended (lib/sessions.js close): its override is kept for its
// jobs, if it has any; one with none needs nothing here.
function sessionEnded(session, override) {
  if (!isId(session) || !counts.has(session)) return;
  const last = callLimits.check(override);
  ended.set(session, last != null ? Object.assign({}, last, {bound: 'defaults'}) : null);
}

// -> {session, limits}: limits an override for the run's token and its
// invoke message, or null (the defaults, read at each check)
function forRun(key) {
  const session = isId(key) ? byKey.get(key) : undefined;
  if (session === undefined) return {session: null, limits: null};
  if (isLive(session)) return {session, limits: null};
  const last = ended.get(session);
  return {session, limits: last != null ? callLimits.check(last) : null};
}

module.exports = {remember, forget, sessionEnded, forRun, size: () => byKey.size,
  resetForTests: () => { byKey.clear(); counts.clear(); ended.clear(); }};
