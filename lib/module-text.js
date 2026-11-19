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

// s cut to max characters, never leaving half a surrogate pair at the cut
// (the medium on #445's second round, 7)
function cutAt(s, max) {
  if (!Number.isInteger(max) || max < 0 || s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff) ? cut.slice(0, -1) : cut;
}

function moduleText(text, max) {
  return cutAt(String(text), max).replace(UNSAFE, ' ');
}

// One plain line: the rule, runs of spaces made one, trimmed, cut, and
// trimmed again after the cut (a notice, a refused ask's reason)
function moduleLine(text, max) {
  const flat = String(text == null ? '' : text).replace(UNSAFE, ' ').replace(/ {2,}/g, ' ').trim();
  return cutAt(flat, max).trimEnd();
}

module.exports = {moduleText, moduleLine, UNSAFE};
