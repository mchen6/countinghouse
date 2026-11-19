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
// A failure with a reason other than the last one said is said too, so an
// outage left open (a kind seldom asked, entries or identityForModule) never
// hides a later, different cause (the medium on #445's second round, 2).
const LOOKUPS = new Set(['authenticate', 'listDevices', 'identityForModule', 'entries']);
const outages = new Map();
const reasonOf = (err) => { try { return String(err && err.message); } catch (e) { return ''; } };
function providerFailed(err, what) {
  let outage = outages.get(what);
  if (outage == null) { outage = {failed: 0, said: null}; outages.set(what, outage); }
  const reason = reasonOf(err);
  if (outage.said !== reason) {
    outage.said = reason;
    try { require('../logger').E(err); } catch (logErr) { /* still answered */ }
  }
  outage.failed++;
}
function providerAnswered(what) {
  const outage = outages.get(what);
  if (outage == null) return;
  outages.delete(what);
  const n = outage.failed;
  try { require('../logger').W(`the auth provider answers again (${what}): ${n} lookup${n === 1 ? '' : 's'} failed meanwhile`); } catch (logErr) { /* no logger */ }
}

const WRAPPERS = new WeakSet();
function guardedLookup(provider, what, fn) {
  const wrapper = function(...args) {
    const callback = args[args.length - 1];
    if (typeof(callback) !== 'function') return fn.apply(provider, args);
    args[args.length - 1] = (err, ...rest) => {
      if (err != null) {
        providerFailed(err, what);
        // the provider's own error as the cause, never serialised: the
        // operator's start-up line says it (framework.js), no answer does
        const na = new CountinghouseError('SYSTEM_ERROR_USERDB_NA');
        Object.defineProperty(na, 'cause', {value: err, enumerable: false, writable: true, configurable: true});
        return callback(na);
      }
      providerAnswered(what);
      return callback(null, ...rest);
    };
    return fn.apply(provider, args);
  };
  WRAPPERS.add(wrapper);
  return wrapper;
}
// provider -> the same provider, its lookups guarded; a method set on it
// later (a test's stand-in) is guarded as it is read
function guarded(provider) {
  if (provider == null) return provider;
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

module.exports = {
  guarded:           guarded,
  identitySource:    identitySource,
  getAuthProvider:   getAuthProvider,
  createAuthProvider: createAuthProvider,
  AuthProvider:      AuthProvider
};
