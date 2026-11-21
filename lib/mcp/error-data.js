'use strict';
// The keys a client reads an error by, in a tool error result's _meta and a
// JSON-RPC error's data alike, and a rate-limit refusal's data. One module,
// so every limiter answers the same shape: the gateway's and the limit on
// keys that don't resolve (lib/unauth-limit.js, which the gateway requires
// and so cannot require the gateway back). #482's high, rounds 2 and 3, and
// its merge with #483.
const {kindOf, retryAfterOf} = require('../countinghouse-error');

const ERROR_CODE_META_KEY = 'countinghouse/code';
const ERROR_KIND_META_KEY = 'countinghouse/kind';
// when to retry, in whole seconds: only what a limiter wrote (countinghouse-
// error retryAfterOf), never read from the error's own properties
const RETRY_AFTER_META_KEY = 'countinghouse/retryAfter';

// a rate-limit refusal's data: its code, its kind (the catalogue's row, or
// module for one that left a handler) and, where a limiter wrote one, when
// to retry
function limitData(refusal) {
  const data = {[ERROR_CODE_META_KEY]: refusal.code, [ERROR_KIND_META_KEY]: kindOf(refusal)};
  const after = retryAfterOf(refusal);
  if (after !== undefined) data[RETRY_AFTER_META_KEY] = after;
  return data;
}

// The one answer for a limiter's refusal on /mcp (A-rpc429): the limit on
// keys that don't resolve, a key over its budget (tools/list, tasks/*,
// completion) and the runtime at its server-wide limit alike. A JSON-RPC
// error -32000 (a server error: JSON-RPC defines no code for this), the
// catalogue's message, limitData; by the request's id when one was read.
const LIMIT_JSONRPC = -32000;
const LIMIT_CODES = ['UNAUTH_RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'RUNTIME_BUSY'];
function limitAnswer(id, refusal) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: LIMIT_JSONRPC, message: refusal.message, data: limitData(refusal)}};
}
// (a limiter's own answer, by its JSON-RPC code as well as its data's code:
// another answer that merely carries the code -- a resource read's error
// copied from a tool result -- is never sent as a limit)
const isLimitAnswer = (answer) => answer != null && !Array.isArray(answer) && answer.error != null && answer.error.code === LIMIT_JSONRPC &&
  answer.error.data != null && LIMIT_CODES.includes(answer.error.data[ERROR_CODE_META_KEY]);
// Retry-After from a limited answer's own hint (the refusal's, written by its
// limiter: never recomputed apart from what the answer says)
const hintOf = (answer) => answer.error.data[RETRY_AFTER_META_KEY];
// /mcp's single answer: a limit's is sent with its code's catalogue status
// (429; 503 for RUNTIME_BUSY, the runtime's own, as on REST) and Retry-After
// -> whether it was
function answerLimit(res, answer) {
  if (!isLimitAnswer(answer)) return false;
  const after = hintOf(answer);
  if (Number.isInteger(after)) res.set('Retry-After', String(after));
  res.status(require('../error-catalogue').CODES[answer.error.data[ERROR_CODE_META_KEY]].httpStatus).json(answer);
  return true;
}
// a legacy batch's answers, 200 whatever each says: Retry-After when any
// message was a limit's, the longest of their hints
function batchLimit(res, answers) {
  if (!Array.isArray(answers)) return;
  const hints = answers.filter(isLimitAnswer).map(hintOf).filter((h) => Number.isInteger(h));
  if (hints.length > 0) res.set('Retry-After', String(Math.max(...hints)));
}

module.exports = {ERROR_CODE_META_KEY, ERROR_KIND_META_KEY, RETRY_AFTER_META_KEY, limitData, limitAnswer, isLimitAnswer, answerLimit, batchLimit};
