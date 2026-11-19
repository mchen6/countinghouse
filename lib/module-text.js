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

// Every built-in the rule uses, taken at load, before any module code runs
// (the Reviewer, on the fold after #445): output-lines cleans a module's
// output in its own worker, after the lockdown, and the lockdown leaves the
// intrinsics as they are. A module that patches Array.from, Set's has, a
// String or RegExp method or a global can't get a control character into
// its own log lines. So: no string iterator, no regex replace, no array
// writes through a prototype; each RegExp has its exec pinned as its own
// property, which test reads before the prototype's.
const uncurry = Function.prototype.call.bind(Function.prototype.bind, Function.prototype.call);
const ObjectDefineProperty = Object.defineProperty;
const SafeSet = Set;
const SetHas = uncurry(Set.prototype.has);
const SetAdd = uncurry(Set.prototype.add);
const StringCtor = String;
const StringFromCodePoint = String.fromCodePoint;
const StringCodePointAt = uncurry(String.prototype.codePointAt);
const StringCharCodeAt = uncurry(String.prototype.charCodeAt);
const StringSlice = uncurry(String.prototype.slice);
const RegExpExec = RegExp.prototype.exec;
const RegExpTest = uncurry(RegExp.prototype.test);
const NumberIsInteger = Number.isInteger;
// a RegExp whose exec is its own (the built-in's, taken above)
const pinned = (re) => ObjectDefineProperty(re, 'exec', {__proto__: null, value: RegExpExec, writable: false, configurable: false, enumerable: false});
const test = (re, c) => RegExpTest(re, c);

const HIDDEN = pinned(new RegExp(`[${hiddenClass}]`, 'u'));
// The part of the class a declaration may not carry at all (lib/
// declarations.js): the controls, the line and paragraph separators and the
// bidi controls (overrides, isolates and marks), which reorder or break what
// a person reads. The rest of the class (zero-width, fillers, tags,
// selectors) is cleaned on the way out, never refused at load (#378).
// validation 05 holds that each is in the class.
const CONTROL_OR_BIDI = pinned(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\u200e\u200f\u061c]/u);
const hasControlOrBidi = (text) => test(CONTROL_OR_BIDI, StringCtor(text));
const PICTOGRAPHIC = pinned(/\p{Extended_Pictographic}/u);
const SKIN_TONE = pinned(/[\u{1f3fb}-\u{1f3ff}]/u);
const ZWJ = '‍';
const ZWNJ = '‌';
const VS16 = '️';
const LETTER = pinned(/\p{L}/u);
const MARK = pinned(/\p{M}/u);
const BLACK_FLAG = '\u{1f3f4}';
const CANCEL_TAG = '\u{e007f}';
const isTag = (c) => c !== undefined && StringCodePointAt(c, 0) >= 0xe0020 && StringCodePointAt(c, 0) <= 0xe007e;

// s as its code points: {length, 0: c, 1: c, ...} on a null prototype, so no
// write goes through a prototype a module could have given a setter
function codePoints(s) {
  const points = {__proto__: null, length: 0};
  let n = 0;
  for (let i = 0; i < s.length;) {
    const cp = StringCodePointAt(s, i);
    const width = cp > 0xffff ? 2 : 1;
    points[n++] = StringSlice(s, i, i + width);
    i += width;
  }
  points.length = n;
  return points;
}

const pictographic = (c) => c !== undefined && test(PICTOGRAPHIC, c);
// whether the code point at i ends an emoji: a pictographic character, then
// at most a skin tone or a VS-16
function endsEmoji(points, i) {
  if (i < 0) return false;
  if (pictographic(points[i])) return true;
  if ((points[i] !== undefined && test(SKIN_TONE, points[i]) || points[i] === VS16) && pictographic(points[i - 1])) return true;
  return false;
}
const letter = (c) => c !== undefined && test(LETTER, c);
// a visible combining mark (a hidden one, a selector, is no part of a word)
const visibleMark = (c) => c !== undefined && test(MARK, c) && !test(HIDDEN, c);
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
const RGI_SUBDIVISIONS = new SafeSet(['gbeng', 'gbsct', 'gbwls']);
// the indexes of every RGI subdivision flag's tags: a black flag, its tag
// letters, a cancel tag
function flagTags(points) {
  const kept = new SafeSet();
  for (let i = 0; i < points.length; i++) {
    if (points[i] !== BLACK_FLAG) continue;
    let j = i + 1;
    let spelled = '';
    while (isTag(points[j]) && spelled.length <= 6) { spelled += StringFromCodePoint(StringCodePointAt(points[j], 0) - 0xe0000); j++; }
    if (points[j] === CANCEL_TAG && SetHas(RGI_SUBDIVISIONS, spelled)) for (let k = i + 1; k <= j; k++) SetAdd(kept, k);
  }
  return kept;
}

// text with every hidden character replaced by `by` (a space, or '' to
// drop it), but those in keep (a Set made at load) and those an emoji
// sequence, a word or an RGI flag holds
function cleaned(text, keep, by = ' ') {
  const s = StringCtor(text);
  if (!test(HIDDEN, s)) return s;
  const points = codePoints(s);
  const flags = flagTags(points);
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (!test(HIDDEN, c) || SetHas(keep, c) || keptInEmoji(points, i) || SetHas(flags, i)) out += c;
    else out += by;
  }
  return out;
}

// text without the controls, separators and bidi controls (the gate's
// subset), but those in keep (a Set made at load): a module's output lines
// and log fields (lib/output-lines.js), in its own worker. The rest of the
// class stays for the client-facing cleaner (#378).
function withoutControlOrBidi(text, keep) {
  const s = StringCtor(text);
  if (!test(CONTROL_OR_BIDI, s)) return s;
  let out = '';
  for (let i = 0; i < s.length;) {
    const width = StringCodePointAt(s, i) > 0xffff ? 2 : 1;
    const c = StringSlice(s, i, i + width);
    i += width;
    if (!test(CONTROL_OR_BIDI, c) || SetHas(keep, c)) out += c;
  }
  return out;
}

const NOTHING = new SafeSet();
const LINES = new SafeSet(['\n', '\t']);
const line = (text) => cleaned(text, NOTHING);
const message = (text) => cleaned(text, LINES);

// s cut to max characters, never leaving half a surrogate pair at the cut
// (the medium on #445's second round, 7)
function cutAt(s, max) {
  if (!NumberIsInteger(max) || max < 0 || s.length <= max) return s;
  const cut = StringSlice(s, 0, max);
  const last = StringCharCodeAt(cut, cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff) ? StringSlice(cut, 0, -1) : cut;
}

// (client-text's line(): a hidden character a space, but an emoji
// sequence, a joiner within a word and an RGI flag kept: the medium on #445's
// final round, 1)
function moduleText(text, max) {
  return line(cutAt(StringCtor(text), max));
}

// runs of spaces made one, and the ends trimmed of spaces (the only
// whitespace left once line() has run)
function oneSpaced(s) {
  let out = '';
  let pending = false;
  for (let i = 0; i < s.length; i++) {
    const c = StringSlice(s, i, i + 1);
    if (c === ' ') { pending = out !== ''; continue; }
    if (pending) { out += ' '; pending = false; }
    out += c;
  }
  return out;
}

// One plain line: the rule, runs of spaces made one, trimmed, cut, and
// trimmed again after the cut (a notice, a refused ask's reason)
function moduleLine(text, max) {
  return oneSpaced(cutAt(oneSpaced(line(text == null ? '' : text)), max));
}

module.exports = {moduleText, moduleLine, line, message, cleaned, cutAt, hasControlOrBidi, withoutControlOrBidi, CONTROL_OR_BIDI_SOURCE: CONTROL_OR_BIDI.source};
