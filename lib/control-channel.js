'use strict';
// The control channel (packs in place, part 2, plan Task A2; docs/superpowers/
// specs/2026-11-14-packs-in-place-and-settings-tool-design.md section 1):
// ch-local start speaks to the runtime it spawned over an IPC fd, never over
// stdin or stdout (the client's MCP channel). Only in the single-identity
// profile (--controlChannel ipc, checked in framework.js). Module code never
// reaches it: modules run in workers, which have no process.send, and the
// handlers live only in this closure on the main thread.
//
// Once it listens, the channel says so, unasked: {type: 'ready'} (no id).
// start holds its requests until then (a request sent before the listener
// was lost, and held start's queue until its timeout: the review of
// ch-local's part 3 P5); an older runtime never says it, and start waits a
// while, then goes on.
// Requests: {id, type: 'load' | 'unload' | 'reload' | 'set', ...}, applied one
// at a time, in order. Replies: {id, ok: true, ...} or {id, ok: false, code,
// message}. The codes are internal to start and the runtime (CONTROL_*), never
// a client's.
// restore and drain: ch-local daemon's, for the shared runtime (C3): the
// session table handed to a new runtime before it listens, and the stop
const TYPES = ['load', 'unload', 'reload', 'set', 'notice', 'restore', 'drain', 'idle-stop'];

// The runtime asks ch-local too (part 3 P2, Task 4: may-elicit, load-pack):
// {id: 'r<n>', type, ...}; ch-local answers {id, ok, ...} with no type, which
// the listener routes to the waiting ask, never answering it as a request.
// An older ch-local ignores the request (or answers CONTROL_UNKNOWN): ask
// resolves CONTROL_NO_ANSWER at its timeout, and its caller fails closed.
const ASK_TIMEOUT_MS = 5000;
let current = null;   // this process's channel: {send, waiting}
let nextAsk = 1;

// handlers: {load, unload, reload, set}, each (msg) -> Promise of a reply's
// fields; a missing one answers CONTROL_NOT_READY. send: process.send's
// stand-in (a test's). -> {stop()}.
function start(handlers = {}, {on = (fn) => process.on('message', fn), off = (fn) => process.off('message', fn), send = (m) => process.send(m)} = {}) {
  let chain = Promise.resolve();
  const reply = (m) => { try { send(m); } catch (e) { /* start has gone: nothing to answer */ } };
  const waiting = new Map();   // r-id -> resolve
  const listener = (msg) => {
    const id = (msg != null && (typeof(msg.id) === 'number' || typeof(msg.id) === 'string')) ? msg.id : null;
    if (id == null) return;
    // a reply to the runtime's own ask (an r-id and no type): to its waiter
    if (typeof(id) === 'string' && /^r\d+$/.test(id) && msg.type === undefined) {
      const w = waiting.get(id);
      if (w != null) { waiting.delete(id); w(msg); }
      return;
    }
    chain = chain.then(async () => {
      if (!TYPES.includes(msg.type)) return reply({id, ok: false, code: 'CONTROL_UNKNOWN', message: `unknown request type ${JSON.stringify(String(msg.type)).slice(0, 40)}`});
      const handler = handlers[msg.type];
      if (typeof(handler) !== 'function') return reply({id, ok: false, code: 'CONTROL_NOT_READY', message: `${msg.type} is not served yet`});
      try {
        const fields = await handler(msg);
        return reply(Object.assign({}, fields, {id, ok: true}));
      } catch (e) {
        return reply({id, ok: false, code: (e != null && typeof(e.code) === 'string') ? e.code : 'CONTROL_FAILED', message: String((e != null && e.message) || e).slice(0, 300)});
      }
    });
  };
  on(listener);
  // the runtime's own operation (M4: a unit the supervisor gave up on,
  // unloaded), serialised with ch-local's requests on the one chain
  const enqueue = (fn) => {
    chain = chain.then(() => fn()).catch((e) => { try { require('./logger').E(e); } catch (err) { /* not serving */ } });
    return true;
  };
  current = {send: reply, waiting, enqueue};
  reply({type: 'ready'});
  return {stop: () => { off(listener); if (current != null && current.waiting === waiting) current = null; }};
}

// msg: {type, ...} -> the reply {id, ok, ...}; {ok: false, code:
// 'CONTROL_NO_ANSWER'} at the timeout; {ok: false, code: 'CONTROL_NONE'} with
// no channel (no --controlChannel). Never rejects.
function ask(msg, {timeoutMs = ASK_TIMEOUT_MS} = {}) {
  if (current == null) return Promise.resolve({ok: false, code: 'CONTROL_NONE'});
  const {send, waiting} = current;
  const id = `r${nextAsk++}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ok: false, code: 'CONTROL_NO_ANSWER'}); }, timeoutMs);
    if (typeof(timer.unref) === 'function') timer.unref();
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send(Object.assign({}, msg, {id}));
  });
}

// An unasked message to ch-local (the shared runtime's session-state,
// session-gone and decline, for the daemon's table): {type, ...}, never an
// id, which would read as a request or a reply. -> false with no channel.
// -> true when queued on the channel's chain; false with no channel.
function enqueue(fn) {
  if (current == null) return false;
  return current.enqueue(fn);
}

function tell(msg) {
  if (msg == null || typeof(msg.type) !== 'string' || msg.type === '') throw new Error('a told message has a type');
  if (msg.id !== undefined) throw new Error('a told message has no id');
  if (current == null) return false;
  current.send(msg);
  return true;
}

module.exports = {start, ask, tell, enqueue, TYPES, resetForTests: () => { current = null; }};
