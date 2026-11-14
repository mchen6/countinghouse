// Never silent (packs in place, part 2, plan Task A4; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md section 2): each pack
// change applied to a running session is said once as an MCP
// notifications/message, for clients that show it, and once as a one-line
// text block on the next result of a tool of that pack, which every client
// shows. A notice for a module no longer loaded (an unload) goes on the next
// result of any tool. ch-local start sends them over the control channel.
const NOTICE_MAX = 200;
const PER_MODULE_MAX = 20;

const pending = new Map();   // module (friendly name) -> [text]
const anyTool = [];          // for a module no longer loaded
let notifier = null;         // the stdio server's notify, once it serves

function setNotifier(fn) { notifier = (typeof(fn) === 'function') ? fn : null; }

// module: the pack's scenario's friendly name, or null for "any tool".
function add(module, text) {
  const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').slice(0, NOTICE_MAX);
  if (t === '') return;
  const list = (module == null) ? anyTool : (pending.get(module) || []);
  if (list.length < PER_MODULE_MAX) list.push(t);
  if (module != null) pending.set(module, list);
  if (notifier != null) {
    try { notifier({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'notice', logger: 'countinghouse', data: t}}); } catch (e) { /* said on the next result */ }
  }
}

// The notices for a result of `module`'s tool, each once.
function take(module) {
  const out = anyTool.splice(0, anyTool.length);
  if (module != null && pending.has(module)) { out.push(...pending.get(module)); pending.delete(module); }
  return out;
}

module.exports = {add, take, setNotifier, NOTICE_MAX};
