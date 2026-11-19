'use strict';
// The one rule for text a module chose, wherever it goes: the operator's
// log, an answer in the runtime's words, a notice, and what a module
// declares as it leaves for an MCP client (lib/client-text.js takes line and
// message from here; the Reviewer's high reviews of #445, R1 and 1). Every
// character of the repo's one hidden-character class, lib/conditions-why.json
// hiddenClass (the controls, the line and paragraph separators, the bidi
// controls, the zero-width and filler characters, the soft hyphen, the
// variation selectors, the tag characters, a lone surrogate), becomes a
// space, so a module's text can never forge a log line, hide text or reorder
// what an operator or a model reads. An emoji sequence, a joiner within a
// word and an RGI subdivision flag are kept whole. Pure: it requires only
// its class (data), so the lean worker loads it at boot.
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
// the RGI subdivision flags (Unicode's emoji-sequences: England, Scotland,
// Wales), as their tag letters spell them. Only these keep their tags: a
// black flag and a cancel tag around any other run would carry ASCII text
// a model reads and a person sees as a flag (F2-1).
const RGI_SUBDIVISIONS = new Set(['gbeng', 'gbsct', 'gbwls']);
// the indexes of every RGI subdivision flag's tags: a black flag, its tag
// letters, a cancel tag
function flagTags(points) {
  const kept = new Set();
  for (let i = 0; i < points.length; i++) {
    if (points[i] !== BLACK_FLAG) continue;
    let j = i + 1;
    let spelled = '';
    while (isTag(points[j]) && spelled.length <= 6) { spelled += String.fromCodePoint(points[j].codePointAt(0) - 0xe0000); j++; }
    if (points[j] === CANCEL_TAG && RGI_SUBDIVISIONS.has(spelled)) for (let k = i + 1; k <= j; k++) kept.add(k);
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


// s cut to max characters, never leaving half a surrogate pair at the cut
// (the medium on #445's second round, 7)
function cutAt(s, max) {
  if (!Number.isInteger(max) || max < 0 || s.length <= max) return s;
  const cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff) ? cut.slice(0, -1) : cut;
}

// (client-text's line(): a hidden character a space, but an emoji
// sequence, a joiner within a word and an RGI flag kept: the medium on #445's
// final round, 1)
function moduleText(text, max) {
  return line(cutAt(String(text), max));
}

// One plain line: the rule, runs of spaces made one, trimmed, cut, and
// trimmed again after the cut (a notice, a refused ask's reason)
function moduleLine(text, max) {
  const flat = line(text == null ? '' : text).replace(/ {2,}/g, ' ').trim();
  return cutAt(flat, max).trimEnd();
}

module.exports = {moduleText, moduleLine, line, message, cutAt};
