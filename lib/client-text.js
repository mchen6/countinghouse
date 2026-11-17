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
//                   Data is looked into at any depth (values and keys). In
//                   an input or a form, a hidden character where nothing can
//                   be left out or changed -- under if, not, contains or
//                   propertyNames, in a name other than an optional
//                   property's, a required entry, pattern, contentMediaType
//                   -- makes the schema unusable; an unknown keyword holding
//                   one is left out, whole (it means nothing to validation).
//                   A copy, kept per declared object; validation uses the
//                   declared one.
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

const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
const TEXT_KEYWORDS = new Set(['title', 'description', '$comment']);
// JSON Schema 2020-12's keywords, and a form's enumNames: any other is
// unknown, means nothing to validation, and can be left out
const KNOWN_KEYWORDS = new Set(['$schema', '$id', '$ref', '$dynamicRef', '$anchor', '$dynamicAnchor', '$defs', 'definitions', '$comment', '$vocabulary',
  'type', 'enum', 'const', 'default', 'examples', 'title', 'description', 'format', 'pattern', 'properties', 'patternProperties', 'additionalProperties',
  'required', 'items', 'prefixItems', 'additionalItems', 'contains', 'minContains', 'maxContains', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties',
  'dependentRequired', 'dependentSchemas', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else', 'contentEncoding', 'contentMediaType', 'contentSchema', 'readOnly', 'writeOnly', 'deprecated', 'enumNames',
  // what the gateway's validator (Ajv 2020 with ajv-formats) enforces too:
  // never unknown (mcp-contract 34 holds this list to Ajv's own)
  '$recursiveAnchor', '$recursiveRef', 'id', 'nullable', 'dependencies', 'formatMaximum', 'formatMinimum', 'formatExclusiveMaximum', 'formatExclusiveMinimum']);
// keywords whose value is one subschema, where one nothing can satisfy is
// `false` and means the same
const SUBSCHEMA = new Set(['items', 'additionalProperties', 'unevaluatedItems', 'unevaluatedProperties', 'then', 'else', 'contentSchema', 'additionalItems']);
// a condition, a negation, a "some item", a name's schema: there nothing can
// be left out without changing what the declared schema allows, so what
// can't be sent makes the node holding it unsatisfiable ('exact')
const EXACT = new Set(['if', 'not', 'contains', 'propertyNames']);
// lists of subschemas (an old-style tuple items too)
const LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items']);
const UNSATISFIABLE = Symbol('unsatisfiable');
const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const ObjectHasOwnCT = Object.hasOwn;
// whether a value holds a hidden character anywhere: a string, or any key or
// value at any depth of an array or object (F3-1: data the client may send
// back, or that a model reads, is never only its top-level strings)
function deepHidden(v, seen = new Set()) {
  if (typeof(v) === 'string') return HIDDEN.test(v) && hasHidden(v);
  if (v == null || typeof(v) !== 'object' || seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => deepHidden(x, seen));
  return Object.keys(v).some((k) => hasHidden(k) || deepHidden(v[k], seen));
}
// an own property, whatever its name (__proto__ too)
const put = (o, key, value) => Object.defineProperty(o, key, {value, writable: true, enumerable: true, configurable: true});
// a $ref's hidden character, as written or percent-encoded (a JSON Pointer
// fragment may be either)
const refHidden = (ref) => { if (hasHidden(ref)) return true; try { return hasHidden(decodeURIComponent(ref)); } catch (e) { return false; } };
// what an object advertises when a property was left out for its name: no
// name with a hidden character may be sent at all, so leaving it out never
// lets a value through that the declared schema refuses (the pattern is
// written in ASCII escapes: it holds no hidden character itself)
const NO_HIDDEN_NAME = {not: {pattern: `[${hiddenClass}]`}};
const step = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// One walk, which cleans and says what it did (ctx.report, for the load's
// warnings: one account of what the gateway does, never a second scan).
// mode 'input' (a tool's input, a form): text cleaned; data, annotations and
// unknown keywords with a hidden character left out; what can't be left
// out or changed (a required entry, pattern, a name a schema is matched or
// referred to by, an enum left with nothing, a const) makes its node
// UNSATISFIABLE, and that is left out in turn where it can be (an optional
// property, one anyOf branch, `false` for one subschema), up to the root,
// which makes the schema unusable. 'exact' (under if, not, contains,
// propertyNames): the same, except that nothing but annotations and unknown
// keywords is left out: anything else unsatisfiable makes the node holding
// the exact keyword unsatisfiable. 'output': text cleaned, unknown keywords
// with one left out (they mean nothing to validation); names and data as
// declared (the client checks results against them).
function cleanSchema(node, mode, ctx, path) {
  if (!isObject(node)) return node;
  const seen = ctx.copies[mode];
  // known, from an earlier pass, to be one that can't be sent (a cycle)
  if (ctx.unsendable[mode].has(node)) return UNSATISFIABLE;
  if (seen.has(node)) {
    // a node still being copied, met again through a cycle: its copy is
    // partial for now; noted, so that if it turns out unsatisfiable the walk
    // is run again with that known (schema(), below)
    if (ctx.walking[mode].has(node)) ctx.partial[mode].add(node);
    return seen.get(node);
  }
  const out = {};
  seen.set(node, out);
  ctx.walking[mode].add(node);
  const output = mode === 'output';
  const exact = mode === 'exact';
  const note = (at, what, effect) => { if (ctx.report != null) ctx.report.push({path: at, what, effect}); };
  let unsatisfiable = false;
  const unsat = (at, what) => { note(at, what, 'unsatisfiable'); unsatisfiable = true; };
  let keptMembers = null;
  const leftOut = new Set();      // properties left out by their names
  const absent = new Set();       // properties advertised as `false` (never present)
  let noHiddenNames = false;      // a name left out for its hidden character
  // a child's copy, or UNSATISFIABLE: in 'exact', any child that is makes this
  // node so (nothing there is left out)
  const child = (value, childMode, at) => {
    const c = cleanSchema(value, childMode, ctx, at);
    if (c === UNSATISFIABLE && exact) unsatisfiable = true;
    return c;
  };
  for (const key of Object.keys(node)) {
    const value = node[key];
    const at = step(path, key);
    // an unknown keyword means nothing to validation: one holding a hidden
    // character anywhere (its name too) is left out, whole, in every mode
    if (!KNOWN_KEYWORDS.has(key)) {
      if (hasHidden(key) || deepHidden(value)) { note(at, `the unknown keyword ${JSON.stringify(key.slice(0, 64))}`, 'left out'); continue; }
      put(out, key, value);
      continue;
    }
    if (TEXT_KEYWORDS.has(key) && typeof(value) === 'string') { put(out, key, key === 'title' ? line(value) : message(value)); continue; }
    if (key === 'enumNames') continue;    // after the members (below)
    // annotations: nothing to validation, so left out with a hidden
    // character (an output's are its data, as declared)
    if (key === 'default' || key === 'examples') {
      if (output) { if (deepHidden(value)) note(at, key, 'as declared'); put(out, key, value); continue; }
      if (key === 'examples' && Array.isArray(value)) {
        const kept = value.filter((m) => !deepHidden(m));
        if (kept.length < value.length) note(at, 'a member of examples', 'left out');
        if (kept.length > 0) put(out, key, kept);
      } else if (deepHidden(value)) {
        note(at, key, 'left out');
      } else {
        put(out, key, value);
      }
      continue;
    }
    if (key === 'enum' || key === 'const') {
      if (output) { if (deepHidden(value)) note(at, key, 'as declared'); put(out, key, value); continue; }
      if (key === 'enum' && Array.isArray(value) && !exact) {
        keptMembers = [];
        value.forEach((m, i) => { if (!deepHidden(m)) keptMembers.push(i); });
        if (keptMembers.length < value.length) note(at, 'a member of enum', 'left out');
        put(out, key, keptMembers.map((i) => value[i]));
        if (keptMembers.length === 0) unsat(at, 'enum, left with no member');
      } else if (deepHidden(value)) {
        unsat(at, key);
      } else {
        put(out, key, value);
      }
      continue;
    }
    if (key === 'properties' && isObject(value)) {
      const map = {};
      for (const name of Object.keys(value)) {
        const named = step(at, name);
        if (hasHidden(name)) {
          if (output) { note(named, `the property name ${JSON.stringify(name.slice(0, 64))}`, 'as declared'); put(map, name, child(value[name], mode, named)); continue; }
          if (exact) { unsat(named, `the property name ${JSON.stringify(name.slice(0, 64))}`); continue; }
          // left out, and no name with a hidden character may be sent
          // (below): never wider than the declared schema
          note(named, `the property name ${JSON.stringify(name.slice(0, 64))}`, 'left out');
          leftOut.add(name);
          noHiddenNames = true;
          continue;
        }
        const c = child(value[name], mode, named);
        if (c === UNSATISFIABLE) {
          // advertised as never present (`false`), not dropped: dropped, it
          // would take any value under additionalProperties
          if (!exact) { note(named, 'the property', 'left out'); absent.add(name); put(map, name, false); }
          continue;
        }
        put(map, name, c);
      }
      put(out, key, map);
      continue;
    }
    if ((key === '$defs' || key === 'definitions' || key === 'patternProperties' || key === 'dependentSchemas') && isObject(value)) {
      const map = {};
      for (const name of Object.keys(value)) {
        const named = step(at, name);
        if (hasHidden(name) && !output) {
          // a definition is reached by a $ref, which then holds the hidden
          // character itself: left out; a pattern or a dependency is matched
          // by it: its node can't be sent
          if (key === '$defs' || key === 'definitions') { note(named, `the definition name ${JSON.stringify(name.slice(0, 64))}`, 'left out'); continue; }
          // a dependency on a property no name with a hidden character may be
          // sent as (below) never applies: left out; a pattern's may match
          // names without one: its node can't be sent
          if (key === 'dependentSchemas') { note(named, `the name ${JSON.stringify(name.slice(0, 64))}`, 'left out'); noHiddenNames = true; continue; }
          unsat(named, `the name ${JSON.stringify(name.slice(0, 64))}`);
          continue;
        }
        if (hasHidden(name)) note(named, `the name ${JSON.stringify(name.slice(0, 64))}`, 'as declared');
        const c = child(value[name], mode, named);
        // (one nothing can satisfy, kept as `false`: a $ref to it still
        // resolves, to what nothing satisfies, and a match is refused)
        put(map, name, c === UNSATISFIABLE ? false : c);
      }
      put(out, key, map);
      continue;
    }
    if (LISTS.has(key) && Array.isArray(value)) {
      const items = value.map((v, i) => child(v, mode, step(at, i)));
      if (key === 'anyOf') {
        const kept = items.filter((v) => v !== UNSATISFIABLE);
        if (kept.length < items.length && !exact) note(at, 'a branch of anyOf', 'left out');
        if (kept.length === 0) unsatisfiable = true;
        put(out, key, kept);
      } else if (key === 'oneOf') {
        // "exactly one": a branch left out would change the count, and so
        // what passes; one that can't be sent makes this node so. Except a
        // form's choices: every branch a const (beside annotations), each
        // value its own, so no value matches two and one left out changes
        // nothing for the others (as anyOf)
        const choice = (b) => isObject(b) && ObjectHasOwnCT(b, 'const') && Object.keys(b).every((k) => k === 'const' || TEXT_KEYWORDS.has(k) || k === 'default' || k === 'examples');
        const consts = value.every(choice) ? value.map((b) => JSON.stringify(b.const)) : null;
        if (consts != null && new Set(consts).size === consts.length && !exact) {
          const kept = items.filter((v) => v !== UNSATISFIABLE);
          if (kept.length < items.length) note(at, 'a choice of oneOf', 'left out');
          if (kept.length === 0) unsatisfiable = true;
          put(out, key, kept);
        } else {
          if (items.includes(UNSATISFIABLE)) unsat(at, 'a branch of oneOf');
          put(out, key, items);
        }
      } else if (key === 'allOf') {
        if (items.includes(UNSATISFIABLE)) unsatisfiable = true;
        put(out, key, items.filter((v) => v !== UNSATISFIABLE));
      } else {
        put(out, key, items.map((v) => (v === UNSATISFIABLE ? false : v)));
      }
      continue;
    }
    if (SUBSCHEMA.has(key) && isObject(value)) {
      const c = child(value, mode, at);
      put(out, key, (c === UNSATISFIABLE) ? false : c);
      continue;
    }
    if (EXACT.has(key) && isObject(value)) {
      const c = cleanSchema(value, output ? 'output' : 'exact', ctx, at);
      if (c === UNSATISFIABLE) { unsatisfiable = true; continue; }
      put(out, key, c);
      continue;
    }
    // required, dependentRequired, pattern, contentMediaType, format, $ref,
    // $vocabulary, type: as declared, so a hidden character makes the node
    // unsatisfiable (an output's, as declared)
    if (deepHidden(value) || ((key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef') && typeof(value) === 'string' && refHidden(value))) {
      if (output) note(at, key, 'as declared');
      else { unsat(at, key); continue; }
    }
    put(out, key, isObject(value) ? cleanSchema(value, output ? 'output' : 'exact', ctx, at) : value);
  }
  // a form's names for its choices, beside the members kept (one for each,
  // as declared; otherwise, or with a name that is no string, left out)
  if (Array.isArray(node.enumNames)) {
    const at = step(path, 'enumNames');
    const aligned = keptMembers == null || (Array.isArray(node.enum) && node.enumNames.length === node.enum.length);
    const names = !aligned ? null : (keptMembers != null) ? keptMembers.map((i) => node.enumNames[i]) : node.enumNames;
    if (names != null && names.every((n) => typeof(n) === 'string')) put(out, 'enumNames', names.map((n) => line(n)));
    else if (deepHidden(node.enumNames)) note(at, 'enumNames', 'left out');
    else if (names != null) put(out, 'enumNames', names);
  }
  if (noHiddenNames && !output) put(out, 'propertyNames', out.propertyNames != null ? {allOf: [out.propertyNames, NO_HIDDEN_NAME]} : NO_HIDDEN_NAME);
  if (Array.isArray(node.required) && node.required.some((name) => leftOut.has(name) || absent.has(name))) unsatisfiable = true;
  ctx.walking[mode].delete(node);
  if (unsatisfiable) {
    seen.set(node, UNSATISFIABLE);
    ctx.unsat[mode].add(node);
    return UNSATISFIABLE;
  }
  return out;
}

// kept per declared object, by mode (an object fetched afresh is cleaned
// afresh: worker mode's schemas, a task's record). report: an array, for
// the load's warnings, which each finding is pushed to ({path, what,
// effect: 'left out' | 'unsatisfiable' | 'as declared'}); never kept.
const kept = {input: new WeakMap(), output: new WeakMap()};
function schema(s, {output = false, report = null} = {}) {
  if (!isObject(s)) return {schema: s, unusable: false};
  const store = output ? kept.output : kept.input;
  if (report == null && store.has(s)) return store.get(s);
  // run again while a node met through a cycle (its copy partial then)
  // turns out unsatisfiable, with that known from the start: no kept copy
  // ever holds a partial one (each run knows one more; bounded by the nodes)
  const modes = () => ({input: new Set(), exact: new Set(), output: new Set()});
  const unsendable = modes();
  let c;
  let ctx;
  for (let round = 0; round < 10000; round++) {
    ctx = {copies: {input: new Map(), exact: new Map(), output: new Map()}, report: report != null ? [] : null,
      unsendable, walking: modes(), partial: modes(), unsat: modes()};
    c = cleanSchema(s, output ? 'output' : 'input', ctx, '');
    let more = false;
    for (const m of ['input', 'exact', 'output']) {
      for (const n of ctx.partial[m]) if (ctx.unsat[m].has(n) && !unsendable[m].has(n)) { unsendable[m].add(n); more = true; }
    }
    if (!more) break;
  }
  if (report != null) report.push(...ctx.report);
  const result = (c === UNSATISFIABLE) ? {schema: null, unusable: true} : {schema: c, unusable: false};
  if (report == null) store.set(s, result);
  return result;
}

module.exports = {line, message, hasHidden, schema, KNOWN_KEYWORDS};
