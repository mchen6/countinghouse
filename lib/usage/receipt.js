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

const RECEIPT_META_KEY = 'countinghouse/receipt';

function receiptReserved(data) {
  const output = data != null && typeof data === 'object' ? data.output : null;
  return output != null && typeof output === 'object' && !Array.isArray(output) && Object.prototype.hasOwnProperty.call(output, 'receipt');
}

// -> the result to send: the same object, with the receipt added for a
// scenario's success. `call` null (counting unavailable): unchanged.
function finishToolCall({usage, call, result, role, tool, startedMs, now = Date.now}) {
  if (call == null || usage == null) return result;
  const text = (Array.isArray(result.content) ? result.content : []).filter((c) => c != null && c.type === 'text').map((c) => c.text).join('\n');
  const {bytes, lines} = countText(text);
  const failed = result.isError === true;
  // an error's code, for the report's errors by code (recordOut keeps it only
  // when it reads as a code)
  const code = failed && result._meta != null ? result._meta['countinghouse/code'] : undefined;
  const receipt = usage.recordOut(call, {tool, bytes, lines, ms: Math.max(0, now() - startedMs), outcome: failed ? 'error' : 'ok', code});
  if (role !== 'scenario' || failed) return result;
  result._meta = {...(result._meta || {}), [RECEIPT_META_KEY]: receipt};
  result.content = [...(Array.isArray(result.content) ? result.content : []), {type: 'text', text: usage.receiptSentenceOf(call)}];
  return result;
}

module.exports = {finishToolCall, receiptReserved, RECEIPT_META_KEY};
