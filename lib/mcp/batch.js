'use strict';
// A JSON-RPC batch, bounded (the Fable pass over the MCP surface, F3-3).
// Batches are the legacy path's alone: a 2026-07-28 request is sent one per
// POST (lib/routes/mcp.js), and the session socket answers an array as an
// invalid request. HTTP and --stdio still take them, run in series, and
// every answer is kept until the last: with no bound, one 8 MB body of
// ~170,000 list requests (tools/list answers the built-ins with no valid
// key) held gigabytes of answers before the one response was written.
//
// So a batch is refused whole past MAX_BATCH_LENGTH messages, before any of
// it runs; and once its answers pass MAX_BATCH_ANSWER_BYTES (two of the
// lists' largest pages, lib/mcp/pages.js MAX_PAGE_BYTES), no later message
// runs: each request is answered that it did not. The answer that took the
// batch past is kept: its request ran (a call may be billed, or have written
// something), and its answer is bounded on its own. A message the gateway
// never answers (a notification) gets no answer here either.
const gateway = require('./gateway');

const MAX_BATCH_LENGTH = 32;
const MAX_BATCH_ANSWER_BYTES = 8 * 1024 * 1024;
const JSONRPC_INTERNAL_ERROR = -32603;

const idOf = (m) => (m != null && typeof(m) === 'object' && !Array.isArray(m) && (typeof(m.id) === 'string' || typeof(m.id) === 'number') ? m.id : null);

// The refusal of a batch too long to run, or null.
function lengthRefusal(messages) {
  if (!Array.isArray(messages) || messages.length <= MAX_BATCH_LENGTH) return null;
  return gateway.errorResponse(null, gateway.JSONRPC_INVALID_REQUEST,
    `invalid JSON-RPC 2.0 request: a batch of ${messages.length} messages; at most ${MAX_BATCH_LENGTH} are taken (send them in smaller batches, or one at a time)`);
}

// Runs a batch's messages in series, through run(message) -> Promise of its
// answer (null for none), and resolves to the answers in order, null for a
// message that gets none. (Each answer's size is measured with
// JSON.stringify, as it is written: the legacy path's cost, once per answer.)
// maxBytes: tests only.
async function runBatch(messages, run, {maxBytes = MAX_BATCH_ANSWER_BYTES} = {}) {
  const out = [];
  let bytes = 0;
  for (const m of messages) {
    if (bytes > maxBytes) {
      out.push(gateway.isNotification(m) ? null
        : gateway.errorResponse(idOf(m), JSONRPC_INTERNAL_ERROR, `not run: the batch's answers passed ${maxBytes} bytes before it; send it alone`));
      continue;
    }
    const r = await run(m);
    out.push(r == null ? null : r);
    if (r != null) bytes += Buffer.byteLength(JSON.stringify(r));
  }
  return out;
}

module.exports = {MAX_BATCH_LENGTH, MAX_BATCH_ANSWER_BYTES, lengthRefusal, runBatch};
