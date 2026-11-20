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
// pack ch-local changed) is copied into every session open now, so one
// opened later doesn't get it. A session's queue ends with it (forget).
// Under --stdio and over HTTP there is one queue, as before.
const NOTICE_MAX = 200;
// the runtime's own sentence, which it bounds itself (a module turned off:
// its callers and both ways back, lib/settings-tool.js offNotice): said
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
  perSession.set(id, {pending: new Map(), notify: (typeof(notify) === 'function') ? notify : null, minimum: 'debug'});
}
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

module.exports = {add, take, setNotifier, setLevel, openSession, forget, dropProcessQueue, LEVELS, NOTICE_MAX, OWN_NOTICE_MAX, PER_MODULE_MAX,
  resetForTests: () => { pending.clear(); perSession.clear(); minimum = 'debug'; }};
