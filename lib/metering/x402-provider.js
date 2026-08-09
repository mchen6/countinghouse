// x402 (HTTP 402 Payment Required + on-chain USDC micropayment) exit, as a
// proof-of-concept MeteringProvider implementation. NOT a working payment
// integration -- this exists to prove the interface can host a
// fundamentally different settlement model (pay-per-call, on-chain) next to
// the prepaid-balance Redis model, per the plan doc's explicit "first
// version: interface + Redis impl + one x402 PoC export, don't build it out
// further" scope. There is no facilitator integration, no on-chain payment
// verification, and no real `cost` -> USDC conversion here.
var util = require('util');
var MeteringProvider = require('./provider');

function X402PaymentRequiredError(details) {
  Error.call(this);
  this.name    = 'X402PaymentRequiredError';
  this.message = 'HTTP 402 Payment Required';
  this.details = details;
}
util.inherits(X402PaymentRequiredError, Error);

function X402MeteringProvider(opts) {
  MeteringProvider.call(this);
  opts = opts || {};
  this.payToAddress = opts.payToAddress || null; // wallet address to receive USDC
  this.network       = opts.network || 'base-sepolia';
}

util.inherits(X402MeteringProvider, MeteringProvider);

// PoC only: x402 has no prepaid-balance concept (every call is its own
// micropayment), so there's nothing meaningful to report as a balance.
X402MeteringProvider.prototype.checkBalance = function(apiKey, callback) {
  return callback(null, {apiKey: apiKey, balance: null, model: 'pay-per-call'});
};

// A real implementation would inspect the incoming request for x402 payment
// proof (e.g. a signed payment header) and, if present and valid, verify it
// on-chain or via a facilitator before allowing the call through -- only
// then would this resolve successfully. This PoC always signals that
// payment is required and returns the challenge shape (amount/currency/
// network/payTo) a caller would need to satisfy; it never actually verifies
// or accepts a payment.
X402MeteringProvider.prototype.recordCall = function(apiKey, tool, cost, callback) {
  return callback(new X402PaymentRequiredError({
    tool:     tool,
    amount:   cost,
    currency: 'USDC',
    network:  this.network,
    payTo:    this.payToAddress
  }));
};

// x402's economic model is itself a rate limiter of sorts (every call has a
// direct cost), so this PoC doesn't layer an additional limit on top.
X402MeteringProvider.prototype.rateLimit = function(apiKey, callback) {
  return callback(null, {limited: false});
};

module.exports = {
  X402MeteringProvider:    X402MeteringProvider,
  X402PaymentRequiredError: X402PaymentRequiredError
};
