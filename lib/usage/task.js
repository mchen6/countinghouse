// Task-augmented tools/call is counted like a direct one (reviewer,
// 2026-11-11, step 3b). A task runs as a job, possibly in another process
// than the one that queued it (the Redis queue is shared), and the call ids
// are per process, so the id is minted where the job runs:
//   start(jobData) -> {usageCall} | null: the job processor's start hook,
//     just before the job is sent to its worker. The id rides in the invoke
//     args as on the direct path, so the remote client's In records carry it.
//   complete(jobData, results, {extra, error}, schema) -> {usageReceipt,
//     usageSentence} | null: the completion hook. It writes the Out record
//     under the same id, counting the text tasks/result will send: built
//     with `schema`, the output schema the result is stamped with, and for a
//     reserved output the RECEIPT_RESERVED error itself (review of #60). For a
//     scenario's success it returns the receipt and its sentence, which the
//     job processor merges into job.data.
//   addTaskReceipt(result, jobData): tasks/result adds the kept receipt in
//     _meta['countinghouse/receipt'] and as the second text block.
// A job whose action is not a listed tool (an HTTP /add-job of something
// else) is not counted, and nor is a job with no owner (a scheduler
// template, apiKey null: reviewer, 2026-11-11). Every run of a retried job
// is its own call: each did real work and made its own server calls
// (reviewer, 2026-11-11). Counting never fails a job: every error is caught.
const {finishToolCall, receiptReserved, RECEIPT_META_KEY} = require('./receipt');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

// usage: () -> the recorder; targetFor(jobData) -> the listed tool target
// {name, role, module} or null; callerOf(apiKey) -> the opaque caller id;
// buildResult(err, results, schema) -> the MCP result tasks/result builds.
function taskHooks({usage, targetFor, callerOf, buildResult, now = Date.now}) {
  const runs = new Map(); // call -> {target, startedMs}

  function start(jobData) {
    try {
      // the owner by opaque id (R2-1 Task 3), or by key as before
      if (jobData == null || (jobData.apiKey == null && jobData.ownerId == null)) return null;
      const target = targetFor(jobData);
      if (target == null) return null;
      const caller = (jobData.ownerId != null) ? String(jobData.ownerId) : callerOf(jobData.apiKey);
      const call = usage().beginCall({pack: target.role === 'scenario' ? target.module : null, module: target.module, tool: target.name, caller: caller});
      runs.set(call, {target, startedMs: now()});
      return {usageCall: call};
    } catch (_) {
      return null;
    }
  }

  function complete(jobData, results, run, schema = null) {
    try {
      const call = run != null && run.extra != null ? run.extra.usageCall : null;
      const begun = call != null ? runs.get(call) : null;
      if (begun == null) return null;
      runs.delete(call);
      let error = run.error != null ? run.error : null;
      // Only a scenario's output reserves `receipt` (the runtime adds its own there).
      if (error == null && begun.target.role === 'scenario' && receiptReserved(results)) error = new CountinghouseError('RECEIPT_RESERVED');
      const result = finishToolCall({usage: usage(), call, result: buildResult(error, results, schema), role: begun.target.role, tool: begun.target.name, startedMs: begun.startedMs, now});
      const receipt = result._meta != null ? result._meta[RECEIPT_META_KEY] : null;
      if (receipt == null) return null;
      return {usageReceipt: receipt, usageSentence: result.content[result.content.length - 1].text};
    } catch (_) {
      return null;
    }
  }

  return {start, complete};
}

function addTaskReceipt(result, jobData) {
  if (result == null || result.isError === true || jobData == null || jobData.usageReceipt == null || typeof jobData.usageSentence !== 'string') return result;
  return {
    ...result,
    content: [...result.content, {type: 'text', text: jobData.usageSentence}],
    _meta: {...(result._meta || {}), [RECEIPT_META_KEY]: jobData.usageReceipt}
  };
}

module.exports = {taskHooks, addTaskReceipt};
