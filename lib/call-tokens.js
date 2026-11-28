'use strict';
// R2-1 Task 3 (docs/superpowers/specs/2026-11-07-r2-1-no-raw-keys-in-modules-design.md,
// section 3): the per-call tokens the main thread issues when it sends a
// call to a worker, and resolves when that worker's hop, device query,
// remote call or peer announcement cites one. A token is 128 random bits;
// what it stands for lives here, on the main thread only:
//   {billingKey, identityKey, module, workerId, deviceID, parent, jobID,
//    expires, limits, session, serviceID, actionName, ask}
// billingKey is the outer caller's key (who pays), identityKey the module's
// runsModules binding or null (who the module's hops authorize as), parent
// the token of the call this one was issued inside (a hop's chains to its
// outer call, so a 3-hop composite bills the original caller at every hop).
//
// A token is bound to the worker it was issued to: resolve() answers only
// for that workerId, so a token read off one worker (a peer callee that kept
// what crossed its channel, a module that hooks its worker's send path) is
// foreign anywhere else. It lives as long as its call: dropped when the call
// answers or its worker ends, and bounded by ttlMs as a backstop.
//
// The chain is enforced (the review of #138, 1): a child token is its
// parent's call's, so it expires no later than its parent, is dropped with
// it, and resolves only while every ancestor is live. Otherwise a part that
// never answered its hop could mint itself a fresh token from the last one
// each time it neared its end, and one call would bill its caller for ever.
// A child whose parent is already gone is refused (CALL_TOKEN_INVALID): its
// call has ended, and the child would be no one's.
//
// session (the shared runtime, B1 Task 2): the opaque id of the client
// session the outer call came from, or null (HTTP, a job before Task 3, a
// call from no session). A child takes its parent's: a hop never changes
// session, and one issued with another is refused (CALL_TOKEN_INVALID,
// which names no session). Main thread only, as every entry is: no worker
// sees it.
//
// serviceID, actionName and ask (ctx.ask, lib/module-ask.js): the action the
// call is of, and the call's ask state, for a call that has them (an outer
// call the gateway started). They are the call's own: a hop's entry has
// none of its parent's.
const crypto = require('crypto');
const CountinghouseError = require('./countinghouse-error').CountinghouseError;
const {CODES} = require('./error-catalogue');

// required on first use, then kept (lib/require-once.js): no require() on the call path
const requireOnce = require('./require-once');
const callLimitsLib = requireOnce(() => require('./call-limits'));

const byToken  = new Map();   // token -> entry
const byWorker = new Map();   // workerId -> Set(token)
const children = new Map();   // token -> Set(child token)
const bySession = new Map();  // session id -> Set(token), for the session's end
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
// The chain's depth is bounded (the review of #141, N2): a hop inside a
// chain this deep is refused HOP_CHAIN_TOO_DEEP, which also bounds the
// walks below. Mutual recursion between two composites is what reaches it.
const MAX_CHAIN_DEPTH = 64;

// limits: the call's own cap and timeout (lib/call-limits.js); a token with
// none takes its parent's (a hop is held to its caller's)
// progress: the outer call's notifier (lib/mcp/progress.js), given to the
// root token and copied to every token of its chain, so a hop finds it
// without a walk (progressOf). Main-thread state, never sent.
function issue({billingKey, identityKey = null, module = null, workerId, deviceID = null, parent = null, jobID = null, ttlMs = DEFAULT_TTL_MS, limits = null, session = null, progress = null,
  serviceID = null, actionName = null, ask = null}) {
  if (billingKey == null) throw new Error('call-tokens: a token needs a billing key');
  if (workerId == null) throw new Error('call-tokens: a token needs the worker it is for');
  if (session != null && typeof(session) !== 'string') throw new Error('call-tokens: a session is its id');
  const parentEntry = (parent != null) ? byToken.get(parent) : null;
  if (parent != null && parentEntry == null) throw new CountinghouseError('CALL_TOKEN_INVALID');
  const depth = (parentEntry != null) ? parentEntry.depth + 1 : 0;
  if (depth > MAX_CHAIN_DEPTH) throw new CountinghouseError('HOP_CHAIN_TOO_DEEP', `${depth} hops`);
  // a hop's session is its parent's; checked before anything is recorded
  if (parentEntry != null && session != null && session !== parentEntry.session) throw new CountinghouseError('CALL_TOKEN_INVALID');
  const ownSession = parentEntry != null ? parentEntry.session : session;
  const token = crypto.randomBytes(16).toString('hex');
  let expires = Date.now() + ttlMs;
  if (parentEntry != null) {
    expires = Math.min(expires, parentEntry.expires);
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(token);
  }
  // an override only (null: the global values, read at each check), never
  // looser than its parent's, field by field
  const own = callLimitsLib().tighter(limits, parentEntry != null ? parentEntry.limits : null);
  // (seq: bumped by each of its calls the runtime noted, refused or through;
  // parentSeq: its caller's seq when it began, so its note passes up only to a
  // caller that has not moved on since)
  byToken.set(token, {token, billingKey, identityKey, module, workerId, deviceID, parent, jobID, expires, depth, limits: own, session: ownSession,
    seq: 0, parentSeq: parentEntry != null ? (parentEntry.seq || 0) : 0,
    progress: parentEntry != null ? parentEntry.progress : progress,
    // its own action, whichever token it is; the ask state (ctx.ask,
    // lib/module-ask.js) on the outer call's token only: a hop's ask finds
    // it by its chain (outerOf), so a call has one
    serviceID: typeof(serviceID) === 'string' ? serviceID : null, actionName: typeof(actionName) === 'string' ? actionName : null,
    ask: (parentEntry == null && ask != null) ? ask : null});
  if (!byWorker.has(workerId)) byWorker.set(workerId, new Set());
  byWorker.get(workerId).add(token);
  if (ownSession != null) {
    if (!bySession.has(ownSession)) bySession.set(ownSession, new Set());
    bySession.get(ownSession).add(token);
  }
  return token;
}

// Whether `e` and every ancestor of it is here and unexpired.
function chainLive(e, now) {
  for (let cur = e; cur != null; cur = (cur.parent != null) ? byToken.get(cur.parent) : null) {
    if (cur.expires <= now) return false;
    if (cur.parent != null && !byToken.has(cur.parent)) return false;
  }
  return true;
}

// The entry for `token` as cited by worker `workerId`, or null: unknown,
// expired (itself or any ancestor), or another worker's.
function resolve(token, {workerId}) {
  if (typeof(token) !== 'string') return null;
  const e = byToken.get(token);
  if (e == null) return null;
  if (!chainLive(e, Date.now())) { drop(token); return null; }
  if (e.workerId !== workerId) return null;
  return e;
}

// What runs when a token is dropped aborting (M19): its remote calls'
// aborts. Only a cancel and a timeout drop with {abort: true}; a token
// dropped because its call answered aborts nothing, so a remote call still
// running then runs to its end, as before. Either way the hooks of the token
// and every descendant go with it.
const dropHooks = new Map();   // token -> Set(fn)
// onDrop(token, fn) -> unregister: fn runs once, when `token` or an
// ancestor of it is dropped aborting; at once for a token already gone. A
// hook that throws is logged and the rest still run.
function onDrop(token, fn) {
  if (typeof(fn) !== 'function') return () => {};
  if (!byToken.has(token)) {
    runHook(fn);
    return () => {};
  }
  if (!dropHooks.has(token)) dropHooks.set(token, new Set());
  dropHooks.get(token).add(fn);
  return () => {
    const set = dropHooks.get(token);
    if (set != null) { set.delete(fn); if (set.size === 0) dropHooks.delete(token); }
  };
}
function runHook(fn) {
  try {
    fn();
  } catch (e) {
    try { require('./logger').E(e); } catch (_) { /* a bare process */ }
  }
}

// Drops `token` and every descendant of it: a walk with its own stack, not
// the call stack (the review of #141, N2). abort: a cancel's or a timeout's
// drop, which runs the onDrop hooks (M19).
function drop(token, {abort = false} = {}) {
  // A part's token, dropped: main's own note on it (noteRefused) passes to its
  // caller's call, marked further (said as another module's, DEVICE_NOT_FOUND:
  // the caller may not see the part's own refusals), only if the caller has
  // not moved on since the part began (no call of its noted since, refused or
  // through: its seq), so a late drop (a worker's late report) never plants an
  // older note; only the token dropped, never a descendant dropped with it.
  // Nothing a worker says is read for it: whether the part failed is not known
  // here, so a part that went on and answered passes its note too.
  const own = byToken.get(token);
  if (own != null && own.refused != null && own.parent != null) {
    const parent = byToken.get(own.parent);
    if (parent != null && parent.refused == null && (parent.seq || 0) === own.parentSeq) parent.refused = {code: own.refused.code, to: own.refused.to, further: true};
  }
  const stack = [token];
  while (stack.length > 0) {
    const t = stack.pop();
    const e = byToken.get(t);
    if (e == null) continue;
    byToken.delete(t);
    const hooks = dropHooks.get(t);
    if (hooks != null) {
      dropHooks.delete(t);
      if (abort === true) for (const fn of hooks) runHook(fn);
    }
    const set = byWorker.get(e.workerId);
    if (set != null) { set.delete(t); if (set.size === 0) byWorker.delete(e.workerId); }
    const ofS = e.session != null ? bySession.get(e.session) : null;
    if (ofS != null) { ofS.delete(t); if (ofS.size === 0) bySession.delete(e.session); }
    if (e.parent != null && children.has(e.parent)) {
      children.get(e.parent).delete(t);
      if (children.get(e.parent).size === 0) children.delete(e.parent);
    }
    const kids = children.get(t);
    if (kids != null) { children.delete(t); for (const k of kids) stack.push(k); }
  }
}

// A worker ended: every token issued to it.
function dropFor(workerId) {
  const set = byWorker.get(workerId);
  if (set == null) return;
  for (const t of [...set]) drop(t);
}

// How many unexpired tokens are issued to a worker: the calls it is running
// and the hops, jobs and peer channels citing it. A per-session worker with
// any is never evicted at the cap (R1, lib/session-workers.js).
function liveFor(workerId) {
  const set = byWorker.get(workerId);
  if (set == null) return 0;
  const now = Date.now();
  let n = 0;
  for (const t of set) {
    const e = byToken.get(t);
    if (e != null && e.expires > now) n++;
  }
  return n;
}

// A session's live tokens (a copy), for its end (Task 4).
function ofSession(id) {
  const set = typeof(id) === 'string' ? bySession.get(id) : null;
  return new Set(set != null ? set : []);
}

function sweep() {
  const now = Date.now();
  for (const [t, e] of byToken) if (e.expires <= now) drop(t);
}
setInterval(sweep, SWEEP_MS).unref();

// The binding of the module a worker hosts for `deviceID`, kept on the
// worker's proxy by DeviceManager at the composition verdict: {identity,
// module}. What a token issued for that device's calls authorizes as.
function bindingOf(wm, deviceID) {
  const b = (wm != null && wm.bindings != null) ? wm.bindings[deviceID] : null;
  return (b != null) ? b : {identity: null, module: null};
}

// Whether a module's resolved declarations (its binding's `targets`, from
// the composition verdict) include this hop's target. A module that
// declared nothing has no targets, so it can hop nowhere (R2-1 Task 4).
function declaredTarget(binding, deviceID, serviceID, actionName) {
  return binding != null && binding.targets instanceof Set && binding.targets.has(`${deviceID}|${serviceID}|${actionName}`);
}
// A binding's resolved declarations as {deviceID, serviceID, actionName}
// (the targets' own encoding stays here): [] for one with none.
function declaredTargetsOf(binding) {
  if (binding == null || !(binding.targets instanceof Set)) return [];
  return [...binding.targets].map((t) => {
    const first = t.indexOf('|');
    const last = t.lastIndexOf('|');
    return {deviceID: t.slice(0, first), serviceID: t.slice(first + 1, last), actionName: t.slice(last + 1)};
  });
}
// Whether a module declared any call on `deviceID` (the device query's
// check): stops at the first match.
function declaresDevice(binding, deviceID) {
  if (binding == null || !(binding.targets instanceof Set)) return false;
  const prefix = `${deviceID}|`;
  for (const t of binding.targets) if (t.startsWith(prefix)) return true;
  return false;
}
// The actions a module declared on one device, as the callee checks them:
// `${serviceID}|${actionName}`.
function declaredActionsOn(binding, deviceID) {
  const out = [];
  if (binding == null || !(binding.targets instanceof Set)) return out;
  const prefix = `${deviceID}|`;
  for (const t of binding.targets) if (t.startsWith(prefix)) out.push(t.slice(prefix.length));
  return out;
}

// What a worker's composition names in place of an identity (R2-1 Task 5):
// that the module is bound, never to whom. The main thread authorizes a
// worker's hops by the identity its call's token carries, never by
// anything the worker states.
const BOUND_IDENTITY = '(bound)';
// The identity a worker's hop, channel request or device query authorizes
// as: the token's, the module's binding when its call was issued.
function identityOf(tokenEntry) {
  return (tokenEntry != null) ? tokenEntry.identityKey : null;
}

// Whether the composition verdict for a module has landed: every device's
// binding is set then, even with no declarations (lib/device-manager.js).
const hasVerdict = (wm, deviceID) => wm != null && wm.bindings != null && wm.bindings[deviceID] != null;

// The main thread's own refusal of a call's own last module call (a hop, a
// device query: to 'module'; a remote call: to 'remote'), by its code, kept on
// that call's own entry (a nested callee's passes up when its token goes: drop): said
// where that call fails. A later call of its that goes through clears it
// (noteThrough), so a refusal the module recovered from is never said; so
// does a later call that failed without the runtime refusing it. Only a
// runtime code (the catalogue's) is a refusal, never a crash's own class, a
// code of another's, or a remote's own failure (a runtime-kind REMOTE_ code:
// unreachable, a timeout: the call went through); and only by a token live
// for the worker that asked.
const REFUSED_TO = new Set(['module', 'remote']);
// the remote's own failures: the call went through to it (never the runtime's
// own refusal of it, such as HOP_IDENTITY_UNRESOLVED). REMOTE_RESULT_TOO_LARGE
// is among them: its marker is a public string a remote can send in its own
// error (lib/remote/client.js codeFor), so it is never said as the runtime's.
const REMOTE_OWN_FAILURE = new Set(['REMOTE_UNREACHABLE', 'REMOTE_TIMEOUT', 'REMOTE_AUTH_FAILED', 'REMOTE_PROTOCOL', 'REMOTE_RESULT_TOO_LARGE']);
function noteRefused(token, code, to, workerId) {
  if (!REFUSED_TO.has(to)) return;
  const entry = resolve(token, {workerId});
  if (entry == null) return;
  const refusal = typeof(code) === 'string' && code !== 'DEVICE_INVOKE_EXCEPTION' && code !== 'DEVICE_INVOKE_FAIL' &&
    Object.prototype.hasOwnProperty.call(CODES, code) && !(to === 'remote' && REMOTE_OWN_FAILURE.has(code));
  entry.refused = refusal ? {code, to} : null;
  entry.seq = (entry.seq || 0) + 1;
}
// a call of its that went through: its kept refusal goes (a hop sent, a
// device found, a peer hop announced, a remote that answered).
function noteThrough(token, workerId) {
  const entry = resolve(token, {workerId});
  if (entry != null) { entry.refused = null; entry.seq = (entry.seq || 0) + 1; }
}
// the call's kept refusal, or null
function refusedOf(token) {
  const e = (typeof(token) === 'string') ? byToken.get(token) : null;
  return (e != null && e.refused != null) ? Object.assign({code: e.refused.code, to: e.refused.to}, e.refused.further === true ? {further: true} : {}) : null;
}

// The outer call's entry for an entry of its chain (itself, for the outer
// call), or null when a link of the chain is gone. The walk is bounded by
// the chain's depth limit.
function outerOf(entry) {
  let cur = (entry != null) ? entry : null;
  for (let hops = 0; cur != null && cur.parent != null; hops++) {
    if (hops > MAX_CHAIN_DEPTH) return null;
    cur = byToken.get(cur.parent) || null;
  }
  return cur;
}

// The outer call's progress notifier for any live token of its chain, or
// null: a hop or remote call billed under it ticks it (MCP completeness M9).
// Taken when the hop starts, so a token dropped by the time it is billed
// still ticks.
function progressOf(token) {
  const e = (token != null) ? byToken.get(token) : null;
  return (e != null && e.progress != null) ? e.progress : null;
}

module.exports = {noteRefused, noteThrough, refusedOf, issue, resolve, drop, onDrop, progressOf, outerOf, dropFor, liveFor, ofSession, bindingOf, declaredTarget, declaredTargetsOf, declaresDevice, declaredActionsOn, identityOf, hasVerdict,
  BOUND_IDENTITY, size: () => byToken.size, MAX_CHAIN_DEPTH};
