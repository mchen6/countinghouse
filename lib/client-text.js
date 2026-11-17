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
//   schema(s, {output}) -> {schema, unusable}: an advertised JSON schema (a
//                   tool's input or output, a question's form) as it leaves.
//                   Text at a keyword's place is cleaned: title a line,
//                   description and $comment keeping \n and \t. A name (under
//                   properties, $defs...) and data (enum, const, default,
//                   examples: values the client may send back) are never
//                   changed: in an input, a string member or example with a
//                   hidden character is left out (an enumNames entry with
//                   its member), a default with one dropped, a property
//                   named with one, or whose enum or const is left with
//                   nothing, left out; when what is left out is required,
//                   the schema is unusable (the tool is not listed, the
//                   question unavailable). An output's data and names stay
//                   as declared: the client checks results against them.
//                   pattern and format are syntax, as declared; an unknown
//                   keyword's text too, its subschemas walked. A copy, kept
//                   per declared object; validation uses the declared one.
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

const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
// keywords whose value is one subschema, where one nothing can satisfy is
// `false` and means the same; and those where `false` would change what the
// declared schema allows (a condition, a negation, a "some item"), cleaned
// in 'keep' mode instead: their text only, their data as declared
const SUBSCHEMA = new Set(['items', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'then', 'else', 'contentSchema', 'additionalItems']);
const EXACT = new Set(['if', 'not', 'contains', 'propertyNames']);
const LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const UNSATISFIABLE = Symbol('unsatisfiable');
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const hiddenString = (v) => typeof(v) === 'string' && hasHidden(v);
// an own property, whatever its name (__proto__ too)
const put = (o, key, value) => Object.defineProperty(o, key, {value, writable: true, enumerable: true, configurable: true});

// mode 'input': text cleaned, data with a hidden character left out (and
// what that leaves unsatisfiable, UNSATISFIABLE); 'keep': text cleaned,
// names and data as declared (an output, an exact place, an unknown keyword)
function cleanSchema(node, mode, copies) {
  if (Array.isArray(node)) return node.map((v) => cleanSchema(v, 'keep', copies));
  if (!isObject(node)) return node;
  const seen = copies[mode];
  if (seen.has(node)) return seen.get(node);
  const out = {};
  seen.set(node, out);
  const input = mode === 'input';
  let unsatisfiable = false;
  let keptMembers = null;
  const leftOut = new Set();
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (key === 'title' && typeof(value) === 'string') put(out, key, line(value));
    else if ((key === 'description' || key === '$comment') && typeof(value) === 'string') put(out, key, message(value));
    else if (key === 'enumNames') continue;
    else if (DATA_KEYWORDS.has(key)) {
      if (!input) put(out, key, value);
      else if (key === 'enum' && Array.isArray(value)) {
        keptMembers = [];
        value.forEach((m, i) => { if (!hiddenString(m)) keptMembers.push(i); });
        put(out, key, keptMembers.map((i) => value[i]));
        if (keptMembers.length === 0) unsatisfiable = true;
      } else if (key === 'const') {
        if (hiddenString(value)) unsatisfiable = true; else put(out, key, value);
      } else if (key === 'default') {
        if (!hiddenString(value)) put(out, key, value);
      } else if (key === 'examples' && Array.isArray(value)) {
        const kept = value.filter((m) => !hiddenString(m));
        if (kept.length > 0) put(out, key, kept);
      } else {
        put(out, key, value);
      }
    } else if (SCHEMA_MAPS.has(key) && isObject(value)) {
      const map = {};
      for (const name of Object.keys(value)) {
        const isProperty = key === 'properties' && input;
        if (isProperty && hasHidden(name)) { leftOut.add(name); continue; }
        const c = cleanSchema(value[name], mode, copies);
        if (c === UNSATISFIABLE) {
          // a property, left out; a definition or a pattern's schema, kept
          // as `false` (a $ref to it still resolves, to what nothing satisfies)
          if (isProperty) { leftOut.add(name); continue; }
          put(map, name, false);
          continue;
        }
        put(map, name, c);
      }
      put(out, key, map);
    } else if (LISTS.has(key) && Array.isArray(value)) {
      const items = value.map((v) => cleanSchema(v, mode, copies));
      if (key === 'anyOf' || key === 'oneOf') {
        const kept = items.filter((v) => v !== UNSATISFIABLE);
        if (kept.length === 0) unsatisfiable = true;
        put(out, key, kept);
      } else if (key === 'allOf') {
        if (items.includes(UNSATISFIABLE)) unsatisfiable = true;
        put(out, key, items.filter((v) => v !== UNSATISFIABLE));
      } else {
        put(out, key, items.map((v) => (v === UNSATISFIABLE ? false : v)));
      }
    } else if (SUBSCHEMA.has(key) && isObject(value)) {
      const c = cleanSchema(value, mode, copies);
      put(out, key, (c === UNSATISFIABLE) ? false : c);
    } else if (EXACT.has(key) || isObject(value) || Array.isArray(value)) {
      // an exact place, or an unknown keyword's value: text only
      put(out, key, cleanSchema(value, 'keep', copies));
    } else {
      put(out, key, value);
    }
  }
  // a form's names for its choices, beside the members kept (one for each,
  // as declared; otherwise left out rather than misaligned)
  if (Array.isArray(node.enumNames)) {
    const aligned = keptMembers == null || (Array.isArray(node.enum) && node.enumNames.length === node.enum.length);
    if (aligned) {
      const names = (keptMembers != null) ? keptMembers.map((i) => node.enumNames[i]) : node.enumNames;
      put(out, 'enumNames', names.map((n) => (typeof(n) === 'string' ? line(n) : n)));
    }
  }
  if (Array.isArray(node.required) && node.required.some((name) => leftOut.has(name))) unsatisfiable = true;
  if (unsatisfiable) {
    seen.set(node, UNSATISFIABLE);
    return UNSATISFIABLE;
  }
  return out;
}

// kept per declared object, by mode (an object fetched afresh is cleaned
// afresh: worker mode's schemas, a task's record)
const kept = {input: new WeakMap(), output: new WeakMap()};
function schema(s, {output = false} = {}) {
  if (!isObject(s)) return {schema: s, unusable: false};
  const store = output ? kept.output : kept.input;
  if (store.has(s)) return store.get(s);
  const c = cleanSchema(s, output ? 'keep' : 'input', {input: new Map(), keep: new Map()});
  const result = (c === UNSATISFIABLE) ? {schema: null, unusable: true} : {schema: c, unusable: false};
  store.set(s, result);
  return result;
}

module.exports = {line, message, hasHidden, schema};
