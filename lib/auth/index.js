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
  if (instance == null) instance = createAuthProvider();
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

// The provider's failures are said once per outage, its first with the
// error itself, and when it answers again how many failed meanwhile; never a
// stack per request. The caller answers SYSTEM_ERROR_USERDB_NA in the
// catalogue's words: the provider's text can name a database's host or port
// (the high review of #445, 6).
// One outage per kind of lookup (authenticate, listDevices, resolve): one
// that keeps failing while another answers is still said once, never on
// every request (the medium on #445's high round, 1).
const outages = new Map();
function providerFailed(err, what = 'authenticate') {
  if (!outages.has(what)) {
    outages.set(what, {failed: 0});
    try { require('../logger').E(err); } catch (logErr) { /* still answered */ }
  }
  outages.get(what).failed++;
}
function providerAnswered(what = 'authenticate') {
  const outage = outages.get(what);
  if (outage == null) return;
  outages.delete(what);
  const n = outage.failed;
  try { require('../logger').W(`the auth provider answers again (${what}): ${n} lookup${n === 1 ? '' : 's'} failed meanwhile`); } catch (logErr) { /* no logger */ }
}

module.exports = {
  providerFailed:    providerFailed,
  providerAnswered:  providerAnswered,
  identitySource:    identitySource,
  getAuthProvider:   getAuthProvider,
  createAuthProvider: createAuthProvider,
  AuthProvider:      require('./provider')
};
