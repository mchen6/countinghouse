// R2-1 Task 3 (docs/superpowers/specs/2026-11-07-r2-1-no-raw-keys-in-modules-design.md,
// section 3): the per-call tokens the main thread issues when it sends a
// call to a worker, and resolves when that worker's hop, device query,
// remote call or peer announcement cites one. A token is 128 random bits;
// what it stands for lives here, on the main thread only:
//   {billingKey, identityKey, module, workerId, deviceID, parent, jobID,
//    expires}
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
const crypto = require('crypto');

const byToken  = new Map();   // token -> entry
const byWorker = new Map();   // workerId -> Set(token)
const children = new Map();   // token -> Set(child token)
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

function issue({billingKey, identityKey = null, module = null, workerId, deviceID = null, parent = null, jobID = null, ttlMs = DEFAULT_TTL_MS}) {
  if (billingKey == null) throw new Error('call-tokens: a token needs a billing key');
  if (workerId == null) throw new Error('call-tokens: a token needs the worker it is for');
  const token = crypto.randomBytes(16).toString('hex');
  let expires = Date.now() + ttlMs;
  const parentEntry = (parent != null) ? byToken.get(parent) : null;
  if (parentEntry != null) {
    expires = Math.min(expires, parentEntry.expires);
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent).add(token);
  }
  byToken.set(token, {token, billingKey, identityKey, module, workerId, deviceID, parent, jobID, expires});
  if (!byWorker.has(workerId)) byWorker.set(workerId, new Set());
  byWorker.get(workerId).add(token);
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

// Drops `token` and every descendant of it.
function drop(token) {
  const e = byToken.get(token);
  if (e == null) return;
  byToken.delete(token);
  const set = byWorker.get(e.workerId);
  if (set != null) { set.delete(token); if (set.size === 0) byWorker.delete(e.workerId); }
  if (e.parent != null && children.has(e.parent)) {
    children.get(e.parent).delete(token);
    if (children.get(e.parent).size === 0) children.delete(e.parent);
  }
  const kids = children.get(token);
  if (kids != null) { children.delete(token); for (const k of [...kids]) drop(k); }
}

// A worker ended: every token issued to it.
function dropFor(workerId) {
  const set = byWorker.get(workerId);
  if (set == null) return;
  for (const t of [...set]) drop(t);
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

module.exports = {issue, resolve, drop, dropFor, bindingOf, size: () => byToken.size};
