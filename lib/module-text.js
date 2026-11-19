'use strict';
// The one rule for text a module chose on its way to the operator's log or
// an answer in the runtime's words (the Reviewer's second high review of
// #445, R1): every character of the repo's one hidden-character class
// (lib/conditions-why.json hiddenClass, which client-text applies too: the
// controls, the line and paragraph separators, the bidi controls, the
// zero-width and filler characters, the soft hyphen, the variation
// selectors, the tag characters, a lone surrogate) becomes a space, so a
// module's text can never forge a log line, hide text or reorder what an
// operator or a model reads (the final high review of #445, 1); cut to max
// characters. lib/schema-safety.js declaredText is this rule, at its own
// length.
const {hiddenClass} = require('./conditions-why.json');
const UNSAFE = new RegExp(`[${hiddenClass}]`, 'gu');

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
