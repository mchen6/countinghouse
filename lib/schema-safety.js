// A module's schema.json, checked before anything of it is resolved, compiled
// or run (the reviewer's ruling on #152, 2026-11-13). Since lean worker step 1
// a module's input and output are validated on the main thread, which every
// module and session shares, so a schema that would stall it or exhaust its
// memory is refused at load, fail closed, rather than left to a worker's
// limits:
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
const path = require('path');
const {CountinghouseError} = require('./countinghouse-error');

const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_PATTERN_LENGTH = 1000;
const MAX_NODES = 100000;
const MAX_REF_HOPS = 64;
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
function firstUnsafePattern(doc) {
  const stack = [{node: doc, at: '', map: false}];
  while (stack.length > 0) {
    const {node, at, map} = stack.pop();
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

const NOWHERE = Symbol('nowhere');

// The node a local $ref names ('#', '#/a/b'), following a $ref met along
// the way as the runtime's resolution does; NOWHERE when it names no place
// in the document.
function resolveLocal(doc, ref, hops = 0) {
  if (hops > MAX_REF_HOPS || typeof(ref) !== 'string' || !ref.startsWith('#')) return NOWHERE;
  let pointerText;
  try {
    pointerText = decodeURIComponent(ref.slice(1));
  } catch (e) {
    return NOWHERE;
  }
  if (pointerText === '') return doc;
  if (!pointerText.startsWith('/')) return NOWHERE;
  let node = doc;
  for (const raw of pointerText.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    while (isObject(node) && typeof(node.$ref) === 'string' && !Object.prototype.hasOwnProperty.call(node, token)) {
      node = resolveLocal(doc, node.$ref, hops + 1);
      if (node === NOWHERE) return NOWHERE;
    }
    if (node == null || typeof(node) !== 'object' || !Object.prototype.hasOwnProperty.call(node, token)) return NOWHERE;
    node = node[token];
  }
  return node;
}

const OVER = Number.POSITIVE_INFINITY;
const CYCLE = Symbol('cycle');
const UNRESOLVED = Symbol('unresolved');

// The node count of `node` with its $refs expanded, at most `budget` (OVER
// past it), or CYCLE, or UNRESOLVED (a $ref naming no place in the
// document). Every key counts, data included: counting more only refuses
// sooner. Each node is counted once (memo), so the cost is the document's
// size, not the expansion's.
function expandedSize(doc, node, budget, memo, open) {
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
    if (!count(expandedSize(doc, child, budget, memo, open))) break;
  }
  if (result == null && isObject(node) && typeof(node.$ref) === 'string') {
    const target = resolveLocal(doc, node.$ref);
    count(target === NOWHERE ? UNRESOLVED : expandedSize(doc, target, budget, memo, open));
  }
  open.delete(node);
  if (result == null) result = total;
  if (result !== CYCLE) memo.set(node, result);
  return result;
}

// -> {path, reason} when the document, or the actions' schemas together,
// come to more than the budget expanded, or a $ref refers to itself or to
// no place in the document; null otherwise.
function firstOversized(spec, doc) {
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
    n = expandedSize(doc, doc, MAX_NODES, memo, new Set());
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
        const size = expandedSize(doc, node, MAX_NODES, memo, new Set());
        const bad = judge(size, pointer);
        if (bad != null) return bad;
        total += size;
        if (total > MAX_NODES) return {path: pointer, reason: `actions' schemas that come to more than ${MAX_NODES} schema nodes together with their $refs expanded`};
      }
    }
  }
  return null;
}

// -> null, or the reason text to refuse schema.json's `text` (as read) with
// for the module whose api.json is `spec` (parsed, or null).
function schemaProblem(text, spec) {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_SCHEMA_BYTES) return {path: '', reason: `schema.json is larger than 1 MB (${bytes} bytes)`};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return null;   // not JSON: the load's own error
  }
  return firstUnsafePattern(doc) || firstOversized(spec, doc);
}

function refusalFor(name, problem) {
  return new CountinghouseError('MODULE_ASSEMBLY_FAIL', String(name),
    `stage=schemaSafety -- schema.json${problem.path !== '' ? ` ${problem.path}` : ''}: ${problem.reason}; refused, so that it never runs on the main thread`);
}

// -> null, or the MODULE_ASSEMBLY_FAIL to refuse the module at `modulePath`
// with. Reads api.json and schema.json itself (each once); one it cannot
// read or parse is left to the load's own errors.
function schemaRefusal(modulePath, name) {
  let text;
  try {
    text = fs.readFileSync(path.join(String(modulePath), 'schema.json'), 'utf8');
  } catch (e) {
    return null;
  }
  let spec = null;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(String(modulePath), 'api.json'), 'utf8'));
  } catch (e) {
    spec = null;
  }
  const problem = schemaProblem(text, spec);
  return (problem == null) ? null : refusalFor(name, problem);
}

module.exports = {schemaRefusal, schemaProblem, refusalFor, unsafePattern, MAX_SCHEMA_BYTES, MAX_PATTERN_LENGTH, MAX_NODES};
