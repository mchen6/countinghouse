'use strict';
// A cancelled 2026-07-28 task's tombstone (MCP completeness M15, spec
// section 9). It says `cancelled` to the task's owner and session only
// (anyone else gets the one -32602 an unknown task gets), where the job would
// otherwise answer:
// - a job not yet running is removed by the cancel, as the legacy cancel
//   does, so without a mark tasks/get would answer "unknown": its tombstone
//   lasts the task's ttlMs, or an hour when that is null;
// - a job already in a worker can't be removed: it runs to its end, billed
//   (cooperative), and is kept as any finished job is. Its tombstone lasts as
//   long as the job can (`lasting`): the task's ttlMs under --store local
//   (the job timeout and the result's retention, past which the job is
//   forgotten), and no expiry under Redis, which keeps a finished job. So the
//   task never reads completed once its tombstone is gone (the review of
//   #329). A mark on the job itself would not hold: the runner writes its
//   own copy of the job's data back at completion (job-control.js's stamp).
//
// It lives in the store's key-value space (Redis db 5, or the local store's
// kv.json), under task-tombstone:<taskId>. No module can name it: every key
// a module's ctx.redis command sends is put under m:<module name>: by the
// main thread (lib/redis-namespace.js), and runtime-internal keys carry no
// such prefix. It holds the owner's opaque meter id, never a key, and its
// session only as sessionKey's hash, never the id (B5 Task 2's review, L1: a
// session id is never in the store; 128-bit ids, so a plain SHA-256 is
// enough, and it still matches after a restart).
const crypto = require('crypto');
const PREFIX = 'task-tombstone:';
// -> a session's id as a tombstone keeps it: its SHA-256 (hex), or null
const sessionKey = (session) => (typeof(session) === 'string' && session !== '' ? crypto.createHash('sha256').update(session).digest('hex') : null);
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const kv = () => require('./store').getStore().kv;

// -> Promise, resolved once written (a store error is the cancel's own to
// log). session: the canceller's id, kept as sessionKey(session). ttlMs: the
// task's (null when the store keeps finished jobs); lasting: the job outlives
// the cancel, so the tombstone lasts as long as it can.
// The tasks this process cancelled, known at once (the store's write is
// asynchronous): a stop before a pass's tombstone could be read still records
// it as the cancelled call it is (lib/usage/task.js outcomeOf; the medium on
// #488's round 1). Bounded; a cancel made by another process on a shared
// store is not here, and a stop records that pass as it settled.
const CANCELLED_HERE_MAX = 10000;
const cancelledHere = new Set();
function put(taskId, {owner, session = null, createdAt}, ttlMs, {lasting = false} = {}) {
  cancelledHere.add(String(taskId));
  if (cancelledHere.size > CANCELLED_HERE_MAX) cancelledHere.delete(cancelledHere.values().next().value);
  const given = Number.isInteger(ttlMs) && ttlMs > 0;
  // (the ttl it is stored with, kept in it: what a cancelled task's view
  // reports -- null for a lasting one with none given; the medium on #531's
  // round, 1)
  const stored = given ? ttlMs : (lasting ? null : DEFAULT_TTL_MS);
  const value = JSON.stringify({owner, session: sessionKey(session), createdAt, cancelledAt: new Date().toISOString(), ttlMs: stored});
  const key = `${PREFIX}${taskId}`;
  const done = (resolve, reject) => (err) => (err != null ? reject(err) : resolve());
  if (lasting && !given) return new Promise((resolve, reject) => kv().set(key, value, done(resolve, reject)));
  return new Promise((resolve, reject) => kv().set(key, value, 'PX', given ? ttlMs : DEFAULT_TTL_MS, done(resolve, reject)));
}

// -> Promise of {owner, session (its sessionKey), createdAt, cancelledAt, ttlMs}, or null
function get(taskId) {
  return new Promise((resolve) => kv().get(`${PREFIX}${taskId}`, (err, value) => {
    if (err != null || typeof(value) !== 'string') return resolve(null);
    try { return resolve(JSON.parse(value)); } catch (e) { return resolve(null); }
  }));
}

// -> whether this process cancelled taskId
const cancelledByThisProcess = (taskId) => taskId != null && cancelledHere.has(String(taskId));

module.exports = {put, get, cancelledByThisProcess, sessionKey, PREFIX, DEFAULT_TTL_MS};
