// Step 3c (reviewer, 2026-11-11; the review of 3c): a module runs in the same
// worker as handler-ctx, so a hop's usageCall is the worker's claim, not a
// fact. The main thread checks it where it forwards a hop (device-manager's
// invokeforeignaction), once user-auth has let the hop through:
//   - a usageCall the calling worker owns is forwarded unchanged, and the
//     callee's worker is granted the call for the hop's length, so a part may
//     call on under it;
//   - a usageCall that has finished (the run timed out, or its Out record is
//     written) goes on without the id, so nothing more is recorded under it;
//   - any other usageCall is answered USAGE_CALL_FOREIGN (a module error),
//     and the hop is not forwarded.
// A hop with no usageCall passes as it always has. Two limits (reviewer,
// 2026-11-12), stated, not enforced:
//   - ownership is per worker: a worker running two calls at once owns both,
//     so a module can misattribute between its own concurrent calls and
//     nothing else. R2-1's per-call token, issued and bound by the main
//     thread, closes it;
//   - a module that leaves the id off a hop undercounts its own receipt and
//     cannot inflate anyone else's.
//
// The direct-peer-channel path does not carry usageCall (the callee invokes
// with {input} only, lib/device-manager.js onPeerChannelOpen); if it ever
// does, its grant goes through the broker, which sees both workers.
const CountinghouseError = require('../countinghouse-error').CountinghouseError;

// -> {call}: forward, owning `call`; {}: forward with no id; {error}: refuse.
function claimHop(usage, args, callerWorkerId) {
  if (args == null || typeof args !== 'object' || args.usageCall == null) return {};
  const call = args.usageCall;
  if (usage != null && usage.isFinished(call)) {
    delete args.usageCall;
    return {};
  }
  if (usage == null || !Number.isInteger(call) || !usage.ownsCall(call, callerWorkerId)) {
    return {error: new CountinghouseError('USAGE_CALL_FOREIGN', 'a hop stated a usage call its worker was not given')};
  }
  return {call};
}

// The one-call form for a message with no callee worker (A's remote message):
// null to go on, or the refusal.
function checkHop(usage, args, callerWorkerId) {
  const claim = claimHop(usage, args, callerWorkerId);
  return claim.error != null ? claim.error : null;
}

module.exports = {claimHop, checkHop};
