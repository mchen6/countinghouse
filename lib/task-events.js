'use strict';
// MCP completeness M16, Task 1 (plan
// docs/superpowers/plans/2026-11-17-mcp-m16-task-notifications.md): a
// 2026-07-28 task's changes, told on the main thread by both job runners
// (lib/job-control.js's QueueEvents, lib/job-control-local.js's own state
// changes), for the listen hub to turn into notifications/tasks (Task 2).
// A kind is what changed: 'active' (its run started), 'progress' (its
// ctx.job.progress), 'completed', 'failed' (for good, not a retried
// attempt), 'input_required' (its pass ended on its question, M22: it waits
// for an answer), or 'cancelled': told by the gateway's tasks/cancel once
// the task's tombstone is written, never by a runner's removal (a listener's
// lookup then would find neither the job nor yet the tombstone).
// A question's wait ends unseen: tasks/get reads ASK_EXPIRED from its record
// (lib/task-asks.js) once expiresAt has passed, and no runner changes the
// job then. So a task told input_required is told 'failed' again at that
// time, here, in every process that told it: one unref'd timer per waiting
// task (task-asks bounds them, MAX_TOTAL), cleared by any later kind for
// it. A stale one is harmless: a listener builds the task, and the task
// decides.
// Only the task's id and the kind cross here, never its data: a listener
// builds the task through tasks/get's own lookup, owner check included.
// A task is a job with the gateway's minted id (job-control-common
// TASK_ID); a legacy job, or any other, is never told. A listener's throw
// is logged, never the runner's.
const {TASK_ID} = require('./job-control-common');

const KINDS = new Set(['active', 'progress', 'completed', 'failed', 'cancelled', 'input_required']);
const listeners = new Set();
// taskId -> the timer that tells its question's wait has ended
const waits = new Map();
// past expiresAt by this much, so the record reads expired when told
const EXPIRY_MARGIN_MS = 10;

// fn(taskId, kind); -> a function that removes it
function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(jobId, kind) {
  if (!KINDS.has(kind)) throw new TypeError(`task-events: unknown kind ${String(kind)}`);
  const id = String(jobId);
  if (!TASK_ID.test(id)) return;
  clearTimeout(waits.get(id));
  waits.delete(id);
  if (kind === 'input_required') tellExpiry(id);
  for (const fn of [...listeners]) {
    try {
      fn(id, kind);
    } catch (e) {
      logError(e);
    }
  }
}

function logError(e) {
  try { require('./logger').E(e); } catch (_) { /* no logger */ }
}

// the question's wait, from its record: told 'failed' once it has ended
// (unless a later kind came first). A record gone or unread tells nothing:
// the task's next change, or its next tasks/get, tells.
function tellExpiry(id) {
  const asked = {};
  waits.set(id, asked);
  Promise.resolve().then(() => require('./task-asks').get(id)).then((record) => {
    if (waits.get(id) !== asked || record == null || !(record.expiresAt > 0)) {
      if (waits.get(id) === asked) waits.delete(id);
      return;
    }
    const t = setTimeout(() => {
      if (waits.get(id) !== t) return;
      waits.delete(id);
      emit(id, 'failed');
    }, Math.max(0, record.expiresAt - Date.now()) + EXPIRY_MARGIN_MS);
    if (typeof(t.unref) === 'function') t.unref();
    waits.set(id, t);
  }).catch((e) => {
    if (waits.get(id) === asked) waits.delete(id);
    logError(e);
  });
}

// (tests: how many questions' waits are timed)
function pendingWaits() {
  return waits.size;
}

module.exports = {on, emit, KINDS, pendingWaits};
