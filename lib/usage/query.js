// ctx.usage() (the reviewer, 2026-11-13, the pack receipt): the current
// call's counts so far (lib/usage/index.js soFar), read-only. A worker's
// query states its call's usage id and token, and is checked here, on the
// main thread, as its remote call is (lib/remote/index.js callRemote): the
// token must be one issued to that worker (else CALL_TOKEN_INVALID), and the
// usage id one that worker was given (else USAGE_CALL_FOREIGN,
// lib/usage/hop.js). No id (a peer channel's call, not a tools/call), or a
// finished one, answers null before the token is looked at: a call's token
// is dropped when it answers, and in both cases there is nothing to read.
// The main thread's own query (single-thread mode, not a sandbox) is taken
// as given.
const {CountinghouseError} = require('../countinghouse-error');
const callTokens = require('../call-tokens');
const {checkHop} = require('./hop');
const {recorder} = require('../remote/usage');

// data: {usageCall, token}. workerId: the worker that asked, or undefined on
// the main thread. -> the counts, or null.
function answerUsageQuery(data, workerId) {
  const d = (data != null && typeof(data) === 'object') ? data : {};
  const usage = recorder();
  let call = Number.isInteger(d.usageCall) ? d.usageCall : null;
  if (call == null || usage.isFinished(call)) return null;
  if (workerId !== undefined) {
    if (callTokens.resolve(d.token, {workerId: workerId}) == null) throw new CountinghouseError('CALL_TOKEN_INVALID', 'usage');
    const claimed = {usageCall: d.usageCall};
    const refused = checkHop(usage, claimed, workerId);   // strips a finished id
    if (refused != null) throw refused;
    call = Number.isInteger(claimed.usageCall) ? claimed.usageCall : null;
  }
  return call == null ? null : usage.soFar(call);
}

module.exports = {answerUsageQuery};
