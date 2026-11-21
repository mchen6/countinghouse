'use strict';
// What decides where auth.json is and whether it is made, in one place, with
// no other loads: the file auth provider (lib/auth/file-provider.js), the
// --hardened parent's create and check (framework.js), the child's grant
// (lib/hardened-launch.js) and the broker's protected lists
// (lib/fs-broker) must agree on both (B-meter-keys 4r).
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

// The auth store's file --authConfigPath names, resolved against cwd, else
// its provider's default: auth.sqlite3 for the sqlite store, auth.json for
// the file provider (lib/cli-options.js refuses a value that is not one
// path). What the broker protects (lib/fs-broker) is the file that holds the
// keys, whichever store it is.
function authConfigPathOf(options, cwd = process.cwd()) {
  const given = options.authConfigPath;
  if (typeof(given) === 'string' && given !== '') return path.resolve(cwd, given);
  return (options.authProvider === 'sqlite') ? path.join(cwd, 'auth.sqlite3') : defaultConfigPath(cwd);
}

// The auth.json the file provider reads, resolved against cwd, or null when
// it reads none: under --debug (auth bypassed), in the single-identity
// profile (its provider is in memory), or with the sqlite or CouchDB
// provider; any other provider value is the file provider (lib/auth). An
// empty --authConfigPath is the default, as the provider takes it.
function fileAuthPathOf(options, cwd = process.cwd()) {
  if (options.debug === true || options.singleIdentity === true) return null;
  if (options.authProvider === 'sqlite' || options.authProvider === 'couchdb') return null;
  return authConfigPathOf(options, cwd);
}

module.exports = {defaultConfigPath, envKeyOf, authConfigPathOf, fileAuthPathOf};
