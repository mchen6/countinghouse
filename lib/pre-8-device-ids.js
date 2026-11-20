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
let last = null;   // {provider, names, warn}: what a reload checks again

// provider: the auth provider (grantedDeviceIDs: every device ID a grant
// names, one call, no key: the file and sqlite providers; another provider
// is not checked); names: the friendly names of the loaded modules'
// devices; warn: (line) -> logs it. -> Promise, never rejecting.
function warnPre8Grants(provider, names, warn) {
  last = {provider, warn, names: new Set([...(last != null ? last.names : []), ...names.filter((n) => typeof(n) === 'string')])};
  const todo = [...new Set(names)].filter((n) => typeof(n) === 'string' && !checked.has(n));
  if (provider == null || typeof(provider.grantedDeviceIDs) !== 'function' || todo.length === 0) return Promise.resolve();
  for (const n of todo) checked.add(n);
  return new Promise((resolve) => {
    try { provider.grantedDeviceIDs((err, ids) => resolve(err != null ? null : ids)); } catch (e) { resolve(null); }
  }).then((ids) => {
    const granted = new Set(Array.isArray(ids) ? ids : []);
    for (const name of todo) {
      const old = pre8DeviceIDForName(name);
      if (!granted.has(old) || said.has(name)) continue;
      said.add(name);
      warn(`grant for ${name} names its pre-8.0 device ID ${old}; the new one is ${deviceIDForName(name)}: regenerate the grant (a '*' grant needs nothing)`);
    }
  }, () => undefined);
}

// The auth configuration re-read (lib/auth reloadAuth): every module loaded
// so far is checked again against the grants as they are now.
function regranted() {
  if (last == null) return Promise.resolve();
  checked = new Set();
  said = new Set();
  return warnPre8Grants(last.provider, [...last.names], last.warn);
}

module.exports = {warnPre8Grants, regranted, pre8DeviceIDForName};
