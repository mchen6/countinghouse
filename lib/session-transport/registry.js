'use strict';
// The runtime's sessions, on the main thread (the shared-runtime design
// section 2; the interface agreed with B for B1). It's the stable surface B
// codes against:
//
//   registry.on('gone', id)     once per session forgotten, announced or not
//   registry.on('session', s)   once per NEW session (a resume reattaches
//                               the same s and emits nothing)
//   registry.get(id) -> s | null
//
//   s.id          128 random bits, hex; derived from nothing
//   s.client      {status, conditions, repo}: the latest `client` frame, updated
//                 in place on each (re)connect and each conditions? answer.
//                 repo is an owner/name slug or null. The token MAC is
//                 not kept here: the listener uses it once, to decide
//                 own-runtime
//   s.connected   true while a connection is attached
//   'attach', 'detach'  across a reconnect ('attach' once the resumed
//                       connection has settled, so s.notify reaches it)
//   'end'         once, when the session is gone (bye, the reconnect window
//                 expired, or the registry closed); s is dead after it
//   'replay'      (entries) after a new session's settle, from a restarted
//                 daemon's shim: B2 applies each only if at least as tight
//   s.notify(obj)       one notification (an M with no header); dropped while
//                       detached
//   s.askConditions()   -> Promise<{status, conditions, repo} | null>: sends
//                       conditions?, waits ASK_TIMEOUT_MS (12 s, longer than
//                       the shim's 10 s for its child); null is no answer
//   s.record(entry), s.forget()   the shim's records, for a daemon restart
//
// Resume tokens are single-use and rotated at each WELCOME; only a hash of
// the current one is held, and a resume is refused while the session is
// connected.
//
// Across a runtime restart (the review of #255, N3): a token is 256 random
// bits, so its hash is plain SHA-256 and no key need outlive the runtime.
// Each new hash is told to ch-local daemon ({type: 'session-resume',
// session, hash}) BEFORE the token is returned to be sent in a WELCOME, and
// IPC is ordered, so the daemon never holds a hash older than the token a
// shim has. A session's end is told too ({type: 'session-gone', session}).
// A restarted runtime is handed the daemon's rows (_restore): each waits,
// unconnected, for its resume within the reconnect window. The shim
// re-authenticates with the new runtime's secret before it resumes, so a
// hash alone resumes nothing.
const crypto = require('crypto');
const EventEmitter = require('events');

const ASK_TIMEOUT_MS = 12000;
const RECONNECT_WINDOW_MS = 60000;
const SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const clientOf = (frame) => {
  const repo = (typeof(frame.repo) === 'string' && SLUG.test(frame.repo) && !frame.repo.split('/').some((p) => p === '.' || p === '..')) ? frame.repo : null;
  if (frame.status !== 'ok') return {status: 'failed', conditions: 'no', repo: null};
  return {status: 'ok', conditions: frame.conditions === 'yes' ? 'yes' : 'no', repo};
};

class Session extends EventEmitter {
  constructor(registry) {
    super();
    this.id = crypto.randomBytes(16).toString('hex');
    this.client = null;
    this.connected = false;
    this._registry = registry;
    this._conn = null;          // {notify(obj), control(obj)} of the attached connection
    this._tokenHash = null;
    this._asks = new Map();     // seq -> resolve
    this._askSeq = 0;
    this._window = null;
    this._ended = false;
  }

  notify(obj) {
    if (this._conn != null && !this._ended) this._conn.notify(obj);
  }

  askConditions() {
    if (this._conn == null || this._conn.settled !== true || this._ended) return Promise.resolve(null);
    const seq = ++this._askSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._asks.delete(seq); resolve(null); }, this._registry.askTimeoutMs);
      if (typeof(timer.unref) === 'function') timer.unref();
      this._asks.set(seq, (client) => { clearTimeout(timer); resolve(client); });
      this._conn.control({op: 'conditions?', seq});
    });
  }

  record(entry) { if (this._conn != null && !this._ended) this._conn.control({op: 'record', entry}); }
  forget() { if (this._conn != null && !this._ended) this._conn.control({op: 'forget'}); }

  // the listener's side ------------------------------------------------------
  _setClient(frame) {
    const c = clientOf(frame);
    if (this.client == null) this.client = c;
    else Object.assign(this.client, c);
    if (frame.seq !== undefined && this._asks.has(frame.seq)) {
      const resolve = this._asks.get(frame.seq);
      this._asks.delete(frame.seq);
      resolve(Object.assign({}, this.client));
    }
  }

  _attach(conn) {
    clearTimeout(this._window);
    this._window = null;
    this._conn = conn;
    this.connected = true;
  }

  // the attached connection settled: a resumed session is back ('attach'),
  // and only now may B write to it
  _settled() {
    if (this._everSettled === true) this.emit('attach');
    this._everSettled = true;
    this._live = true;
  }

  _detach() {
    if (this._conn == null) return;
    this._conn = null;
    this.connected = false;
    for (const resolve of this._asks.values()) resolve(null);
    this._asks.clear();
    // 'detach' pairs with a settled connection: a resumed one that drops
    // before it settles was never back, so nothing is emitted for it
    const wasLive = this._live === true;
    this._live = false;
    if (wasLive) this.emit('detach');
    this._window = setTimeout(() => this._end(), this._registry.reconnectWindowMs);
    if (typeof(this._window.unref) === 'function') this._window.unref();
  }

  _rotateToken() {
    const token = `rt_${crypto.randomBytes(32).toString('base64url')}`;
    this._tokenHash = hashOf(token);
    return token;
  }

  _end() {
    if (this._ended) return;
    this._ended = true;
    clearTimeout(this._window);
    this._registry._forget(this);
    for (const resolve of this._asks.values()) resolve(null);
    this._asks.clear();
    const conn = this._conn;
    this._conn = null;
    this.connected = false;
    if (conn != null && typeof(conn.close) === 'function') conn.close();
    this.emit('end');
  }
}

class Registry extends EventEmitter {
  // tell: ch-local daemon's unasked messages (lib/control-channel.js tell)
  constructor({askTimeoutMs = ASK_TIMEOUT_MS, reconnectWindowMs = RECONNECT_WINDOW_MS, tell = () => {}} = {}) {
    super();
    this._tell = tell;
    this._wasBusy = false;
    this.askTimeoutMs = askTimeoutMs;
    this.reconnectWindowMs = reconnectWindowMs;
    this._byId = new Map();
    this._byToken = new Map();
  }

  // only settled sessions: one not yet past its first client frame is the
  // listener's, not B's
  get(id) { const s = this._byId.get(id); return (s != null && s._announced === true) ? s : null; }
  all() { return [...this._byId.values()].filter((s) => s._announced === true); }

  // the listener's side ------------------------------------------------------
  _create() {
    const s = new Session(this);
    this._byId.set(s.id, s);
    this._counted();
    return s;
  }

  // ch-local daemon's idle stop: 'busy' when the first session appears,
  // 'idle' when the last is forgotten. A session detached within its window,
  // or restored and not yet resumed, still counts: it may come back.
  idle() { return this._byId.size === 0; }
  _counted() {
    const busy = this._byId.size > 0;
    if (busy === this._wasBusy) return;
    this._wasBusy = busy;
    this._tell({type: busy ? 'busy' : 'idle'});
  }

  // a session opened by a WELCOME but not yet settled is announced at settle
  _announce(s) { this.emit('session', s); }

  // -> the session a token resumes, or null (unknown, used, or connected)
  _resume(token) {
    const s = this._byToken.get(hashOf(token));
    if (s == null || s._ended || s.connected) return null;
    return s;
  }

  // a new token for s; the old one is void
  _issue(s) {
    if (s._tokenHash != null && this._byToken.get(s._tokenHash) === s) this._byToken.delete(s._tokenHash);
    const token = s._rotateToken();
    this._byToken.set(s._tokenHash, s);
    // told first: the daemon's copy is never older than the token sent
    this._tell({type: 'session-resume', session: s.id, hash: s._tokenHash});
    return token;
  }

  // ch-local daemon's rows after a runtime restart: [{session, resume}],
  // validated by lib/session-transport/restore.js. Each waits, unconnected
  // and unannounced, for its resume within the reconnect window.
  _restore(rows) {
    for (const {session, resume} of rows) {
      if (this._byId.has(session) || this._byToken.has(resume)) continue;
      const s = new Session(this);
      s.id = session;
      s._tokenHash = resume;
      this._byId.set(s.id, s);
      this._byToken.set(resume, s);
      s._window = setTimeout(() => s._end(), this.reconnectWindowMs);
      if (typeof(s._window.unref) === 'function') s._window.unref();
    }
    this._counted();
  }

  _count() { return this._byId.size; }

  _forget(s) {
    this._byId.delete(s.id);
    if (s._tokenHash != null && this._byToken.get(s._tokenHash) === s) this._byToken.delete(s._tokenHash);
    this._tell({type: 'session-gone', session: s.id});
    // every forgotten session, a restored one never resumed included (it was
    // never announced, so has no 'end' anyone heard): B2 drops its state
    this.emit('gone', s.id);
    this._counted();
  }

  // every session ends (the runtime is stopping)
  close() { for (const s of [...this._byId.values()]) s._end(); }
}

const createRegistry = (opts) => new Registry(opts);

module.exports = {createRegistry, ASK_TIMEOUT_MS, RECONNECT_WINDOW_MS};
