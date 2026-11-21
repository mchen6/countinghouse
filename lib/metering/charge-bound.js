'use strict';
// How long a hop waits for its charge (B-hopcharge, release 1). Every hop
// path bills its caller once (recordCall) before it answers: the peer path
// (lib/peer-channel-broker.js billChecked), a routed device hop
// (lib/device-manager.js) and a remote call (lib/remote/index.js), all
// through boundedCharge. A store that is slow to answer -- a stalled Redis,
// or --store local --meter's update() waiting for the store lock, up to
// UPDATE_WAIT_MS (10 s) -- held the hop's answer with it. The wait is
// bounded by one constant, METER_PENDING_MS: past it the hop is answered
// with its billing pending ({billingPending: true} as its platformMetering,
// never "unbilled"). The charge is issued once and never re-issued: the
// bound changes only when the caller hears. Its late outcome is logged when
// it comes (lateOutcome): a charge that lands, at info; one that fails, at
// error, naming the key only by its meterId (lib/key-fingerprint.js) --
// that call then goes unbilled, as a peer hop's late failure always has. A
// cancel or the outer call's end never stops it.
//
// The allowance is per key, and small: at most MAX_PENDING_PER_KEY charges
// of one key (counted by its keyFingerprint, never the key) are pending
// past the bound at once. A hop that reaches the bound with that many
// already pending waits for its own charge, as every hop did before, so a
// stall never makes a looping caller's hops free: billing is never lost to
// a stall, only delayed by it (the reviewer's ruling on #496). A slot is
// taken when a charge goes pending, and given back when that charge
// answers, whatever its outcome; one still unanswered at PENDING_CEILING_MS
// gives it back then, said at error (its outcome still logged if it comes).
const LOG = require('../logger');
const {meterId, keyFingerprint} = require('../key-fingerprint');

const METER_PENDING_MS = 500;
// A few concurrent hops of one caller -- a scenario fanning out to its parts
// at once -- ride out a stall without waiting; any more wait for their
// charge, as before. Small: it is only a stall allowance.
const MAX_PENDING_PER_KEY = 4;
// Past the store's own longest wait (json-file UPDATE_WAIT_MS, 10 s) with
// room: a charge still unanswered by then is a provider that never answers.
const PENDING_CEILING_MS = 60000;

const pendingByKey = new Map();   // keyFingerprint -> charges pending past the bound
const pendingOf = (fp) => pendingByKey.get(fp) || 0;
function takeSlot(fp) { pendingByKey.set(fp, pendingOf(fp) + 1); }
function giveSlot(fp) {
  const n = pendingOf(fp) - 1;
  if (n > 0) pendingByKey.set(fp, n);
  else pendingByKey.delete(fp);
}

// A charge's error as it may be logged: its code kept, its message cut and
// with the key, should a provider's message repeat it (a store command's
// arguments), replaced by its meterId -- never the key itself.
function chargeError(what, tool, billingKey, err, tail = '') {
  const id = meterId(String(billingKey));
  const raw = (err != null && err.message != null) ? String(err.message) : String(err);
  const why = (billingKey != null && String(billingKey) !== '' ? raw.split(String(billingKey)).join(`[meter ${id}]`) : raw).slice(0, 200);
  const out = new Error(`${what} ${tool}: the billing failed for meter ${id} (${why})${tail}`);
  if (err != null && err.code !== undefined) out.code = err.code;
  return out;
}

// A pending charge's outcome, when it comes. what: 'hop' or 'peer hop' or
// 'remote call'; tool: the hop's tool name.
function lateOutcome(what, tool, billingKey, err, result) {
  if (err != null) return LOG.E(chargeError(what, tool, billingKey, err, '; it was pending, and this call goes unbilled'));
  return LOG.I(`${what} ${tool}: the pending billing landed (charged ${result != null && result.charged !== undefined ? result.charged : '?'})`);
}

// ci.recordCall(billingKey, tool, cost, ..., opts) once, answered once:
// onAnswer(err, result, false) with the charge's own answer when it comes
// within METER_PENDING_MS, or when this key already has MAX_PENDING_PER_KEY
// charges pending (it waits, as before); else onAnswer(null, null, true) at
// the bound, and the charge's outcome logged when it comes. A recordCall
// that throws is answered as its error. {what, opts}: the log's name for the
// path; the recordCall's own options (a session), passed as given.
function boundedCharge(ci, billingKey, tool, cost, onAnswer, {what = 'hop', opts, boundMs = METER_PENDING_MS, ceilingMs = PENDING_CEILING_MS} = {}) {
  const fp = keyFingerprint(String(billingKey));
  let answered = false;
  let pending = false;
  let landedOnce = false;   // (a provider answering twice is heard once)
  let ceiling = null;
  let slotHeld = false;
  const answer = (...a) => {
    if (answered) return undefined;
    answered = true;
    return onAnswer(...a);
  };
  const bound = setTimeout(() => {
    if (answered || landedOnce) return;
    // (this key's allowance spent: this hop waits for its own charge)
    if (pendingOf(fp) >= MAX_PENDING_PER_KEY) {
      LOG.I(`${what} ${tool}: the charge has not answered within ${boundMs} ms, and this caller already has ${MAX_PENDING_PER_KEY} charges pending; waiting for it`);
      return;
    }
    pending = true;
    takeSlot(fp);
    slotHeld = true;
    ceiling = setTimeout(() => {
      if (landedOnce || !slotHeld) return;
      slotHeld = false;
      giveSlot(fp);
      LOG.E(chargeError(what, tool, billingKey, new Error(`no answer within ${ceilingMs} ms`), '; it is pending still: its slot is given back, and its outcome logged if it comes'));
    }, ceilingMs);
    if (typeof(ceiling.unref) === 'function') ceiling.unref();
    LOG.I(`${what} ${tool}: billing pending, the charge has not answered within ${boundMs} ms; its outcome is logged when it comes`);
    answer(null, null, true);
  }, boundMs);
  if (typeof(bound.unref) === 'function') bound.unref();
  const landed = (err, result) => {
    if (landedOnce) return undefined;
    landedOnce = true;
    clearTimeout(bound);
    if (pending) {
      clearTimeout(ceiling);
      if (slotHeld) { slotHeld = false; giveSlot(fp); }
      return lateOutcome(what, tool, billingKey, err, result);
    }
    return answer(err != null ? err : null, err != null ? null : result, false);
  };
  try {
    if (opts !== undefined) ci.recordCall(billingKey, tool, cost, landed, opts);
    else ci.recordCall(billingKey, tool, cost, landed);
  } catch (e) {
    // (a throw from the answer itself, under a provider that answers at
    // once, is the caller's own: it goes on, never taken for the charge's)
    if (landedOnce) throw e;
    landed(e, null);
  }
}

// a test's: how many of a key's charges are pending now (by its key, which
// is fingerprinted here, as the count is)
const pendingForTests = (billingKey) => pendingOf(keyFingerprint(String(billingKey)));

module.exports = {boundedCharge, lateOutcome, chargeError, pendingForTests, METER_PENDING_MS, MAX_PENDING_PER_KEY, PENDING_CEILING_MS};
