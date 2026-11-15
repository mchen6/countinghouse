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
// the exact change (the setting's name and its canonical value). The change
// itself is held here, server-side. So a retry from another session, for
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
const kindOf = (name) => (/^pack\./.test(String(name)) ? 'pack' : String(name));

class Confirmations {
  constructor({now = Date.now, ttlMs = TTL_MS} = {}) {
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
    const payload = JSON.stringify(['countinghouse-confirm/1', nonce, String(session), String(name), next]);
    return crypto.createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  // change: {name, old, next, client: {name, version}, session} -> {requestState, replaced}
  stage(change) {
    if (this.forms <= 0) throw new Error('no forms left this start');
    this.forms -= 1;
    const staged = {
      name: String(change.name),
      old: change.old,
      next: change.next,
      client: change.client != null ? {name: String(change.client.name), version: String(change.client.version)} : null,
      session: String(change.session),
      at: this.now()
    };
    const nonce = crypto.randomBytes(16).toString('base64url');
    const mac = this.macOf(nonce, staged);
    const replaced = this.pending != null ? this.pending.staged : null;
    this.pending = {nonce, mac, staged};
    return {requestState: `${nonce}.${mac}`, replaced};
  }

  // the retry's {name, next, session} -> {ok: true, staged} | {ok: false, code}
  verify(requestState, retry) {
    const invalid = {ok: false, code: 'SETTING_CONFIRMATION_INVALID'};
    const m = typeof(requestState) === 'string' && requestState.length <= 128 ? STATE.exec(requestState) : null;
    if (m == null || retry == null) return invalid;
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
    if (p.staged.name !== String(retry.name) || p.staged.next !== retry.next || p.staged.session !== String(retry.session)) return invalid;
    // used up here, before anything else can see it (single use, server-side)
    this.pending = null;
    if (this.now() - p.staged.at > this.ttlMs) {
      const kind = kindOf(p.staged.name);
      const n = (this.expiries.get(kind) || 0) + 1;
      this.expiries.set(kind, n);
      if (n >= EXPIRIES_TO_LOCK) this.declines.add(kind);
      return {ok: false, code: 'SETTING_CONFIRMATION_EXPIRED'};
    }
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
