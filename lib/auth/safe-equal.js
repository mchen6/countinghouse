// Compares two secrets in constant time for equal lengths, so an API key or
// --debugKey cannot be recovered from response timing (review R1-5). The
// length itself is not hidden. Only strings match; null never equals null.
const crypto = require('crypto');

function safeEqual(a, b) {
  if (typeof(a) !== 'string' || typeof(b) !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = {safeEqual};
