'use strict';
const conditionsWhy = require('./conditions-why');
// Staging a loosening for the user's own confirmation (part 3, section 2 of
// docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md;
// plan docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md, Task 2).
//
// The settings tool answers a loosening asked for in conversation with a
// dialog for the user (an InputRequiredResult); the client retries the call
// with the answer and the requestState it was given. requestState is
// attacker-controlled (MCP 2026-07-28, basic/patterns/mrtr): it carries only
// a random nonce and an HMAC-SHA256, under this start's own key (random, in
// memory only), of that nonce, the MCP session that staged the change, and
// the change the retry names (the setting's name and its canonical value).
// The change itself is held here, server-side, with what the form showed
// (a pack's version), which no retry can alter. So a retry from another session, for
// another value or setting, after a restart, or with a state the runtime did
// not give, fails the HMAC; one past 120 s has expired; and single use is
// enforced here, not trusted to the client.
//
// One pending change at a time (per start): a new one replaces it. Prompt
// fatigue: a decline (a cancel counts as one) locks that setting's kind
// against conversation until the next start (a decline on any pack locks
// every pack), and so do two expiries; at most FORMS_PER_START forms a start.
//
// In a shared runtime (B2 Task 5; the design, #236 section 3) all of that is
// each session's own: confirmations(session) is that session's store, with
// its staged change, its nonce, its decline lock per kind and its three
// forms. The MAC key is one for the runtime, and the session id, which
// comes from the connection, is in the MAC. Across a user's sessions there
// is one window per kind (UserWindow): three declines or expiries within 30
// minutes stop that kind's forms for the next 30, in every session, and a
// form pending anywhere counts toward the three, so a prompt injection
// cannot fan forms out over sessions. An expiry is counted when the form's
// own deadline passes, on a timer, not at a later ask. --stdio's one store
// (confirmations() with no session) is outside the window, as before.
const crypto = require('crypto');

const TTL_MS = 120 * 1000;
const STATE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;   // 16-byte nonce, 32-byte HMAC, base64url
const USED_KEPT = 64;   // used nonces remembered, so a replay says USED rather than INVALID
// the nonce-and-HMAC mechanics, shared with a module's question (ctx.ask):
// the MAC over one JSON array, its comparison as canonical strings in
// constant time, the nonce, the short memory of nonces
const mechanics = require('./request-state');
const FORMS_PER_START = 3;
const EXPIRIES_TO_LOCK = 2;
// a setting's kind (every pack.<name> is one kind), as lib/settings-tool.js
// groups its history by
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
// every module.<package>.<setting> is one kind too, `module` (the
// module-level configuration design, section 4.4)
const MODULE_SETTING = /^module\..+\.[a-z][a-zA-Z0-9_]{0,63}$/;
const kindOf = (name) => (PACK.test(String(name)) ? 'pack' : MODULE_SETTING.test(String(name)) ? 'module' : String(name));
// a monotonic clock in ms (a wall-clock step never extends or ends a form)
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
const isSession = (s) => typeof(s) === 'string' && s.length > 0 && s.length <= 200;
// the per-user window: this many declines or expiries of a kind within
// WINDOW_MS stop that kind's forms for the next WINDOW_MS
const WINDOW_MS = 30 * 60 * 1000;
const WINDOW_COUNT = 3;
const KINDS = ['maxOutputBytes', 'requestTimeout', 'pack', 'module'];
// the most declines a restored list holds
const MAX_LOADED = 64;
// how long a decline matters to a restarted runtime: it can be the first of
// three that locked the kind a window after it
const LOAD_KEEP_MS = 2 * WINDOW_MS;
// a decline's time may be this far ahead of this clock, as the daemon's
// restore allows it (lib/session-transport/restore.js): a wall clock set
// back a little between a decline and a restart loses no list
const LOAD_AHEAD_MS = 60 * 1000;

// The clock, the timers and the daemon's ear: a test's own (configure).
const deps = {};
function configure(given = {}) {
  Object.assign(deps, {
    now: monotonicMs,
    // the wall clock: only for the time a decline is told with, and the
    // ages of the daemon's list (load)
    wall: () => Date.now(),
    timer: (fn, ms) => { const t = setTimeout(fn, ms); if (typeof(t.unref) === 'function') t.unref(); return t; },
    clearTimer: (t) => { if (t != null) clearTimeout(t); },
    // each decline or expiry, to the daemon, which keeps them across a
    // runtime restart (Task 6's message): the kind and a time, nothing else
    tell: (m) => { try { require('./control-channel').tell(m); } catch (e) { /* no channel: this start's window only */ } }
  }, given);
}
configure();

// The window across every session of the user, per kind.
class UserWindow {
  constructor() {
    this.events = new Map();        // kind -> [when], declines and expiries
    this.lockedUntil = new Map();   // kind -> when its forms may be shown again
  }

  // the declines and expiries of a kind still inside the window
  count(kind) {
    const now = deps.now();
    const kept = (this.events.get(kind) || []).filter((at) => now - at < WINDOW_MS);
    if (kept.length > 0) this.events.set(kind, kept); else this.events.delete(kind);
    return kept.length;
  }

  // a decline or an expiry, now
  note(kind) {
    this.noteAt(kind, deps.now());
    deps.tell({type: 'decline', kind: kind, at: deps.wall()});
  }

  // one at a time of its own (on this start's clock): the third within the
  // window locks the kind for a window from then
  noteAt(kind, when) {
    const kept = (this.events.get(kind) || []).filter((at) => when - at < WINDOW_MS).concat([when]);
    this.events.set(kind, kept);
    if (kept.length >= WINDOW_COUNT) this.lockedUntil.set(kind, Math.max(this.lockedUntil.get(kind) || 0, when + WINDOW_MS));
  }

  // The daemon's list, after a runtime restart (Task 6's restore): the
  // declines and expiries it kept, [{kind, at}], at epoch ms. Validated as
  // strictly as a session's state (N2): a known kind and a whole-number
  // time no later than now, nothing else in an entry, at most MAX_LOADED in
  // all. A list that fails is dropped whole and every kind is locked
  // (lockAll): what it cannot show was declined is taken as declined.
  // -> whether it was loaded.
  load(list) {
    const wall = deps.wall();
    const ok = Array.isArray(list) && list.length <= MAX_LOADED && list.every((d) => d != null && typeof(d) === 'object' && !Array.isArray(d)
      && Object.keys(d).sort().join() === 'at,kind' && KINDS.includes(d.kind) && Number.isInteger(d.at) && d.at >= 0 && d.at <= wall + LOAD_AHEAD_MS);
    if (!ok) { this.lockAll(); return false; }
    const now = deps.now();
    // oldest first, each at its age on this start's clock. A lock runs a
    // window from its third event, so events up to two windows old count:
    // the daemon keeps each one LOAD_KEEP_MS.
    for (const d of list.slice().sort((x, y) => x.at - y.at)) {
      // one a little ahead of this clock (the restore's own slack) is now
      const age = Math.max(0, wall - d.at);
      if (age < LOAD_KEEP_MS) this.noteAt(d.kind, now - age);
    }
    return true;
  }

  // Every kind locked for a window from now: a start that could not learn
  // what was declined before it (Task 6: no restore within its 3 s, or a
  // list that failed).
  lockAll() {
    const until = deps.now() + WINDOW_MS;
    for (const kind of KINDS) this.lockedUntil.set(kind, Math.max(this.lockedUntil.get(kind) || 0, until));
  }

  locked(kind) {
    return deps.now() < (this.lockedUntil.get(kind) || 0);
  }

  // whether one more form of the kind may be shown: pending, the forms of
  // that kind up in any session now
  mayStage(kind, pending) {
    return !this.locked(kind) && this.count(kind) + pending < WINDOW_COUNT;
  }
}

class Confirmations {
  // key: the runtime's one MAC key (a shared runtime's sessions); window:
  // the user's (then also: an expiry is counted on a timer at the form's
  // own deadline)
  // session: its id, so a change of its locks or forms is announced (onChange)
  constructor({now = monotonicMs, ttlMs = TTL_MS, key = null, window = null, session = null} = {}) {
    this.session = session;
    this.now = now;
    this.ttlMs = ttlMs;
    this.key = key != null ? key : crypto.randomBytes(32);
    this.window = window;
    this.timer = null;
    this.expired = [];              // a session's forms that ended unanswered, for the history (takeExpired)
    this.gone = new mechanics.RecentNonces(USED_KEPT);   // a session's recent expired nonces: a late answer is told so
    this.pending = null;            // {nonce, mac, staged}
    this.used = new mechanics.RecentNonces(USED_KEPT);   // recent used nonces
    this.declines = new Set();      // kinds
    this.expiries = new Map();      // kind -> count
    this.forms = FORMS_PER_START;
    this.lockChanges = 0;           // every lock that fell and every latch, counted (lockChangesOf)
    this.latchedBy = undefined;     // the latch (N1): undefined, or why (lib/conditions-why.js check: {reason, at?} or null)
    this.latchedKinds = new Set();  // the kinds the latch locked (a kind declined before it stays the user's decline)
    this.restoredKinds = new Set(); // the kinds locked by a restore across a restart: their origin unknown (the reviewer's ruling (c) on #337)
  }

  // scope: what the change is for, when it is not the default (B2 Task 5b:
  // 'all-sessions'). It is in the MAC and in the staged change, so the form
  // a user saw is the change that is made; a state with no scope is byte
  // for byte what it always was.
  macOf(nonce, {session, name, next, scope = null}) {
    // one JSON array: no two different changes give the same bytes
    return mechanics.macOf(this.key, ['countinghouse-confirm/1', nonce, session, String(name), next].concat(scope != null ? [String(scope)] : []));
  }

  // A pending form past its 120 s, left unanswered: cleared and counted as an
  // expiry (before a decline lock is read, so the second one locks before a
  // third form is sent). -> the expired staged change, or null.
  sweep() {
    const p = this.pending;
    if (p == null || this.now() - p.staged.at <= this.ttlMs) return null;
    this.clearPending();
    this.unanswered(p, 'expired');
    return p.staged;
  }

  // A form that ended with no answer: counted. In a shared runtime's
  // session it is also kept for the history (takeExpired: nobody may be
  // asking when it ends), and, when its time ran out, its nonce is kept so
  // that an answer arriving late is told it expired. how: 'expired' (its
  // 120 s, or its session's end) or 'replaced' (its session asked for
  // another).
  unanswered(p, how) {
    this.countExpiry(p.staged.name);
    if (this.window == null) return;
    this.expired.push(Object.assign({}, p.staged, {ended: how}));
    if (how !== 'expired') return;
    this.gone.add(p.nonce);
  }

  // the pending form gone, with its timer
  clearPending() {
    this.pending = null;
    if (this.timer != null) { deps.clearTimer(this.timer); this.timer = null; }
  }

  // A session's forms that ended unanswered since this was last asked, for
  // the history, each once: the staged change, with ended: 'expired' or
  // 'replaced'.
  takeExpired() {
    return this.expired.splice(0);
  }

  // The session's decline locks, as its export carries them (Task 6).
  locks() {
    return [...this.declines].sort();
  }

  // The session's locks, forms left and unanswered kinds as its export
  // carries them (lib/session-state.js): how it would stand if the runtime
  // died now. A form open now is one that would never be answered, so it
  // counts as unanswered: a kind with one form left unanswered and another
  // open is told as locked, which is what two are. An answer's tell
  // corrects it. Here nothing is locked by it: the open form may still be
  // answered. (unanswered(p, how), above, is what counts one for good.)
  // -> {locks, formsLeft, unanswered}: a kind is in one list at most, and
  // unanswered lists a kind only with a form spent.
  exported() {
    const counts = new Map(this.expiries);
    if (this.pending != null) {
      const kind = kindOf(this.pending.staged.name);
      counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    const locks = new Set(this.declines);
    for (const [kind, n] of counts) if (n >= EXPIRIES_TO_LOCK) locks.add(kind);
    const unanswered = [...counts].filter(([kind, n]) => n >= 1 && !locks.has(kind)).map(([kind]) => kind);
    return {locks: [...locks].sort(), formsLeft: this.forms, unanswered: unanswered.sort()};
  }

  // A session's locks and forms left as the daemon kept them across a
  // runtime restart (Task 6's import). Nothing is counted in the user's
  // window by it: what was declined came in the daemon's own list (load).
  // Only ever tighter than a fresh store: locks added, forms taken away.
  // unanswered: the kinds it had left one form unanswered of, each
  // counted as one here: the next of that kind locks it.
  restore({locks, formsLeft, unanswered} = {}) {
    for (const kind of Array.isArray(locks) ? locks : []) {
      if (!KINDS.includes(kind) || this.declines.has(kind)) continue;
      this.declines.add(kind);
      // a decline or a latch before the restart: which is not known, so its
      // refusal claims neither
      this.restoredKinds.add(kind);
    }
    if (Number.isInteger(formsLeft) && formsLeft >= 0 && formsLeft < this.forms) this.forms = formsLeft;
    for (const kind of Array.isArray(unanswered) ? unanswered : []) {
      if (KINDS.includes(kind) && !(this.expiries.get(kind) >= 1)) this.expiries.set(kind, 1);
    }
  }

  // Its locks or its forms left may have changed: said to whoever keeps a
  // session's state (lib/session-state.js), which tells only what differs.
  announce() {
    if (this.session == null) return;
    for (const fn of listeners) { try { fn(this.session); } catch (e) { /* the change is made all the same */ } }
  }

  // N1: one "conditions: no" from the session's client locks every kind for
  // its life, as ordinary decline locks. Not a decline of the user's: the
  // window counts nothing, and a form pending is simply gone.
  // why: the client line's (lib/conditions-why.js), only as that rule
  // takes it, and the first one that says something: a later latch with a
  // why replaces none, never another why. The refusal says it.
  latch(why = null) {
    const w = conditionsWhy.check(why);
    if (this.latchedBy == null) this.latchedBy = w;
    this.clearPending();
    for (const kind of KINDS) {
      // a kind restored across a restart is the latch's now: a fresh "no" is
      // a known cause
      if (!this.declines.has(kind) || this.restoredKinds.has(kind)) this.latchedKinds.add(kind);
      this.restoredKinds.delete(kind);
      this.declines.add(kind);
    }
    // counted also when every kind was locked already: a latch is its own fact
    this.lockChanges += 1;
    this.announce();
  }

  // The session's end: a form still pending counts as an expiry.
  end() {
    const p = this.pending;
    if (p == null) return;
    this.clearPending();
    this.unanswered(p, 'expired');
  }

  // change: {name, old, next, client: {name, version}, session} ->
  // {requestState, replaced}, or null (no forms left, no session, or the
  // kind locked: the caller refuses)
  stage(change) {
    if (change == null || !isSession(change.session)) return null;
    this.sweep();
    // In a shared runtime a form its session leaves unanswered to ask for
    // another is an expiry (F7): shown all the same. It is counted first,
    // before anything is decided, since it may be the one that locks the
    // kind: the next form would then be one that could never be accepted.
    // If no form follows, it is kept for the history (takeExpired).
    let replaced = null;
    if (this.window != null && this.pending != null) {
      const p = this.pending;
      this.clearPending();
      this.unanswered(p, 'replaced');
      replaced = p.staged;
    }
    if (this.forms <= 0 || this.declined(change.name)) return null;
    // the user's window, before a form is spent: the forms of this kind up
    // in any session count
    if (this.window != null && !this.window.mayStage(kindOf(change.name), pendingAnywhere(kindOf(change.name)))) return null;
    this.forms -= 1;
    const staged = {
      name: String(change.name),
      old: change.old,
      next: change.next,
      version: change.version != null ? String(change.version) : null,
      client: change.client != null ? {name: String(change.client.name), version: String(change.client.version)} : null,
      session: change.session,
      at: this.now()
    };
    // only a change that has one carries a scope: every other staged change
    // is the shape it always was
    if (change.scope != null) staged.scope = String(change.scope);
    // what settings.json yielded when the form was shown, for a change that
    // will be stored (an all-sessions one): the retry is refused if the file
    // has changed since
    if (change.yields !== undefined) staged.yields = change.yields;
    const nonce = mechanics.newNonce();
    const mac = this.macOf(nonce, staged);
    if (this.window == null) replaced = this.pending != null ? this.pending.staged : null;
    // the form that follows says it itself: the one it replaced is not said twice
    else if (replaced != null) this.expired.pop();
    this.pending = {nonce, mac, staged};
    if (this.window != null) {
      // its own deadline, counted when it passes, not at a later ask
      this.timer = deps.timer(() => { this.timer = null; this.sweep(); }, this.ttlMs + 1);
    }
    // a form was spent
    this.announce();
    return {requestState: `${nonce}.${mac}`, replaced};
  }

  countExpiry(name) {
    const kind = kindOf(name);
    const n = (this.expiries.get(kind) || 0) + 1;
    this.expiries.set(kind, n);
    if (n >= EXPIRIES_TO_LOCK) { this.declines.add(kind); this.lockChanges += 1; }
    if (this.window != null) this.window.note(kind);
    this.announce();
  }

  // As verify, without using the state up: {ok: true, staged, requestState}
  // | {ok: false, code} (a retry that carries no answer gets the same form).
  check(requestState, retry) {
    return this.verify(requestState, retry, {consume: false});
  }

  // the retry's {name, next, session} -> {ok: true, staged} | {ok: false, code}
  verify(requestState, retry, {consume = true} = {}) {
    const invalid = {ok: false, code: 'SETTING_CONFIRMATION_INVALID'};
    const m = typeof(requestState) === 'string' && requestState.length <= 128 ? STATE.exec(requestState) : null;
    if (m == null || retry == null || !isSession(retry.session)) return invalid;
    const [, nonce, mac] = m;
    if (this.used.has(nonce)) return {ok: false, code: 'SETTING_CONFIRMATION_USED'};
    // a session's form whose time ran out before its answer came
    if (this.gone.has(nonce)) return {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'};
    const p = this.pending;
    if (p == null || p.nonce !== nonce) return invalid;
    // the HMAC of what the retry says, against the one given: another session,
    // setting or value (or a forged state) does not match
    // compared as the canonical strings, in constant time (request-state's
    // sameMac: one spelling only of a MAC is valid)
    if (!mechanics.sameMac(this.macOf(nonce, retry), mac)) return invalid;
    if (p.staged.name !== String(retry.name) || p.staged.next !== retry.next || p.staged.session !== retry.session) return invalid;
    if ((p.staged.scope != null ? p.staged.scope : null) !== (retry.scope != null ? String(retry.scope) : null)) return invalid;
    if (this.now() - p.staged.at > this.ttlMs) {
      this.clearPending();
      this.unanswered(p, 'expired');
      return {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'};
    }
    if (!consume) return {ok: true, staged: Object.assign({}, p.staged), requestState: `${nonce}.${mac}`};
    // used up here, before anything else can see it (single use, server-side).
    // Nothing is announced by it: what the answer leaves is, once (its
    // decline's lock, its change, or lib/settings-tool.js at the end of an
    // answer that applied nothing).
    this.clearPending();
    this.used.add(nonce);
    return {ok: true, staged: Object.assign({}, p.staged, {client: p.staged.client != null ? Object.assign({}, p.staged.client) : null})};
  }

  // by setting name: its kind (any pack.* is 'pack')
  decline(name) {
    this.declines.add(kindOf(name));
    this.lockChanges += 1;
    if (this.window != null) this.window.note(kindOf(name));
    this.announce();
  }
  declined(name) { return this.declines.has(kindOf(name)); }
  // whether the session is latched (N1), and why, as the client said it
  latched() { return this.latchedBy !== undefined; }
  // whether this kind is locked by the latch, not by the user
  latchedFor(name) { return this.latchedKinds.has(kindOf(name)); }
  // whether this kind's lock came back across a restart, its cause unknown
  restoredFor(name) { return this.restoredKinds.has(kindOf(name)); }
  latchedWhy() { return this.latchedBy === undefined ? null : this.latchedBy; }
  formsLeft() { return this.forms; }
}

// One per process: a start's confirmations, with its key (--stdio's one
// session, and HTTP's none). And, in a shared runtime, one per session:
// under the runtime's one key, inside the user's one window.
let current = null;
let sharedKey = null;
let theWindow = null;
const bySession = new Map();   // session id -> its Confirmations
const userWindow = () => (theWindow != null ? theWindow : (theWindow = new UserWindow()));
function confirmations(session = null) {
  if (session == null) return (current != null ? current : (current = new Confirmations()));
  if (!isSession(session)) throw new Error('settings-confirm: a session is its id');
  let own = bySession.get(session);
  if (own == null) {
    if (sharedKey == null) sharedKey = crypto.randomBytes(32);
    own = new Confirmations({now: () => deps.now(), key: sharedKey, window: userWindow(), session: session});
    bySession.set(session, own);
  }
  return own;
}
// the forms of a kind up in any session now
function pendingAnywhere(kind) {
  let n = 0;
  for (const own of bySession.values()) if (own.pending != null && kindOf(own.pending.staged.name) === kind) n += 1;
  return n;
}
// A session's end: its store is gone, and a form it left pending counts as
// an expiry in the user's window. -> its forms that ended unanswered and
// were not yet said (the one pending, any its timer expired), for the
// history.
function forget(session) {
  const own = bySession.get(session);
  if (own == null) return [];
  own.end();
  bySession.delete(session);
  return own.takeExpired();
}
// how many sessions have a store (a session's end leaves none)
const held = () => bySession.size;
// A session's locks and forms left, as its export carries them, read
// without making a store: one that never asked has none of the first and
// all of the second.
function stateOf(session) {
  const own = bySession.get(session);
  return own == null ? {locks: [], formsLeft: FORMS_PER_START} : {locks: own.locks(), formsLeft: own.formsLeft()};
}
// The same as a session's export carries it (Confirmations.exported), read
// without making a store.
function exportedOf(session) {
  const own = bySession.get(session);
  return own == null ? {locks: [], formsLeft: FORMS_PER_START, unanswered: []} : own.exported();
}
// A session's state may have changed outside its store's own methods (an
// answer whose change was not applied): said, if it has a store.
function announceFor(session) {
  const own = bySession.get(session);
  if (own != null) own.announce();
}
// fn(session): a session's locks or forms left may have changed
const listeners = [];
// How many times a lock fell on a session or it was latched (N1), since its
// store was made. Whoever waits before it loosens something for a session
// reads it before and after: the list of locks alone does not show a latch
// on a session whose every kind was locked already.
function lockChangesOf(session) {
  const own = bySession.get(session);
  return own == null ? 0 : own.lockChanges;
}

function onChange(fn) { if (typeof(fn) === 'function' && !listeners.includes(fn)) listeners.push(fn); }
// Whether the user's window has room for one more form of a setting's kind
// now: asked before a session's client is (its conditions cost ch-local a
// child process), so a form that could not be shown costs nothing. A form
// the asking session has up counts either way: left for another, it is an
// expiry.
const windowOpenFor = (name) => userWindow().mayStage(kindOf(name), pendingAnywhere(kindOf(name)));
// N1's latch, for a session (lib/sessions.js, on a client frame that says
// conditions: no).
function latch(session, why = null) {
  confirmations(session).latch(why);
}
const resetForTests = () => {
  for (const own of bySession.values()) own.clearPending();
  bySession.clear();
  current = null;
  sharedKey = null;
  theWindow = null;
  listeners.length = 0;
  configure();
};

module.exports = {Confirmations, UserWindow, confirmations, userWindow, forget, held, stateOf, exportedOf, announceFor, lockChangesOf, onChange, windowOpenFor, latch, configure, resetForTests, TTL_MS, FORMS_PER_START, WINDOW_MS, LOAD_KEEP_MS, kindOf};
