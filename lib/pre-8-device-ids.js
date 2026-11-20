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
// module and its two IDs.
const UUID = require('uuid-1345');
const {deviceIDForName} = require('./call-address');

// the derivation before 8.0 -- for this warning only, never an ID in use
function pre8DeviceIDForName(friendlyName) {
  return UUID.v5({namespace: UUID.namespace.url, name: `https://registry.apemesh.com/packages/${friendlyName}`});
}

const said = new Set();   // module names already warned about, this process

// provider: the auth provider (entries, listDevices); names: the friendly
// names of the loaded modules' devices; warn: (line) -> logs it. -> Promise,
// never rejecting: a provider that fails is simply not checked.
function warnPre8Grants(provider, names, warn) {
  const todo = [...new Set(names)].filter((n) => typeof(n) === 'string' && !said.has(n));
  if (provider == null || typeof(provider.entries) !== 'function' || typeof(provider.listDevices) !== 'function' || todo.length === 0) return Promise.resolve();
  const byOld = new Map(todo.map((n) => [pre8DeviceIDForName(n), n]));
  const cb = (fn) => new Promise((resolve) => { try { fn((err, v) => resolve(err != null ? null : v)); } catch (e) { resolve(null); } });
  return cb((done) => provider.entries(done)).then((list) => {
    const keys = Array.isArray(list) ? list.map((e) => (e != null ? e.apiKey : null)).filter((k) => k != null) : [];
    // one key's grants at a time: a start's one pass, not a burst on the provider
    return keys.reduce((p, key) => p.then(() => cb((done) => provider.listDevices(key, done)).then((r) => {
      const devices = (r != null && Array.isArray(r.devices)) ? r.devices : [];
      for (const d of devices) {
        const name = byOld.get(d);
        if (name == null || said.has(name)) continue;
        said.add(name);
        warn(`grant for ${name} names its pre-8.0 device ID ${d}; the new one is ${deviceIDForName(name)}: regenerate the grant (a '*' grant needs nothing)`);
      }
    })), Promise.resolve());
  }).then(() => undefined, () => undefined);
}

module.exports = {warnPre8Grants, pre8DeviceIDForName};
