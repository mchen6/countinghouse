'use strict';
// Never silent (packs in place, part 2, plan Task A4; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): each pack
// change applied to a running session is said once as an MCP
// notifications/message, for clients that show it, and once as a one-line
// text block on the next result of a tool of that pack, which every client
// shows. A notice for a module no longer loaded (an unload) goes on the next
// result of any tool. ch-local start sends them over the control channel.
//
// A shared runtime (B2 Task 3; #236 section 3): each session has its own
// queue, notifier (its s.notify) and level (its logging/setLevel). A notice
// for one session is said to it alone; a global one (a terminal change, a
// pack ch-local changed) is copied into every session open now. One told to
// every session as a standing fact (keep: ch-local's lines over the control
// channel, a module loaded, unloaded, turned off or not applied) is kept
// for the sessions that join later too, bounded (STANDING_*); any other
// global one reaches only the sessions open now. A session's queue ends
// with it (forget). Under --stdio and over HTTP there is one queue, as
// before.
const NOTICE_MAX = 200;
// the runtime's own sentence, which it bounds itself (a module turned off:
// its callers and the way back, lib/settings-tool.js offNotice): said
// whole, still one line (#449's high review, round 3, R). Its shortest form
// with two names of npm's longest, 214 characters, is about 625
const OWN_NOTICE_MAX = 700;
// the runtime's own notices (own: true) queue in a lane of their own, taken
// with any tool's result before the others: a flood of other notices never
// evicts them (#449's high review, round 6, 1)
const OWN = Symbol('own');
const PER_MODULE_MAX = 20;

// module (friendly name), or null for a module no longer loaded ->
// {texts, dropped}: the newest PER_MODULE_MAX, and how many older ones were
// let go (said as one line, so nothing is silent)
const pending = new Map();
let notifier = null;         // the stdio server's notify, once it serves
// a shared runtime's sessions: id -> {pending (as above), notify, minimum}
const perSession = new Map();
// MCP's syslog levels: a notice is sent as a notification unless the client
// asked for a level above notice (logging/setLevel)
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
let minimum = 'debug';

function setNotifier(fn) { notifier = (typeof(fn) === 'function') ? fn : null; }
// session: in a shared runtime, a session's id, its level alone; else the
// process's. false: an unknown level, or no such session.
function setLevel(level, session = null) {
  if (!LEVELS.includes(level)) return false;
  if (shared()) {
    const q = perSession.get(session);
    if (q == null) return false;
    q.minimum = level;
    return true;
  }
  minimum = level;
  return true;
}

// A shared runtime's session, from its settle to its end (lib/sessions.js):
// notify is its s.notify.
function openSession(id, notify) {
  if (typeof(id) !== 'string' || perSession.has(id)) return;
  const q = {pending: new Map(), notify: (typeof(notify) === 'function') ? notify : null, minimum: 'debug'};
  perSession.set(id, q);
  joined(q);
}

// ---- Standing notices (a shared runtime) ----
// What was told to every session that a session joining later is still to
// hear: ch-local's start sends its lines (outside edits, the ceiling's
// notes, the audit line, a module not loaded, the upgrade check) as soon as
// the runtime's control channel is up, before any session can have settled,
// and a module may be unloaded or turned off while no session is open. Each
// is kept with when it was told, and given to a session at its open, queued
// only: never sent as a notification then (a client that sent initialize
// may not be done with it), so its next result carries them, as any
// session's. Bounded: the newest STANDING_PER_KIND of each kind (a module's
// name, or the runtime's own lane), STANDING_KINDS kinds (past it, the kind
// told longest ago goes, all of it), each for STANDING_MS. Past a bound the
// oldest go, and a joining session is told in one line how many of this
// run's were let go, so none is lost unsaid.
const STANDING_PER_KIND = 5;
const STANDING_KINDS = 64;
const STANDING_MS = 24 * 3600 * 1000;
// [{key, text, at}], oldest first
let standing = [];
// how many were ever kept this run (so how many were let go: this, less what
// is kept now)
let keptEver = 0;
// the wall clock (configure): when a notice was told, said to a session
// that joins later, and its age
let now = () => Date.now();
// The words a joining session reads (business's, 2026-11-28; pinned word for
// word in validation 04): the time is the runtime's form in its answers (ISO
// 8601, UTC); the dropped line names all three bounds, so it is true
// whichever one let a notice go
const earlierLine = (at, text) => `Earlier, before this session joined (${new Date(at).toISOString()}): ${text}`;
const droppedLine = (n) => `${n} earlier ${n === 1 ? 'notice' : 'notices'} from this run ${n === 1 ? 'is' : 'are'} not shown here: a session that joins later is given only the newest (${STANDING_PER_KIND} of each kind, up to ${STANDING_KINDS} kinds, from the last 24 hours)`;

function prune() {
  const since = now() - STANDING_MS;
  standing = standing.filter((e) => e.at >= since);
  const count = new Map();
  for (let i = standing.length - 1; i >= 0; i--) {
    const n = (count.get(standing[i].key) || 0) + 1;
    count.set(standing[i].key, n);
    if (n > STANDING_PER_KIND) standing.splice(i, 1);
  }
  for (;;) {
    const newest = new Map();
    for (const e of standing) newest.set(e.key, e.at);
    if (newest.size <= STANDING_KINDS) return;
    let oldest = null;
    for (const [key, at] of newest) if (oldest == null || at < newest.get(oldest)) oldest = key;
    standing = standing.filter((e) => e.key !== oldest);
  }
}

// A notice told to every session, kept for those that join later (a shared
// runtime only): the module, text and bound as add takes them.
function keep(module, text, {max = undefined, own = false} = {}) {
  if (!shared()) return;
  const key = own === true ? OWN : keyOf(module);
  const bound = Number.isSafeInteger(max) && max > 0 ? max : (own === true ? OWN_NOTICE_MAX : NOTICE_MAX);
  const t = moduleLine(text, Math.min(bound, OWN_NOTICE_MAX));
  if (t === '') return;
  standing.push({key, text: t, at: now()});
  keptEver += 1;
  prune();
}

// a session's open: what is kept, in the order it was told, with when
function joined(q) {
  if (standing.length === 0 && keptEver === 0) return;
  prune();
  const gone = keptEver - standing.length;
  if (gone > 0) queue(q.pending, OWN, droppedLine(gone), null, q.minimum);
  for (const e of standing) queue(q.pending, e.key, earlierLine(e.at, e.text), null, q.minimum);
}

// a test's clock
function configure({now: clock} = {}) { if (typeof(clock) === 'function') now = clock; }
function forget(id) { perSession.delete(id); }
// Shared mode on (lib/sessions.js attach): what the process queue held from
// before goes, as a session opened after a global notice doesn't get it,
// and nothing more is queued there
function dropProcessQueue() { pending.clear(); }
const shared = () => require('./sessions').shared();
const {moduleLine} = require('./module-text');

// A notice and its module key are one line of plain text, whatever ch-local
// or a pack name from npm carries: moduleLine (lib/module-text.js), the one
// rule, runs of spaces made one, cut without splitting a pair.
const MODULE_MAX = 128;
const keyOf = (module) => (module == null ? null : (moduleLine(module, MODULE_MAX) || null));

function queue(into, module, t, notify, level) {
  const entry = into.get(module) || {texts: [], dropped: 0};
  entry.texts.push(t);
  if (entry.texts.length > PER_MODULE_MAX) { entry.texts.shift(); entry.dropped += 1; }
  into.set(module, entry);
  if (notify != null && LEVELS.indexOf('notice') >= LEVELS.indexOf(level)) {
    try { notify({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: t}}); } catch (e) { /* said on the next result */ }
  }
}

// module: the pack's scenario's friendly name, or null for "any tool".
// session: in a shared runtime, one session's id, said to it alone (to none
// if it has ended), or null, to every session open now. sessionOnly: a
// notice that is one session's (a change it confirmed): with no session it
// is dropped, never said to all (fails closed). except: with no session,
// every session open now but that one (a change one session made for all:
// B2 Task 5b). Under --stdio (its one session) and over HTTP, the one queue
// either way.
// max: the runtime's own text's bound (at most OWN_NOTICE_MAX); a module's
// text is never given one.
// (own: the runtime's own text, in its own lane, with OWN_NOTICE_MAX as its
// bound unless a max is given: one option, so the two never part)
function add(module, text, {session = null, sessionOnly = false, except = null, max = undefined, own = false} = {}) {
  module = own === true ? OWN : keyOf(module);
  const bound = Number.isSafeInteger(max) && max > 0 ? max : (own === true ? OWN_NOTICE_MAX : NOTICE_MAX);
  const t = moduleLine(text, Math.min(bound, OWN_NOTICE_MAX));
  if (t === '') return;
  if (!shared()) return queue(pending, module, t, notifier, minimum);
  if (session == null && sessionOnly === true) return;
  if (session != null) {
    const q = typeof(session) === 'string' ? perSession.get(session) : null;
    if (q != null) queue(q.pending, module, t, q.notify, q.minimum);
    return;
  }
  for (const [id, q] of perSession) if (id !== except) queue(q.pending, module, t, q.notify, q.minimum);
}

// The notices for a result of `module`'s tool, each once: in a shared
// runtime, the calling session's only.
function take(module, session = null) {
  module = keyOf(module);
  let from = pending;
  if (shared()) {
    const q = typeof(session) === 'string' ? perSession.get(session) : null;
    if (q == null) return [];
    from = q.pending;
  }
  const out = [];
  for (const key of (module != null ? [OWN, null, module] : [OWN, null])) {
    const entry = from.get(key);
    if (entry == null) continue;
    from.delete(key);
    if (entry.dropped > 0) out.push(`${entry.dropped} earlier ${entry.dropped === 1 ? 'change' : 'changes'}${typeof(key) === 'string' ? ` to ${key}` : ''} not listed here`);
    out.push(...entry.texts);
  }
  return out;
}

module.exports = {add, keep, take, setNotifier, setLevel, openSession, forget, dropProcessQueue, configure, LEVELS, NOTICE_MAX, OWN_NOTICE_MAX, PER_MODULE_MAX,
  STANDING_PER_KIND, STANDING_KINDS, STANDING_MS, standingWords: Object.freeze({earlier: earlierLine, dropped: droppedLine}),
  resetForTests: () => { pending.clear(); perSession.clear(); minimum = 'debug'; standing = []; keptEver = 0; now = () => Date.now(); }};
