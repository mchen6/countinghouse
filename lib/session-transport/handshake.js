'use strict';
// The session handshake's secret and MACs (design section 1, contract 2).
// Each side proves the secret, which is never sent:
//   ms = HMAC-SHA256(secret, "ch-server" || p || nc || ns)   (PROVE)
//   mc = HMAC-SHA256(secret, "ch-client" || p || ns || nc)   (AUTH)
// p is HELLO's protocol as one byte; nc and ns are 32 random bytes each. A
// token is compared by HMAC-SHA256(secret, "ch-token" || its UTF-8), never
// sent; so is a pack credential, by HMAC-SHA256(secret, "ch-cred" || its
// variable's name || 0x00 || its value's UTF-8).
//
// The secret file holds exactly 64 lowercase hex characters, optionally
// followed by one newline: 32 random bytes, new at each runtime start.
const crypto = require('crypto');

const SECRET_BYTES = 32;
const CHALLENGE_BYTES = 32;

const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const protocolByte = (p) => Buffer.from([p & 0xff]);

const serverMac = (secret, protocol, nc, ns) => hmac(secret, 'ch-server', protocolByte(protocol), nc, ns);
const clientMac = (secret, protocol, ns, nc) => hmac(secret, 'ch-client', protocolByte(protocol), ns, nc);
const tokenMac = (secret, token) => hmac(secret, 'ch-token', Buffer.from(String(token), 'utf8'));
const credentialMac = (secret, name, value) => hmac(secret, 'ch-cred', Buffer.from(String(name), 'utf8'), Buffer.from([0]), Buffer.from(String(value), 'utf8'));

// constant time; a different length is unequal
function macEquals(a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const SECRET_FORM = /^[0-9a-f]{64}\n?$/;
// the file's text -> the 32 bytes, or null for anything but the form
function parseSecret(text) {
  if (typeof(text) !== 'string' || !SECRET_FORM.test(text)) return null;
  return Buffer.from(text.slice(0, 64), 'hex');
}
const formatSecret = (secret) => `${Buffer.from(secret).toString('hex')}\n`;
const newSecret = () => crypto.randomBytes(SECRET_BYTES);
const newChallenge = () => crypto.randomBytes(CHALLENGE_BYTES);

// a base64 field of a handshake frame -> exactly `bytes` bytes, or null
function bytesOf(b64, bytes) {
  if (typeof(b64) !== 'string' || b64.length > 128) return null;
  const buf = Buffer.from(b64, 'base64');
  return (buf.length === bytes && buf.toString('base64') === b64) ? buf : null;
}

module.exports = {serverMac, clientMac, tokenMac, credentialMac, macEquals, parseSecret, formatSecret, newSecret, newChallenge, bytesOf, SECRET_BYTES, CHALLENGE_BYTES};
