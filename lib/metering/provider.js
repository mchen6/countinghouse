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

// deviceID/serviceID/actionName can't contain this exact sequence in
// practice (deviceIDs are UUIDs, serviceIDs are URNs using single/double
// colons, actionNames are plain identifiers), so it's a safe, reversible
// delimiter for encoding the legacy three-part lookup key into the single
// opaque `tool` string the MeteringProvider interface expects.
const LEGACY_TOOL_DELIMITER = ':::';

function encodeLegacyTool(deviceID, serviceID, actionName) {
  return deviceID + LEGACY_TOOL_DELIMITER + serviceID + LEGACY_TOOL_DELIMITER + actionName;
}

function decodeLegacyTool(tool) {
  const parts = String(tool).split(LEGACY_TOOL_DELIMITER);
  if (parts.length !== 3) return null;
  return {deviceID: parts[0], serviceID: parts[1], actionName: parts[2]};
}

// Statics, so every backend (and anything naming a billable action) shares
// one encoding without loading a backend.
MeteringProvider.encodeLegacyTool = encodeLegacyTool;
MeteringProvider.decodeLegacyTool = decodeLegacyTool;

// What a module is told about a hop's charge (its platformMetering, R2-1
// Task 5, the review of #163): the tool, the charge, the balance and any
// free calls left, never the key a provider's answer carries. Applied on the
// main thread before the answer leaves for a worker; null stays null.
function forModule(result) {
  if (result == null || typeof(result) !== 'object') return null;
  const out = {};
  for (const k of ['tool', 'charged', 'balance', 'remainingFreeCalls']) if (result[k] !== undefined) out[k] = result[k];
  return out;
}

module.exports = MeteringProvider;
module.exports.forModule = forModule;
