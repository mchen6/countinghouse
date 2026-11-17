'use strict';
// A cancelled 2026-07-28 task's tombstone (MCP completeness M15, spec
// section 9). A cancel removes the task's job, as the legacy cancel does, so
// without a mark tasks/get would answer "unknown" for a task its owner just
// cancelled. The tombstone says `cancelled` instead, to that owner and
// session only (anyone else gets the one -32602 an unknown task gets), until
// the task's ttlMs, or an hour when that is null.
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
// log: the job is gone either way)
function put(taskId, {owner, session = null, createdAt}, ttlMs) {
  const value = JSON.stringify({owner, session, createdAt, cancelledAt: new Date().toISOString()});
  const ms = (Number.isInteger(ttlMs) && ttlMs > 0) ? ttlMs : DEFAULT_TTL_MS;
  return new Promise((resolve, reject) => kv().set(`${PREFIX}${taskId}`, value, 'PX', ms, (err) => (err != null ? reject(err) : resolve())));
}

// -> Promise of {owner, session, createdAt, cancelledAt}, or null
function get(taskId) {
  return new Promise((resolve) => kv().get(`${PREFIX}${taskId}`, (err, value) => {
    if (err != null || typeof(value) !== 'string') return resolve(null);
    try { return resolve(JSON.parse(value)); } catch (e) { return resolve(null); }
  }));
}

module.exports = {put, get, PREFIX, DEFAULT_TTL_MS};
