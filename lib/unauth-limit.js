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
// Limits: --unauthRateLimit lookups that don't resolve per minute per address (default 30; 0
// turns it off), and ten times that across the process (a spray from many
// addresses). The process cap never refuses an address with nothing in its
// own window: a new client, or one back after a restart (the set of keys
// that resolved is in memory), still has its first lookup, and a key that
// resolves is remembered; a spray from many addresses gets one lookup per
// address a minute. An address is the socket's, IPv6 grouped by its /64, or
// req.ip under --trustProxy. In memory only: an unauthenticated loop costs no
// Redis round trip either.
const net = require('net');
const {AsyncLocalStorage} = require('async_hooks');
const {CountinghouseError} = require('./countinghouse-error');
// a key kept by its digest, never itself (lib/key-fingerprint.js)
const {meterId} = require('./key-fingerprint');

const WINDOW_MS = 60 * 1000;
const PROCESS_FACTOR = 10;
const MAX_ADDRESSES = 10000;
const RECENT_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT = 10000;
const DEFAULT_PER_MINUTE = 30;

// an address as the limiter keys it: an IPv4-mapped IPv6 address as IPv4,
// another IPv6 address by its /64, anything else as it is
function addressKeyOf(address) {
  let a = String(address == null ? '' : address);
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  if (!net.isIPv6(a)) return a;
  // expand "::" to the eight groups, then keep four
  const [head, tail] = a.includes('::') ? a.split('::') : [a, null];
  const h = head === '' ? [] : head.split(':');
  const t = tail == null || tail === '' ? [] : tail.split(':');
  const groups = tail == null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// perMinute: refusals per address per minute (0: no limit); now: a clock.
// An address's window holds its refusals and its lookups in flight, each a
// {t} (a lookup's leaves the window when its key resolves, by identity; one
// never settled leaves it as a refusal's does, after WINDOW_MS).
function createLimiter({perMinute = DEFAULT_PER_MINUTE, now = Date.now, maxAddresses = MAX_ADDRESSES, maxRecent = MAX_RECENT} = {}) {
  const processCap = perMinute * PROCESS_FACTOR;
  const byAddress = new Map();   // address key -> [{t}], oldest first; Map order = least recently counted first
  const everyone = [];           // every {t} in the window, oldest first
  const recent = new Map();      // meterId(key) -> until when; Map order = least recently resolved first
  const inWindow = (entries, t) => { while (entries.length > 0 && entries[0].t <= t - WINDOW_MS) entries.shift(); return entries; };
  const drop = (entries, e) => { const i = entries.indexOf(e); if (i !== -1) entries.splice(i, 1); };
  const limiter = {
    perMinute,
    // -> ms to wait before the next lookup is made, or 0 when under budget
    retryAfterMs(addressKey) {
      if (perMinute <= 0) return 0;
      const t = now();
      const mine = byAddress.get(addressKey);
      const own = mine != null ? inWindow(mine, t) : [];
      const all = inWindow(everyone, t);
      let wait = 0;
      if (own.length >= perMinute) wait = Math.max(wait, own[own.length - perMinute].t + WINDOW_MS - t);
      // (never an address with nothing in its own window: see the header)
      if (own.length > 0 && all.length >= processCap) wait = Math.max(wait, all[all.length - processCap].t + WINDOW_MS - t);
      return wait;
    },
    // counts one against addressKey -> the entry (settle(entry) takes it back)
    count(addressKey) {
      if (perMinute <= 0) return null;
      const t = now();
      const e = {t};
      const mine = byAddress.has(addressKey) ? inWindow(byAddress.get(addressKey), t) : [];
      byAddress.delete(addressKey);
      mine.push(e);
      if (mine.length > perMinute) mine.splice(0, mine.length - perMinute);
      byAddress.set(addressKey, mine);
      while (byAddress.size > maxAddresses) byAddress.delete(byAddress.keys().next().value);
      inWindow(everyone, t).push(e);
      if (everyone.length > processCap) everyone.splice(0, everyone.length - processCap);
      return e;
    },
    // a lookup's entry back out of the window: its key resolved
    uncount(addressKey, e) {
      if (e == null) return;
      const mine = byAddress.get(addressKey);
      if (mine != null) drop(mine, e);
      drop(everyone, e);
    },
    refused(addressKey) { limiter.count(addressKey); },
    resolved(appKey) {
      if (perMinute <= 0 || appKey == null) return;
      const h = meterId(appKey);
      recent.delete(h);
      recent.set(h, now() + RECENT_TTL_MS);
      while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
    },
    resolvedLately(appKey) {
      if (appKey == null) return false;
      const h = meterId(appKey);
      const until = recent.get(h);
      if (until == null) return false;
      if (until <= now()) { recent.delete(h); return false; }
      return true;
    },
    sizes: () => ({addresses: byAddress.size, recent: recent.size, refusals: everyone.length})
  };
  return limiter;
}

const store = new AsyncLocalStorage();
let limiter = null;
function current() {
  if (limiter == null) {
    const options = require('./cli-options');
    const n = options.unauthRateLimit;
    limiter = createLimiter({perMinute: Number.isInteger(n) && n >= 0 ? n : DEFAULT_PER_MINUTE});
  }
  return limiter;
}

// the key a route reads, in its order (lib/routes/user.js validateUser)
const keyOfRequest = (req) => {
  const h = req.headers || {};
  for (const name of ['x-ch-key', 'x-app-key', 'authorization']) if (h[name] != null) return String(h[name]);
  return null;
};

// The HTTP gate, before the body parsers and every route.
function middleware() {
  return (req, res, next) => {
    const l = current();
    if (l.perMinute <= 0) return next();
    const address = addressKeyOf(req.ip != null ? req.ip : (req.socket != null ? req.socket.remoteAddress : null));
    const wait = l.retryAfterMs(address);
    if (wait > 0 && !l.resolvedLately(keyOfRequest(req))) {
      const err = new CountinghouseError('UNAUTH_RATE_LIMITED');
      res.set('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
      // /mcp: a JSON-RPC error (no id: nothing was parsed), its code in data,
      // as the gateway's own transport refusals are shaped; elsewhere the
      // routes' {code, message}
      const mcp = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '').toLowerCase() === '/mcp';
      return res.status(err.httpStatus).json(mcp
        ? {jsonrpc: '2.0', id: null, error: {code: -32000, message: err.message, data: {code: err.code}}}
        : {code: err.code, message: err.message});
    }
    return store.run({address}, next);
  };
}

// A REST route's answer for a lookup refused for its address (beforeLookup's
// null, met once the request was under way): 429, Retry-After, {code, message}.
function answerLimited(res, err) {
  const s = store.getStore();
  const wait = s != null ? current().retryAfterMs(s.address) : 0;
  res.set('Retry-After', String(Math.max(1, Math.ceil(wait / 1000))));
  return res.status(err.httpStatus).json({code: err.code, message: err.message});
}

// lib/user-auth.js's lookup of a key: beforeLookup(appKey) -> null when the
// request's address is over budget and the key has not resolved lately (the
// lookup is not made: UNAUTH_RATE_LIMITED), else {resolved(), refused()},
// one of which is called once the provider answers. In flight, the lookup
// holds a place in its address's window; resolved() gives it back and
// remembers the key, refused() keeps it. A key that resolved lately takes
// no place (it still counts if refused now). Outside an HTTP request: no
// limit, nothing counted.
const NOTHING = {resolved() {}, refused() {}};
function beforeLookup(appKey) {
  const s = store.getStore();
  if (s == null) return NOTHING;
  const l = current();
  if (l.perMinute <= 0) return NOTHING;
  const known = l.resolvedLately(appKey);
  if (!known && l.retryAfterMs(s.address) > 0) return null;
  const entry = known ? null : l.count(s.address);
  let settled = false;
  return {
    resolved() { if (settled) return; settled = true; l.uncount(s.address, entry); l.resolved(appKey); },
    refused() { if (settled) return; settled = true; if (entry == null) l.count(s.address); }
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
// a key refused with no lookup (none sent, --debug's wrong debugKey)
function keyRefused() {
  const s = store.getStore();
  if (s != null) current().refused(s.address);
}

// a test's: the process's limiter made again from the options
function resetForTests() { limiter = null; }

module.exports = {middleware, answerLimited, beforeLookup, keyRefused, keyResolvedBy, createLimiter, addressKeyOf, resetForTests, WINDOW_MS, PROCESS_FACTOR, DEFAULT_PER_MINUTE};
