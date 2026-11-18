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
//   v2.<payload>.<mac>
//
//   payload   base64url of salt(16) | iv(12) | the AES-256-GCM ciphertext |
//             its tag(16), sealing JSON {n, e, q, r, c, a}: a 16-byte nonce,
//             the expiry (epoch ms, TTL_MS out), the pending question's key,
//             its round, the call's round (every question's rounds together,
//             so never under its question's), and the answers given in
//             earlier rounds (at most MAX_ANSWERS_BYTES), padded to a length
//             set by the answers alone. Sealed (F2-4): the question's key
//             names the question and who asked it (an unlisted part's
//             device, service and action), which its client must not read,
//             or learn the length of. The seal's key is derived from the MAC
//             key under its own label with a salt of its own for each state
//             (HKDF, sealPayload), so a state stays the runtime's
//             alone to read, with no table kept, as before. v1 (the payload
//             in the clear) is refused: one minted before an upgrade is
//             refused after it (its ask is asked again).
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

const VERSION = 'v2';
// (/2 with v2: the MAC is the gate between versions, a v1 payload relabelled
// v2 is refused by it, before anything is opened)
const LABEL = 'countinghouse-request-state/2';
// the label the MAC key is derived under (lib/identity.js derivedKey)
const KEY_LABEL = 'countinghouse-request-state-key/1';
// the label the payload's seal key is derived from the MAC key under
const SEAL_LABEL = 'countinghouse-request-state-seal/1';
const TTL_MS = 5 * 60 * 1000;
// Servers that share the secret and the store do not share a clock. This
// much difference between two of them is allowed for: a state from a
// server whose clock runs ahead still verifies on one behind it, and a
// used nonce is remembered this much past its expiry, so the one behind
// refuses a replay for as long as it still takes the state.
const CLOCK_SKEW_MS = 60 * 1000;
// arguments nested deeper bind nothing (refused outright, never by the
// stack running out)
const MAX_ARGUMENTS_DEPTH = 128;
const MAX_STATE_BYTES = 16 * 1024;
const MAX_ANSWERS_BYTES = 8 * 1024;
const MAX_ROUND = 16;
// what the state is of, as its user writes it (lib/module-ask.js: the
// question's key and name and who asked)
const MAX_QUESTION = 1024;
// and the question's key as the payload's JSON writes it, in bytes: its
// escaping (a quote or a backslash two bytes, a control six, a character
// past ASCII two to four) is bounded here, so the padding can cover the
// worst case (F2-4). A key past it is refused (mint throws, the ask is
// ASK_UNAVAILABLE): its parts are a declared question's name, a module's
// npm name, a device's UUID and a service's URN, all ASCII, so a real key
// is about its character length plus its quotes' escapes, well within.
const MAX_QUESTION_BYTES = 2048;
const MAX_REMEMBERED = 65536;
const NONCE = /^[A-Za-z0-9_-]{22}$/;                             // 16 bytes, base64url
// (STATE, the form a state's text must have, is made below, once its
// largest payload is known)

// ---- the mechanics lib/settings-confirm.js shares ----------------------

const newNonce = () => crypto.randomBytes(16).toString('base64url');

// The payload sealed, and opened (F2-4). AES-256-GCM under a key of its
// own for each state: one HKDF from the MAC key with a fresh 16-byte salt,
// under SEAL_LABEL, so no key ever meets two IVs whatever the number of
// states. Laid out as salt(16) | iv(12) | ciphertext | tag(16). The
// plaintext is padded with spaces (JSON reads past them) to its answers'
// bytes plus SEAL_ROOM, which covers every other field at its largest, the
// question's key as the JSON writes it included (MAX_QUESTION_BYTES): its
// length tells a client nothing it did not send itself, not how long the
// question's key is, which names the asker. A payload given as text (a
// test's) is sealed as it is, padded the same. Encrypt-then-MAC: the MAC is
// over the sealed payload, and checked before anything is opened.
const SEAL_ROOM = MAX_QUESTION_BYTES + 256;
// the largest sealed payload, in base64url characters (no padding): its
// answers and SEAL_ROOM, and the salt, IV and tag; and the largest state
// with it, which must fit MAX_STATE_BYTES (checked at load: a constant
// changed alone fails here, not in a branch no call reaches)
const MAX_PAYLOAD_CHARS = Math.ceil((MAX_ANSWERS_BYTES + SEAL_ROOM + 16 + 12 + 16) * 4 / 3);
if (VERSION.length + 1 + MAX_PAYLOAD_CHARS + 1 + 43 > MAX_STATE_BYTES) throw new Error('request-state: the largest state is over MAX_STATE_BYTES');
const STATE = new RegExp(`^v2\\.([A-Za-z0-9_-]{1,${MAX_PAYLOAD_CHARS}})\\.([A-Za-z0-9_-]{43})$`);   // a 32-byte HMAC, base64url
const stateKeyOf = (key, salt) => Buffer.from(crypto.hkdfSync('sha256', key, salt, SEAL_LABEL, 32));
// answersBytes: the answers' JSON length, as mint measured it
function sealPayload(key, value, answersBytes = null) {
  const text = typeof(value) === 'string' ? value : JSON.stringify(value);
  const answers = answersBytes != null ? answersBytes
    : (value != null && typeof(value) === 'object' && value.a !== undefined) ? Buffer.byteLength(JSON.stringify(value.a), 'utf8') : 0;
  const bytes = Buffer.byteLength(text, 'utf8');
  const padded = bytes < answers + SEAL_ROOM ? text + ' '.repeat(answers + SEAL_ROOM - bytes) : text;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', stateKeyOf(key, salt), iv);
  const body = Buffer.concat([c.update(padded, 'utf8'), c.final()]);
  return Buffer.concat([salt, iv, body, c.getAuthTag()]).toString('base64url');
}
// -> the payload's value; throws on anything that is not a seal of ours
function openPayload(key, sealed) {
  const b = Buffer.from(sealed, 'base64url');
  if (b.length < 16 + 12 + 16 + 2) throw new Error('request-state: not a sealed payload');
  const d = crypto.createDecipheriv('aes-256-gcm', stateKeyOf(key, b.subarray(0, 16)), b.subarray(16, 28));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28, b.length - 16)), d.final()]).toString('utf8'));
}

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
// what makes a state single use, never does.
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

// ---- the state (v2: sealed) ---------------------------------------------

// The runtime's key for these states: derived from the identity secret, so
// every process that shares the secret (and the store, for the used
// nonces) verifies what another made. Throws before the secret is loaded,
// and in a worker.
const key = () => require('./identity').derivedKey(KEY_LABEL);

// The call's arguments as the MAC binds them: one spelling for each value a
// request can carry, and no two values with the same one. Object keys
// sorted at every depth (a key with no value is no key); array order kept.
// JSON.stringify alone would not do: it spells -0 as 0 and a number that is
// not finite as null, and JSON.parse gives both ("-0", "1e999"), so a state
// made for one would verify for the other. -0 is spelled apart; a number
// that is not finite, or anything JSON has no form for, binds nothing
// (throws).
function canonicalArguments(value, depth) {
  const bad = (what) => new Error(`request-state: ${what}`);
  if (depth > MAX_ARGUMENTS_DEPTH) throw bad(`arguments nested deeper than ${MAX_ARGUMENTS_DEPTH}`);
  if (value === null || typeof(value) === 'boolean' || typeof(value) === 'string') return JSON.stringify(value);
  if (typeof(value) === 'number') {
    if (!Number.isFinite(value)) throw bad('a number that is not finite is in the arguments');
    return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    // by index, so a hole or an undefined is seen (JSON has neither)
    for (let i = 0; i < value.length; i++) items.push(canonicalArguments(value[i], depth + 1));
    return `[${items.join(',')}]`;
  }
  if (typeof(value) !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw bad('the arguments hold a value JSON has no form for');
  }
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalArguments(value[k], depth + 1)}`).join(',')}}`;
}
// no arguments and {} are one call
function argumentsHash(args) {
  return crypto.createHash('sha256').update(canonicalArguments(args == null ? {} : args, 0)).digest('hex');
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

const goodRound = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_ROUND;
const goodContent = (question, round, callRound, answers) => isText(question, MAX_QUESTION) && Buffer.byteLength(JSON.stringify(question), 'utf8') <= MAX_QUESTION_BYTES
  && goodRound(round) && goodRound(callRound) && callRound >= round && isPlainObject(answers);

// A state for the retry of the request `binding` names: {caller, session,
// method, tool, arguments}. content: {question, round, callRound, answers}. Throws on
// anything it should not have been asked to make (the caller's bug).
function mint(key, content, binding, {now = Date.now()} = {}) {
  const bad = (what) => new Error(`request-state: ${what}`);
  if (!goodKey(key)) throw bad('a key is at least 32 bytes');
  const bound = boundTo(binding);
  if (bound == null) throw bad('a state is bound to a caller, a session (or \'\'), a method, a tool and its arguments');
  if (!isPlainObject(content) || !goodContent(content.question, content.round, content.callRound, content.answers)) {
    throw bad(`a state carries a question's key, its round and the call's (1 to ${MAX_ROUND}, the call's never under its question's) and the earlier answers`);
  }
  const answersBytes = Buffer.byteLength(JSON.stringify(content.answers), 'utf8');
  if (answersBytes > MAX_ANSWERS_BYTES) throw bad(`the earlier answers are at most ${MAX_ANSWERS_BYTES} bytes`);
  const payload = sealPayload(key, {n: newNonce(), e: now + TTL_MS, q: content.question, r: content.round, c: content.callRound, a: content.answers}, answersBytes);
  // (within MAX_STATE_BYTES by construction: checked at load, above)
  return `${VERSION}.${payload}.${macOf(key, [LABEL, payload].concat(bound))}`;
}

// The retry's state, against the request it came with.
// -> {ok: true, nonce, expiresAt, question, round, callRound, answers} | {ok: false, why}
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
  try { p = openPayload(key, m[1]); } catch (e) { return no('payload'); }
  if (!isPlainObject(p) || Object.keys(p).sort().join() !== 'a,c,e,n,q,r' || typeof(p.n) !== 'string' || !NONCE.test(p.n)
    || !Number.isSafeInteger(p.e) || !goodContent(p.q, p.r, p.c, p.a)) return no('payload');
  // the earlier answers within their bound here too, whatever made the state
  if (Buffer.byteLength(JSON.stringify(p.a), 'utf8') > MAX_ANSWERS_BYTES) return no('payload');
  if (p.e <= now) return no('expired');
  // an expiry further out than any state is given (a clock ahead of this
  // one by CLOCK_SKEW_MS allowed for): not one of ours
  if (p.e > now + TTL_MS + CLOCK_SKEW_MS) return no('payload');
  return {ok: true, nonce: p.n, expiresAt: p.e, question: p.q, round: p.r, callRound: p.c, answers: p.a};
}

// Single use: the verified state's nonce, remembered in `used`
// ({use(nonce, until) -> boolean | Promise<boolean>}: a UsedNonces, or the
// store's usedNonces part) until CLOCK_SKEW_MS past its expiry, so a server
// whose clock is behind still finds it used while it takes the state.
// -> whether this is its first use. A store that cannot say (Redis down)
// rejects, and the caller refuses the retry: never "first use" by default,
// and only the store's plain true is one. now: a test's (a UsedNonces takes
// it; the store's part goes by its own clock).
async function consume(used, verified, {now} = {}) {
  if (verified == null || verified.ok !== true || typeof(verified.nonce) !== 'string' || !NONCE.test(verified.nonce) || !Number.isSafeInteger(verified.expiresAt)) return false;
  const until = verified.expiresAt + CLOCK_SKEW_MS;
  return (await (now === undefined ? used.use(verified.nonce, until) : used.use(verified.nonce, until, now))) === true;
}

module.exports = {mint, verify, consume, key, argumentsHash, macOf, sameMac, newNonce, UsedNonces, RecentNonces, sealPayload, openPayload,
  VERSION, LABEL, KEY_LABEL, TTL_MS, CLOCK_SKEW_MS, MAX_STATE_BYTES, MAX_ANSWERS_BYTES, MAX_ROUND};
