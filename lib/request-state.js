'use strict';
// requestState: what a client carries from an input_required answer to its
// retry (MCP 2026-07-28's multi-round-trip requests). The mechanics, for the
// two things that answer input_required: a module's question (ctx.ask; the
// MCP completeness design, section 8) and the runtime's own settings dialog
// (lib/settings-confirm.js, which keeps its own staging, key and locks, and
// takes from here the MAC, its comparison, the nonce and the memory of
// nonces).
//
// The state is the client's to send, so the attacker's to write:
//
//   v1.<payload>.<mac>
//
//   payload   base64url JSON {n, e, q, r, a}: a 16-byte nonce, the expiry
//             (epoch ms, TTL_MS out), the pending question's key, the round,
//             and the answers given in earlier rounds (at most
//             MAX_ANSWERS_BYTES)
//   mac       HMAC-SHA256, base64url, over one JSON array: a version label,
//             the payload, the caller's opaque id, the session id (or ''),
//             the method, the tool's name, and the SHA-256 of the call's
//             arguments in canonical JSON
//
// So a state is good only for the principal, within the time, and for the
// request it was made for (the three bindings MRTR asks for). It is single
// use, which only the server can make true: its nonce is remembered until
// its expiry (UsedNonces here; the store's usedNonces part in a runtime). A
// state that fails any check is refused with one answer, whatever failed:
// `why` is for the runtime's own line, never for the client.
//
// The expiry is on the wall clock: with the key derived from the identity
// secret (lib/identity.js derivedKey) any process that shares the secret
// and the store can verify a state, and a restart strands no dialog.
//
// Main thread only: no key, nonce or state is ever a worker's.
const crypto = require('crypto');
const {canonicalJSON} = require('./mcp/output-schema-hash');

const VERSION = 'v1';
const LABEL = 'countinghouse-request-state/1';
// the label the MAC key is derived under (lib/identity.js derivedKey)
const KEY_LABEL = 'countinghouse-request-state-key/1';
const TTL_MS = 5 * 60 * 1000;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_ANSWERS_BYTES = 8 * 1024;
const MAX_ROUND = 16;
const MAX_QUESTION = 128;
const MAX_REMEMBERED = 65536;
const NONCE = /^[A-Za-z0-9_-]{22}$/;                             // 16 bytes, base64url
const STATE = /^v1\.([A-Za-z0-9_-]{1,22000})\.([A-Za-z0-9_-]{43})$/;   // a 32-byte HMAC, base64url

// ---- the mechanics lib/settings-confirm.js shares ----------------------

const newNonce = () => crypto.randomBytes(16).toString('base64url');

// One JSON array: no two different lists of fields give the same bytes.
function macOf(key, fields) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(fields)).digest('base64url');
}

// Compared as the canonical strings, not their decoded bytes: base64url's
// last character carries padding bits, and a MAC differing only there
// decodes alike (one spelling only is valid). In constant time.
function sameMac(want, given) {
  if (typeof(want) !== 'string' || typeof(given) !== 'string') return false;
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The used nonces, in memory: each kept until its state's own expiry, so a
// replay inside it is known, then dropped (its state is refused as expired
// from then on). Bounded, and full it refuses: a nonce still good is never
// forgotten to make room.
class UsedNonces {
  constructor({max = MAX_REMEMBERED} = {}) {
    this.max = max;
    this.until = new Map();   // nonce -> its expiry
  }

  get size() { return this.until.size; }

  // -> whether this is the nonce's first use (and it is now remembered)
  use(nonce, expiresAt, now = Date.now()) {
    if (typeof(nonce) !== 'string' || nonce === '' || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
    // the expired go, oldest first (states share one lifetime, so the
    // order they were used in is nearly the order they expire in)
    for (const [n, e] of this.until) { if (e > now) break; this.until.delete(n); }
    if (this.until.has(nonce) && this.until.get(nonce) > now) return false;
    if (this.until.size >= this.max) {
      // any expired one behind a longer-lived one
      for (const [n, e] of this.until) if (e <= now) this.until.delete(n);
      if (this.until.size >= this.max) return false;
    }
    this.until.delete(nonce);   // an expired entry of the same name: it goes to the back
    this.until.set(nonce, expiresAt);
    return true;
  }
}

// A short memory of nonces, the last `max` added, oldest out: for telling
// an answer's case apart in its text (a replay "used", a late answer
// "expired") where single use is enforced some other way, as the settings
// dialog's is by its server-held staging. It forgets; UsedNonces, which is
// what makes a v1 state single use, never does.
class RecentNonces {
  constructor(max = 64) {
    this.max = max;
    this.kept = [];
  }

  get size() { return this.kept.length; }

  has(nonce) { return this.kept.includes(nonce); }

  add(nonce) {
    if (this.kept.includes(nonce)) return;
    this.kept.push(nonce);
    if (this.kept.length > this.max) this.kept.shift();
  }
}

// ---- the v1 state -------------------------------------------------------

// The runtime's key for these states: derived from the identity secret, so
// every process that shares the secret (and the store, for the used
// nonces) verifies what another made. Throws before the secret is loaded,
// and in a worker.
const key = () => require('./identity').derivedKey(KEY_LABEL);

// The call's arguments, as the MAC binds them: no arguments and {} are one call.
function argumentsHash(args) {
  return crypto.createHash('sha256').update(canonicalJSON(args == null ? {} : args)).digest('hex');
}

const isText = (s, max) => typeof(s) === 'string' && s.length > 0 && s.length <= max;
const isPlainObject = (o) => o != null && typeof(o) === 'object' && !Array.isArray(o);
const goodKey = (key) => Buffer.isBuffer(key) && key.length >= 32;

// -> the MAC's fields after the label and the payload, or null: a caller, a
// method and a tool, and a session that is a string ('' for none)
function boundTo(binding) {
  if (!isPlainObject(binding) || !isText(binding.caller, 256) || typeof(binding.session) !== 'string' || binding.session.length > 256
    || !isText(binding.method, 128) || !isText(binding.tool, 512)) return null;
  let hash;
  try { hash = argumentsHash(binding.arguments); } catch (e) { return null; }
  return [binding.caller, binding.session, binding.method, binding.tool, hash];
}

const goodContent = (question, round, answers) => isText(question, MAX_QUESTION) && Number.isInteger(round) && round >= 1 && round <= MAX_ROUND && isPlainObject(answers);

// A state for the retry of the request `binding` names: {caller, session,
// method, tool, arguments}. content: {question, round, answers}. Throws on
// anything it should not have been asked to make (the caller's bug).
function mint(key, content, binding, {now = Date.now()} = {}) {
  const bad = (what) => new Error(`request-state: ${what}`);
  if (!goodKey(key)) throw bad('a key is at least 32 bytes');
  const bound = boundTo(binding);
  if (bound == null) throw bad('a state is bound to a caller, a session (or \'\'), a method, a tool and its arguments');
  if (!isPlainObject(content) || !goodContent(content.question, content.round, content.answers)) {
    throw bad(`a state carries a question's key, a round of 1 to ${MAX_ROUND} and the earlier answers`);
  }
  if (Buffer.byteLength(JSON.stringify(content.answers), 'utf8') > MAX_ANSWERS_BYTES) throw bad(`the earlier answers are at most ${MAX_ANSWERS_BYTES} bytes`);
  const payload = Buffer.from(JSON.stringify({n: newNonce(), e: now + TTL_MS, q: content.question, r: content.round, a: content.answers}), 'utf8').toString('base64url');
  const state = `${VERSION}.${payload}.${macOf(key, [LABEL, payload].concat(bound))}`;
  if (state.length > MAX_STATE_BYTES) throw bad(`a state is at most ${MAX_STATE_BYTES} bytes`);
  return state;
}

// The retry's state, against the request it came with.
// -> {ok: true, nonce, expiresAt, question, round, answers} | {ok: false, why}
// Not yet consumed: consume() makes it single use.
function verify(key, state, binding, {now = Date.now()} = {}) {
  const no = (why) => ({ok: false, why: why});
  if (!goodKey(key)) return no('no key');
  if (typeof(state) !== 'string' || state.length > MAX_STATE_BYTES) return no('not a state');
  const m = STATE.exec(state);
  if (m == null) return no('not a state');
  const bound = boundTo(binding);
  if (bound == null) return no('no binding');
  // the MAC first: nothing of the payload is read before it holds
  if (!sameMac(macOf(key, [LABEL, m[1]].concat(bound)), m[2])) return no('mac');
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (e) { return no('payload'); }
  if (!isPlainObject(p) || Object.keys(p).sort().join() !== 'a,e,n,q,r' || typeof(p.n) !== 'string' || !NONCE.test(p.n)
    || !Number.isSafeInteger(p.e) || !goodContent(p.q, p.r, p.a)) return no('payload');
  if (p.e <= now) return no('expired');
  // an expiry further out than any state is given: not one of ours
  if (p.e > now + TTL_MS) return no('payload');
  return {ok: true, nonce: p.n, expiresAt: p.e, question: p.q, round: p.r, answers: p.a};
}

// Single use: the verified state's nonce, remembered until its expiry in
// `used` ({use(nonce, expiresAt) -> boolean | Promise<boolean>}: a
// UsedNonces, or the store's usedNonces part). -> whether this is its first
// use. A store that cannot say (Redis down) rejects, and the caller refuses
// the retry: never "first use" by default.
async function consume(used, verified) {
  if (verified == null || verified.ok !== true || typeof(verified.nonce) !== 'string' || !NONCE.test(verified.nonce) || !Number.isSafeInteger(verified.expiresAt)) return false;
  return (await used.use(verified.nonce, verified.expiresAt)) === true;
}

module.exports = {mint, verify, consume, key, argumentsHash, macOf, sameMac, newNonce, UsedNonces, RecentNonces,
  VERSION, LABEL, KEY_LABEL, TTL_MS, MAX_STATE_BYTES, MAX_ANSWERS_BYTES, MAX_ROUND};
