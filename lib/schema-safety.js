// A module's schema.json, checked before anything of it is resolved, compiled
// or run (the reviewer's rulings on #152, 2026-11-13). A courtesy refusal at
// load, run in a validator worker in worker mode (in single-thread mode, where
// a module's code runs on the main thread anyway, there): a module's input
// and output are validated in validator workers, whose deadline
// (lib/validator-pool.js) is the boundary; this refuses, before that, a
// schema plainly unsafe to compile or run:
//   - schema.json over 1 MB;
//   - a regular expression (a `pattern`, a `patternProperties` key) over
//     1000 characters, or one that can backtrack catastrophically: a
//     repetition inside a repeated group (star height above 1, the check
//     safe-regex makes), or a repeated group whose alternatives start with
//     the same token (`(a|aa)+`);
//   - a document that comes to more than 100000 nodes with its $refs
//     expanded, as a whole or over the actions' schemas together (an
//     expansion bomb: a few lines of $refs that expand exponentially when
//     dereferenced, copied or compiled); a $ref that refers to itself; and a
//     $ref that names no place in schema.json (an anchor, a relative or
//     external URI), which the runtime's resolution never followed.
// The sizes are counted on the raw document, each node once (memoised), so
// a bomb is measured without being expanded.
//
// The refusal is MODULE_ASSEMBLY_FAIL naming the module and the schema path
// (a JSON pointer into schema.json), never the pattern itself.
'use strict';

const fs = require('fs');
// The path module for `modulePath`: in a module worker it is /app, POSIX on
// every OS (lib/fs-broker/identity.js, issue #40).
// (taken at load, not on first use: a validation worker loads this file
// at boot, and nothing of the runtime's after its lockdown, #194's PR 1)
const identity = require('./fs-broker/identity');
const pathOf = (modulePath) => identity.pathFor(String(modulePath));
// declarations requires this file at its load: taken through lazy-require's
// holder, which a validation worker warms at boot
const declarationsLib = require('./lazy-require').lazy('./declarations');
const {CountinghouseError} = require('./countinghouse-error');

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_PATTERN_LENGTH = 1000;
const MAX_NODES = 100000;
const jsonPointer = require('./json-pointer');
const MAX_REF_HOPS = jsonPointer.MAX_REF_HOPS;
const SCHEMA_KEYS = ['input', 'output', 'fault'];
// In a schema object, a value under these is data, not a schema: a
// `pattern` there is not one. (Under a map of schemas, such as properties,
// the same names are a property's and hold schemas.)
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
// Keywords whose value maps names (any names) to schemas.
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

const isObject = (v) => v != null && typeof(v) === 'object' && !Array.isArray(v);
const escapeToken = (t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1');

// The token an alternative starts with, for the overlap check: an escape
// (\d, \.), a literal character, or null for anything else (a class, a
// group, an anchor), which is never taken to overlap.
function leadingToken(alternative) {
  if (alternative.length === 0) return null;
  if (alternative[0] === '\\') return alternative.slice(0, 2);
  if ('[(.^$|)*+?{'.includes(alternative[0])) return alternative[0] === '.' ? '.' : null;
  return alternative[0];
}

// -> null, or why `source` could backtrack catastrophically. Repetition is
// *, +, {n,} and {n,m} with m > 1; ? and {n} are not. An escape and a
// character class are one atom each, a class read as JavaScript reads it
// ([] matches nothing and [^] anything; a ] right after them closes them).
function unsafePattern(source) {
  if (typeof(source) !== 'string') return null;
  if (source.length > MAX_PATTERN_LENGTH) return `a pattern longer than ${MAX_PATTERN_LENGTH} characters`;
  // Each open group: whether it holds a repetition, and its alternatives'
  // leading tokens (the text since the group or the last |).
  const frames = [{repeats: false, alternatives: [], start: 0}];
  let lastGroup = null;   // the group just closed, when it is the atom before a quantifier
  let i = 0;
  const quantifierAt = (at) => {
    const c = source[at];
    if (c === '*' || c === '+') return [at + 1, true];
    if (c === '?') return [at + 1, false];
    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (m == null) return null;
      return [at + m[0].length, m[2] != null && (m[3] === '' || Number(m[3]) > 1)];
    }
    return null;
  };
  const endAlternative = (frame, at) => frame.alternatives.push(leadingToken(source.slice(frame.start, at)));
  while (i < source.length) {
    const c = source[i];
    lastGroup = null;
    if (c === '\\') {
      i += 2;
    } else if (c === '[') {
      i++;
      if (source[i] === '^') i++;
      while (i < source.length && source[i] !== ']') i += (source[i] === '\\') ? 2 : 1;
      i++;
    } else if (c === '(') {
      i++;
      if (source[i] === '?') {
        // (?: (?= (?! (?<= (?<! (?<name>
        const m = /^\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(i));
        i += (m != null) ? m[0].length : 1;
      }
      frames.push({repeats: false, alternatives: [], start: i});
      continue;
    } else if (c === '|') {
      endAlternative(frames[frames.length - 1], i);
      i++;
      frames[frames.length - 1].start = i;
      continue;
    } else if (c === ')') {
      if (frames.length > 1) {
        const frame = frames.pop();
        endAlternative(frame, i);
        if (frame.repeats) frames[frames.length - 1].repeats = true;
        lastGroup = frame;
      }
      i++;
    } else if (quantifierAt(i) != null) {
      // a quantifier with no atom before it (after '(', '|' or another
      // quantifier): not ours to judge
      i = quantifierAt(i)[0];
      continue;
    } else {
      i++;   // any other character is one atom
    }
    // An atom ended at i: a quantifier may follow.
    const q = quantifierAt(i);
    if (q == null) continue;
    if (q[1]) {
      if (lastGroup != null && lastGroup.repeats) return 'a pattern that can backtrack catastrophically (a repetition inside a repeated group)';
      if (lastGroup != null && lastGroup.alternatives.length > 1) {
        const leads = lastGroup.alternatives.filter((t) => t != null);
        if (new Set(leads).size < leads.length) return 'a pattern that can backtrack catastrophically (a repeated group whose alternatives start alike)';
      }
      frames[frames.length - 1].repeats = true;
    }
    i = q[0];
    if (source[i] === '?') i++;   // lazy
  }
  return null;
}

// -> {path, reason} for the first unsafe pattern in the document, or null.
// Walked with a stack, not recursion: a deeply nested document cannot
// overflow it. `map`: the node maps names to schemas (no keyword in it is
// data).
function firstUnsafePattern(doc, anchors) {
  const stack = [{node: doc, at: '', map: false}];
  // A $ref's (or $dynamicRef's) target is a schema wherever it sits, under
  // enum or default included: it is walked as one, once.
  const asSchema = new Set();
  while (stack.length > 0) {
    const {node, at, map} = stack.pop();
    if (isObject(node) && !map) {
      for (const target of refTargets(doc, anchors, node)) {
        if (target.node !== NOWHERE && target.node != null && typeof(target.node) === 'object' && !asSchema.has(target.node)) {
          asSchema.add(target.node);
          stack.push({node: target.node, at: target.at, map: false});
        }
      }
    }
    if (Array.isArray(node)) {
      node.forEach((v, k) => stack.push({node: v, at: `${at}/${k}`, map: false}));
      continue;
    }
    if (!isObject(node)) continue;
    if (!map) {
      if (typeof(node.pattern) === 'string') {
        const why = unsafePattern(node.pattern);
        if (why != null) return {path: `${at}/pattern`, reason: why};
      }
      if (isObject(node.patternProperties)) {
        const keys = Object.keys(node.patternProperties);
        for (let k = 0; k < keys.length; k++) {
          const why = unsafePattern(keys[k]);
          if (why != null) return {path: `${at}/patternProperties (its key number ${k + 1})`, reason: why};
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (!map && DATA_KEYWORDS.has(key)) continue;
      stack.push({node: node[key], at: `${at}/${escapeToken(key)}`, map: !map && SCHEMA_MAPS.has(key)});
    }
  }
  return null;
}

const NOWHERE = jsonPointer.NOWHERE;

// The node a local $ref names ('#', '#/a/b'), decoded as the runtime's
// resolution (json-schema-ref-parser) decodes it -- split on '/', then each
// token's ~1 and ~0 replaced and decodeURI applied, which leaves %2F as it
// is -- and following a $ref met along the way, as it does; NOWHERE when it
// names no place in the document.
// The one JSON pointer decoder and local-ref resolver (lib/json-pointer.js):
// the load's refs, the schema walk's and the schema route's paths all name a
// node by it (#400's high review)
const {pointerTokens, declaredTokens, resolveLocal, resolveTokens} = jsonPointer;

// Every $dynamicAnchor's node, by name: a $dynamicRef ('#name') may end at
// any of them (JSON Schema 2020-12), so it is counted through all.
function dynamicAnchors(doc) {
  const out = new Map();
  const stack = [doc];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node == null || typeof(node) !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (isObject(node) && typeof(node.$dynamicAnchor) === 'string') {
      if (!out.has(node.$dynamicAnchor)) out.set(node.$dynamicAnchor, []);
      out.get(node.$dynamicAnchor).push(node);
    }
    for (const v of (Array.isArray(node) ? node : Object.values(node))) stack.push(v);
  }
  return out;
}

// The nodes a schema node's $ref and $dynamicRef name: [{node, at}], node
// NOWHERE for one naming no place. A $dynamicRef '#name' names every
// $dynamicAnchor of that name; '#/...' a place, as a $ref does.
function refTargets(doc, anchors, node) {
  const out = [];
  if (typeof(node.$ref) === 'string') out.push({node: resolveLocal(doc, node.$ref), at: node.$ref.slice(1)});
  if (typeof(node.$dynamicRef) === 'string') {
    const ref = node.$dynamicRef;
    if (ref.startsWith('#/') || ref === '#') {
      out.push({node: resolveLocal(doc, ref), at: ref.slice(1)});
    } else if (ref.startsWith('#') && anchors.has(ref.slice(1))) {
      for (const target of anchors.get(ref.slice(1))) out.push({node: target, at: `(the $dynamicAnchor ${JSON.stringify(ref.slice(1, 40))})`});
    } else {
      out.push({node: NOWHERE, at: ref.slice(1)});
    }
  }
  return out;
}

const OVER = Number.POSITIVE_INFINITY;
const CYCLE = Symbol('cycle');
const UNRESOLVED = Symbol('unresolved');

// The node count of `node` with its $refs expanded, at most `budget` (OVER
// past it), or CYCLE, or UNRESOLVED (a $ref naming no place in the
// document). Every key counts, data included: counting more only refuses
// sooner. Each node is counted once (memo), so the cost is the document's
// size, not the expansion's.
function expandedSize(doc, node, budget, memo, open, anchors) {
  if (node == null || typeof(node) !== 'object') return 1;
  if (memo.has(node)) return memo.get(node);
  if (open.has(node)) return CYCLE;
  open.add(node);
  let total = 1;
  let result = null;
  const count = (n) => {
    if (n === CYCLE || n === UNRESOLVED) { result = n; return false; }
    total += n;
    if (total > budget) { result = OVER; return false; }
    return true;
  };
  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    if (!count(expandedSize(doc, child, budget, memo, open, anchors))) break;
  }
  if (result == null && isObject(node)) {
    for (const target of refTargets(doc, anchors, node)) {
      if (!count(target.node === NOWHERE ? UNRESOLVED : expandedSize(doc, target.node, budget, memo, open, anchors))) break;
    }
  }
  open.delete(node);
  if (result == null) result = total;
  if (result !== CYCLE) memo.set(node, result);
  return result;
}

// -> {path, reason} when the document, or the actions' schemas together,
// come to more than the budget expanded, or a $ref refers to itself or to
// no place in the document; null otherwise.
function firstOversized(spec, doc, anchors) {
  const memo = new Map();
  const judge = (n, at) => {
    if (n === CYCLE) return {path: at, reason: 'a schema whose $ref refers to itself'};
    if (n === UNRESOLVED) return {path: at, reason: 'a $ref that names no place in schema.json (only "#/..." JSON pointers are followed)'};
    if (n === OVER) return {path: at, reason: `more than ${MAX_NODES} schema nodes with its $refs expanded`};
    return null;
  };
  let n;
  try {
    // The whole document: the main thread's resolution dereferences all of it.
    n = expandedSize(doc, doc, MAX_NODES, memo, new Set(), anchors);
  } catch (e) {   // nested past the stack
    return {path: '', reason: 'a schema nested too deeply to check'};
  }
  const whole = judge(n, '');
  if (whole != null) return whole;
  let total = 0;
  const serviceList = (isObject(spec) && isObject(spec.device) && isObject(spec.device.serviceList)) ? spec.device.serviceList : {};
  for (const urn of Object.keys(serviceList)) {
    const actions = isObject(serviceList[urn]) && Array.isArray(serviceList[urn].actionList) ? serviceList[urn].actionList : [];
    for (const action of actions) {
      for (const key of SCHEMA_KEYS) {
        const pointer = (isObject(action) && isObject(action[key])) ? action[key].schema : null;
        if (typeof(pointer) !== 'string') continue;
        const node = (pointer === '/') ? doc : resolveLocal(doc, `#${pointer}`);
        if (node === NOWHERE) continue;   // an action pointer that resolves nowhere: its own error, as before
        // each action's schema is copied on its own: their sizes add up
        const size = expandedSize(doc, node, MAX_NODES, memo, new Set(), anchors);
        const bad = judge(size, pointer);
        if (bad != null) return bad;
        total += size;
        if (total > MAX_NODES) return {path: pointer, reason: `actions' schemas that come to more than ${MAX_NODES} schema nodes together with their $refs expanded`};
      }
    }
  }
  return null;
}

// A problem's text as a log line and an error message may carry it: what a
// module declares is named in it (an action, a property, a template), so it
// is cut and its control characters go, and a module writes no line of its
// own and fills no log.
const DECLARED_TEXT_MAX = 512;
// (the controls, the line separators and the bidi controls: what
// lib/output-lines.js takes from a line, and the tab)
const declaredText = (text) => String(text).slice(0, DECLARED_TEXT_MAX).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');

// -> null, or {path, reason} to refuse the module whose api.json is `spec`
// (parsed, or null) and whose schema.json reads as `text` (null: it has
// none): the schema as one that would stall or exhaust its validators, or
// (stage: 'declarations') what the module declares.
function schemaProblem(text, spec) {
  return schemaVerdict(text, spec).problem;
}
// -> {problem (as schemaProblem), hiddenUnlisted}: hiddenUnlisted the tools
// ([serviceID, action name]) whose declared text leaves them unusable, the
// load's one decision on it (#400, lib/declarations.js check)
function schemaVerdict(text, spec) {
  const checked = checkSchema(text, spec);
  if (checked.problem != null) return {problem: checked.problem, hiddenUnlisted: []};
  // not JSON: the load's own error, and nothing to check declarations in
  if (checked.unread) return {problem: null, hiddenUnlisted: []};
  const first = checked.declared.problems[0];
  return {problem: (first == null) ? null : {path: declaredText(first.path), reason: declaredText(first.message), stage: 'declarations'},
    hiddenUnlisted: Array.isArray(checked.declared.hiddenUnlisted) ? checked.declared.hiddenUnlisted : []};
}

// The one sequence a module's schema.json and declarations are checked in,
// for the load (schemaProblem: its first problem refuses the module) and for
// countinghouse-validate (lib/module-validator.js: it reports every one).
// text: schema.json as read (null: the module has none). spec: api.json,
// parsed.
//   1. is the text safe to hand to the validators (its size, before it is
//      parsed; then its patterns, its size expanded, its $refs)?
//   2. is it JSON? (not: the load's own error, said by whoever reads it)
//   3. what the module declares (lib/declarations.js), against that schema
// A step is reached only when the one before found nothing.
// -> {problem, unread, doc, declared}: problem is the safety problem
// {path, reason} or null; unread says the text was not JSON; doc is
// schema.json parsed and declared is {problems, warnings}, both null unless
// the first two steps passed.
function checkSchema(text, spec) {
  const safety = safetyProblem(text, spec);
  if (safety.problem != null) return {problem: safety.problem, unread: false, doc: null, declared: null};
  if (safety.unread) return {problem: null, unread: true, doc: null, declared: null};
  return {problem: null, unread: false, doc: safety.doc, declared: declarationsLib().check(spec, safety.doc)};
}

// schema.json's text, read by the path a module's own files are read by (a
// sandboxed worker's module is /app, POSIX on every OS: identity.pathFor).
// -> the text, or null for a module that has none. Throws what the read
// threw for a file that is there and cannot be read.
function schemaText(modulePath) {
  const file = pathOf(modulePath).join(String(modulePath), 'schema.json');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// The safety check alone (step 1 above, and the parse):
// -> {problem, doc, unread}: problem is {path, reason} or null; doc is
// schema.json parsed (null for none); unread says the text was not JSON.
function safetyProblem(text, spec) {
  if (text == null) return {problem: null, doc: null, unread: false};
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) return {problem: {path: '', reason: `schema.json is larger than 1 MB (${bytes} bytes)`}, doc: null, unread: false};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {problem: null, doc: null, unread: true};
  }
  const anchors = dynamicAnchors(doc);
  return {problem: firstUnsafePattern(doc, anchors) || firstOversized(spec, doc, anchors), doc: doc, unread: false};
}

// what a refusal says of a problem, after the stage: the load's line and
// validate's message are this same text. The path is made of the module's
// own property names, so it is cut and cleaned as a declaration's is
// (declaredText): it reaches an operator's log and a reviewer's terminal.
// The reason is this file's own words.
const safetyText = (problem) => `schema.json${problem.path !== '' ? ` ${declaredText(problem.path)}` : ''}: ${problem.reason}; refused, as one that would stall or exhaust its validators`;
// what to do about any of them, from the bounds themselves
const SAFETY_FIX = `A schema.json is at most 1 MB, and comes to at most ${MAX_NODES} schema nodes with its $refs expanded (its actions' schemas together too). `
  + `A pattern (also a patternProperties key and a propertyNames pattern) is at most ${MAX_PATTERN_LENGTH} characters, with no repetition inside a repeated group and no repeated group whose alternatives start alike. `
  + 'A $ref is a "#/..." pointer to a place in the file, never to itself, and a schema is not nested past what a check can follow. See docs/module-development.md, "schema.json".';

function refusalFor(name, problem) {
  if (problem.stage === 'declarations') {
    return new CountinghouseError('MODULE_ASSEMBLY_FAIL', String(name), `stage=declarations -- ${problem.reason}`);
  }
  return new CountinghouseError('MODULE_ASSEMBLY_FAIL', String(name),
    `stage=schemaSafety -- ${safetyText(problem)}`);
}

// -> null, or the MODULE_ASSEMBLY_FAIL to refuse the module at `modulePath`
// with. Reads api.json and schema.json itself (each once); one it cannot
// read or parse is left to the load's own errors. A module with no
// schema.json has no schema to refuse, and what it declares is checked all
// the same.
function schemaRefusal(modulePath, name) {
  return schemaChecked(modulePath, name).refusal;
}
// -> {refusal (as schemaRefusal), hiddenUnlisted (as schemaVerdict)}: a load
// on the main thread (single-thread mode) takes both from one walk (#400)
function schemaChecked(modulePath, name) {
  let text = null;
  try {
    text = schemaText(modulePath);
  } catch (e) {
    text = null;
  }
  let spec = null;
  try {
    spec = JSON.parse(fs.readFileSync(pathOf(modulePath).join(String(modulePath), 'api.json'), 'utf8'));
  } catch (e) {
    spec = null;
  }
  const verdict = schemaVerdict(text, spec);
  // spec: the api.json this decided on, for the load to assemble from (one
  // read, so the decision and what is served are the same spec)
  return {refusal: (verdict.problem == null) ? null : refusalFor(name, verdict.problem), hiddenUnlisted: verdict.hiddenUnlisted, spec};
}

module.exports = {schemaVerdict, schemaChecked, schemaRefusal, schemaProblem, checkSchema, schemaText, safetyProblem, safetyText, SAFETY_FIX, refusalFor, declaredText, unsafePattern, resolveLocal, resolveTokens, pointerTokens, declaredTokens, MAX_REF_HOPS, refTargets, dynamicAnchors, NOWHERE, DATA_KEYWORDS, SCHEMA_MAPS, MAX_SCHEMA_BYTES, MAX_PATTERN_LENGTH, MAX_NODES};
