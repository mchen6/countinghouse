'use strict';
// REMOVE AFTER RELEASE 1 (registered: B-apemesh's follow-up). The one place
// the pre-8.0 device-ID derivation may still appear.
//
// Before 8.0 a device's ID was a UUID v5 of a registry URL of another
// project's under the URL namespace; 8.0 derives it in countinghouse's own
// namespace (lib/call-address.js deviceIDForName), so every ID changed. An
// auth file or provider whose grants list specific device IDs, written
// before, no longer matches: those grants are refused until regenerated
// ('*' grants are unaffected). This says so, once per module per process,
// when a grant names a loaded module's pre-8.0 ID: never a key, only the
// module and its two IDs. It asks the provider once for the device IDs its
// grants name (grantedDeviceIDs), never for a key.
const UUID = require('uuid-1345');
const {deviceIDForName} = require('./call-address');

// the derivation before 8.0 -- for this warning only, never an ID in use
function pre8DeviceIDForName(friendlyName) {
  return UUID.v5({namespace: UUID.namespace.url, name: `https://registry.apemesh.com/packages/${friendlyName}`});
}

// names checked against the grants as they are now, and named in a warning:
// each module once, until the auth configuration is reloaded (regranted)
let checked = new Set();
let said = new Set();
let last = null;   // {provider, loaded, warn}: what a reload checks again

// provider: the auth provider (grantedDeviceIDs: every device ID a grant
// names, one call, no key: the file and sqlite providers; another provider
// is not checked); loaded: () -> the friendly names of the devices loaded
// now (asked again by a reload); warn: (line) -> logs it. -> Promise, never
// rejecting. A name is marked checked only once the provider has answered:
// a failed ask is made again by the next pass.
function warnPre8Grants(provider, loaded, warn) {
  last = {provider, loaded, warn};
  let names;
  try { names = loaded(); } catch (e) { names = []; }
  const todo = [...new Set(Array.isArray(names) ? names : [])].filter((n) => typeof(n) === 'string' && !checked.has(n));
  if (provider == null || typeof(provider.grantedDeviceIDs) !== 'function' || todo.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    try { provider.grantedDeviceIDs((err, ids) => resolve(err != null || !Array.isArray(ids) ? null : ids)); } catch (e) { resolve(null); }
  }).then((ids) => {
    if (ids == null) return;   // no answer: nothing marked, asked again next time
    const granted = new Set(ids);
    for (const name of todo) {
      checked.add(name);
      const old = pre8DeviceIDForName(name);
      if (!granted.has(old) || said.has(name)) continue;
      said.add(name);
      warn(`grant for ${name} names its pre-8.0 device ID ${old}; the new one is ${deviceIDForName(name)}: regenerate the grant (a '*' grant needs nothing)`);
    }
  }).catch(() => undefined);
}

// The auth configuration re-read (lib/auth reloadAuth): the modules loaded
// now are checked again against the grants as they are now.
function regranted() {
  if (last == null) return Promise.resolve();
  checked = new Set();
  said = new Set();
  return warnPre8Grants(last.provider, last.loaded, last.warn);
}

// a test's: back to nothing checked, nothing said, nothing to check again
function resetForTests() {
  checked = new Set();
  said = new Set();
  last = null;
}

module.exports = {warnPre8Grants, regranted, resetForTests, pre8DeviceIDForName};
