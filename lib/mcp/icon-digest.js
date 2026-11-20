'use strict';
// A listed icon's digest (F3-2), kept beside the icon object, never on it:
// the registry (lib/mcp/tool-registry.js inlineIcons) sets it once per
// listed icon from the digest it took for the kept one; the listen hub's
// fingerprint (lib/mcp/subscriptions.js) reads it in place of the data.
// Nothing about the icon a client or an in-process reader sees changes.
const digests = new WeakMap();

module.exports = {
  set: (icon, digest) => { if (icon !== null && typeof(icon) === 'object') digests.set(icon, digest); },
  get: (icon) => ((icon !== null && typeof(icon) === 'object') ? digests.get(icon) : undefined)
};
