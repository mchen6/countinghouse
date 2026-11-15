'use strict';
// Preloaded (NODE_OPTIONS=--require) into test/sessions/03's own spawned
// runtime only, on its main thread: records, to the file
// CH_TEST_SESSION_PROBE, every call token's session (lib/call-tokens.js)
// and whether any message the main thread posts to a worker or a channel
// port names the session (its id, or a key called session/sessionId).
// Nothing in lib/ reads a test switch.
const {isMainThread, Worker, MessagePort} = require('worker_threads');
if (isMainThread && process.env.CH_TEST_SESSION_PROBE) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..', '..');
  const out = process.env.CH_TEST_SESSION_PROBE;
  const note = (o) => fs.appendFileSync(out, `${JSON.stringify(o)}\n`);
  const sessionOf = () => require(path.join(ROOT, 'lib', 'sessions')).openLocal();
  const sessionKeys = (v, seen = new Set()) => {
    if (v == null || typeof(v) !== 'object' || seen.has(v)) return false;
    seen.add(v);
    for (const k of Object.keys(v)) if (/^session(Id)?$/i.test(k) || sessionKeys(v[k], seen)) return true;
    return false;
  };
  const probe = (kind, original) => function(message, ...rest) {
    let text = '';
    try { text = JSON.stringify(message) || ''; } catch (e) { text = ''; }
    if (text.includes(sessionOf()) || sessionKeys(message)) note({kind: 'leak', via: kind, sample: text.slice(0, 300)});
    else note({kind: 'post', via: kind});
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
