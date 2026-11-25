'use strict';
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
const {finishToolCall, outFieldsOf, receiptReserved, RECEIPT_META_KEY} = require('./receipt');
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

// usage: () -> the recorder; targetFor(jobData) -> the listed tool target
// {name, role, module} or null (the caller is the job's ownerId);
// buildResult(err, results, schema, target) -> the MCP result tasks/result builds.
// cancelledNow(jobId): whether the task is known cancelled now, at once (a
// stop's record of a pass whose tombstone was not yet read)
function taskHooks({usage, targetFor, buildResult, now = Date.now, cancelledNow = () => false}) {
  const runs = new Map(); // call -> {target, startedMs}

  // session: the job's session for this run (lib/job-sessions.js forRun's), or null
  function start(jobData, session = null) {
    try {
      // the owner by opaque id (R2-1 Task 3; never the key: B-meter-keys (2))
      if (jobData == null || jobData.ownerId == null) return null;
      const target = targetFor(jobData);
      if (target == null) return null;
      const caller = String(jobData.ownerId);
      // the job's session (B1 Task 3), on its records in shared mode only
      const call = usage().beginCall({scenario: target.role === 'scenario' ? target.module : null, module: target.module, tool: target.name, caller: caller,
        session: require('../sessions').forUsage(session)});
      runs.set(call, {target, startedMs: now()});
      return {usageCall: call};
    } catch (_) {
      return null;
    }
  }

  // cancelled: the task was cancelled while this run ran (tasks/cancel, its
  // tombstone): a cancelled call's record, as a tools/call's (M19), whatever
  // its result (B-cancelled, the reviewer's ruling of 2026-11-19)
  function complete(jobData, results, run, schema = null, {cancelled = false} = {}) {
    try {
      const call = run != null && run.extra != null ? run.extra.usageCall : null;
      const begun = call != null ? runs.get(call) : null;
      if (begun == null) return null;
      runs.delete(call);
      settled.delete(call);
      const result = finishToolCall({usage: usage(), call, result: resultOf(begun, run.error, results, schema), role: begun.target.role, tool: begun.target.name, module: begun.target.module, takeNotices: false, startedMs: begun.startedMs, now,
        outcome: cancelled === true ? 'cancelled' : undefined});
      const receipt = result._meta != null ? result._meta[RECEIPT_META_KEY] : null;
      if (receipt == null) return null;
      return {usageReceipt: receipt, usageSentence: result.content[result.content.length - 1].text};
    } catch (_) {
      return null;
    }
  }

  // A pass's Out record written at once with `record`'s fields, nothing
  // sent (asked, ended, cancel): the one place its call is taken and ended
  function endWith(run, record) {
    try {
      const call = run != null && run.extra != null ? run.extra.usageCall : null;
      const begun = call != null ? runs.get(call) : null;
      if (begun == null) return;
      runs.delete(call);
      settled.delete(call);
      usage().recordOut(call, Object.assign({tool: begun.target.name, bytes: 0, ms: Math.max(0, now() - begun.startedMs)}, record));
    } catch (_) { /* counting never fails a run */ }
  }
  // A task's pass that ended with no answer to come (F2-2), closed by its
  // runner before the next pass starts a call of its own: no form could be
  // shown, or there was no room for one more waiting task ('unavailable':
  // a pass, never a call, never a question put to the user), or the task
  // was cancelled while it asked ('cancelled').
  function ended(jobData, run, outcome) {
    endWith(run, {outcome: outcome === 'cancelled' ? 'cancelled' : 'unavailable'});
  }

  // A task's pass that ended on its question (M22): its Out record is an
  // asked one, with the task's round and who asked, as a call's asking pass
  // is (lib/mcp/gateway.js runModuleTarget). Not a result, and not billed.
  function asked(jobData, run, {round, askedBy} = {}) {
    endWith(run, {outcome: 'asked', round, askedBy});
  }

  // The result a pass's record reads, as tasks/result builds it: its error
  // (the call's, or a scenario's reserved output: only a scenario's output
  // reserves `receipt`, the runtime adds its own there), else its results
  function resultOf(begun, error, results, schema) {
    let e = error != null ? error : null;
    if (e == null && begun.target.role === 'scenario' && receiptReserved(results)) e = new CountinghouseError('RECEIPT_RESERVED');
    return buildResult(e, results, schema, begun.target);
  }

  // A pass that has settled -- answered (and charged) or failed -- while its
  // record is still being written (the completion hook reads the output
  // schema and the tombstone, and places the result, first): noted at
  // once, so a stop meanwhile records what it settled with, its bytes and
  // its code as complete() would (outFieldsOf), not a cancel. The schema is
  // not yet read then: the result is built without it.
  // placed: the result's placement as known so far (the gateway notes it
  // again once the schema is read: how its values will be sent), else null.
  const settled = new Map();   // call -> {error, results, placed, jobId}
  function noteSettled(run, error, results, placed) {
    const call = run != null && run.extra != null ? run.extra.usageCall : null;
    if (call != null && runs.has(call)) {
      settled.set(call, {error: error != null ? error : null, results: error != null ? null : results, placed: placed != null ? placed : null, jobId: run.jobId});
    }
  }
  const failed = (run, error) => { if (error != null) noteSettled(run, error, null, null); };
  const answered = (run, results, placed = null) => noteSettled(run, null, results, placed);
  // closeOpen's outcomeOf: a settled call's record fields, else none -- a
  // cancelled one's (its task known cancelled now), as complete() records it
  function outcomeOf(call) {
    const s = settled.get(call);
    const begun = runs.get(call);
    if (s == null || begun == null) return null;
    try {
      const fields = outFieldsOf(resultOf(begun, s.error, s.results, s.placed));
      return cancelledNow(s.jobId) ? Object.assign(fields, {outcome: 'cancelled', code: undefined, kind: undefined}) : fields;
    } catch (_) { return null; }
  }

  // A pass its runner ended without an answer (B-shutdown-usage: its
  // close(), at shutdown): a cancelled call's Out record, nothing sent, at
  // once (no tombstone to read: it is cancelled) -- or, when it had settled
  // and its record was still being written, what it settled with
  // (outcomeOf). Synchronous.
  function cancel(jobData, run) {
    const call = run != null && run.extra != null ? run.extra.usageCall : null;
    const known = call != null ? outcomeOf(call) : null;
    endWith(run, known != null ? known : {outcome: 'cancelled'});
  }

  return {start, complete, asked, ended, cancel, failed, answered, outcomeOf};
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
