'use strict';
// A call's failure as a crash, an untyped failure or a runtime error, logged
// at error level whatever --debug says: DEVICE_INVOKE_EXCEPTION,
// DEVICE_INVOKE_FAIL, or a catalogue code of kind runtime. Never a module's
// own error answer, nor a caller's, a module's or an operator's code (a bad
// request, a refused name: the caller's answer says those). One line a
// failure: the tool (the loaded module and the action), the code, its class
// and the runtime's refusal of the call's last module call before it; no
// input, no module text. Bounded per tool: the first n in a window, then,
// when the window closes (its timer, unref'd), the log is closed, or the
// slot is needed (at most maxTools windows, the oldest closing first), one
// line saying how many were left out since when. A hop's own session is not
// logged (lib/session.js): its caller's failure is. (With
// --directPeerChannels, the default, a hop goes worker to worker: a refusal
// the main thread gave through the device query is still said; one after
// the hop was sent is not the main thread's to see.)
const {CODES} = require('./error-catalogue');
const MAX_TOOLS = 1024;

// err -> its class words, or null when it is not logged
function classOf(err) {
  if (err == null || typeof(err) !== 'object' || err.origin === 'module' || typeof(err.code) !== 'string') return null;
  if (err.code === 'DEVICE_INVOKE_EXCEPTION') return 'the module crashed';
  if (err.code === 'DEVICE_INVOKE_FAIL') return 'the module failed';
  // (a runtime code a handler passed on is the module's: its from-handler mark)
  if (err.fromHandler === true) return null;
  const entry = Object.prototype.hasOwnProperty.call(CODES, err.code) ? CODES[err.code] : null;
  return (entry != null && entry.kind === 'runtime') ? 'a runtime error' : null;
}
// the session's device (a worker's WorkerMessage, whose devices' specs it
// keeps by id, or a device in single-thread mode, with its own spec), the
// action and the device's id -> "<module>/<action>", or null: only a module
// the runtime loaded and an action its spec declares, never a name a request
// supplied (each one would be a window of its own)
const PLAIN = /^[A-Za-z0-9_.@-]{1,128}$/;
function declares(spec, actionName) {
  const services = (spec != null && spec.device != null && spec.device.serviceList != null && typeof(spec.device.serviceList) === 'object') ? spec.device.serviceList : null;
  if (services == null) return false;
  return Object.keys(services).some((id) => { const list = services[id] != null ? services[id].actionList : null; return Array.isArray(list) && list.some((a) => a != null && a.name === actionName); });
}
function toolOf(device, actionName, deviceID) {
  if (device == null || typeof(device) !== 'object' || typeof(actionName) !== 'string' || !PLAIN.test(actionName)) return null;
  const spec = (device.spec != null && device.spec.device != null) ? device.spec
    : (device.deviceList != null && typeof(deviceID) === 'string' && Object.prototype.hasOwnProperty.call(device.deviceList, deviceID)) ? device.deviceList[deviceID] : null;
  if (!declares(spec, actionName)) return null;
  const name = [device.moduleName, device.hostModuleName, spec.device.friendlyName].find((x) => typeof(x) === 'string' && x !== '');
  // (a module's name as its data folder takes it, scoped ones included; no control character in a log line)
  return (name != null && require('./module-data').safeName(name) && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(name)) ? `${name}/${actionName}` : null;
}
const toWord = (to) => (to === 'module' ? 'another module' : 'a remote service');

function createFailedCallLog({write, now = Date.now, n = 5, windowMs = 10 * 60 * 1000, maxTools = MAX_TOOLS, setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimer = clearTimeout} = {}) {
  const tools = new Map();   // tool -> {start, logged, left, since, timer}
  const end = (tool) => {
    const w = tools.get(tool);
    tools.delete(tool);
    // (from a timer or at exit: a logger that can't write is never a throw there)
    if (w != null && w.left > 0) { try { write(`…and ${w.left} more failed calls of ${tool} not logged since ${new Date(w.since).toISOString()}`); } catch (e) { /* nowhere to say it */ } }
  };
  return {
    failed(tool, err, refused = null) {
      const cls = classOf(err);
      if (cls == null) return;
      const at = now();
      let w = tools.get(tool);
      if (w == null) {
        // (every slot in use: the oldest window closes now, its line said)
        if (tools.size >= maxTools) { const [oldest, ow] = tools.entries().next().value; if (ow.timer != null) clearTimer(ow.timer); end(oldest); }
        w = {start: at, logged: 0, left: 0, since: null, timer: null};
        tools.set(tool, w);
        w.timer = setTimer(() => end(tool), windowMs);
      }
      if (w.logged >= n) { if (w.left++ === 0) w.since = at; return; }
      w.logged++;
      const own = refused != null && typeof(refused) === 'object' && Object.prototype.hasOwnProperty.call(refused, 'code') && Object.prototype.hasOwnProperty.call(refused, 'to');
      const before = (own && typeof(refused.code) === 'string') ? `, after the runtime refused its call to ${toWord(refused.to)}: ${refused.code}` : '';
      write(`a call failed: ${tool}: ${err.code} (${cls})${before}`);
    },
    // (a graceful exit's, and a test's: every window closed now, its line said)
    closeAll() { for (const [tool, w] of [...tools]) { if (w.timer != null) clearTimer(w.timer); end(tool); } }
  };
}

// The runtime's one log (main thread): made on first use, its windows said at
// a graceful exit (as far as the logger's stream drains; SIGTERM's exit, 143,
// is at once: nothing added to it); resetRuntimeLog for a test's after().
let runtime = null;
function runtimeLog() {
  if (runtime != null) return runtime;
  const logger = require('./logger');
  const made = createFailedCallLog({write: (line) => logger.E(line)});
  runtime = made;
  require('./exit-sequence').atExit(() => { if (process.exitCode !== 143 && runtime === made) made.closeAll(); });
  return made;
}
function resetRuntimeLog() { const was = runtime; runtime = null; if (was != null) was.closeAll(); }

module.exports = {createFailedCallLog, classOf, toolOf, runtimeLog, resetRuntimeLog};
