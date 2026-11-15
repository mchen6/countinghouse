'use strict';
// What the runtime does with one client line from an M frame (design section
// 1, "The runtime never runs a call the shim didn't number"). The shim's
// parser and JSON.parse may disagree about a line at the edges, so these
// rules hold whatever the shim did:
// - the line is decoded as UTF-8 fatally, never replacing bytes; invalid
//   UTF-8 is a parse error and nothing runs;
// - a line JSON.parse refuses is a parse error, as stdio answers today;
// - an object with an `id` member (a request, whatever its method) runs only
//   if it came with a seq; without one it gets -32600 carrying its id, and
//   never runs, so no call runs without the seq a crash answer needs;
// - a batch likewise runs only with a seq;
// - a response (an `id` and no `method`) is ignored: the runtime sends the
//   client no requests;
// - a notification (no `id`) runs, and is never answered.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const error = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

// line: Buffer; header: the M header ({seq}) or null
// -> {dispatch: true, message} | {dispatch: false, answer: object | null}
function classify(line, header) {
  let text;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(line);
  } catch (e) {
    return {dispatch: false, answer: error(null, PARSE_ERROR, 'parse error: the line is not UTF-8')};
  }
  if (text.trim() === '') return {dispatch: false, answer: null};
  let message;
  try {
    message = JSON.parse(text);
  } catch (e) {
    return {dispatch: false, answer: error(null, PARSE_ERROR, 'parse error: the line is not JSON')};
  }
  const seq = header != null ? header.seq : undefined;
  if (Array.isArray(message)) {
    if (seq === undefined) return {dispatch: false, answer: error(null, INVALID_REQUEST, 'the line was not framed as a request')};
    return {dispatch: true, message, seq};
  }
  if (message == null || typeof(message) !== 'object') {
    return {dispatch: false, answer: error(null, INVALID_REQUEST, 'invalid JSON-RPC 2.0 request')};
  }
  if (has(message, 'id')) {
    if (!has(message, 'method')) return {dispatch: false, answer: null};
    if (seq === undefined) return {dispatch: false, answer: error(message.id, INVALID_REQUEST, 'the line was not framed as a request')};
    return {dispatch: true, message, seq};
  }
  return {dispatch: true, message, seq};
}

module.exports = {classify};
