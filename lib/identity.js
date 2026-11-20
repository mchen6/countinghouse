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
// profile; mode 0600, never read through a link,
// written atomically) or supplied as COUNTINGHOUSE_IDENTITY_SECRET in the
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
let lastRefillAt = 0;

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
  // First start: generated here, written whole under a temporary name and
  // renamed into place, so no reader ever sees a partial file. The secret
  // lives under the data directory, so a server without a usable one has no
  // identity and does not start (it used to fail each module load instead).
  if (process.platform === 'win32' && process.permission != null) throw privateFile.refuseAbsentUnderHardened(file, SPEC);
  secret = Buffer.from(createSecretFile(dir, file, options), 'hex');
}

// Writes a new secret to dir/.identity-secret. -> the secret, as hex.
function createSecretFile(dir, file, options) {
  const generated = crypto.randomBytes(32).toString('hex');
  privateFile.createPrivate(dir, file, generated, SPEC, privateFile.flagOf(dir, options));
  return generated;
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
    provider.entries((err, list) => {
      if (err) return reject(err);
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
      index = nextIndex;
      byKey = nextByKey;
      return resolve();
    });
  });
}

// --debug: the debug key is a user like any other, without a provider.
function addKey(apiKey, userName, isAdmin) {
  mainOnly();
  const id = idFor(null, apiKey);
  index.set(id, {apiKey: String(apiKey), userName: userName, isAdmin: isAdmin === true});
  byKey.set(String(apiKey), id);
  return id;
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
  if (found != null || provider == null || Date.now() - lastRefillAt < REFILL_MIN_MS) return callback(null, found);
  lastRefillAt = Date.now();
  // (a provider failure is lib/auth's guarded SYSTEM_ERROR_USERDB_NA; the
  // index's own refusal, two entries with one id, goes to the log, and the
  // caller is answered the same)
  rebuild(provider).then(() => callback(null, lookup(id)), (e) => {
    if (e instanceof CountinghouseError && e.code === 'SYSTEM_ERROR_USERDB_NA') return callback(e);
    try { log().E(e); } catch (logErr) { /* still answered */ }
    return callback(new CountinghouseError('SYSTEM_ERROR_USERDB_NA'));
  });
}

module.exports = {init, initSync, ready, idFor, idForKey, derivedKey, deriveFrom, rebuild, addKey, lookup, resolve, callerOf, prepareForHardened, SECRET_FILE};
