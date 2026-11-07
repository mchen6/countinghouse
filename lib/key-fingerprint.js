// How a log line names a tenant when only its API key is in hand: the first
// 8 hex digits of the key's sha256, labelled, so two tenants can be told
// apart in a log without the key being in it. A user name is better where
// one is available; this is for the places that have only the key.
// Unsalted, like schedulerId today: R2-1's opaque id (a server-secret
// HMAC) replaces both, so the scheme changes here, in one place.
const crypto = require('crypto');

function keyFingerprint(key) {
  if (key == null) return 'no key';
  return `key sha256:${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 8)}`;
}

module.exports = {keyFingerprint};
