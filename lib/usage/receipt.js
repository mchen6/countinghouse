'use strict';
// The end of a tools/call on a listed module (local-mode spec §5, as amended
// by the reviewer, 2026-11-11). The gateway hands over the MCP result it built:
//   - the Out record counts the module's own text content (every text block
//     of the result as built), never the receipt sentence;
//   - a scenario's successful result gains _meta['countinghouse/receipt'] =
//     {calls, linesIn, bytesIn, linesOut, bytesOut, servers}, beside
//     countinghouse/code, and the sentence as a second text block after the
//     module's text. structuredContent is never touched: it is the module's
//     validated output, and a client that checks it against the closed output
//     schema must keep passing;
//   - receiptReserved(data) is true for an output with a top-level
//     `receipt` field. The gateway refuses it RECEIPT_RESERVED only for a
//     scenario's tool, where the runtime adds its own receipt; any other
//     module's `receipt` field passes through untouched (reviewer,
//     2026-11-12: a payments module's receipt is ordinary).
const {countText} = require('./index');
const {decodedLength} = require('../binary-fields');

// required on first use, then kept (lib/require-once.js): no require() on the call path
const requireOnce = require('../require-once');
const noticesLib = requireOnce(() => require('../notices'));
const {RESULT_KIND} = require('../countinghouse-error');

const RECEIPT_META_KEY = 'countinghouse/receipt';

function receiptReserved(data) {
  const output = data != null && typeof data === 'object' ? data.output : null;
  return output != null && typeof output === 'object' && !Array.isArray(output) && Object.prototype.hasOwnProperty.call(output, 'receipt');
}

// -> the result to send: the same object, with the receipt added for a
// scenario's success. `call` null (counting unavailable): unchanged.
// The notices of pack changes (lib/notices.js) for this tool's module, each
// once, after the receipt: in a shared runtime, the calling session's only.
function withNoticesOf(result, module, session) {
  const said = noticesLib().take(module, session);
  if (said.length === 0) return result;
  result.content = [...(Array.isArray(result.content) ? result.content : []), ...said.map((t) => ({type: 'text', text: t}))];
  return result;
}

// takeNotices false: a task's completion (lib/usage/task.js), whose result is
// kept for its receipt only, never sent: the notices stay for a result that is.
// outcome: the Out record's outcome when the caller knows better than the
// result (M19: 'cancelled', one record, whatever the result was)
// A result's Out record fields -- what it sent (text bytes and lines,
// inline and linked bytes), its outcome, an error's code and whose fault --
// the one reading of a result for its record (finishToolCall; a task's
// pass recorded at a stop, lib/usage/task.js outcomeOf).
function outFieldsOf(result) {
  const text = (Array.isArray(result.content) ? result.content : []).filter((c) => c != null && c.type === 'text').map((c) => c.text).join('\n');
  const {bytes, lines} = countText(text);
  // an image or audio block's decoded bytes (M4) and an inline resource
  // block's (M6): what entered the model's context beside the text; a
  // resource link's size is what stayed behind it (M6)
  const blocks = Array.isArray(result.content) ? result.content : [];
  const inlineBytes = blocks
    .filter((c) => c != null && (c.type === 'image' || c.type === 'audio') && typeof(c.data) === 'string')
    .reduce((n, c) => n + decodedLength(c.data), 0) +
    blocks.filter((c) => c != null && c.type === 'resource' && c.resource != null && typeof(c.resource.blob) === 'string')
      .reduce((n, c) => n + decodedLength(c.resource.blob), 0);
  const linkedBytes = blocks.filter((c) => c != null && c.type === 'resource_link' && Number.isInteger(c.size) && c.size > 0)
    .reduce((n, c) => n + c.size, 0);
  const failed = result.isError === true;
  // an error's code, for the report's errors by code (recordOut keeps it only
  // when it reads as a code)
  const code = failed && result._meta != null ? result._meta['countinghouse/code'] : undefined;
  // whose fault, when a module said it is the caller's (toolCallResult's mark)
  const kind = failed && result[RESULT_KIND] === 'caller' ? 'caller' : undefined;
  return {bytes, lines, inlineBytes, linkedBytes, outcome: failed ? 'error' : 'ok', code, kind};
}

function finishToolCall({usage, call, result, role, tool, module = null, session = null, takeNotices = true, startedMs, now = Date.now, outcome = undefined}) {
  const withNotices = takeNotices ? withNoticesOf : (r) => r;
  if (call == null || usage == null) return withNotices(result, module, session);
  const fields = outFieldsOf(result);
  const failed = fields.outcome === 'error';
  const receipt = usage.recordOut(call, Object.assign({tool, ms: Math.max(0, now() - startedMs)}, fields, outcome != null ? {outcome} : {}));
  if (role !== 'scenario' || failed) return withNotices(result, module, session);
  result._meta = {...(result._meta || {}), [RECEIPT_META_KEY]: receipt};
  result.content = [...(Array.isArray(result.content) ? result.content : []), {type: 'text', text: usage.receiptSentenceOf(call)}];
  return withNotices(result, module, session);
}

module.exports = {finishToolCall, outFieldsOf, receiptReserved, RECEIPT_META_KEY};
