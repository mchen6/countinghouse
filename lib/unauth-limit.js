'use strict';
// A limit on requests whose API key doesn't resolve (release-1 hardening,
// the reviewer's plan of 11-20). Without it an unauthenticated loop costs one
// auth-provider lookup per request, with nothing in its way: the per-key and
// global limits only start once a key has resolved.
//
// Counted where a key is refused for not resolving -- lib/user-auth.js's one
// refusal site (an unknown, missing or malformed key, or --debug's wrong
// debugKey; never a known key without the device) -- against the client's
// address, which the HTTP request carries to it in an AsyncLocalStorage
// store (middleware below): every route is covered, the MCP gateway's
// req-less lookups included, with no plumbing. --stdio and --sessionSocket
// are not HTTP and are not limited (local channels, authenticated already).
//
// Over budget, a request is answered 429 UNAUTH_RATE_LIMITED, Retry-After
// in seconds, before anything else is done: no body parsed, no provider
// asked. The same answer whatever was wrong with its key and whatever it
// named, so it tells nothing. A key that resolved lately (a bounded set of
// its SHA-256 hashes, never the key) is let through while its address is
// over budget, so a valid user behind a shared address is not shut out by
// another's bad requests; it still goes to the provider as any request does
// -- the set lets it past this limiter, it authenticates nothing. API keys
// are high-entropy: this bounds provider load, it is not brute-force
// protection (docs/security-model.md).
//
// Limits: --unauthRateLimit refusals per minute per address (default 30; 0
// turns it off), and ten times that across the process (a spray from many
// addresses). An address is the socket's, IPv6 grouped by its /64, or
// req.ip under --trustProxy. In memory only: an unauthenticated loop costs no
// Redis round trip either.
const crypto = require('crypto');
const net = require('net');
const {AsyncLocalStorage} = require('async_hooks');
const {CountinghouseError} = require('./countinghouse-error');

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

const hashOf = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');

// perMinute: refusals per address per minute (0: no limit); now: a clock
function createLimiter({perMinute = DEFAULT_PER_MINUTE, now = Date.now, maxAddresses = MAX_ADDRESSES, maxRecent = MAX_RECENT} = {}) {
  const processCap = perMinute * PROCESS_FACTOR;
  const byAddress = new Map();   // address key -> [refusal times], oldest first; Map order = least recently refused first
  const everyone = [];           // every refusal time in the window, oldest first
  const recent = new Map();      // key hash -> until when; Map order = least recently resolved first
  const inWindow = (times, t) => { while (times.length > 0 && times[0] <= t - WINDOW_MS) times.shift(); return times; };
  return {
    perMinute,
    // -> ms to wait before the next refusal is taken, or 0 when under budget
    retryAfterMs(addressKey) {
      if (perMinute <= 0) return 0;
      const t = now();
      const mine = byAddress.get(addressKey);
      const own = mine != null ? inWindow(mine, t) : [];
      const all = inWindow(everyone, t);
      let wait = 0;
      if (own.length >= perMinute) wait = Math.max(wait, own[own.length - perMinute] + WINDOW_MS - t);
      if (all.length >= processCap) wait = Math.max(wait, all[all.length - processCap] + WINDOW_MS - t);
      return wait;
    },
    refused(addressKey) {
      if (perMinute <= 0) return;
      const t = now();
      const mine = byAddress.has(addressKey) ? inWindow(byAddress.get(addressKey), t) : [];
      byAddress.delete(addressKey);
      mine.push(t);
      if (mine.length > perMinute) mine.splice(0, mine.length - perMinute);
      byAddress.set(addressKey, mine);
      while (byAddress.size > maxAddresses) byAddress.delete(byAddress.keys().next().value);
      inWindow(everyone, t).push(t);
      if (everyone.length > processCap) everyone.splice(0, everyone.length - processCap);
    },
    resolved(appKey) {
      if (perMinute <= 0 || appKey == null) return;
      const h = hashOf(appKey);
      recent.delete(h);
      recent.set(h, now() + RECENT_TTL_MS);
      while (recent.size > maxRecent) recent.delete(recent.keys().next().value);
    },
    resolvedLately(appKey) {
      if (appKey == null) return false;
      const h = hashOf(appKey);
      const until = recent.get(h);
      if (until == null) return false;
      if (until <= now()) { recent.delete(h); return false; }
      return true;
    },
    sizes: () => ({addresses: byAddress.size, recent: recent.size, refusals: everyone.length})
  };
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

// lib/user-auth.js's two outcomes. A refusal for a key that doesn't resolve
// counts against the request's address; one with none (not HTTP) counts
// nowhere. A key that resolved is remembered (its hash).
function keyRefused() {
  const s = store.getStore();
  // (once per request: a request may look its key up more than once)
  if (s == null || s.refused === true) return;
  s.refused = true;
  current().refused(s.address);
}
function keyResolved(appKey) {
  if (store.getStore() == null) return;
  current().resolved(appKey);
}

// a test's: the process's limiter made again from the options
function resetForTests() { limiter = null; }

module.exports = {middleware, keyRefused, keyResolved, createLimiter, addressKeyOf, resetForTests, WINDOW_MS, PROCESS_FACTOR, DEFAULT_PER_MINUTE};
