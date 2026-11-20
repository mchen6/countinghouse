'use strict';
// Selects and constructs the configured AuthProvider (see provider.js),
// analogous to how lib/countinghouse-interface.js constructs a
// MeteringProvider -- except AuthProvider genuinely has multiple
// switchable backends (--authProvider file|sqlite|couchdb), where
// MeteringProvider today only ever has one (Redis) wired up. Only ever
// called on the main thread -- every doUserAuth call site
// (lib/user-auth.js) runs there (HTTP/MCP routes, PeerChannelBroker,
// and the two direct-invocation call sites are both main-thread-only by
// construction), so this doesn't need worker-thread plumbing.
const options = require('../cli-options');
const {CountinghouseError} = require('../countinghouse-error');
const AuthProvider = require('./provider');

let instance = null;

function createAuthProvider() {
  // the single-identity profile: one key, in memory (LM1 spec section 4)
  if (options.singleIdentity === true) {
    const MemoryAuthProvider = require('./memory-provider');
    return new MemoryAuthProvider({apiKey: options.apiKey});
  }
  switch (options.authProvider) {
    case 'sqlite': {
      const SqliteAuthProvider = require('./sqlite-provider');
      return new SqliteAuthProvider({dbPath: options.authConfigPath});
    }
    case 'couchdb': {
      const CouchDBAuthProvider = require('../couchdb-adapter/couchdb-auth-provider');
      return new CouchDBAuthProvider({dbUrl: options.dbUrl});
    }
    case 'file':
    default: {
      const FileAuthProvider = require('./file-provider');
      return new FileAuthProvider({configPath: options.authConfigPath});
    }
  }
}

// Constructed lazily and cached (not at require() time): options.authProvider
// isn't populated until cli-options.js's setOptions() runs, which happens
// after this module is first required in most startup orderings.
function getAuthProvider() {
  if (instance == null) instance = guarded(createAuthProvider());
  return instance;
}

// The provider whose entries the identity index is built from: the auth
// provider, except under --debug (auth bypassed), where only the
// single-identity profile's one entry is indexed, so its caller id never
// follows the key. null for --debug outside the profile.
function identitySource(o) {
  const opts = o || options;
  if (opts.debug !== true) return getAuthProvider();
  return (opts.singleIdentity === true) ? getAuthProvider() : null;
}

// The provider, wrapped once (the Reviewer's second high review of #445,
// R2): every lookup that reaches it (authenticate, listDevices,
// identityForModule, entries) has its failure said once per outage and kind
// of lookup, the first with the error itself, and when the provider itself
// answers that kind again how many failed meanwhile; never a stack per
// request. The caller is answered SYSTEM_ERROR_USERDB_NA in the catalogue's
// words: the provider's text can name a database's host or port (the high
// review of #445, 6). The base class's identityForModule (no composition)
// is left as it is: device-manager tells it apart by identity.
// An outage keeps the reasons it has said, up to REASONS_MAX, so a cause
// that differs from every one said is said too (a kind seldom asked,
// entries or identityForModule, never hides a later cause), and one said
// before is never said again; past the bound, they are counted. It closes,
// "answers again", only after QUIET_MS with no failure of its kind, so a
// provider that flaps is not opened and closed on every request (the
// Reviewer's high review of #445, 2).
const LOOKUPS = new Set(['authenticate', 'listDevices', 'identityForModule', 'entries']);
const REASONS_MAX = 8;
const QUIET_MS = 10000;
const outages = new Map();
let clock = Date.now;
// a reason as text: an Error's message (from any realm) or a thrown string,
// and "(no message)" for anything else. Never an object's JSON nor a
// function's source: a driver's object can carry its credentials (the
// Reviewer's high review of #448, 6).
// (an object's own code, when it reads as one, keeps two causes apart: the
// medium on #448's second round, 6)
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
function reasonOf(err) {
  let text = null;
  let code = null;
  try {
    if (typeof(err) === 'string') text = err;
    else if (err != null && typeof(err) === 'object') {
      if (typeof(err.message) === 'string') text = err.message;
      const own = Object.getOwnPropertyDescriptor(err, 'code');
      if (own != null && typeof(own.value) === 'string' && REASON_CODE.test(own.value)) code = own.value;
    }
  } catch (e) { text = null; }
  if (text != null && text !== '') return text;
  return code != null ? `(no message; ${code})` : '(no message)';
}
function providerFailed(err, what) {
  let outage = outages.get(what);
  // one answered since its last failure, and quiet since, ended then: said
  // so, and this failure starts a new one (a kind seldom asked never keeps
  // an outage open for good: the medium on the fold, 1)
  if (outage != null && outage.answeredSince && clock() - outage.lastFailedAt >= QUIET_MS) {
    closeOutage(what, outage);
    outage = null;
  }
  if (outage == null) { outage = {failed: 0, said: new Set(), unsaid: 0, lastFailedAt: 0, answeredSince: false}; outages.set(what, outage); }
  outage.failed++;
  outage.lastFailedAt = clock();
  outage.answeredSince = false;
  const reason = reasonOf(err);
  if (outage.said.has(reason)) return;
  if (outage.said.size >= REASONS_MAX) { outage.unsaid++; return; }
  outage.said.add(reason);
  try { require('../logger').E(err instanceof Error ? err : new Error(`the auth provider failed (${what}): ${reason}`)); } catch (logErr) { /* still answered */ }
}
function providerAnswered(what) {
  const outage = outages.get(what);
  if (outage == null) return;
  outage.answeredSince = true;
  if (clock() - outage.lastFailedAt < QUIET_MS) return;
  closeOutage(what, outage);
}
function closeOutage(what, outage) {
  outages.delete(what);
  const n = outage.failed;
  const more = outage.unsaid > 0 ? `; ${outage.unsaid} with reasons past the first ${REASONS_MAX}, not said` : '';
  try { require('../logger').W(`the auth provider answers again (${what}): ${n} lookup${n === 1 ? '' : 's'} failed meanwhile${more}`); } catch (logErr) { /* no logger */ }
}
// (tests: no outage open, and the clock they give)
function resetOutagesForTests({now = Date.now} = {}) { outages.clear(); clock = now; }

const WRAPPERS = new WeakSet();
// the provider's failure as the caller is answered: the catalogue's text,
// the provider's own error as the cause, never serialised (the operator's
// start-up line says it, framework.js; no answer does)
function unavailable(err, what) {
  providerFailed(err, what);
  const na = new CountinghouseError('SYSTEM_ERROR_USERDB_NA');
  Object.defineProperty(na, 'cause', {value: err, enumerable: false, writable: true, configurable: true});
  return na;
}
function guardedLookup(provider, what, fn) {
  const wrapper = function(...args) {
    const callback = args[args.length - 1];
    // every lookup answers through its callback: a call without one is the
    // caller's bug, refused at once and never handed to the provider (the
    // final high review of #445, 4); no provider outage is counted for it
    // (its medium, 3)
    if (typeof(callback) !== 'function') throw new TypeError(`the auth provider's ${what} takes a callback`);
    // answered once, whatever the provider does: one that throws after
    // starting its work, or answers twice, is not answered again (the
    // medium on #445's final round, 2 and 8)
    let answered = false;
    const answerFailed = (err) => {
      if (answered) return undefined;
      answered = true;
      return callback(unavailable(err, what));
    };
    args[args.length - 1] = (err, ...rest) => {
      // (as the sites it replaced tested it, the final high review of #445, 5)
      if (err) return answerFailed(err);
      if (answered) return undefined;
      answered = true;
      providerAnswered(what);
      return callback(null, ...rest);
    };
    let returned;
    try {
      returned = fn.apply(provider, args);
    } catch (thrown) {
      // a provider that throws before answering is a failure like any other;
      // one thrown after it answered (the caller's own callback, say) is not
      // the provider's to convert
      if (answered) throw thrown;
      return answerFailed(thrown);
    }
    // a provider written as an async function: its rejection is a failure
    // too, never an unhandled one (the medium on #445's final round, 5)
    if (returned != null && typeof(returned.then) === 'function') {
      returned.then(undefined, (rejected) => { answerFailed(rejected); });
    }
    return returned;
  };
  WRAPPERS.add(wrapper);
  return wrapper;
}
// provider -> the same provider, its lookups guarded; a method set on it
// later (a test's stand-in), or patched on its class, is guarded as it is
// read. A Proxy (#445), not accessors on the instance: those broke a
// provider's own accessor or non-configurable lookup, and a delete took the
// guard off for good (the Reviewer's high review of #448, 7). (A provider
// whose own method calls another lookup through `this` reaches its target,
// unguarded: no built-in backend does.)
function guarded(provider) {
  if (provider == null) return provider;
  // a Proxy must hand back a non-writable, non-configurable property as it
  // is, so a frozen lookup can't be guarded: refused here, with its reason,
  // never a throw on every read (the medium on #448's second round, 1). No
  // built-in backend freezes its lookups.
  for (const what of LOOKUPS) {
    const d = Object.getOwnPropertyDescriptor(provider, what);
    if (d != null && d.configurable === false && d.writable === false) {
      throw new TypeError(`the auth provider's ${what} is frozen, so the runtime cannot guard it: leave its lookups writable or configurable`);
    }
  }
  const made = new WeakMap();   // the provider's function -> its wrapper
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const fn = Reflect.get(target, prop, receiver);
      if (!LOOKUPS.has(prop) || typeof(fn) !== 'function' || WRAPPERS.has(fn)) return fn;
      if (prop === 'identityForModule' && fn === AuthProvider.prototype.identityForModule) return fn;
      if (!made.has(fn)) made.set(fn, guardedLookup(target, prop, fn));
      return made.get(fn);
    }
  });
}

// The auth config re-read without a restart (POST /reload-auth,
// countinghouse_reload_auth: one path, #458's high review, 6), and what
// follows it: the grant sets tools/call is answered by are read again
// (tool-registry forgetGrants) and the id index follows the configuration
// (lib/identity.js). callback(err, the provider's result); err is the
// provider's refusal or the index's failure, for the caller to name.
function reloadAuth(callback) {
  const provider = getAuthProvider();
  provider.reload((err, result) => {
    if (err != null) return callback(err);
    require('../mcp/tool-registry').forgetGrants();
    // (a grant still naming a pre-8.0 device ID, said again: removed after
    // release 1, lib/pre-8-device-ids.js)
    require('../pre-8-device-ids').regranted();
    // (the callback runs outside the promise chain, as the settings and the
    // usage report's do: a throw in it is not turned into an unhandled
    // rejection)
    return require('../identity').rebuild(provider).then(() => process.nextTick(callback, null, result), (e) => process.nextTick(callback, e));
  });
}

module.exports = {
  reloadAuth:        reloadAuth,
  guarded:           guarded,
  reasonOf:          reasonOf,
  resetOutagesForTests: resetOutagesForTests,
  identitySource:    identitySource,
  getAuthProvider:   getAuthProvider,
  createAuthProvider: createAuthProvider,
  AuthProvider:      AuthProvider
};
