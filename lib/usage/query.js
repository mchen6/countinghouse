// ctx.usage() (the reviewer, 2026-11-13, the pack receipt): the current
// call's counts so far (lib/usage/index.js soFar), read-only. A worker's
// query states its call's usage id and token, and is checked here, on the
// main thread (the review of #161): the token first, always, against the
// worker that asked (else CALL_TOKEN_INVALID, whatever the id); then
// anything but an open call that worker was given (lib/usage/hop.js's
// grant) answers null, alike. So no answer, and no difference in the work
// done, tells another worker's open call from a finished or unknown one:
// a module cannot probe other tenants' activity through it. A call's token
// is dropped when it answers, so a query after that is refused. The main
// thread's own query (single-thread mode, not a sandbox) is taken as given.
const {CountinghouseError} = require('../countinghouse-error');
const callTokens = require('../call-tokens');
const {recorder} = require('../remote/usage');

// data: {usageCall, token}. workerId: the worker that asked, or undefined on
// the main thread. -> the counts, or null.
function answerUsageQuery(data, workerId) {
  const d = (data != null && typeof(data) === 'object') ? data : {};
  if (workerId !== undefined && callTokens.resolve(d.token, {workerId: workerId}) == null) {
    throw new CountinghouseError('CALL_TOKEN_INVALID', 'usage');
  }
  const usage = recorder();
  const call = Number.isInteger(d.usageCall) ? d.usageCall : null;
  if (call == null) return null;
  if (workerId !== undefined && !usage.ownsCall(call, workerId)) return null;
  return usage.soFar(call);
}

module.exports = {answerUsageQuery};
