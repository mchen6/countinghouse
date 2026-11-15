'use strict';
// Preloaded (NODE_OPTIONS=--require) into test/sessions/03's own spawned
// runtime only, on its main thread: records, to the file
// CH_TEST_SESSION_PROBE, every call token's session (lib/call-tokens.js)
// and, for every message the main thread posts to a worker or a channel
// port, its command and whether it names the session anywhere (its id in a
// string, a buffer's bytes, a Map or a Set, or a key called
// session/sessionId).
// Nothing in lib/ reads a test switch.
const {isMainThread, Worker, MessagePort} = require('worker_threads');
if (isMainThread && process.env.CH_TEST_SESSION_PROBE) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..', '..');
  const out = process.env.CH_TEST_SESSION_PROBE;
  const note = (o) => fs.appendFileSync(out, `${JSON.stringify(o)}\n`);
  const sessionOf = () => require(path.join(ROOT, 'lib', 'sessions')).openLocal();
  // whether `v` names the session anywhere: a string holding its id, the
  // bytes of a buffer (an ArrayBuffer, a SharedArrayBuffer, a typed array or
  // a DataView), a Map's or Set's members, or a key called session/sessionId
  const names = (v, id, seen = new Set()) => {
    if (typeof(v) === 'string') return v.includes(id);
    if (v == null || typeof(v) !== 'object' || seen.has(v)) return false;
    seen.add(v);
    if (v instanceof ArrayBuffer || (typeof(SharedArrayBuffer) === 'function' && v instanceof SharedArrayBuffer)) return Buffer.from(v).toString('latin1').includes(id);
    if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('latin1').includes(id);
    if (v instanceof Map) { for (const [k, x] of v) if (names(k, id, seen) || names(x, id, seen)) return true; return false; }
    if (v instanceof Set) { for (const x of v) if (names(x, id, seen)) return true; return false; }
    for (const k of Object.keys(v)) if (/^session(Id)?$/i.test(k) || k.includes(id) || names(v[k], id, seen)) return true;
    return false;
  };
  const probe = (kind, original) => function(message, ...rest) {
    const command = message != null && typeof(message) === 'object' ? (message.command || message.type || null) : null;
    if (names(message, sessionOf())) {
      let sample = '';
      try { sample = (JSON.stringify(message) || '').slice(0, 300); } catch (e) { sample = String(command); }
      note({kind: 'leak', via: kind, command, sample});
    } else {
      note({kind: 'post', via: kind, command: typeof(command) === 'string' ? command : null});
    }
    return original.call(this, message, ...rest);
  };
  Worker.prototype.postMessage = probe('worker', Worker.prototype.postMessage);
  MessagePort.prototype.postMessage = probe('port', MessagePort.prototype.postMessage);
  const callTokens = require(path.join(ROOT, 'lib', 'call-tokens'));
  const issue = callTokens.issue;
  callTokens.issue = function(o) {
    const token = issue.call(this, o);
    const e = callTokens.resolve(token, {workerId: o.workerId});
    note({kind: 'issue', hop: o.parent != null, ours: e != null && e.session === sessionOf(), none: e != null && e.session == null});
    return token;
  };
}
