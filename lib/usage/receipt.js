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
//   - receiptReserved(data) is true for a module output with a top-level
//     `receipt` field, which the gateway refuses RECEIPT_RESERVED: the name is
//     the runtime's.
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
  const receipt = usage.recordOut(call, {tool, bytes, lines, ms: Math.max(0, now() - startedMs), outcome: failed ? 'error' : 'ok'});
  if (role !== 'scenario' || failed) return result;
  result._meta = {...(result._meta || {}), [RECEIPT_META_KEY]: receipt};
  result.content = [...result.content, {type: 'text', text: usage.receiptSentenceOf(call)}];
  return result;
}

module.exports = {finishToolCall, receiptReserved, RECEIPT_META_KEY};
