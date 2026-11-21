'use strict';
// How long a hop waits for its charge (B-hopcharge, release 1). Every hop
// path bills its caller once (recordCall) before it answers: the peer path
// (lib/peer-channel-broker.js billChecked), a routed device hop
// (lib/device-manager.js) and a remote call (lib/remote/index.js). A store
// that is slow to answer -- a stalled Redis, or --store local --meter's
// update() waiting for the store lock, up to UPDATE_WAIT_MS (10 s) --
// held the hop's answer with it. The wait is bounded by one constant,
// METER_PENDING_MS: past it the hop is answered with its billing pending
// ({billingPending: true} as its platformMetering, what a module already
// gets from the peer path), never "unbilled". The charge is issued once and
// never re-issued: the bound changes only when the caller hears. Its late
// outcome is logged when it comes (lateOutcome): a charge that lands, at
// info; one that fails, at error, naming the key only by its meterId
// (lib/key-fingerprint.js) -- that call then goes unbilled, as a peer hop's
// late failure always has. A cancel or the outer call's end never stops
// it.
const LOG = require('../logger');
const {meterId} = require('../key-fingerprint');

const METER_PENDING_MS = 500;

// A pending charge's outcome, when it comes. what: 'hop' or 'peer hop' or
// 'remote call'; tool: the hop's tool name.
function lateOutcome(what, tool, billingKey, err, result) {
  if (err != null) {
    const why = (err && err.message) ? String(err.message).slice(0, 200) : String(err);
    return LOG.E(new Error(`${what} ${tool}: the pending billing failed for meter ${meterId(String(billingKey))} (${why}); this call goes unbilled`));
  }
  return LOG.I(`${what} ${tool}: the pending billing landed (charged ${result != null && result.charged !== undefined ? result.charged : '?'})`);
}

// ci.recordCall(billingKey, tool, cost, ..., opts) once, answered once:
// onAnswer(err, result, false) with the charge's own answer when it comes
// within METER_PENDING_MS; else onAnswer(null, null, true) at the bound, and
// the charge's outcome logged when it comes. A recordCall that throws is
// answered as its error. {what, opts}: the log's name for the path; the
// recordCall's own options (a session), passed as given.
function boundedCharge(ci, billingKey, tool, cost, onAnswer, {what = 'hop', opts, boundMs = METER_PENDING_MS} = {}) {
  let answered = false;
  let pending = false;
  const answer = (...a) => {
    if (answered) return undefined;
    answered = true;
    return onAnswer(...a);
  };
  const bound = setTimeout(() => {
    if (answered) return;
    pending = true;
    LOG.I(`${what} ${tool}: billing pending, the charge has not answered within ${boundMs} ms; its outcome is logged when it comes`);
    answer(null, null, true);
  }, boundMs);
  if (typeof(bound.unref) === 'function') bound.unref();
  const landed = (err, result) => {
    clearTimeout(bound);
    if (pending) return lateOutcome(what, tool, billingKey, err, result);
    return answer(err != null ? err : null, err != null ? null : result, false);
  };
  try {
    if (opts !== undefined) ci.recordCall(billingKey, tool, cost, landed, opts);
    else ci.recordCall(billingKey, tool, cost, landed);
  } catch (e) {
    landed(e, null);
  }
}

module.exports = {boundedCharge, lateOutcome, METER_PENDING_MS};
