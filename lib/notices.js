// Never silent (packs in place, part 2, plan Task A4; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): each pack
// change applied to a running session is said once as an MCP
// notifications/message, for clients that show it, and once as a one-line
// text block on the next result of a tool of that pack, which every client
// shows. A notice for a module no longer loaded (an unload) goes on the next
// result of any tool. ch-local start sends them over the control channel.
const NOTICE_MAX = 200;
const PER_MODULE_MAX = 20;

// module (friendly name), or null for a module no longer loaded ->
// {texts, dropped}: the newest PER_MODULE_MAX, and how many older ones were
// let go (said as one line, so nothing is silent)
const pending = new Map();
let notifier = null;         // the stdio server's notify, once it serves
// MCP's syslog levels: a notice is sent as a notification unless the client
// asked for a level above notice (logging/setLevel)
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];
let minimum = 'debug';

function setNotifier(fn) { notifier = (typeof(fn) === 'function') ? fn : null; }
function setLevel(level) {
  if (!LEVELS.includes(level)) return false;
  minimum = level;
  return true;
}

// Every C0 and C1 control character (ESC included), and the Unicode line and
// paragraph separators: one line of plain text, whatever ch-local or a pack
// name from npm carries.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const MODULE_MAX = 128;
const clean = (v, max) => String(v == null ? '' : v).replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
const keyOf = (module) => (module == null ? null : (clean(module, MODULE_MAX) || null));

// module: the pack's scenario's friendly name, or null for "any tool".
function add(module, text) {
  module = keyOf(module);
  const t = clean(text, NOTICE_MAX);
  if (t === '') return;
  const entry = pending.get(module) || {texts: [], dropped: 0};
  entry.texts.push(t);
  if (entry.texts.length > PER_MODULE_MAX) { entry.texts.shift(); entry.dropped += 1; }
  pending.set(module, entry);
  if (notifier != null && LEVELS.indexOf('notice') >= LEVELS.indexOf(minimum)) {
    try { notifier({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: t}}); } catch (e) { /* said on the next result */ }
  }
}

// The notices for a result of `module`'s tool, each once.
function take(module) {
  module = keyOf(module);
  const out = [];
  for (const key of (module != null ? [null, module] : [null])) {
    const entry = pending.get(key);
    if (entry == null) continue;
    pending.delete(key);
    if (entry.dropped > 0) out.push(`${entry.dropped} earlier ${entry.dropped === 1 ? 'change' : 'changes'}${key != null ? ` to ${key}` : ''} not listed here`);
    out.push(...entry.texts);
  }
  return out;
}

module.exports = {add, take, setNotifier, setLevel, NOTICE_MAX, PER_MODULE_MAX};
