'use strict';
// A call's own values (the shared runtime's design, #223 section 3): the
// output cap (maxOutputBytes) and the timeout (requestTimeout) each call is
// held to. Every call takes them when it starts (lib/session.js) and hands
// them on: to every hop's token entry (lib/call-tokens.js), to its worker
// with the call (the invoke message's `limits`), and from there to the
// worker's own early checks. So a session override, when the shared runtime
// sets one, only has to set a call's values at its start.
//
// Today every call's values are the global options: defaults() at the call's
// start. locale stays global (it is not a call's). The values that bound the
// runtime's own buffers or drains (the validators' heap, the envelope cap,
// the peer broker's held-byte shares, the drain bounds) stay per runtime.
//
// A worker holds the values each of its calls arrived with, by the call's
// token, for the call's own timers and early checks; the main thread's
// checks (the reply cap, the call's timer, the broker's caps) are the
// guarantee.
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
  return Object.freeze({maxOutputBytes: limits.maxOutputBytes, requestTimeout: limits.requestTimeout});
}

// A holder's values (a session, a token entry, an invoke message: anything
// carrying `limits`), or the defaults when it carries none (a call made
// before this, a job, a test)
function of(holder) {
  const own = holder != null ? check(holder.limits) : null;
  return own != null ? own : defaults();
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
  return l !== undefined ? l : defaults();
}

module.exports = {defaults, check, of, remember, forget, forToken, resetForTests: () => byToken.clear()};
