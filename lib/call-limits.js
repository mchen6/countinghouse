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
// Whether this is the main thread, asked only for a holder with a session:
// a worker loads this file after the lockdown, which refuses worker_threads
// there, and a worker's holders never carry a session.
let mainThread = null;
const onMainThread = () => {
  if (mainThread == null) mainThread = require('worker_threads').isMainThread;
  return mainThread;
};

const positiveInteger = (v) => Number.isInteger(v) && v > 0;

// the global options, as a call starting now takes them
// How the agent can raise the output cap, for a size cap's error (the
// business decision-coverage audit, 2026-11-15): with the settings tool
// served (ch-local), the tool's call or the terminal command; otherwise the
// operator's flag. The value suggested is the size needed, in whole MiB, as
// the settings tool takes it, and never past what may be set here: the
// tool's 256MiB, or the operator's ceiling (part 3) when that is lower. A
// size above it gets the most allowed and no command (the review of #265);
// a ceiling that can't be trusted lets conversation raise nothing.
// Language-neutral, so it goes into the message in every locale.
const MiB = 1024 * 1024;
const SETTING_MAX = 256 * MiB;
const sizeText = (v) => (v % MiB === 0 ? `${v / MiB}MiB` : `${v}B`);
// the most maxOutputBytes may be set to here, or null for no raise at all:
// a worker takes the value it was spawned with (outputCeiling: only
// getOptionsForWorker sets it, so it is the worker's mark too -- a worker
// loads this file after the lockdown, which refuses worker_threads there);
// the main thread reads the ceiling (the settings tool's cache: this error
// is rare)
function mostAllowed() {
  if (options.outputCeiling !== undefined) {
    return options.outputCeiling === null ? null : (positiveInteger(options.outputCeiling) ? Math.min(SETTING_MAX, options.outputCeiling) : SETTING_MAX);
  }
  let c;
  try {
    c = require('./settings-tool').cachedCeiling(() => require('./settings-ceiling').readCeiling());
  } catch (e) {
    return null;
  }
  return ceilingBound(c);
}
function ceilingBound(c) {
  if (c == null || c.state === 'none') return SETTING_MAX;
  if (c.state !== 'trusted') return null;
  const v = c.ceiling != null ? c.ceiling.maxOutputBytes : undefined;
  return positiveInteger(v) ? Math.min(SETTING_MAX, v) : SETTING_MAX;
}
function raiseHint(bytes, most = (options.settingsTool === true ? mostAllowed() : SETTING_MAX)) {
  const needed = Math.max(MiB, Math.ceil(Number(bytes) / MiB) * MiB);
  if (options.settingsTool !== true) return `the operator's --maxOutputBytes ${Number.isFinite(needed) ? needed : SETTING_MAX}`;
  if (most == null) return 'no raise in conversation here: the operator\'s ceiling can\'t be trusted';
  if (!Number.isFinite(needed) || needed > most) return `the most allowed here is ${sizeText(most)}`;
  const v = sizeText(needed);
  return `countinghouse_settings {"action":"set","name":"maxOutputBytes","value":"${v}"}, or \`ch-local settings set maxOutputBytes ${v}\` in a terminal`;
}

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
//
// On the main thread a holder of a shared runtime's session (a call's
// sessionId, a token entry's session, or one passed in for a holder that has
// none of its own, as the reply cap's) is held, field by field, to the
// tighter of its own values and its session's current ones (B2 Task 2:
// lib/session-settings.js limitsOf, else the defaults under the operator's
// ceiling, underCeiling: a default above the ceiling never serves): so a terminal
// tightening, or the session's own, reaches a call already under way at its
// next check, and a raise mid-call never loosens it. A worker has no
// session state: its copy is the early answer only.
function sessionOfHolder(holder) {
  if (holder == null) return null;
  if (typeof(holder.sessionId) === 'string') return holder.sessionId;
  if (typeof(holder.session) === 'string') return holder.session;
  return null;
}
function ownOf(holder) {
  const given = holder != null ? holder.limits : null;
  if (given == null) return defaults();
  const own = check(given);
  if (own == null) throw new Error('call-limits: a malformed override');
  return own.bound === 'defaults' ? boundedNow(own) : own;
}
function of(holder, session = sessionOfHolder(holder)) {
  const own = ownOf(holder);
  if (session == null || !onMainThread()) return own;
  const settings = require('./session-settings');
  const now = settings.limitsOf(session) || settings.underCeiling();
  const min = (v, cur) => (positiveInteger(cur) && (!positiveInteger(v) || cur < v) ? cur : v);
  return Object.freeze({maxOutputBytes: min(own.maxOutputBytes, now.maxOutputBytes), requestTimeout: min(own.requestTimeout, now.requestTimeout)});
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
// The map is read and written with Map's methods as they were when this file
// loaded (a worker's boot, before module code): a token is never handed to a
// method module code replaced.
const uncurry = (fn) => Function.prototype.call.bind(fn);
const MapGet = uncurry(Map.prototype.get);
const MapSet = uncurry(Map.prototype.set);
const MapHas = uncurry(Map.prototype.has);
const MapDelete = uncurry(Map.prototype.delete);
const MapClear = uncurry(Map.prototype.clear);
const MapKeys = uncurry(Map.prototype.keys);
const MapSize = uncurry(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
const MapIteratorNext = uncurry(Object.getPrototypeOf(new Map().keys()).next);
const byToken = new Map();
const REMEMBERED_MAX = 10000;   // a call that never answers (its worker killed meanwhile) is not kept forever
function remember(token, limits) {
  const l = check(limits);
  if (typeof(token) !== 'string' || l == null) return;
  if (MapSize(byToken) >= REMEMBERED_MAX && !MapHas(byToken, token)) MapDelete(byToken, MapIteratorNext(MapKeys(byToken)).value);
  MapSet(byToken, token, l);
}
function forget(token) { if (typeof(token) === 'string') MapDelete(byToken, token); }
// a call's values by its token (a hop it makes takes the caller's), or the
// defaults
function forToken(token) {
  const l = typeof(token) === 'string' ? MapGet(byToken, token) : undefined;
  if (l === undefined) return defaults();
  return l.bound === 'defaults' ? boundedNow(l) : l;
}

module.exports = {defaults, check, of, override, tighter, remember, forget, forToken, raiseHint, ceilingBound, resetForTests: () => MapClear(byToken)};
