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
// its selector: a digit is not pictographic).
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
const ZWJ = '‍';
const VS16 = '️';

const pictographic = (c) => c !== undefined && PICTOGRAPHIC.test(c);
// whether the code point at i ends an emoji: a pictographic character, then
// at most a skin tone or a VS-16
function endsEmoji(points, i) {
  if (i < 0) return false;
  if (pictographic(points[i])) return true;
  if ((SKIN_TONE.test(points[i]) || points[i] === VS16) && pictographic(points[i - 1])) return true;
  return false;
}
// whether the hidden code point at i is kept: part of an emoji sequence
function keptInEmoji(points, i) {
  if (points[i] === VS16) return pictographic(points[i - 1]);
  if (points[i] === ZWJ) return endsEmoji(points, i - 1) && pictographic(points[i + 1]);
  return false;
}

function cleaned(text, keep) {
  const s = String(text);
  if (!HIDDEN.test(s)) return s;
  const points = Array.from(s);
  let out = '';
  for (let i = 0; i < points.length; i++) {
    const c = points[i];
    if (!HIDDEN.test(c) || keep.has(c) || keptInEmoji(points, i)) out += c;
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
