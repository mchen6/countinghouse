'use strict';
// The one rule for text a module chose on its way to the operator's log or
// an answer in the runtime's words (the Reviewer's second high review of
// #445, R1): every control character, the line and paragraph separators, and
// the bidi overrides and isolates (U+202A-E, U+2066-9) become a space, so a
// module's text can never forge a log line or reorder what an operator
// reads; cut to max characters. lib/schema-safety.js declaredText is this
// rule, at its own length.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function moduleText(text, max) {
  const s = String(text);
  return (Number.isInteger(max) && max >= 0 ? s.slice(0, max) : s).replace(UNSAFE, ' ');
}

module.exports = {moduleText, UNSAFE};
