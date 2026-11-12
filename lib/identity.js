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
// <moduleDataPath>/.identity-secret (mode 0600, never read through a link,
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
const fs     = require('fs');
const path   = require('path');
const {isMainThread} = require('worker_threads');

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
// The directory the secret lives in: <storePath> under --store local (the
// launcher's home, outside every module's namespace; LM1 spec section 4),
// else <moduleDataPath>.
function secretDir(options) {
  return (options.store === 'local' && options.storePath != null) ? options.storePath : options.moduleDataPath;
}

function initSync(options) {
  mainOnly();
  const dir = secretDir(options);
  const file = path.join(dir, SECRET_FILE);
  const fromEnv = process.env.COUNTINGHOUSE_IDENTITY_SECRET;
  let fromFile = null;
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw refuse(`${file}: ${e.message}`);
  }
  if (st != null) {
    if (st.isSymbolicLink()) throw refuse(`${file} is a symbolic link; the identity secret is never read through a link`);
    if (!st.isFile()) throw refuse(`${file} is not a regular file`);
    if ((st.mode & 0o077) !== 0) {
      throw refuse(`${file} is accessible by group or others (mode ${(st.mode & 0o777).toString(8)}); it must be 0600`);
    }
    fromFile = fs.readFileSync(file, 'utf8').trim();
    if (!SECRET_FORM.test(fromFile)) throw refuse(`${file} must hold the identity secret as 64 hex characters (32 bytes)`);
  }
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
  const generated = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    fs.writeFileSync(tmp, generated, {mode: 0o600, flag: 'wx'});
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* never written */ }
    const flag = (dir === options.moduleDataPath) ? '--moduleDataPath' : '--storePath';
    throw refuse(`${flag} ${dir} cannot be created or is not writable: set it to a writable directory (${e.code || e.message})`);
  }
  secret = Buffer.from(generated, 'hex');
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

// The operator's lookup: a miss asks the provider again (at most once per
// REFILL_MIN_MS), then answers from the index.
function resolve(id, provider, callback) {
  mainOnly();
  const found = lookup(id);
  if (found != null || provider == null || Date.now() - lastRefillAt < REFILL_MIN_MS) return callback(null, found);
  lastRefillAt = Date.now();
  rebuild(provider).then(() => callback(null, lookup(id)), (e) => callback(e));
}

module.exports = {init, initSync, ready, idFor, idForKey, rebuild, addKey, lookup, resolve, SECRET_FILE};
