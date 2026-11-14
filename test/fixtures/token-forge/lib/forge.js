// R2-1 Task 3: a module shares its worker's realm, so it can rewrite what
// its worker sends. This hook stands for any module that does, and is what
// the main thread's token checks must hold against. It rewrites at the
// transport (MessagePort.prototype.postMessage, which parentPort and a peer
// channel's port share), so it forges the routed hop and the peer invoke
// alike, whatever the runtime's own functions are called.
//
// Where a hop's token travels: a routed hop carries it on its own message
// (data.token of invokeforeignaction); a peer invoke carries none, its
// caller worker announcing {channel, invokeId, token} to the main thread
// instead, so for a peer hop the rule is applied to the announcement whose
// invokeId is the hop's id. The runtime announces before it posts the
// invoke (the timer and the announcement start together), so an
// announcement for an invoke not yet seen is held here until the invoke
// is posted, then rewritten under its rule and posted after it.
//
// Rules are keyed by the marker the hop's input carries:
//   billingKey  every billingKey (and the routed hop's appKey) becomes it
//   token       the hop's token becomes it (added where the hop has none)
//   everyToken  the above also apply to every other message sent while the
//               rule is set that carries a token (a device query): for a
//               call that is alone in flight
//   stash       the hop's token is kept under this name
//   tokenFrom   the hop carries the token kept under this name
//   delayInvokeMs  the announcement goes out at once and the peer invoke is
//               posted this much later (an early announcement, #141 N1)
// state.seen[marker] is the token the hop finally carried.
// The global MessagePort (Node's, in every thread), so the fixture asks the
// lockdown for no builtin: under --moduleSandbox enforce a plain hop through
// it must leave the sandbox log clean (composition 18's enforce baseline).
const MessagePort = (typeof(globalThis.MessagePort) === 'function') ? globalThis.MessagePort : null;

const state = globalThis.__tokenForge || (globalThis.__tokenForge = {rules: {}, stash: {}, done: {}, seen: {}});
const hops = new Map();   // a peer invoke's id -> its marker
const deferred = new Map();   // a peer invoke's id -> its announcement, held until the invoke is posted

function hopInput(m) {
  if (m == null || typeof(m) !== 'object') return null;
  if (m.command === 'invokeforeignaction' && m.data != null && m.data.args != null) return m.data.args.input;
  if (m.command === 'peer-invoke') return m.input;
  return null;
}
const holder = (m) => (m.data != null && typeof(m.data) === 'object') ? m.data : m;
const tokenOf = (m) => holder(m).token;

// kind: 'hop' (the hop's own message), 'announce' (a peer hop's
// announcement), 'other' (any message carrying a token, under everyToken).
function apply(m, rule, marker, kind) {
  const h = holder(m);
  if (rule.billingKey != null) {
    if ('billingKey' in h || kind === 'hop') h.billingKey = rule.billingKey;
    if (m.command === 'invokeforeignaction') h.appKey = rule.billingKey;
  }
  const carries = kind === 'announce' || (kind === 'hop' && m.command === 'invokeforeignaction') || (kind === 'other' && h.token !== undefined);
  if (!carries) return;
  if (rule.token != null) h.token = rule.token;
  if (rule.stash != null && h.token !== undefined) state.stash[rule.stash] = h.token;
  if (rule.tokenFrom != null && state.stash[rule.tokenFrom] !== undefined) h.token = state.stash[rule.tokenFrom];
  if (kind !== 'other' && marker != null && h.token !== undefined) state.seen[marker] = h.token;
}

function rewrite(m) {
  if (m == null || typeof(m) !== 'object') return;
  const input = hopInput(m);
  if (input != null && typeof(input.marker) === 'string') {
    if (m.command === 'peer-invoke') hops.set(m.id, input.marker);
    if (state.rules[input.marker] != null) return apply(m, state.rules[input.marker], input.marker, 'hop');
    return;
  }
  if (m.command === 'peer-announce' && m.data != null && hops.has(m.data.invokeId)) {
    const marker = hops.get(m.data.invokeId);
    if (state.rules[marker] != null) apply(m, state.rules[marker], marker, 'announce');
    return;
  }
  if (tokenOf(m) !== undefined) {
    for (const marker of Object.keys(state.rules)) {
      if (state.rules[marker].everyToken === true) apply(m, state.rules[marker], marker, 'other');
    }
  }
}

// The runtime posts to the main thread as envelopes of v8 bytes (#170): the
// hook opens one, rewrites the message inside, and closes it again. A peer
// channel's messages (peer-invoke) are not enveloped. This runs under
// --moduleSandbox off alone: under audit and enforce the lockdown pins the
// runtime's ports, so the hook never sees what they send.
function openEnvelope(message) {
  if (message == null || !(message.b instanceof ArrayBuffer)) return null;
  try {
    const d = new (require('v8').Deserializer)(Buffer.from(message.b));
    d.readHeader();
    return d.readValue();
  } catch (e) {
    return null;
  }
}
// {inner, envelope, rest} -> [message, ...rest] to post: the inner message
// as it now stands, closed again if it came in an envelope.
function closeFor(p) {
  if (p.envelope == null) return [p.inner].concat(p.rest);
  const s = new (require('v8').Serializer)();
  s.writeHeader();
  s.writeValue(p.inner);
  const buf = s.releaseBuffer();
  const b = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const transfer = Array.isArray(p.rest[0]) ? p.rest[0].map((t) => (t === p.envelope.b ? b : t)) : [b];
  return [Object.assign({}, p.envelope, {b})].concat([transfer], p.rest.slice(1));
}

if (MessagePort != null && state.hooked !== true) {
  state.hooked = true;
  const post = MessagePort.prototype.postMessage;
  const send = (port, p) => post.apply(port, closeFor(p));
  try {
    MessagePort.prototype.postMessage = function(message, ...rest) {
      const opened = openEnvelope(message);
      const p = {inner: opened != null ? opened : message, envelope: opened != null ? message : null, rest};
      const m = p.inner;
      try {
        if (m != null && m.command === 'peer-announce' && m.data != null && !hops.has(m.data.invokeId)) {
          deferred.set(m.data.invokeId, {port: this, p});
          return undefined;
        }
        rewrite(m);
      } catch (e) { /* never break the worker */ }
      let delayMs = null;
      try {
        if (m != null && m.command === 'peer-invoke') {
          const rule = hops.has(m.id) ? state.rules[hops.get(m.id)] : null;
          if (rule != null && rule.delayInvokeMs > 0) delayMs = rule.delayInvokeMs;
        }
      } catch (e) { /* never break the worker */ }
      const flush = () => {
        try {
          if (m != null && m.command === 'peer-invoke' && deferred.has(m.id)) {
            const d = deferred.get(m.id);
            deferred.delete(m.id);
            rewrite(d.p.inner);
            send(d.port, d.p);
          }
        } catch (e) { /* never break the worker */ }
      };
      if (delayMs != null) {
        flush();   // the announcement at once, the invoke after the delay
        setTimeout(() => send(this, p), delayMs);
        return undefined;
      }
      const r = send(this, p);
      flush();
      return r;
    };
  } catch (e) { /* never break the worker */ }
}

function waitFor(test, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const poll = () => (test() || Date.now() >= deadline) ? resolve(test()) : setTimeout(poll, 20);
    poll();
  });
}

// Whether `value` holds `needle` anywhere a module can read: own property
// values, a few levels down (the spec: the token is on nothing ctx exposes).
function holds(value, needle, depth = 4, seen = new Set()) {
  if (value === needle) return true;
  if (depth === 0 || value == null || typeof(value) !== 'object' || seen.has(value)) return false;
  seen.add(value);
  for (const k of Object.getOwnPropertyNames(value)) {
    let v;
    try { v = value[k]; } catch (e) { continue; }
    if (holds(v, needle, depth - 1, seen)) return true;
  }
  return false;
}

module.exports = {state, waitFor, holds};
