'use strict';
// The one rule for text a module chose on its way to the operator's log or
// an answer in the runtime's words (the Reviewer's second high review of
// #445, R1): every control character, the line and paragraph separators, and
// the bidi overrides, isolates and marks (U+202A-E, U+2066-9, U+200E/F,
// U+061C) become a space, so a
// module's text can never forge a log line or reorder what an operator
// reads; cut to max characters. lib/schema-safety.js declaredText is this
// rule, at its own length.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

// (cut, then no half of a surrogate pair left at the cut: the medium on
// #445's second round, 7)
function moduleText(text, max) {
  const s = String(text);
  let cut = (Number.isInteger(max) && max >= 0) ? s.slice(0, max) : s;
  if (cut.length > 0 && cut.length < s.length) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  return cut.replace(UNSAFE, ' ');
}

module.exports = {moduleText, UNSAFE};
