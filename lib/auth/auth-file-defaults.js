'use strict';
// What decides where auth.json is and whether it is made, in one place, with
// no other loads: the file auth provider (lib/auth/file-provider.js), the
// --hardened parent's check (framework.js) and the child's grant
// (lib/hardened-launch.js) must agree on both (B-meter-keys 4r).
const path = require('path');

// The default auth.json: in the working directory (dir, when given).
function defaultConfigPath(dir = process.cwd()) {
  return path.join(dir, 'auth.json');
}

// COUNTINGHOUSE_API_KEY, when set and not empty: a whole configuration alone,
// so no demo auth.json is made beside it. -> the key, or null.
function envKeyOf() {
  const k = process.env.COUNTINGHOUSE_API_KEY;
  return (k != null && k !== '') ? k : null;
}

// The auth.json the file provider reads, resolved against cwd, or null when
// it reads none: under --debug (auth bypassed), in the single-identity
// profile (its provider is in memory), or with the sqlite or CouchDB
// provider; any other provider value is the file provider (lib/auth). An
// empty --authConfigPath is the default, as the provider takes it.
function fileAuthPathOf(options, cwd = process.cwd()) {
  if (options.debug === true || options.singleIdentity === true) return null;
  if (options.authProvider === 'sqlite' || options.authProvider === 'couchdb') return null;
  const given = options.authConfigPath;
  return (typeof(given) === 'string' && given !== '') ? path.resolve(cwd, given) : defaultConfigPath(cwd);
}

module.exports = {defaultConfigPath, envKeyOf, fileAuthPathOf};
