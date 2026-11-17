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
// such prefix. It holds the owner's opaque meter id, never a key.
const PREFIX = 'task-tombstone:';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

const kv = () => require('./store').getStore().kv;

// -> Promise, resolved once written (a store error is the cancel's own to
// log). ttlMs: the task's (null when the store keeps finished jobs); lasting:
// the job outlives the cancel, so the tombstone lasts as long as it can.
function put(taskId, {owner, session = null, createdAt}, ttlMs, {lasting = false} = {}) {
  const value = JSON.stringify({owner, session, createdAt, cancelledAt: new Date().toISOString()});
  const given = Number.isInteger(ttlMs) && ttlMs > 0;
  const key = `${PREFIX}${taskId}`;
  const done = (resolve, reject) => (err) => (err != null ? reject(err) : resolve());
  if (lasting && !given) return new Promise((resolve, reject) => kv().set(key, value, done(resolve, reject)));
  return new Promise((resolve, reject) => kv().set(key, value, 'PX', given ? ttlMs : DEFAULT_TTL_MS, done(resolve, reject)));
}

// -> Promise of {owner, session, createdAt, cancelledAt}, or null
function get(taskId) {
  return new Promise((resolve) => kv().get(`${PREFIX}${taskId}`, (err, value) => {
    if (err != null || typeof(value) !== 'string') return resolve(null);
    try { return resolve(JSON.parse(value)); } catch (e) { return resolve(null); }
  }));
}

module.exports = {put, get, PREFIX, DEFAULT_TTL_MS};
