'use strict';
// The keys a client reads an error by, in a tool error result's _meta and a
// JSON-RPC error's data alike, and a rate-limit refusal's data. One module,
// so every limiter answers the same shape: the gateway's and the limit on
// keys that don't resolve (lib/unauth-limit.js, which the gateway requires
// and so cannot require the gateway back). #482's high, rounds 2 and 3, and
// its merge with #483.
const {kindOf, retryAfterOf} = require('../countinghouse-error');
const {CODES} = require('../error-catalogue');

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
// keys that don't resolve, a key over its budget (the lists, tasks/*,
// prompts/get, completion, resources/read), a key or session with as many
// subscriptions open as it may have (TOO_MANY_SUBSCRIPTIONS) and the
// runtime at its limit (a module resource's read at --globalRateLimit:
// RUNTIME_BUSY, 503; every subscription it may hold open: SUBSCRIPTIONS_FULL,
// 503) alike.
// tools/call answers both as a tool error result, as the catalogue says. A JSON-RPC
// error -32000 (a server error: JSON-RPC defines no code for this), the
// catalogue's message, limitData; by the request's id when one was read.
const LIMIT_JSONRPC = -32000;
// (and a local usage ledger that can't be used, LEDGER_CORRUPT and
// LEDGER_UNREADABLE: a per-key gate's refusal too, with its catalogue status
// (500 and 503), never HTTP 200; R-store-aside-locked)
const LIMIT_CODES = ['UNAUTH_RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_SUBSCRIPTIONS', 'SUBSCRIPTIONS_FULL', 'RUNTIME_BUSY', 'LEDGER_CORRUPT', 'LEDGER_UNREADABLE', 'LEDGER_UNREACHABLE', 'LEDGER_UNWRITABLE', 'LEDGER_RECORD_INVALID'];
function limitAnswer(id, refusal) {
  return limitAnswerOf(id, refusal.message, limitData(refusal));
}
// the same from a refusal already said as data (a tool result's _meta: a
// module resource's read refused by the call path's limiters)
function limitAnswerOf(id, message, data) {
  return {jsonrpc: '2.0', id: (id === undefined ? null : id), error: {code: LIMIT_JSONRPC, message, data}};
}
// whether error data is a limiter's own refusal: a limit's code, with the
// kind its catalogue row gives it (caller for a key's or an address's
// limit, runtime for the runtime's), so a module, whose code that left a
// handler is kind module (#482's handler boundary), never answers as the
// limit (#494's high, 2)
const isLimitData = (data) => data != null && LIMIT_CODES.includes(data[ERROR_CODE_META_KEY]) &&
  data[ERROR_KIND_META_KEY] === CODES[data[ERROR_CODE_META_KEY]].kind;
// (a limiter's own answer, by its JSON-RPC code as well as its data's code:
// another answer that merely carries the code -- a resource read's error
// copied from a tool result -- is never sent as a limit)
const isLimitAnswer = (answer) => answer != null && !Array.isArray(answer) && answer.error != null && answer.error.code === LIMIT_JSONRPC &&
  answer.error.data != null && LIMIT_CODES.includes(answer.error.data[ERROR_CODE_META_KEY]);
// Retry-After from a limited answer's own hint (the refusal's, written by its
// limiter: never recomputed apart from what the answer says)
const hintOf = (answer) => answer.error.data[RETRY_AFTER_META_KEY];
// /mcp's single answer: a limit's is sent with its code's catalogue status
// (429; 503 for RUNTIME_BUSY and SUBSCRIPTIONS_FULL, the runtime's own, as on
// REST) and Retry-After
// -> whether it was
function answerLimit(res, answer) {
  if (!isLimitAnswer(answer)) return false;
  const after = hintOf(answer);
  if (Number.isInteger(after)) res.set('Retry-After', String(after));
  res.status(CODES[answer.error.data[ERROR_CODE_META_KEY]].httpStatus).json(answer);
  return true;
}
// a legacy batch's answers, 200 whatever each says: Retry-After when any
// message was a limit's, the longest of their hints
function batchLimit(res, answers) {
  if (!Array.isArray(answers)) return;
  const hints = answers.filter(isLimitAnswer).map(hintOf).filter((h) => Number.isInteger(h));
  if (hints.length > 0) res.set('Retry-After', String(Math.max(...hints)));
}

module.exports = {ERROR_CODE_META_KEY, ERROR_KIND_META_KEY, RETRY_AFTER_META_KEY, limitData, limitAnswer, limitAnswerOf, isLimitData, isLimitAnswer, answerLimit, batchLimit};
