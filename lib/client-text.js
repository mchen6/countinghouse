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
//   schema(s)       -> {schema, unusable}: an advertised JSON schema (a
//                   tool's input or output, a question's form) as it leaves:
//                   its text keywords cleaned (title a line, description and
//                   $comment keeping \n and \t); an annotation (default,
//                   examples, enumNames...) or an unknown keyword holding a
//                   hidden character anywhere, left out; a hidden character
//                   anywhere else (a name, an enum or const member, a
//                   required entry, pattern, $ref...), or a local $ref into
//                   what is left out, makes it unusable (the tool is not
//                   listed, the question unavailable). The one predicate is
//                   whether message() would change a string, so a tab or a
//                   line break in data is no hidden character. A copy, kept
//                   per declared object; validation always uses the
//                   declared schema.
//   holdsHidden(v)  that predicate over any value, keys included
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
const hasHidden = (text) => line(text) !== String(text);

// An advertised JSON schema's text keywords, cleaned as all declared text.
const TEXT_KEYWORDS = new Set(['title', 'description', '$comment']);
// Annotations with no effect on validation: one holding a hidden character
// anywhere is left out
const ANNOTATIONS = new Set(['default', 'examples', 'enumNames', 'deprecated', 'readOnly', 'writeOnly']);
// JSON Schema 2020-12's keywords, and what the gateway's validator (Ajv 2020
// with ajv-formats) enforces besides (mcp-contract 34 holds this list to
// Ajv's own): any other keyword is unknown, means nothing to validation, and
// is left out like an annotation
const KNOWN_KEYWORDS = new Set(['$schema', '$id', '$ref', '$dynamicRef', '$anchor', '$dynamicAnchor', '$defs', 'definitions', '$comment', '$vocabulary',
  'type', 'enum', 'const', 'default', 'examples', 'title', 'description', 'format', 'pattern', 'properties', 'patternProperties', 'additionalProperties',
  'required', 'items', 'prefixItems', 'additionalItems', 'contains', 'minContains', 'maxContains', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties',
  'dependentRequired', 'dependentSchemas', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else', 'contentEncoding', 'contentMediaType', 'contentSchema', 'readOnly', 'writeOnly', 'deprecated', 'enumNames',
  '$recursiveAnchor', '$recursiveRef', 'id', 'nullable', 'dependencies', 'formatMaximum', 'formatMinimum', 'formatExclusiveMaximum', 'formatExclusiveMinimum']);
// Where a value is a schema: one (or a boolean schema), a list of them, or a
// map of names to them. Everything else known is data.
const ONE_SCHEMA = new Set(['items', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'then', 'else', 'contentSchema',
  'additionalItems', 'if', 'not', 'contains', 'propertyNames']);
const SCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
// The one predicate in a schema: what message() would change. An emoji or
// an RGI flag is never hidden, and nor is a tab or a line break, which a
// description keeps: an enum of delimiters ("\t") or a multi-line default
// is ordinary data (#400's medium review).
const hiddenIn = (text) => message(text) !== String(text);
// whether a value holds a hidden character anywhere: a string, or any key or
// value at any depth
function deepHidden(v, seen = new Set()) {
  if (typeof(v) === 'string') return hiddenIn(v);
  if (v == null || typeof(v) !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => deepHidden(x, seen));
  return Object.keys(v).some((k) => hiddenIn(k) || deepHidden(v[k], seen));
}
// an own property, whatever its name (__proto__ too)
const put = (o, key, value) => Object.defineProperty(o, key, {value, writable: true, enumerable: true, configurable: true});
const step = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// One walk over the schema's real schema positions (a cycle walked once),
// which cleans it and says what it did (ctx.report, the load's warnings):
// - text keywords: cleaned;
// - annotations and unknown keywords: left out, whole, when they hold a
//   hidden character anywhere (they mean nothing to validation);
//   (a text keyword that is no string is an annotation);
// - anything else (a name, an enum or const member, a required entry,
//   pattern, $ref, format, wherever it is, under not or if too) holding one
//   makes the schema unusable: nothing it holds can be changed or left out
//   without changing what it means. So does a local $ref into what is left
//   out (schema(), after the walk), which would be left dangling.
// Validation always uses the declared schema; this only decides what a
// client is shown.
function walk(node, ctx, path) {
  if (!isObject(node)) return node;
  if (ctx.copies.has(node)) return ctx.copies.get(node);
  const out = {};
  ctx.copies.set(node, out);
  const unusable = (at, what) => { ctx.unusable = true; if (ctx.report != null) ctx.report.push({path: at, what, effect: 'unusable'}); };
  for (const key of Object.keys(node)) {
    const value = node[key];
    const at = step(path, key);
    if (!KNOWN_KEYWORDS.has(key) || ANNOTATIONS.has(key) || (TEXT_KEYWORDS.has(key) && typeof(value) !== 'string')) {
      if (hiddenIn(key) || deepHidden(value)) {
        if (ctx.report != null) ctx.report.push({path: at, what: KNOWN_KEYWORDS.has(key) ? key : `the unknown keyword ${JSON.stringify(key.slice(0, 64))}`, effect: 'left out'});
        if (!ctx.leftOutAt.has(node)) ctx.leftOutAt.set(node, new Set());
        ctx.leftOutAt.get(node).add(key);
        continue;
      }
      put(out, key, value);
      continue;
    }
    if (TEXT_KEYWORDS.has(key) && typeof(value) === 'string') { put(out, key, key === 'title' ? line(value) : message(value)); continue; }
    if (SCHEMA_MAPS.has(key) && isObject(value)) {
      const map = {};
      for (const name of Object.keys(value)) {
        if (hiddenIn(name)) unusable(step(at, name), `the name ${JSON.stringify(name.slice(0, 64))}`);
        put(map, name, walk(value[name], ctx, step(at, name)));
      }
      put(out, key, map);
      continue;
    }
    if (key === 'dependencies' && isObject(value)) {
      // each entry a list of names (data) or a schema
      const map = {};
      for (const name of Object.keys(value)) {
        if (hiddenIn(name)) unusable(step(at, name), `the name ${JSON.stringify(name.slice(0, 64))}`);
        const v = value[name];
        if (isObject(v) || typeof(v) === 'boolean') put(map, name, walk(v, ctx, step(at, name)));
        else { if (deepHidden(v)) unusable(step(at, name), 'dependencies'); put(map, name, v); }
      }
      put(out, key, map);
      continue;
    }
    if (SCHEMA_LISTS.has(key) && Array.isArray(value)) { put(out, key, value.map((v, i) => walk(v, ctx, step(at, i)))); continue; }
    if (ONE_SCHEMA.has(key) && isObject(value)) { put(out, key, walk(value, ctx, at)); continue; }
    // data: enum, const, required, dependentRequired, $vocabulary, type,
    // pattern, format, contentMediaType, $ref and the rest, as declared
    if (deepHidden(value)) unusable(at, key);
    else if (key === '$ref' && typeof(value) === 'string') ctx.refs.push({at, ref: value});
    put(out, key, value);
  }
  return out;
}

// Whether a local $ref ("#/a/b") passes through a keyword the walk left
// out: by the declared nodes themselves, so however a node was reached.
function intoLeftOut(root, ref, leftOutAt) {
  if (!ref.startsWith('#/')) return false;
  let tokens;
  try { tokens = decodeURIComponent(ref.slice(2)).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~')); } catch (e) { return false; }
  let node = root;
  for (const t of tokens) {
    if (node == null || typeof(node) !== 'object') return false;
    const out = leftOutAt.get(node);
    if (out != null && out.has(t)) return true;
    if (!Object.hasOwn(node, t)) return false;
    node = node[t];
  }
  return false;
}

// kept per declared object (an object fetched afresh is cleaned afresh:
// worker mode's schemas, a task's record). report: an array, for the load's
// warnings, which each finding is pushed to ({path, what, effect: 'left
// out' | 'unusable'}); never kept. -> {schema (null when unusable), unusable}
const kept = new WeakMap();
function schema(s, {report = null} = {}) {
  if (!isObject(s)) return {schema: s, unusable: false};
  if (report == null && kept.has(s)) return kept.get(s);
  const ctx = {copies: new Map(), report, unusable: false, leftOutAt: new Map(), refs: []};
  const c = walk(s, ctx, '');
  for (const {at, ref} of ctx.refs) {
    if (!intoLeftOut(s, ref, ctx.leftOutAt)) continue;
    ctx.unusable = true;
    if (report != null) report.push({path: at, what: `$ref ${JSON.stringify(ref.slice(0, 64))}, into what is left out,`, effect: 'unusable'});
  }
  const result = ctx.unusable ? {schema: null, unusable: true} : {schema: c, unusable: false};
  if (report == null) kept.set(s, result);
  return result;
}

// (holdsHidden: the schema's predicate over any value, the load's fast path:
// a document holding none has nothing to warn of)
module.exports = {line, message, hasHidden, schema, holdsHidden: (v) => deepHidden(v), KNOWN_KEYWORDS};
