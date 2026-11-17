'use strict';
// Text a module declares, as it leaves for an MCP client (MCP completeness
// M18, the final security pass): a tool's title and description, a
// prompt's title, description, arguments' descriptions and messages, a
// resource's title and description, a question's dialog. A hidden
// character is one a model reads and a person does not see: countinghouse's
// one class of them, lib/conditions-why.json hiddenClass (the shared
// runtime wire's, and ch-local's lib/clean-text.js's twin). Each becomes a
// space, as lib/schema-safety.js declaredText and ch-local's cleanText do,
// so no two words are joined by what was hidden between them. Cleaned here,
// on the way out, never at load: what a module declares is never refused or
// changed for it, and its own handlers see it as written.
//
// Two exceptions keep an emoji whole: a ZERO WIDTH JOINER between two
// pictographic characters (a skin tone or a VS-16 may come between the
// first and the joiner), and a VARIATION SELECTOR-16 right after one. Any
// other joiner or selector is a space (a keycap, 1 + VS-16 + U+20E3, loses
// its selector: a digit is not pictographic). A subdivision flag keeps its
// tag letters: a run of tags right after a black flag (U+1F3F4) that ends
// in a CANCEL TAG; any other tag is a space.
//
// And a word keeps its spelling: a ZERO WIDTH NON-JOINER or JOINER between
// two letters, in any script (combining marks may come between the first
// letter and the joiner), only shapes them (Persian, Arabic, Indic text)
// and carries nothing hidden, so it is kept. Next to anything else, or at
// an edge, it is a space.
//
//   line(text)      every hidden character a space, \n and \t too
//   message(text)   the same, \n and \t kept (a prompt's message); \r is a
//                   space
//   hasHidden(text) whether line(text) would change it: a value the client
//                   sends back (a completion candidate) is left out for it,
//                   never changed
const {hiddenClass} = require('./conditions-why.json');

const HIDDEN = new RegExp(`[${hiddenClass}]`, 'u');
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SKIN_TONE = /[\u{1f3fb}-\u{1f3ff}]/u;
const ZWJ = '\u200d';
const ZWNJ = '\u200c';
const VS16 = '\ufe0f';
const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;
const BLACK_FLAG = '\u{1f3f4}';
const CANCEL_TAG = '\u{e007f}';
const isTag = (c) => c !== undefined && c.codePointAt(0) >= 0xe0020 && c.codePointAt(0) <= 0xe007e;

const pictographic = (c) => c !== undefined && PICTOGRAPHIC.test(c);
// whether the code point at i ends an emoji: a pictographic character, then
// at most a skin tone or a VS-16
function endsEmoji(points, i) {
  if (i < 0) return false;
  if (pictographic(points[i])) return true;
  if ((SKIN_TONE.test(points[i]) || points[i] === VS16) && pictographic(points[i - 1])) return true;
  return false;
}
const letter = (c) => c !== undefined && LETTER.test(c);
// a visible combining mark (a hidden one, a selector, is no part of a word)
const visibleMark = (c) => c !== undefined && MARK.test(c) && !HIDDEN.test(c);
// whether the joiner at i sits between two letters: a letter before it
// (visible combining marks between allowed) and one right after it
function betweenLetters(points, i) {
  let j = i - 1;
  while (j >= 0 && visibleMark(points[j])) j--;
  return j >= 0 && letter(points[j]) && letter(points[i + 1]);
}
// whether the hidden code point at i is kept: part of an emoji sequence, a
// joiner within a word
function keptInEmoji(points, i) {
  if (points[i] === VS16) return pictographic(points[i - 1]);
  if (points[i] === ZWJ && endsEmoji(points, i - 1) && pictographic(points[i + 1])) return true;
  if (points[i] === ZWJ || points[i] === ZWNJ) return betweenLetters(points, i);
  return false;
}
// the indexes of every subdivision flag's tags: a black flag, a run of tag
// characters, a cancel tag
function flagTags(points) {
  const kept = new Set();
  for (let i = 0; i < points.length; i++) {
    if (points[i] !== BLACK_FLAG) continue;
    let j = i + 1;
    while (isTag(points[j])) j++;
    if (j > i + 1 && points[j] === CANCEL_TAG) for (let k = i + 1; k <= j; k++) kept.add(k);
  }
  return kept;
}

function cleaned(text, keep) {
  const s = String(text);
  if (!HIDDEN.test(s)) return s;
  const points = Array.from(s);
  const flags = flagTags(points);
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (!HIDDEN.test(c) || keep.has(c) || keptInEmoji(points, i) || flags.has(i)) out += c;
    else out += ' ';
  }
  return out;
}

const NOTHING = new Set();
const LINES = new Set(['\n', '\t']);
const line = (text) => cleaned(text, NOTHING);
const message = (text) => cleaned(text, LINES);
const hasHidden = (text) => line(text) !== String(text);

module.exports = {line, message, hasHidden};
