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
// A hop is never answered later than DEADLINE_MARGIN_MS before its caller's
// deadline (opts' deadline, where the path has one), so its answer reaches
// the caller before the caller's own timer fails it: a hop told it failed
// is never billed (the reviewer's high on #496, 1). The deadline is read
// again at least every RECHECK_MS while a hop waits (a getter: the session
// may tighten it, Session.rearm), so a tightened one is seen within
// RECHECK_MS: the hop is then still answered at least DEADLINE_MARGIN_MS -
// RECHECK_MS (150 ms) before it (round 2, b). A hop that starts within the margin of its caller's deadline is
// answered pending at once, past the allowance too: the deadline is the
// session's own (the main thread's), never a module's, so that window is
// only an outer call's last DEADLINE_MARGIN_MS, and the outer call is itself
// billed (the reviewer's ruling, round 2, a).
//
// The cap bounds how many charges are pending (the reviewer's ruling on
// #496): at most MAX_PENDING_PER_KEY of one key (counted by its meterId,
// never the key) past the bound at once. A slot is taken when a charge goes
// pending and held until that charge answers, whatever its outcome, never
// given back before (PENDING_CEILING_MS only says a charge is still
// pending). A hop that reaches the bound with its key's allowance spent
// waits for its own charge, as every hop did before, so a stall never makes
// a looping caller's hops free: billing is delayed by a stall, never lost to
// it. That wait ends at its caller's deadline less the margin (or the
// ceiling, with no deadline): the hop is then answered as pending, taking no
// slot -- a store that never answers falls under the store-down rule (a
// deduction that fails delivers the result: billChecked), said at error.
// Charges still pending when the process exits -- with a slot or past the
// allowance -- are said at error, by the key's fingerprint (never its meter
// id, which names its record in the ledger).
const LOG = require('../logger');
const {keyFingerprint, meterId} = require('../key-fingerprint');
const {codeOf} = require('./charge-mark');

const METER_PENDING_MS = 500;
// A few concurrent hops of one caller -- a scenario fanning out to its parts
// at once -- ride out a stall without waiting; any more wait for their
// charge, as before. Small: it is only a stall allowance.
const MAX_PENDING_PER_KEY = 4;
// How long before its caller's deadline a hop is answered at the latest:
// the answer still has to cross to the caller (a reply message to a worker,
// a session callback, a peer result), which takes milliseconds on a quiet
// runtime and tens of them on a busy one; a quarter second covers that
// with room, and is small beside any caller's timeout (seconds).
const DEADLINE_MARGIN_MS = 250;
// Past the store's own longest wait (json-file UPDATE_WAIT_MS, 10 s) with
// room: a charge still unanswered by then is said at error (its slot kept).
const PENDING_CEILING_MS = 60000;
// How often a waiting hop reads its caller's deadline again (a tightening
// is seen within this): a few wake-ups, only for a charge that is slow.
const RECHECK_MS = 100;

const REAL_CLOCK = Object.freeze({now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t)});

const pendingByKey = new Map();   // meterId -> charges pending past the bound, holding a slot
const unanswered = new Map();     // meterId -> every charge answered pending and not yet landed
const shownAs = new Map();        // meterId -> the key's fingerprint, as the exit line says it (its latest form)
const pendingOf = (fp) => pendingByKey.get(fp) || 0;
const add = (map, fp, d) => {
  const n = (map.get(fp) || 0) + d;
  if (n > 0) map.set(fp, n);
  else map.delete(fp);
};
let exitSaid = false;
function sayAtExit() {
  // (charges still pending at exit are said, once registered)
  if (exitSaid) return;
  exitSaid = true;
  process.once('exit', sayPendingAtExit);
}
function sayPendingAtExit() {
  for (const [id, n] of unanswered) {
    try { LOG.E(new Error(`at exit, ${n} charge(s) of ${shownAs.get(id) || 'a key'} were still pending: their outcome is unknown`)); } catch (e) { /* no logger */ }
  }
}

const unref = (t) => { if (t != null && typeof(t.unref) === 'function') t.unref(); return t; };

// A charge's error as it may be logged: the key's fingerprint (never the
// key, nor its meter id), the amount where known, and the error's code alone
// (a store's message may name a host, a URL or the key).
function chargeError(what, tool, billingKey, err, tail = '', cost = undefined) {
  const id = keyFingerprint(billingKey);
  const amount = (cost !== undefined) ? `, amount ${cost}` : '';
  const out = new Error(`${what} ${tool}: the billing failed for ${id}${amount} (${codeOf(err)})${tail}`);
  if (err != null && err.code !== undefined) out.code = err.code;
  return out;
}

// A call's charge lost after the call ran (the store failed it, mid-call):
// the key's fingerprint (never the key, nor the meter id that names its
// ledger record), the tool, the amount, and the error's code alone (a
// store's message may repeat the key). Every charge site logs this.
function chargeLost(tool, key, cost, err) {
  const out = new Error(`metering: a call's charge was not recorded: ${keyFingerprint(key)}, tool ${tool}, amount ${cost} (${codeOf(err)})`);
  if (err != null && err.code !== undefined) out.code = err.code;
  return out;
}

// A pending charge's outcome, when it comes. what: 'hop' or 'peer hop' or
// 'remote call'; tool: the hop's tool name.
function lateOutcome(what, tool, billingKey, err, result, cost) {
  if (err != null) return LOG.E(chargeError(what, tool, billingKey, err, '; it was pending, and this call goes unbilled', cost));
  return LOG.I(`${what} ${tool}: the pending billing landed (charged ${result != null && result.charged !== undefined ? result.charged : '?'})`);
}

// ci.recordCall(billingKey, tool, cost, ..., opts) once, answered once:
// onAnswer(err, result, false) with the charge's own answer when it comes in
// time, else onAnswer(null, null, true) (pending) -- at METER_PENDING_MS, or
// at the latest DEADLINE_MARGIN_MS before the caller's deadline; with this
// key's allowance spent, only at that deadline less the margin (or the
// ceiling, with none). A recordCall that throws is answered as its error.
// {what, opts, deadline}: the log's name for the path; the recordCall's own
// options (a session), passed as given; the caller's deadline (ms since the
// epoch, on clock.now's scale). boundMs, ceilingMs, clock: a test's.
function boundedCharge(ci, billingKey, tool, cost, onAnswer,
  {what = 'hop', opts, deadline, boundMs = METER_PENDING_MS, ceilingMs = PENDING_CEILING_MS, clock = REAL_CLOCK} = {}) {
  let fp = null;   // (its meterId, worked out only when the bound fires)
  let answered = false;
  let pending = false;
  let landedOnce = false;   // (a provider answering twice is heard once)
  let bound = null;         // the bound, re-armed while the deadline is read again
  let later = null;         // the allowance-spent wait, or the ceiling (one of them)
  let slotHeld = false;
  let callerThrew = null;   // (a throw from onAnswer itself: the caller's own)
  // the caller's deadline now: a number, or a getter read each time
  const deadlineNow = () => {
    const d = (typeof(deadline) === 'function') ? deadline() : deadline;
    return (typeof(d) === 'number' && Number.isFinite(d)) ? d : Infinity;
  };
  // the latest a hop may be answered, as an instant on clock's scale
  const latestAt = () => deadlineNow() - DEADLINE_MARGIN_MS;
  // fn, at `at()` -- read again at least every RECHECK_MS, so an instant that
  // moves earlier is kept -- through setRef (the handle, for landed's clear)
  const armUntil = (at, fn, setRef) => {
    const step = () => {
      const left = at() - clock.now();
      if (left <= 0) return fn();
      return setRef(unref(clock.setTimeout(step, Math.min(left, RECHECK_MS))));
    };
    const left = at() - clock.now();
    setRef(unref(clock.setTimeout(step, Math.max(0, Math.min(left, RECHECK_MS)))));
  };
  const answer = (...a) => {
    if (answered) return undefined;
    answered = true;
    try {
      return onAnswer(...a);
    } catch (e) {
      callerThrew = e;
      throw e;
    }
  };
  const goPending = () => {
    pending = true;
    if (fp == null) fp = meterId(String(billingKey));
    // (counted by its meterId; said at exit by its fingerprint, the latest
    // form -- one line a key, never the meter id itself)
    shownAs.set(fp, keyFingerprint(billingKey));
    add(unanswered, fp, 1);
    sayAtExit();
    LOG.I(`${what} ${tool}: billing pending, the charge has not answered in time; its outcome is logged when it comes`);
    answer(null, null, true);
  };
  const startedAt = clock.now();
  const onBound = () => {
    if (answered || landedOnce) return;
    fp = meterId(String(billingKey));
    if (pendingOf(fp) >= MAX_PENDING_PER_KEY) {
      // this key's allowance spent: it waits for its own charge, until its
      // caller's deadline less the margin (or the ceiling, with none), read
      // again while it waits
      const waitFrom = clock.now();
      LOG.I(`${what} ${tool}: the charge has not answered in time, and this caller already has ${MAX_PENDING_PER_KEY} charges pending; waiting for it`);
      armUntil(() => Math.min(waitFrom + ceilingMs, latestAt()), () => {
        if (answered || landedOnce) return;
        LOG.E(chargeError(what, tool, billingKey, {code: 'NO_ANSWER'},
          ': no answer before its caller\'s deadline, with this caller\'s allowance spent; answered as pending (the store-down rule), its outcome logged if it comes'));
        goPending();
      }, (h) => { later = h; });
      return;
    }
    add(pendingByKey, fp, 1);
    slotHeld = true;
    // (said, never freed: the slot is held until the charge answers)
    later = unref(clock.setTimeout(() => {
      if (landedOnce) return;
      LOG.E(chargeError(what, tool, billingKey, {code: 'NO_ANSWER'}, `: no answer within ${ceilingMs} ms; it is still pending, its slot held until it answers`));
    }, ceilingMs));
    goPending();
  };
  armUntil(() => Math.min(startedAt + boundMs, latestAt()), onBound, (h) => { bound = h; });
  const landed = (err, result) => {
    if (landedOnce) return undefined;
    landedOnce = true;
    clock.clearTimeout(bound);
    clock.clearTimeout(later);
    if (pending) {
      add(unanswered, fp, -1);
      if (!unanswered.has(fp)) shownAs.delete(fp);
      if (slotHeld) { slotHeld = false; add(pendingByKey, fp, -1); }
      return lateOutcome(what, tool, billingKey, err, result, cost);
    }
    return answer(err != null ? err : null, err != null ? null : result, false);
  };
  try {
    if (opts !== undefined) ci.recordCall(billingKey, tool, cost, landed, opts);
    else ci.recordCall(billingKey, tool, cost, landed);
  } catch (e) {
    // a throw from the answer itself, under a provider that answers at
    // once, is the caller's own: it goes on, never taken for the charge's
    if (e === callerThrew) throw e;
    // a provider that throws after it answered: its own fault, said
    if (landedOnce) return LOG.E(chargeError(what, tool, billingKey, e, '; the provider threw after it answered'));
    landed(e, null);
  }
  return undefined;
}

// a test's: how many of a key's charges are pending now (by its key, whose
// meterId the count is under); every count forgotten; what exit would say
const pendingForTests = (billingKey) => pendingOf(meterId(String(billingKey)));
const resetForTests = () => { pendingByKey.clear(); unanswered.clear(); shownAs.clear(); };

module.exports = {boundedCharge, lateOutcome, chargeError, pendingForTests, resetForTests, sayPendingAtExit,
  METER_PENDING_MS, MAX_PENDING_PER_KEY, DEADLINE_MARGIN_MS, PENDING_CEILING_MS, RECHECK_MS, chargeLost};
