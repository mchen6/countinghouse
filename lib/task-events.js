'use strict';
// MCP completeness M16, Task 1 (plan
// docs/superpowers/plans/2026-11-17-mcp-m16-task-notifications.md): a
// 2026-07-28 task's changes, told on the main thread by both job runners
// (lib/job-control.js's QueueEvents, lib/job-control-local.js's own state
// changes), for the listen hub to turn into notifications/tasks (Task 2).
// A kind is what changed: 'active' (its run started), 'progress' (its
// ctx.job.progress), 'completed', 'failed' (for good, not a retried
// attempt) or 'removed' (taken off the queue: its owner's tasks/cancel).
// Only the task's id and the kind cross here, never its data: a listener
// builds the task through tasks/get's own lookup, owner check included.
// A task is a job with the gateway's minted id (job-control-common
// TASK_ID); a legacy job, or any other, is never told. A listener's throw
// is logged, never the runner's.
const {TASK_ID} = require('./job-control-common');

const KINDS = new Set(['active', 'progress', 'completed', 'failed', 'removed']);
const listeners = new Set();

// fn(taskId, kind); -> a function that removes it
function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(jobId, kind) {
  if (!KINDS.has(kind)) throw new TypeError(`task-events: unknown kind ${String(kind)}`);
  const id = String(jobId);
  if (!TASK_ID.test(id)) return;
  for (const fn of [...listeners]) {
    try {
      fn(id, kind);
    } catch (e) {
      try { require('./logger').E(e); } catch (_) { /* no logger */ }
    }
  }
}

module.exports = {on, emit, KINDS};
