'use strict';
// The opaque per-user id (R2-1, spec section 1): the same for a user across
// every module on this server, and nothing a module can turn back into a
// key or a name.
//
//   id = "u_" + base64url(HMAC-SHA256(secret, source)), 22 characters
//
// The source is the auth entry's optional stable `id` field when it has one
// ("id:" + field), else the API key ("key:" + apiKey): domain-separated, so
// an `id` equal to some other user's key never yields that user's id. With
// a stable id, rotating the key keeps the user's id (and so their per-user
// module data and schedulers); without one, the id changes with the key.
//
// The secret is 32 random bytes, kept as 64 hex characters in
// <moduleDataPath>/.identity-secret (<storePath>/ in the LM1 single-identity
// profile; mode 0600, never read through a link or under a second name,
// published whole and never over another's: lib/private-file.js) or supplied as COUNTINGHOUSE_IDENTITY_SECRET in the
// same form. It is generated only when neither exists; both present and
// different is refused, since silently preferring one would change every
// id. Changing the secret changes every id.
//
// The index (id -> {apiKey, userName, isAdmin}; userName null for an entry
// without one, never the key) is built from the auth provider's entries
// before the server listens and on every reload, and it never leaves the
// main thread: a worker gets no secret and no index, and every call here
// throws there. lookup() is synchronous, for the billing hot path; resolve()
// is the operator's form, which on a miss asks the provider once more (an
// id set in sqlite or CouchDB after the last reload), throttled.
const crypto = require('crypto');
const privateFile = require('./private-file');
const path   = require('path');
// lib/thread-info.js, not worker_threads: in a lean worker this file loads on
// first use (CHUtil.recordUsage), after the lockdown refuses worker_threads
const {isMainThread} = require('./thread-info');
const {CountinghouseError} = require('./countinghouse-error');
const log = require('./lazy-require').lazy('./logger');

const SECRET_FILE   = '.identity-secret';
const SECRET_FORM   = /^[0-9a-f]{64}$/;
const ID_LENGTH     = 22;
const REFILL_MIN_MS = 5000;

let secret = null;            // Buffer, once init has run
let index  = new Map();       // id -> {apiKey, userName, isAdmin}
let byKey  = new Map();       // apiKey -> id
// keys no provider lists, made known for this process (addKey: --debugKey
// from framework.js, --debug's keys from know()): kept across a rebuild,
// which otherwise drops them; at most REMEMBERED_MAX, the one added longest
// ago out first (--debug only, loopback: its owner then reads as unknown)
const remembered = new Map();   // id -> {apiKey, userName, isAdmin}
const REMEMBERED_MAX = 1024;
// What an owner remembered without a provider, and lost since, is said as
// (a job's final refusal; a peer channel's close): never the key. One text,
// for every place that says it (#518's high, L3).
const OWNER_LOST_WITHOUT_PROVIDER = 'its key is no longer known to this process: it was remembered without a listing provider (--debug), ' +
  `and the process restarted since, or remembered more than ${REMEMBERED_MAX} keys`;
// Rebuilds, by the order their provider reads started: a result older than
// one already applied is dropped (a slow reload's never drops a key a newer
// refill added: #518's high, M1)
let startedGen = 0;
let appliedGen = 0;
// The refill a miss waits for (freshRefill): one at a time, at most one per
// REFILL_MIN_MS, its provider read started after the miss
let queuedRefill = null;      // {provider, run}: the one waiting to start
let refillChain = Promise.resolve();
let lastRefillStart = 0;
// (the clock refills are throttled by: a test's, injected through
// stateForTests().setClock, never a real wait)
let clock = {now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms)};
// a refill's provider read that has not answered by then is refused (the
// caller retries), and the refills after it go on: a provider that hangs
// never stalls every later miss (the medium on #518's high round)
const REFILL_DEADLINE_MS = 10000;

function mainOnly() {
  if (!isMainThread) throw new Error('identity: the identity service runs on the main thread only');
}

function refuse(message) {
  return Object.assign(new Error(message), {code: 'IDENTITY_SECRET_INVALID'});
}

// Loads the secret, or creates it. Throws (startup refuses, exit 2) on a
// secret in the wrong form, a file readable by others or reached through a
// link, or a file and a variable that differ. Messages never hold a secret.
// The file's checks, its writing and the --hardened parent's check are
// lib/private-file.js's, shared with lib/server-id.js.
// The directory the secret lives in: lib/private-file.js ownDir (<storePath>
// in the single-identity profile, else <moduleDataPath>).
const secretDir = (options) => privateFile.ownDir(options);
const CHECKED_VARIABLE = 'COUNTINGHOUSE_IDENTITY_ACL_CHECKED';
const SPEC = {what: 'the identity secret', form: SECRET_FORM, formText: '64 hex characters (32 bytes)', variable: CHECKED_VARIABLE, refuse};

function initSync(options) {
  mainOnly();
  const dir = secretDir(options);
  const file = path.join(dir, SECRET_FILE);
  const fromEnv = process.env.COUNTINGHOUSE_IDENTITY_SECRET;
  const fromFile = privateFile.readChecked(file, SPEC);
  if (fromEnv != null) {
    if (!SECRET_FORM.test(fromEnv)) throw refuse('COUNTINGHOUSE_IDENTITY_SECRET must be 64 hex characters (32 bytes)');
    if (fromFile != null && fromFile !== fromEnv) {
      throw refuse(`COUNTINGHOUSE_IDENTITY_SECRET and ${file} hold different secrets; keep one of them ` +
        '(changing the identity secret changes every user id)');
    }
    secret = Buffer.from(fromEnv, 'hex');
    return;
  }
  if (fromFile != null) {
    secret = Buffer.from(fromFile, 'hex');
    return;
  }
  // First start: generated here and published whole, never over a file
  // already there (lib/private-file.js createPrivate). The secret
  // lives under the data directory, so a server without a usable one has no
  // identity and does not start (it used to fail each module load instead).
  if (process.platform === 'win32' && process.permission != null) throw privateFile.refuseAbsentUnderHardened(file, SPEC);
  secret = Buffer.from(createSecretFile(dir, file, options), 'hex');
}

// Writes a new secret to dir/.identity-secret. -> the secret, as hex: the
// one written, or, when another start wrote one first, that one, checked.
function createSecretFile(dir, file, options) {
  const generated = crypto.randomBytes(32).toString('hex');
  if (privateFile.createPrivate(dir, file, generated, SPEC, privateFile.flagOf(dir, options))) return generated;
  return privateFile.readChecked(file, SPEC, {settle: true});
}

// --hardened on Windows (the review of #197; lib/private-file.js
// prepareForHardened): the parent, before it relaunches, creates the secret
// if there is none (and no COUNTINGHOUSE_IDENTITY_SECRET: then no file is
// made), checks it as initSync does, and hands on the file's identity in
// COUNTINGHOUSE_IDENTITY_ACL_CHECKED.
// hooks.afterOpen: a test's, between the open and the check.
function prepareForHardened(options, hooks = {}) {
  if (process.platform !== 'win32') return;
  const dir = secretDir(options);
  const file = path.join(dir, SECRET_FILE);
  privateFile.prepareForHardened(file, SPEC, {
    create: () => {
      if (process.env.COUNTINGHOUSE_IDENTITY_SECRET != null) return false;   // the variable's secret; no file is made
      createSecretFile(dir, file, options);
      return true;
    },
    check: () => {
      const saved = secret;
      try { initSync(options); } finally { secret = saved; }
    }
  }, hooks);
}

function init(options) {
  try {
    initSync(options);
    return Promise.resolve();
  } catch (e) {
    return Promise.reject(e);
  }
}

function ready() {
  return secret != null;
}

// A key for one use of the runtime's own, derived from the secret with
// HKDF-SHA256 under that use's label (lib/request-state.js: a requestState's
// MAC key). 32 bytes; the same in every process that shares the secret, so
// what one signs another verifies, and a restart changes nothing. Never the
// secret, and never the key ids are made with: a derived key that leaked
// would say nothing of either. Main thread only, as the secret is.
const derived = new Map();    // label -> Buffer, of the secret they were derived from
// The derivation itself, pure: a secret (Buffer) and a label -> 32 bytes.
// derivedKey's, and what a test uses to work out a key from a server's
// secret file (test/helpers/job-queue.js), so the two cannot drift.
function deriveFrom(secretBytes, label) {
  return Buffer.from(crypto.hkdfSync('sha256', secretBytes, Buffer.alloc(0), label, 32));
}
let derivedFrom = null;
function derivedKey(label) {
  mainOnly();
  if (typeof(label) !== 'string' || label.length === 0 || label.length > 128) throw new Error('identity: a derived key has a label of 1 to 128 characters');
  if (secret == null) throw new Error('identity: not initialized');
  // a secret loaded again (initSync, or the --hardened parent's check) is
  // another Buffer: nothing derived from the one before is handed out
  if (derivedFrom !== secret) { derived.clear(); derivedFrom = secret; }
  let key = derived.get(label);
  if (key == null) {
    key = deriveFrom(secret, label);
    derived.set(label, key);
  }
  // the caller's own copy: one that wipes its key after use changes no other's
  return Buffer.from(key);
}

// entry: the auth entry ({id?}) or null; apiKey: its key.
function idFor(entry, apiKey) {
  mainOnly();
  if (secret == null) throw new Error('identity: not initialized');
  const stable = (entry != null && entry.id != null) ? String(entry.id) : null;
  const source = (stable != null) ? `id:${stable}` : `key:${String(apiKey)}`;
  return `u_${crypto.createHmac('sha256', secret).update(source, 'utf8').digest('base64url').slice(0, ID_LENGTH)}`;
}

// The id for a key as this server knows it: from the index when the key has
// an entry (so a stable `id` counts), else from the key alone.
function idForKey(apiKey) {
  mainOnly();
  if (secret == null || apiKey == null) return null;
  const known = byKey.get(String(apiKey));
  return (known != null) ? known : idFor(null, apiKey);
}

// Rebuilds the index from provider.entries(cb(err, [{apiKey, userName,
// isAdmin, id?}])). A provider without entries() leaves the index empty.
function rebuild(provider) {
  mainOnly();
  return new Promise((resolve, reject) => {
    if (provider == null || typeof(provider.entries) !== 'function') return resolve();
    const gen = ++startedGen;
    provider.entries((err, list) => {
      if (err) return reject(err);
      // (a read started before one already applied: stale, dropped)
      if (gen < appliedGen) return resolve();
      const nextIndex = new Map();
      const nextByKey = new Map();
      const positionOf = new Map();
      let clash = null;
      (list || []).forEach((e, i) => {
        if (e == null || e.apiKey == null || clash != null) return;
        const id = idFor(e, e.apiKey);
        // Two entries yielding one id (a stable id the provider let through
        // twice, or a key equal to another's): refused, naming positions.
        if (positionOf.has(id)) { clash = `entries ${positionOf.get(id)} and ${i + 1} yield the same id; every id must be unique`; return; }
        positionOf.set(id, i + 1);
        // A name is never stood in for by the key: an entry without one is null.
        nextIndex.set(id, {apiKey: String(e.apiKey), userName: e.userName != null ? String(e.userName) : null, isAdmin: e.isAdmin === true});
        nextByKey.set(String(e.apiKey), id);
      });
      if (clash != null) return reject(Object.assign(new Error(clash), {code: 'AUTH_CONFIG_INVALID'}));
      // (a key remembered for this process stays: its id still resolves, so
      // a job stored under it is never orphaned, even once a provider lists
      // the key under another id -- the key itself then maps to the
      // provider's; the medium on #518's high round)
      for (const [id, e] of remembered) {
        if (!nextIndex.has(id)) nextIndex.set(id, e);
        if (!nextByKey.has(e.apiKey)) nextByKey.set(e.apiKey, id);
      }
      index = nextIndex;
      byKey = nextByKey;
      appliedGen = gen;
      return resolve();
    });
  });
}

// --debug: the debug key is a user like any other, without a provider (and
// know()'s keys a provider doesn't list, where that is allowed).
function addKey(apiKey, userName, isAdmin) {
  mainOnly();
  const id = idFor(null, apiKey);
  const e = {apiKey: String(apiKey), userName: userName, isAdmin: isAdmin === true};
  index.set(id, e);
  byKey.set(String(apiKey), id);
  remembered.delete(id);
  remembered.set(id, e);
  if (remembered.size > REMEMBERED_MAX) {
    const [oldest, old] = remembered.entries().next().value;
    remembered.delete(oldest);
    if (index.get(oldest) === old) { index.delete(oldest); byKey.delete(old.apiKey); }
  }
  return id;
}

// Makes a key known to the index before anything is stored by its id (a
// job's owner, B-meter-keys (2)), so the key is found again from the id
// before every run, and nothing stores the key itself. -> Promise of its id.
// - in the index: its id;
// - a miss: a refill from the provider (a sqlite or CouchDB user added
//   since the last reload, with its stable id), freshRefill's: shared with
//   every other miss, at most one provider read per REFILL_MIN_MS (so a
//   first add can wait up to that long), bounded by REFILL_DEADLINE_MS; a
//   refill that fails or times out rejects;
// - still missing with a provider (one that authenticated a key it doesn't
//   list: a lagging view): rejects -- never a key-based id that a later
//   refill, listing the key with a stable id, would orphan; the caller
//   refuses, retryably;
// - with no provider, or one without entries() (--debug), or when the
//   caller says a key the provider doesn't list is still a user
//   (rememberUnlisted: --debug's single-identity profile, which accepts
//   every key): remembered for this process (addKey). Such an owner is not
//   known after a restart, nor once REMEMBERED_MAX others came since
//   (OWNER_LOST_WITHOUT_PROVIDER).
// The refill is freshRefill's: never a miss answered without the provider
// asked (#518's high, M1). providerOf: () -> the provider (lib/auth
// identitySource), asked only on a miss.
function know(apiKey, providerOf, {rememberUnlisted = false} = {}) {
  mainOnly();
  if (secret == null || apiKey == null) return Promise.resolve(null);
  const key = String(apiKey);
  if (byKey.has(key)) {
    const id = byKey.get(key);
    // (a remembered key used again is the newest: its owner lasts longest)
    if (remembered.has(id)) { const e = remembered.get(id); remembered.delete(id); remembered.set(id, e); }
    return Promise.resolve(id);
  }
  const settle = () => (byKey.has(key) ? byKey.get(key) : addKey(key, null, false));
  const provider = (typeof(providerOf) === 'function') ? providerOf() : providerOf;
  if (provider == null || typeof(provider.entries) !== 'function') return Promise.resolve(settle());
  return freshRefill(provider).then(() => {
    if (byKey.has(key)) return byKey.get(key);
    if (rememberUnlisted) return settle();
    return Promise.reject(Object.assign(new Error('the provider does not list the key'), {code: 'IDENTITY_NOT_LISTED'}));
  });
}

// The index's generation: it changes each time a rebuild is applied (the
// door's memo of keys the listing didn't show: user-auth.js)
function generation() { return appliedGen; }

// Whether an authenticated key needs know() before its id is read: false
// when the index holds it, and wherever no index is kept (not initialized, or
// a worker, which has none). Synchronous: user-auth's door asks on every
// request (the final pass's gateway part, A2).
function isIndexed(apiKey) {
  if (!isMainThread || secret == null || apiKey == null) return true;
  return byKey.has(String(apiKey));
}

// A refill whose provider read starts after this call: the one queued, if
// one is waiting to start, else a new one, after the one running and at
// least REFILL_MIN_MS after the last start (a removed owner's schedulers
// cost one provider read per interval, never one each). -> Promise, after it
// is applied; rejects with the provider's error.
function freshRefill(provider) {
  mainOnly();
  // (the one waiting to start, of this provider: a different provider's is
  // never answered for this one)
  if (queuedRefill != null && queuedRefill.provider === provider) return queuedRefill.run;
  const entry = {provider, run: null};
  entry.run = refillChain.then(() => new Promise((resolve) => clock.setTimeout(resolve, Math.max(0, lastRefillStart + REFILL_MIN_MS - clock.now()))))
    .then(() => {
      if (queuedRefill === entry) queuedRefill = null;
      lastRefillStart = clock.now();
      return new Promise((resolve, reject) => {
        const t = clock.setTimeout(() => reject(Object.assign(new Error(`the auth provider did not list its entries within ${REFILL_DEADLINE_MS} ms`), {code: 'IDENTITY_REFILL_TIMEOUT'})), REFILL_DEADLINE_MS);
        rebuild(provider).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      });
    });
  queuedRefill = entry;
  refillChain = entry.run.catch(() => {});
  return entry.run;
}

function lookup(id) {
  mainOnly();
  const e = index.get(id);
  return (e != null) ? {apiKey: e.apiKey, userName: e.userName, isAdmin: e.isAdmin} : null;
}

// The caller as a module's ctx shows it (R2-1 Task 5, spec section 2):
// {id, isAdmin}, built on the main thread from a key, never the key or a
// user name. isAdmin: the session's flag when the caller has one, else the
// index's for the key.
function callerOf(apiKey, isAdmin) {
  if (apiKey == null || secret == null) return {id: null, isAdmin: false};
  const id = idForKey(apiKey);
  const known = (isAdmin === undefined) ? lookup(id) : null;
  return {id: id, isAdmin: (isAdmin !== undefined) ? isAdmin === true : (known != null && known.isAdmin === true)};
}

// The operator's lookup: a miss asks the provider again (at most once per
// REFILL_MIN_MS), then answers from the index.
function resolve(id, provider, callback) {
  mainOnly();
  const found = lookup(id);
  if (found != null || provider == null) return callback(null, found);
  // (freshRefill's: a read after this miss, one throttle with every other
  // miss's -- the medium on #518's high round)
  // (a provider failure is lib/auth's guarded SYSTEM_ERROR_USERDB_NA; the
  // index's own refusal, two entries with one id, goes to the log, and the
  // caller is answered the same)
  freshRefill(provider).then(() => callback(null, lookup(id)), (e) => {
    if (e instanceof CountinghouseError && e.code === 'SYSTEM_ERROR_USERDB_NA') return callback(e);
    try { log().E(e); } catch (logErr) { /* still answered */ }
    return callback(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'));
  });
}

// Tests only (test/helpers/identity-scope.js): the whole state, kept to be
// put back, so a test file that sets an identity leaves the process as it
// found it. -> {restore(), forget()}: never the secret or a key itself
// (this file loads in workers too, where module code reaches its exports).
function stateForTests() {
  const kept = {secret, index: new Map(index), byKey: new Map(byKey), remembered: new Map(remembered), clock};
  return {
    restore: () => {
      secret = kept.secret;
      index = new Map(kept.index);
      byKey = new Map(kept.byKey);
      remembered.clear();
      for (const [k, v] of kept.remembered) remembered.set(k, v);
      clock = kept.clock;
      // (no refill left pending applies over the state put back)
      queuedRefill = null;
      refillChain = Promise.resolve();
      lastRefillStart = 0;
      startedGen += 1;
      appliedGen = startedGen;
    },
    // a test's clock for the refill throttle: {now(), setTimeout(fn, ms)}
    setClock: (c) => { clock = c; },
    // the index emptied, the secret kept (an owner leaving it mid-run)
    forget: () => { index = new Map(); byKey = new Map(); remembered.clear(); }
  };
}

module.exports = {init, initSync, ready, idFor, idForKey, derivedKey, deriveFrom, rebuild, addKey, know, isIndexed, generation, freshRefill, lookup, resolve, callerOf, prepareForHardened, SECRET_FILE,
  REMEMBERED_MAX, OWNER_LOST_WITHOUT_PROVIDER, stateForTests};
