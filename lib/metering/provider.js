// MeteringProvider: the interface every metering/billing backend implements.
// Originally extracted from metering logic that lived inline in
// lib/session.js (Session.prototype.updateRedisUserRecord, since retired --
// see docs/design-decisions.md's AuthProvider section) and
// lib/user-auth.js's old balance/priceRecord lookup -- see redis-provider.js
// for the built-in implementation.
function MeteringProvider() {}

// Records that `tool` was called on behalf of `apiKey` at cost `cost`
// (platform-defined units -- the existing Redis implementation treats this
// as a balance decrement), and applies it (deduct balance, decrement a
// free-call count, etc. depending on the backend). `callback(err, result)`;
// `result` is backend-specific but should at least include `charged` (the
// amount actually deducted, which may be 0 if a free-call allowance
// covered it) and the caller's resulting `balance` where that concept
// applies.
MeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  throw new Error('MeteringProvider.recordCall must be implemented by a subclass');
};

// Returns the current balance/standing for `apiKey`. `callback(err, result)`;
// `result` includes at least `apiKey` and `balance` (which may be `null`
// for backends, like pay-per-call models, where a running balance isn't a
// meaningful concept).
MeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  throw new Error('MeteringProvider.checkBalance must be implemented by a subclass');
};

// Checks whether `apiKey` is currently within its allowed call rate.
// `callback(err, result)`; `result` includes at least `limited` (boolean).
MeteringProvider.prototype.rateLimit = function(apiKey, callback) {
  throw new Error('MeteringProvider.rateLimit must be implemented by a subclass');
};

module.exports = MeteringProvider;
