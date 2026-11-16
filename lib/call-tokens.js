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
  byToken.set(token, {token, billingKey, identityKey, module, workerId, deviceID, parent, jobID, expires, depth, limits: own, session: ownSession,
    progress: parentEntry != null ? parentEntry.progress : progress,
    serviceID: typeof(serviceID) === 'string' ? serviceID : null, actionName: typeof(actionName) === 'string' ? actionName : null, ask: ask != null ? ask : null});
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

// Drops `token` and every descendant of it: a walk with its own stack, not
// the call stack (the review of #141, N2).
function drop(token) {
  const stack = [token];
  while (stack.length > 0) {
    const t = stack.pop();
    const e = byToken.get(t);
    if (e == null) continue;
    byToken.delete(t);
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

// The outer call's progress notifier for any live token of its chain, or
// null: a hop or remote call billed under it ticks it (MCP completeness M9).
// Taken when the hop starts, so a token dropped by the time it is billed
// still ticks.
function progressOf(token) {
  const e = (token != null) ? byToken.get(token) : null;
  return (e != null && e.progress != null) ? e.progress : null;
}

module.exports = {issue, resolve, drop, progressOf, dropFor, ofSession, bindingOf, declaredTarget, declaresDevice, declaredActionsOn, identityOf, hasVerdict,
  BOUND_IDENTITY, size: () => byToken.size, MAX_CHAIN_DEPTH};
