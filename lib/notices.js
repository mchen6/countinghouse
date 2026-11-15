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
const shared = () => require('./sessions').shared();

// Every C0 and C1 control character (ESC included), and the Unicode line and
// paragraph separators: one line of plain text, whatever ch-local or a pack
// name from npm carries.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const MODULE_MAX = 128;
const clean = (v, max) => String(v == null ? '' : v).replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
const keyOf = (module) => (module == null ? null : (clean(module, MODULE_MAX) || null));

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
// if it has ended), or null, to every session open now. Under --stdio (its
// one session) and over HTTP, the one queue either way.
function add(module, text, {session = null} = {}) {
  module = keyOf(module);
  const t = clean(text, NOTICE_MAX);
  if (t === '') return;
  if (!shared()) return queue(pending, module, t, notifier, minimum);
  if (session != null) {
    const q = typeof(session) === 'string' ? perSession.get(session) : null;
    if (q != null) queue(q.pending, module, t, q.notify, q.minimum);
    return;
  }
  for (const q of perSession.values()) queue(q.pending, module, t, q.notify, q.minimum);
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
  for (const key of (module != null ? [null, module] : [null])) {
    const entry = from.get(key);
    if (entry == null) continue;
    from.delete(key);
    if (entry.dropped > 0) out.push(`${entry.dropped} earlier ${entry.dropped === 1 ? 'change' : 'changes'}${key != null ? ` to ${key}` : ''} not listed here`);
    out.push(...entry.texts);
  }
  return out;
}

module.exports = {add, take, setNotifier, setLevel, openSession, forget, NOTICE_MAX, PER_MODULE_MAX,
  resetForTests: () => { pending.clear(); perSession.clear(); minimum = 'debug'; }};
