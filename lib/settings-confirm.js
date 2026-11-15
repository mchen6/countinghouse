'use strict';
// Staging a loosening for the user's own confirmation (part 3, section 2 of
// docs/superpowers/specs/2026-11-14-guarding-settings-by-conversation-design.md;
// plan docs/superpowers/plans/2026-11-14-part3-p2-elicitation.md, Task 2).
//
// The settings tool answers a loosening asked for in conversation with a
// dialog for the user (an InputRequiredResult); the client retries the call
// with the answer and the requestState it was given. requestState is
// attacker-controlled (MCP 2026-07-28, basic/patterns/mrtr): it carries only
// a random nonce and an HMAC-SHA256, under this start's own key (random, in
// memory only), of that nonce, the MCP session that staged the change, and
// the change the retry names (the setting's name and its canonical value).
// The change itself is held here, server-side, with what the form showed
// (a pack's version), which no retry can alter. So a retry from another session, for
// another value or setting, after a restart, or with a state the runtime did
// not give, fails the HMAC; one past 120 s has expired; and single use is
// enforced here, not trusted to the client.
//
// One pending change at a time (per start): a new one replaces it. Prompt
// fatigue: a decline (a cancel counts as one) locks that setting's kind
// against conversation until the next start (a decline on any pack locks
// every pack), and so do two expiries; at most FORMS_PER_START forms a start.
const crypto = require('crypto');

const TTL_MS = 120 * 1000;
const STATE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;   // 16-byte nonce, 32-byte HMAC, base64url
const USED_KEPT = 64;   // used nonces remembered, so a replay says USED rather than INVALID
const FORMS_PER_START = 3;
const EXPIRIES_TO_LOCK = 2;
// a setting's kind (every pack.<name> is one kind), as lib/settings-tool.js
// groups its history by
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
const kindOf = (name) => (PACK.test(String(name)) ? 'pack' : String(name));
// a monotonic clock in ms (a wall-clock step never extends or ends a form)
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);
const isSession = (s) => typeof(s) === 'string' && s.length > 0 && s.length <= 200;

class Confirmations {
  constructor({now = monotonicMs, ttlMs = TTL_MS} = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.key = crypto.randomBytes(32);
    this.pending = null;            // {nonce, mac, staged}
    this.used = [];                 // recent used nonces
    this.declines = new Set();      // kinds
    this.expiries = new Map();      // kind -> count
    this.forms = FORMS_PER_START;
  }

  macOf(nonce, {session, name, next}) {
    // one JSON array: no two different changes give the same bytes
    const payload = JSON.stringify(['countinghouse-confirm/1', nonce, session, String(name), next]);
    return crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  // A pending form past its 120 s, left unanswered: cleared and counted as an
  // expiry (before a decline lock is read, so the second one locks before a
  // third form is sent). -> the expired staged change, or null.
  sweep() {
    const p = this.pending;
    if (p == null || this.now() - p.staged.at <= this.ttlMs) return null;
    this.pending = null;
    this.countExpiry(p.staged.name);
    return p.staged;
  }

  // change: {name, old, next, client: {name, version}, session} ->
  // {requestState, replaced}, or null (no forms left, no session, or the
  // kind locked: the caller refuses)
  stage(change) {
    if (change == null || !isSession(change.session)) return null;
    this.sweep();
    if (this.forms <= 0 || this.declined(change.name)) return null;
    this.forms -= 1;
    const staged = {
      name: String(change.name),
      old: change.old,
      next: change.next,
      version: change.version != null ? String(change.version) : null,
      client: change.client != null ? {name: String(change.client.name), version: String(change.client.version)} : null,
      session: change.session,
      at: this.now()
    };
    const nonce = crypto.randomBytes(16).toString('base64url');
    const mac = this.macOf(nonce, staged);
    const replaced = this.pending != null ? this.pending.staged : null;
    this.pending = {nonce, mac, staged};
    return {requestState: `${nonce}.${mac}`, replaced};
  }

  countExpiry(name) {
    const kind = kindOf(name);
    const n = (this.expiries.get(kind) || 0) + 1;
    this.expiries.set(kind, n);
    if (n >= EXPIRIES_TO_LOCK) this.declines.add(kind);
  }

  // As verify, without using the state up: {ok: true, staged, requestState}
  // | {ok: false, code} (a retry that carries no answer gets the same form).
  check(requestState, retry) {
    return this.verify(requestState, retry, {consume: false});
  }

  // the retry's {name, next, session} -> {ok: true, staged} | {ok: false, code}
  verify(requestState, retry, {consume = true} = {}) {
    const invalid = {ok: false, code: 'SETTING_CONFIRMATION_INVALID'};
    const m = typeof(requestState) === 'string' && requestState.length <= 128 ? STATE.exec(requestState) : null;
    if (m == null || retry == null || !isSession(retry.session)) return invalid;
    const [, nonce, mac] = m;
    if (this.used.includes(nonce)) return {ok: false, code: 'SETTING_CONFIRMATION_USED'};
    const p = this.pending;
    if (p == null || p.nonce !== nonce) return invalid;
    // the HMAC of what the retry says, against the one given: another session,
    // setting or value (or a forged state) does not match
    // compared as the canonical strings, not their decoded bytes: base64url's
    // last character carries padding bits, and a state differing only there
    // decodes alike (one spelling only is valid)
    const want = Buffer.from(this.macOf(nonce, retry), 'utf8');
    const given = Buffer.from(mac, 'utf8');
    if (want.length !== given.length || !crypto.timingSafeEqual(want, given)) return invalid;
    if (p.staged.name !== String(retry.name) || p.staged.next !== retry.next || p.staged.session !== retry.session) return invalid;
    if (this.now() - p.staged.at > this.ttlMs) {
      this.pending = null;
      this.countExpiry(p.staged.name);
      return {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'};
    }
    if (!consume) return {ok: true, staged: Object.assign({}, p.staged), requestState: `${nonce}.${mac}`};
    // used up here, before anything else can see it (single use, server-side)
    this.pending = null;
    this.used.push(nonce);
    if (this.used.length > USED_KEPT) this.used.shift();
    return {ok: true, staged: Object.assign({}, p.staged, {client: p.staged.client != null ? Object.assign({}, p.staged.client) : null})};
  }

  // by setting name: its kind (any pack.* is 'pack')
  decline(name) { this.declines.add(kindOf(name)); }
  declined(name) { return this.declines.has(kindOf(name)); }
  formsLeft() { return this.forms; }
}

// One per process: a start's confirmations, with its key.
let current = null;
const confirmations = () => (current != null ? current : (current = new Confirmations()));
const resetForTests = () => { current = null; };

module.exports = {Confirmations, confirmations, resetForTests, TTL_MS, FORMS_PER_START, kindOf};
