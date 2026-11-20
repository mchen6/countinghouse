'use strict';
// The keys a client reads an error by, in a tool error result's _meta and a
// JSON-RPC error's data alike, and a rate-limit refusal's data. One module,
// so every limiter answers the same shape: the gateway's and the limit on
// keys that don't resolve (lib/unauth-limit.js, which the gateway requires
// and so cannot require the gateway back). #482's high, rounds 2 and 3, and
// its merge with #483.
const ERROR_CODE_META_KEY = 'countinghouse/code';
const ERROR_KIND_META_KEY = 'countinghouse/kind';
// when to retry, in whole seconds: only what a limiter wrote (countinghouse-
// error retryAfterOf), never read from the error's own properties
const RETRY_AFTER_META_KEY = 'countinghouse/retryAfter';

// a rate-limit refusal's data: its code, its kind (the catalogue's row, or
// module for one that left a handler) and, where a limiter wrote one, when
// to retry
function limitData(refusal) {
  const {kindOf, retryAfterOf} = require('../countinghouse-error');
  const data = {[ERROR_CODE_META_KEY]: refusal.code, [ERROR_KIND_META_KEY]: kindOf(refusal)};
  const after = retryAfterOf(refusal);
  if (after !== undefined) data[RETRY_AFTER_META_KEY] = after;
  return data;
}

module.exports = {ERROR_CODE_META_KEY, ERROR_KIND_META_KEY, RETRY_AFTER_META_KEY, limitData};
