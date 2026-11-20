'use strict';
// A limit on requests whose API key doesn't resolve (release-1 hardening,
// the reviewer's plan of 11-20). Without it an unauthenticated loop costs one
// auth-provider lookup per request, with nothing in its way: the per-key and
// global limits only start once a key has resolved.
//
// Counted where a key is looked up -- lib/user-auth.js, the one place a key
// is resolved (/device-list resolves its key there too) -- against the
// client's address, which the HTTP request carries to it in an
// AsyncLocalStorage store (middleware below): every route is covered, the
// MCP gateway's req-less lookups included, with no plumbing. A lookup takes
// a place in its address's budget while it is in flight (so requests sent
// at once cannot all pass before any is counted), and keeps it unless the
// key resolved (a known key, with the device or without it): an unknown,
// missing or malformed key, --debug's wrong debugKey, or a provider that
// could not answer, each counts, once per lookup (a legacy batch looks its
// key up once per message). Over budget, the lookup is not made: the
// caller gets UNAUTH_RATE_LIMITED. --stdio and --sessionSocket are not HTTP
// and are not limited (local channels, authenticated already).
//
// Over budget, a request is answered 429 UNAUTH_RATE_LIMITED, Retry-After
// in seconds, before anything else is done: no body parsed, no provider
// asked. The same answer whatever was wrong with its key and whatever it
// named, so it tells nothing. A key that resolved lately (a bounded set of
// its digests, never the key) is let through while its address is
// over budget, so a valid user behind a shared address is not shut out by
// another's bad requests; it still goes to the provider as any request does
// -- the set lets it past this limiter, it authenticates nothing. API keys
// are high-entropy: this bounds provider load, it is not brute-force
// protection (docs/security-model.md).
//
// Limits: --unauthRateLimit lookups that don't resolve per minute per
// address (default 30; 0 turns it off), ten times that per wider prefix,
// and a hundred times that across the process, all three always
// (createLimiter). Only a request's own lookups count: made until its
// answer is sent, of a key it carried or with none; what outlives it (a
// worker it started: outsideRequest) carries no address. An address is the socket's,
// or req.ip under --trustProxy, each spelling of one address one key
// (addressKeyOf), IPv6 grouped by its /64. In memory only: an
// unauthenticated loop costs no Redis round trip either.
const {AsyncLocalStorage} = require('async_hooks');
const options = require('./cli-options');
const {CountinghouseError} = require('./countinghouse-error');
// a key kept by its digest, never itself (lib/key-fingerprint.js)
const {meterId} = require('./key-fingerprint');

const WINDOW_MS = 60 * 1000;
// (ii) a wider prefix's limit, and (iii) the process's, as multiples of an
// address's
const PREFIX_FACTOR = 10;
const GLOBAL_FACTOR = 100;
const MAX_ADDRESSES = 10000;
const MAX_PREFIXES = 10000;
const RECENT_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT = 10000;
const DEFAULT_PER_MINUTE = options.UNAUTH_RATE_LIMIT_DEFAULT;
// a full sweep of a window table for emptied windows, at most this often
const SWEEP_MS = 1000;

// an address as the limiter keys it, whatever its spelling (case, the
// IPv4-mapped forms dotted or hex, brackets, a port, a zone): an IPv4
// address (an IPv4-mapped one too) as dotted IPv4, another IPv6 address by
// its /64, anything that is not an address as it is
function addressKeyOf(address) {
  let a = String(address == null ? '' : address).trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(a);
  if (bracketed != null) a = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  const g = options.ipGroups(a);
  if (g == null) return a;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

// the wider prefix an address key is in: an IPv4 address's /24, an IPv6
// /64's /48; anything else (not an address) is its own
function prefixKeyOf(addressKey) {
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(addressKey);
  if (v4 != null) return `${v4[1]}.0/24`;
  const v6 = /^([0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}):[0-9a-f]{1,4}::\/64$/.exec(addressKey);
  if (v6 != null) return `${v6[1]}::/48`;
  return addressKey;
}

// perMinute: lookups per address per minute (0: no limit); now: a clock.
// Three windows, every lookup counted in each, each always applied (the
// high review of #483, round 2): (i) its address (an IPv6 /64, an IPv4
// address) at perMinute; (ii) its wider prefix (an IPv6 /48, an IPv4 /24)
// at PREFIX_FACTOR times that; (iii) the process at GLOBAL_FACTOR times
// that. A key that resolved lately passes all three (beforeLookup). A
// window holds an address's refusals and its lookups in flight, each a {t}
// (a lookup's leaves when its key resolves, by identity; one never settled
// leaves as a refusal's does, after WINDOW_MS).
//
// The address and prefix tables are bounded for memory only: past their
// size, the windows that have emptied go (a full sweep, in no reliance on
// order), then the least recently counted. A window pushed out with lookups
// still in it opens no hole: (ii) and (iii) still hold what it held.
function createLimiter({perMinute = DEFAULT_PER_MINUTE, now = Date.now, maxAddresses = MAX_ADDRESSES, maxPrefixes = MAX_PREFIXES, maxRecent = MAX_RECENT} = {}) {
  const caps = {address: perMinute, prefix: perMinute * PREFIX_FACTOR, global: perMinute * GLOBAL_FACTOR};
  // A window: its entries oldest first, with how many are live (counted, not
  // taken back) and how many of those are lookups in flight -- counts kept as
  // entries come and go, so no check scans a window (the last-round high on
  // #483, 1: a scan over a full process window cost every request). An
  // entry {t, pending, gone, wins} knows the windows still holding it; one
  // taken back (its key resolved) is marked gone and leaves its windows'
  // arrays when it reaches their front.
  const newWindow = () => ({entries: [], live: 0, pending: 0});
  const byAddress = new Map();   // address key -> window; Map order = least recently counted first
  const byPrefix = new Map();    // prefix key -> window, as byAddress
  const everyone = newWindow();  // the process's
  const recent = new Map();      // meterId(key) -> until when; Map order = least recently resolved first
  const swept = new Map([[byAddress, -Infinity], [byPrefix, -Infinity]]);
  const leave = (w, x) => {
    x.wins = x.wins.filter((v) => v !== w);
    if (!x.gone) { w.live--; if (x.pending) w.pending--; }
  };
  // the front: what has left the window (expired) or was taken back (gone)
  const prune = (w, t) => {
    while (w.entries.length > 0 && (w.entries[0].gone || w.entries[0].t <= t - WINDOW_MS)) leave(w, w.entries.shift());
    return w;
  };
  // ms until the window has room, 0 when it has; a second when a lookup in
  // it is still in flight (its place may come back as soon as its key
  // resolves: a Retry-After of the window's whole minute would hold back a
  // valid caller's burst for nothing). Its front, once pruned, is live: room
  // comes when it leaves.
  const waitOf = (w, cap, t) => {
    if (w == null || prune(w, t).live < cap) return 0;
    const until = w.entries[0].t + WINDOW_MS - t;
    return w.pending > 0 ? Math.min(1000, until) : until;
  };
  const enter = (w, cap, e, t) => {
    prune(w, t);
    w.entries.push(e);
    w.live++;
    if (e.pending) w.pending++;
    e.wins.push(w);
    // (a window holds at most its cap: the oldest go first)
    while (w.live > cap) leave(w, w.entries.shift());
  };
  const tableWindow = (table, key) => {
    let w = table.get(key);
    if (w == null) w = newWindow();
    table.delete(key);
    table.set(key, w);
    return w;
  };
  const bound = (table, max, t) => {
    if (table.size <= max) return;
    if (t - swept.get(table) >= SWEEP_MS) {
      swept.set(table, t);
      for (const [key, w] of Array.from(table)) if (prune(w, t).live === 0) table.delete(key);
    }
    while (table.size > max) table.delete(table.keys().next().value);
  };
  const limiter = {
    perMinute,
    // -> ms to wait before the next lookup is made, or 0 when under budget
    retryAfterMs(addressKey) {
      if (perMinute <= 0) return 0;
      const t = now();
      return Math.max(waitOf(byAddress.get(addressKey), caps.address, t), waitOf(byPrefix.get(prefixKeyOf(addressKey)), caps.prefix, t),
        waitOf(everyone, caps.global, t));
    },
    // counts one against addressKey (its address, its prefix, the process);
    // pending: a lookup in flight (settle or uncount it) -> the entry
    count(addressKey, {pending = false} = {}) {
      if (perMinute <= 0) return null;
      const t = now();
      const e = {t, pending: pending === true, gone: false, wins: []};
      enter(tableWindow(byAddress, addressKey), caps.address, e, t);
      enter(tableWindow(byPrefix, prefixKeyOf(addressKey)), caps.prefix, e, t);
      enter(everyone, caps.global, e, t);
      bound(byAddress, maxAddresses, t);
      bound(byPrefix, maxPrefixes, t);
      return e;
    },
    // a lookup in flight refused: it stays counted, no longer in flight
    settle(e) {
      if (e == null || !e.pending) return;
      e.pending = false;
      for (const w of e.wins) w.pending--;
    },
    // a lookup's entry back out of every window: its key resolved
    uncount(addressKey, e) {
      if (e == null || e.gone) return;
      for (const w of e.wins) { w.live--; if (e.pending) w.pending--; }
      e.gone = true;
      e.pending = false;
      e.wins = [];
      const w = byAddress.get(addressKey);
      if (w != null && w.live === 0) byAddress.delete(addressKey);
    },
    refused(addressKey) { limiter.count(addressKey); },
    resolved(appKey) {
      if (perMinute <= 0 || appKey == null) return;
      const h = meterId(appKey);
      recent.delete(h);
      recent.set(h, now() + RECENT_TTL_MS);
      while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
    },
    // a key refused now: no longer one that resolved lately (revoked)
    forget(appKey) {
      if (appKey != null) recent.delete(meterId(appKey));
    },
    resolvedLately(appKey) {
      if (appKey == null) return false;
      const h = meterId(appKey);
      const until = recent.get(h);
      if (until == null) return false;
      if (until <= now()) { recent.delete(h); return false; }
      return true;
    },
    sizes: () => ({addresses: byAddress.size, prefixes: byPrefix.size, recent: recent.size, refusals: everyone.live})
  };
  return limiter;
}

const store = new AsyncLocalStorage();
let limiter = null;
function current() {
  if (limiter == null) {
    // (validated by cli-options; unset before options are, as in a unit test)
    limiter = createLimiter({perMinute: options.unauthRateLimit != null ? options.unauthRateLimit : DEFAULT_PER_MINUTE});
  }
  return limiter;
}

// the keys a route may read, in its order (lib/routes/user.js validateUser;
// /mcp reads X-CH-Key alone)
const KEY_HEADERS = ['x-ch-key', 'x-app-key', 'authorization'];
const keysOfRequest = (req) => {
  const h = req.headers || {};
  return KEY_HEADERS.filter((name) => h[name] != null).map((name) => String(h[name]));
};


// The HTTP gate, before the body parsers and every route.
function middleware() {
  return (req, res, next) => {
    const l = current();
    if (l.perMinute <= 0) return next();
    const address = addressKeyOf(req.ip != null ? req.ip : (req.socket != null ? req.socket.remoteAddress : null));
    const wait = l.retryAfterMs(address);
    // (a key that resolved lately in any of the headers a route may read)
    if (wait > 0 && !keysOfRequest(req).some((k) => l.resolvedLately(k))) {
      const err = new CountinghouseError('UNAUTH_RATE_LIMITED');
      res.set('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
      // /mcp: a JSON-RPC error (no id: nothing was parsed), its code in data,
      // as the gateway's own transport refusals are shaped; elsewhere the
      // routes' {code, message}
      const mcp = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '').toLowerCase() === '/mcp';
      return res.status(err.httpStatus).json(mcp ? rpcLimited(null, err) : {code: err.code, message: err.message});
    }
    // The request's own: its address, the keys it carries, and whether it is
    // still being answered. A worker spawned or a listener set up while it is
    // served inherits this store (AsyncLocalStorage follows every async
    // resource made in it); so a lookup counts only while the request is open
    // and only for a key it carried (the high review of #483, 4), and
    // workers are spawned outside it (outsideRequest).
    // (the keys by their digests: the store outlives the request in what it
    // started, and a raw key is never kept in a long-lived structure)
    const own = {address, keys: keysOfRequest(req).map(meterId), open: true};
    // (closed when its answer is sent; a connection closed before that --
    // a reset after a batch was sent, a cancelled call's destroyed answer, a
    // listen stream the client left -- keeps the request's own lookups
    // counted for one more window, then ends it: the rest of a batch is not
    // looked up uncounted (the high review of #483, round 2, 1), and nothing
    // the request happened to start counts against its address for good;
    // what outlives a request is started outside it, outsideRequest)
    res.once('finish', () => { own.open = false; });
    res.once('close', () => { if (own.open) own.closedAt = Date.now(); });
    return store.run(own, next);
  };
}
// the request's store, if this runs on its own path: open, and a key it
// carried -- or no key, which is the route reading none, whatever headers
// came (an empty X-CH-Key; only headers /mcp does not read: the high review
// of #483, round 2, 8)
function ownRequest(appKey) {
  const s = store.getStore();
  if (s == null || s.open !== true || (s.closedAt != null && Date.now() - s.closedAt >= WINDOW_MS)) return null;
  const mine = appKey == null || s.keys.includes(meterId(appKey));
  return mine ? s : null;
}
// fn run outside any request's store: for what outlives the request that
// happened to start it (a module's worker, a validator's)
function outsideRequest(fn) {
  return store.exit(fn);
}

// The one answer for an address over budget. On /mcp a JSON-RPC error,
// -32000 (a server error: JSON-RPC defines no code for this), its code in
// data, by the request's id when one was read (the middleware's has none);
// a single request's is sent as a 429 (answerLimitedRpc). Elsewhere 429,
// Retry-After and the routes' {code, message} (answerLimited).
const JSONRPC_UNAUTH_LIMITED = -32000;
function rpcLimited(id, err) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: JSONRPC_UNAUTH_LIMITED, message: err.message, data: {code: err.code}}};
}
const isRpcLimited = (answer) => answer != null && !Array.isArray(answer) && answer.error != null && answer.error.data != null && answer.error.data.code === 'UNAUTH_RATE_LIMITED';
// a legacy batch's answers, 200 whatever each says: Retry-After when any
// message was the limit's
function batchLimited(res, answers) {
  if (Array.isArray(answers) && answers.some(isRpcLimited)) res.set('Retry-After', retryAfterSeconds());
}
function retryAfterSeconds() {
  const s = store.getStore();
  const wait = s != null ? current().retryAfterMs(s.address) : 0;
  return String(Math.max(1, Math.ceil(wait / 1000)));
}

// A REST route's answer for a lookup refused for its address (beforeLookup's
// null, met once the request was under way): 429, Retry-After, {code, message}.
function answerLimited(res, err) {
  res.set('Retry-After', retryAfterSeconds());
  return res.status(err.httpStatus).json({code: err.code, message: err.message});
}
// /mcp's single answer: a 429 with Retry-After when it is the limit's
// (rpcLimited), else as the caller would send it -> whether it was
function answerRpcLimited(res, answer) {
  if (!isRpcLimited(answer)) return false;
  res.set('Retry-After', retryAfterSeconds());
  res.status(new CountinghouseError('UNAUTH_RATE_LIMITED').httpStatus).json(answer);
  return true;
}

// lib/user-auth.js's lookup of a key: beforeLookup(appKey) -> null when the
// request's address is over budget and the key has not resolved lately (the
// lookup is not made: UNAUTH_RATE_LIMITED), else {resolved(), refused()},
// one of which is called once the provider answers. In flight, the lookup
// holds a place in its address's window; resolved() gives it back and
// remembers the key, refused(answered) keeps it and, when the provider
// answered (not when it failed), forgets the key (a key revoked since it
// resolved is counted again; a provider outage drops no valid key).
// Either way it counts: a lookup that did not resolve the key fails closed. A key that resolved lately takes no
// place (it still counts if refused now). Off the request's own path (no
// request, one that has ended, a key it did not carry): no limit, nothing
// counted.
const NOTHING = {resolved() {}, refused() {}};
function beforeLookup(appKey) {
  const s = ownRequest(appKey);
  if (s == null) return NOTHING;
  const l = current();
  if (l.perMinute <= 0) return NOTHING;
  const known = l.resolvedLately(appKey);
  if (!known && l.retryAfterMs(s.address) > 0) return null;
  const entry = known ? null : l.count(s.address, {pending: true});
  let settled = false;
  return {
    resolved() { if (settled) return; settled = true; l.uncount(s.address, entry); l.resolved(appKey); },
    refused(answered = true) {
      if (settled) return;
      settled = true;
      if (answered) l.forget(appKey);
      if (entry == null) l.count(s.address); else l.settle(entry);
    }
  };
}
// Whether a provider's answer says the key resolved: an answer, or a known
// key without the device (USER_HAS_NO_DEVICE). Anything else -- unknown, a
// code this does not know, the provider's failure -- does not (fails closed).
function keyResolvedBy(err, result) {
  if (err != null || result == null) return false;
  if (result.ok === true) return true;
  return result.err != null && result.err.code === 'USER_HAS_NO_DEVICE';
}
// a key resolved with no lookup (--debug's own debugKey): remembered, as
// one the provider resolved is
function keyResolved(appKey) {
  if (ownRequest(appKey) != null) current().resolved(appKey);
}
// a key refused with no lookup (none sent, --debug's wrong debugKey)
// -- counted only while the address's windows have room: past that, no
// more (a batch of 32 key-less messages adds no more than the budget: the
// last-round high on #483, 3)
function keyRefused(appKey) {
  const s = ownRequest(appKey);
  if (s == null) return;
  const l = current();
  if (l.retryAfterMs(s.address) === 0) l.refused(s.address);
}

// a test's: the process's limiter made again from the options
function resetForTests() { limiter = null; }

// a test's: the process's limiter's sizes
const sizesForTests = () => current().sizes();
// a test's: the store of the request this runs in, or undefined
const requestStoreForTests = () => store.getStore();

module.exports = {middleware, answerLimited, answerRpcLimited, batchLimited, rpcLimited, outsideRequest, requestStoreForTests, sizesForTests, beforeLookup, keyRefused, keyResolved, keyResolvedBy,
  createLimiter, addressKeyOf, prefixKeyOf, resetForTests, WINDOW_MS, PREFIX_FACTOR, GLOBAL_FACTOR, DEFAULT_PER_MINUTE};
