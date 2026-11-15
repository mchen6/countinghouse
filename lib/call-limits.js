'use strict';
// A call's own values (the shared runtime's design, #223 section 3): the
// output cap (maxOutputBytes) and the timeout (requestTimeout) each call is
// held to. Every call takes them when it starts (lib/session.js) and hands
// them on: to every hop's token entry (lib/call-tokens.js), to its worker
// with the call (the invoke message's `limits`), and from there to the
// worker's own early checks. So a session override, when the shared runtime
// sets one, only has to set a call's values at its start.
//
// A call carries only a real override (a session's, once the shared runtime
// sets one, through override()): one with none reads the global options at
// each check, so a live tightening (the settings tool, a control set) reaches
// a running call's later hops and its reply cap (the security review of
// #233). Today no call has an override. locale stays global (it is not a
// call's). The values that bound the
// runtime's own buffers or drains (the validators' heap, the envelope cap,
// the peer broker's held-byte shares, the drain bounds) stay per runtime.
//
// A worker holds the values each of its calls arrived with, by the call's
// token, for the call's own timers and early checks; the main thread's
// checks (the reply cap, the call's timer, the broker's caps) are the
// guarantee.
//
// An override may be bounded by the defaults (bound: 'defaults', the shared
// runtime's B1 Task 3): a job run of a session that has ended carries the
// session's last values so marked, and every check takes each field's
// tighter of it and the global option as it is at that check. So a loosening
// never outlives its session, a tightening does, and a later tightening of
// the defaults still reaches the run (never pinned at its start). A hop of
// such a call stays bounded (tighter() keeps the mark).
const options = require('./cli-options');

const positiveInteger = (v) => Number.isInteger(v) && v > 0;

// the global options, as a call starting now takes them
function defaults() {
  return Object.freeze({maxOutputBytes: options.maxOutputBytes, requestTimeout: options.requestTimeout});
}

// {maxOutputBytes, requestTimeout}, both positive integers, frozen; or null
function check(limits) {
  if (limits == null || typeof(limits) !== 'object') return null;
  if (!positiveInteger(limits.maxOutputBytes) || !positiveInteger(limits.requestTimeout)) return null;
  return Object.freeze({maxOutputBytes: limits.maxOutputBytes, requestTimeout: limits.requestTimeout,
    ...(limits.bound === 'defaults' ? {bound: 'defaults'} : {})});
}

// A checked override bounded by the defaults -> its values now: each field
// the tighter of its own and the option's (an option that is unset bounds
// nothing; the runtime always sets both)
function boundedNow(own) {
  const d = defaults();
  const min = (v, def) => (positiveInteger(def) ? Math.min(v, def) : v);
  return Object.freeze({maxOutputBytes: min(own.maxOutputBytes, d.maxOutputBytes), requestTimeout: min(own.requestTimeout, d.requestTimeout)});
}

// A holder's values (a session, a token entry, an invoke message: anything
// carrying `limits`): its override, or the global options as they are now
// when it carries none. An override that is present but malformed fails
// closed (it is refused where it is set: override()).
function of(holder) {
  const given = holder != null ? holder.limits : null;
  if (given == null) return defaults();
  const own = check(given);
  if (own == null) throw new Error('call-limits: a malformed override');
  return own.bound === 'defaults' ? boundedNow(own) : own;
}

// Sets holder's override; a malformed one is refused (never the defaults
// instead: they could be looser than what was meant).
function override(holder, limits) {
  const own = check(limits);
  if (own == null) throw new Error('call-limits: an override is {maxOutputBytes, requestTimeout}, both positive integers');
  holder.limits = own;
  return own;
}

// The tighter of two overrides, field by field (a hop's own and its
// caller's: never looser than the caller's); null when neither is one.
function tighter(a, b) {
  const x = check(a);
  const y = check(b);
  if (x == null) return y;
  if (y == null) return x;
  return Object.freeze({maxOutputBytes: Math.min(x.maxOutputBytes, y.maxOutputBytes), requestTimeout: Math.min(x.requestTimeout, y.requestTimeout),
    ...((x.bound === 'defaults' || y.bound === 'defaults') ? {bound: 'defaults'} : {})});
}

// Worker side: the values each call arrived with, by its token, while it runs.
const byToken = new Map();
const REMEMBERED_MAX = 10000;   // a call that never answers (its worker killed meanwhile) is not kept forever
function remember(token, limits) {
  const l = check(limits);
  if (typeof(token) !== 'string' || l == null) return;
  if (byToken.size >= REMEMBERED_MAX && !byToken.has(token)) byToken.delete(byToken.keys().next().value);
  byToken.set(token, l);
}
function forget(token) { if (typeof(token) === 'string') byToken.delete(token); }
// a call's values by its token (a hop it makes takes the caller's), or the
// defaults
function forToken(token) {
  const l = typeof(token) === 'string' ? byToken.get(token) : undefined;
  if (l === undefined) return defaults();
  return l.bound === 'defaults' ? boundedNow(l) : l;
}

module.exports = {defaults, check, of, override, tighter, remember, forget, forToken, resetForTests: () => byToken.clear()};
