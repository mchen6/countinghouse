'use strict';
// The in-flight registry (MCP completeness M19, spec section 13): each
// cancellable request (a module tool's tools/call, a resources/read) while
// it runs, by its transport's scope and its request id, so a
// notifications/cancelled can find it.
//   scope: 'stdio' (the process's one connection) or a shared runtime's
//          session id. HTTP registers nothing: there the POST's own close is
//          the signal, and the connection is the request.
//   register(scope, id, cancel) -> unregister(): called when the request
//          answers; it removes only its own entry (a newer request that
//          reused the id keeps its own).
//   cancel(scope, id) -> true when a request was found: its cancel runs
//          once and its entry goes. An unknown id, a finished request or
//          another scope's request is ignored, as the spec has it: one Map
//          lookup, nothing kept, so a flood of notices costs that and no more.
// The registry holds only calls in flight, which the rate limit and the
// request timeout already bound.
const LOG = require('../logger');

const entries = new Map();   // key -> {cancel}

// a JSON-RPC request id is a string or a number; anything else names nothing
const keyOf = (scope, id) => {
  if (typeof(scope) !== 'string' || scope === '') return null;
  if (typeof(id) === 'string') return `${scope}\u0000s:${id}`;
  if (typeof(id) === 'number' && Number.isFinite(id)) return `${scope}\u0000n:${id}`;
  return null;
};

function register(scope, id, cancel) {
  const key = keyOf(scope, id);
  if (key == null || typeof(cancel) !== 'function') return () => {};
  const entry = {cancel};
  entries.set(key, entry);
  return () => { if (entries.get(key) === entry) entries.delete(key); };
}

function cancel(scope, id) {
  const key = keyOf(scope, id);
  if (key == null) return false;
  const entry = entries.get(key);
  if (entry == null) return false;
  entries.delete(key);
  try {
    entry.cancel();
  } catch (e) {
    try { LOG.E(e); } catch (_) { /* a bare process: no logger */ }
  }
  return true;
}

module.exports = {register, cancel, size: () => entries.size, clear: () => entries.clear()};
